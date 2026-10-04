/**
 * Fake stores for the commerce bridge suites (P6-01): the App Store Server API, Google (OAuth
 * token endpoint, `purchases.products.get` / `:acknowledge` / `voidedpurchases`, the OIDC JWKS)
 * and the Steam Web API. Web APIs only, so the workerd lane can reuse it. No real key, account,
 * app or purchase anywhere: Apple's JWS are signed by a chain generated in the test
 * (`x509Fixtures.ts`), Google's push JWTs by an RSA key generated here.
 */

import { SignJWT, exportJWK, type JWK } from "jose";
import { makeChain, signX5cJws, type TestChain } from "./x509Fixtures.js";

type Json = Record<string, unknown>;

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export interface FakeRequest {
  method: string;
  url: URL;
  authorization: string | null;
}

// ── Apple ────────────────────────────────────────────────────────────────────────────────────

export const BUNDLE_ID = "gg.acme.djdl";
/** The app's Apple ID: Production notifications carry it (sandbox ones do not). */
export const APP_APPLE_ID = 1234567890;
export const APPLE_PRODUCT = "gg.acme.djdl.skins";

export interface AppleTx {
  transactionId: string;
  originalTransactionId?: string;
  bundleId?: string;
  productId?: string;
  environment?: string;
  type?: string;
  inAppOwnershipType?: string;
  appAccountToken?: string;
  revocationDate?: number;
}

export class AppleFake {
  chain!: TestChain;
  /** transactionId → the Server API's view of it. */
  transactions = new Map<string, AppleTx>();
  requests: FakeRequest[] = [];
  /** Answer the next N Server API calls with this status. */
  failNext: { status: number; count: number } | null = null;

  static async create(at: number): Promise<AppleFake> {
    const f = new AppleFake();
    f.chain = await makeChain({ at });
    return f;
  }

  txPayload(tx: AppleTx, signedMs: number): Json {
    return {
      transactionId: tx.transactionId,
      originalTransactionId: tx.originalTransactionId ?? tx.transactionId,
      bundleId: tx.bundleId ?? BUNDLE_ID,
      productId: tx.productId ?? APPLE_PRODUCT,
      purchaseDate: signedMs - 1000,
      type: tx.type ?? "Non-Consumable",
      inAppOwnershipType: tx.inAppOwnershipType ?? "PURCHASED",
      environment: tx.environment ?? "Production",
      signedDate: signedMs,
      storefront: "USA",
      ...(tx.appAccountToken !== undefined
        ? { appAccountToken: tx.appAccountToken }
        : {}),
      ...(tx.revocationDate !== undefined
        ? { revocationDate: tx.revocationDate, revocationReason: 0 }
        : {}),
    };
  }

  /** A StoreKit `jwsRepresentation` for `tx`, signed at `at` (epoch seconds). */
  signTransaction(
    tx: AppleTx,
    at: number,
    chain: TestChain = this.chain,
  ): Promise<string> {
    return signX5cJws(this.txPayload(tx, at * 1000), chain.leafKey, chain.x5c);
  }

  /** A Notifications V2 `signedPayload`. */
  async signNotification(
    o: {
      uuid: string;
      type: string;
      subtype?: string;
      tx?: AppleTx;
      environment?: string;
      bundleId?: string;
      /** Default: `APP_APPLE_ID` in Production, absent in Sandbox; `null` omits it. */
      appAppleId?: number | null;
    },
    at: number,
    chain: TestChain = this.chain,
  ): Promise<string> {
    const environment = o.environment ?? "Production";
    const appAppleId =
      o.appAppleId === undefined
        ? environment === "Production"
          ? APP_APPLE_ID
          : null
        : o.appAppleId;
    const data: Json = {
      bundleId: o.bundleId ?? BUNDLE_ID,
      environment,
      ...(appAppleId !== null ? { appAppleId } : {}),
      ...(o.tx
        ? { signedTransactionInfo: await this.signTransaction(o.tx, at, chain) }
        : {}),
    };
    return signX5cJws(
      {
        notificationType: o.type,
        ...(o.subtype ? { subtype: o.subtype } : {}),
        notificationUUID: o.uuid,
        data,
        version: "2.0",
        signedDate: at * 1000,
      },
      chain.leafKey,
      chain.x5c,
    );
  }

  /** The Server API: `GET /inApps/v1/transactions/{id}` on either host. */
  async handle(req: FakeRequest, at: number): Promise<Response> {
    this.requests.push(req);
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count--;
      return json(this.failNext.status, { errorCode: 0 });
    }
    if (!req.authorization?.startsWith("Bearer ")) return json(401, null);
    const m = req.url.pathname.match(/^\/inApps\/v1\/transactions\/(\d+)$/);
    if (!m || req.method !== "GET") return json(404, { errorCode: 4040010 });
    const tx = this.transactions.get(m[1]!);
    if (!tx) return json(404, { errorCode: 4040010 });
    const sandboxHost = req.url.hostname === "api.storekit-sandbox.apple.com";
    if (
      (tx.environment ?? "Production") === "Sandbox"
        ? !sandboxHost
        : sandboxHost
    )
      return json(404, { errorCode: 4040010 });
    return json(200, {
      signedTransactionInfo: await this.signTransaction(tx, at),
    });
  }
}

// ── Google ───────────────────────────────────────────────────────────────────────────────────

export const PLAY_PACKAGE = "gg.acme.djdl";
export const PLAY_SKU = "skins_pack";
export const PUSH_AUDIENCE =
  "https://key.example.test/djdl/distribution/hooks/play-rtdn";
export const PUSH_ACCOUNT = "rtdn-push@acme-djdl.iam.gserviceaccount.com";

export interface PlayPurchaseState {
  purchaseState: number;
  acknowledgementState: number;
  purchaseType?: number;
  obfuscatedExternalAccountId?: string;
  orderId?: string;
}

export class GoogleFake {
  /** `<sku>/<token>` → the purchase as Play reports it. */
  purchases = new Map<string, PlayPurchaseState>();
  voided: Array<{ purchaseToken: string; voidedTimeMillis: number }> = [];
  acknowledged: string[] = [];
  requests: FakeRequest[] = [];
  jwksFetches = 0;
  failAcknowledge = 0;
  private keys!: CryptoKeyPair;
  private jwk!: JWK;
  readonly kid = "test-google-kid-1";

  static async create(): Promise<GoogleFake> {
    const f = new GoogleFake();
    f.keys = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: Uint8Array.of(1, 0, 1),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    f.jwk = {
      ...(await exportJWK(f.keys.publicKey)),
      kid: f.kid,
      alg: "RS256",
      use: "sig",
    };
    return f;
  }

  /** A Pub/Sub push OIDC token. `over` replaces claims (`email`, `aud`, `iss`, …). */
  pushToken(at: number, over: Record<string, unknown> = {}): Promise<string> {
    const claims: Record<string, unknown> = {
      iss: "https://accounts.google.com",
      aud: PUSH_AUDIENCE,
      email: PUSH_ACCOUNT,
      email_verified: true,
      sub: "1234567890",
      iat: at,
      exp: at + 3600,
      ...over,
    };
    return new SignJWT(claims as never)
      .setProtectedHeader({ alg: "RS256", kid: this.kid, typ: "JWT" })
      .sign(this.keys.privateKey);
  }

  /** A Pub/Sub push body for an RTDN `data` object. */
  pushBody(messageId: string, data: Json): Json {
    return {
      message: {
        data: btoa(
          JSON.stringify({ version: "1.0", eventTimeMillis: "1", ...data }),
        ),
        messageId,
        publishTime: "2023-11-14T22:13:20Z",
        attributes: {},
      },
      subscription: "projects/acme-djdl/subscriptions/rtdn-push",
    };
  }

  async handle(req: FakeRequest, init?: RequestInit): Promise<Response> {
    this.requests.push(req);
    const { url } = req;
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token")
      return json(200, {
        access_token: "ya29.test-commerce",
        expires_in: 3600,
        token_type: "Bearer",
      });
    if (
      url.hostname === "www.googleapis.com" &&
      url.pathname === "/oauth2/v3/certs"
    ) {
      this.jwksFetches++;
      return json(200, { keys: [this.jwk] });
    }
    if (url.hostname !== "androidpublisher.googleapis.com")
      return json(404, null);
    if (req.authorization !== "Bearer ya29.test-commerce")
      return json(401, null);
    const prefix = `/androidpublisher/v3/applications/${PLAY_PACKAGE}/purchases/`;
    if (!url.pathname.startsWith(prefix)) return json(403, null);
    const rest = url.pathname.slice(prefix.length);
    if (rest === "voidedpurchases" && req.method === "GET")
      return json(200, { voidedPurchases: this.voided });
    const m = rest.match(
      /^products\/([^/]+)\/tokens\/([^/:]+)(:acknowledge)?$/,
    );
    if (!m) return json(404, null);
    const key = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
    const p = this.purchases.get(key);
    if (!p) return json(404, { error: { code: 404 } });
    if (m[3]) {
      if (req.method !== "POST") return json(405, null);
      if (this.failAcknowledge > 0) {
        this.failAcknowledge--;
        return json(503, null);
      }
      void init;
      this.acknowledged.push(key);
      p.acknowledgementState = 1;
      return json(200, null);
    }
    return json(200, {
      kind: "androidpublisher#productPurchase",
      purchaseTimeMillis: "1700000000000",
      consumptionState: 0,
      regionCode: "US",
      ...p,
    });
  }
}

// ── Steam ────────────────────────────────────────────────────────────────────────────────────

export const STEAM_APP = "480";
export const STEAM_DLC = "1234560";
export const STEAM_KEY = "0123456789ABCDEF0123456789ABCDEF";

export class SteamFake {
  /** ticket → {steamid, identity it was made for}. */
  tickets = new Map<string, { steamid: string; identity: string }>();
  /** `<steamid>:<appid>` → ownership. */
  owns = new Map<
    string,
    {
      ownsapp: boolean;
      ownersteamid: string;
      timedtrial?: boolean;
      /** Default: true when `ownsapp` (a purchase). */
      permanent?: boolean;
      sitelicense?: boolean;
      usercanceled?: boolean;
    }
  >();
  requests: FakeRequest[] = [];

  handle(req: FakeRequest): Response {
    this.requests.push(req);
    const q = req.url.searchParams;
    if (req.url.hostname !== "partner.steam-api.com") return json(404, null);
    if (q.get("key") !== STEAM_KEY) return json(403, null);
    if (req.url.pathname === "/ISteamUserAuth/AuthenticateUserTicket/v1/") {
      const t = this.tickets.get(q.get("ticket") ?? "");
      if (
        !t ||
        q.get("appid") !== STEAM_APP ||
        q.get("identity") !== t.identity
      )
        return json(200, {
          response: { error: { errorcode: 101, errordesc: "Invalid ticket" } },
        });
      return json(200, {
        response: {
          params: {
            result: "OK",
            steamid: t.steamid,
            ownersteamid: t.steamid,
            vacbanned: false,
            publisherbanned: false,
          },
        },
      });
    }
    if (req.url.pathname === "/ISteamUser/CheckAppOwnership/v4/") {
      const o = this.owns.get(`${q.get("steamid")}:${q.get("appid")}`);
      return json(200, {
        appownership: {
          ownsapp: o?.ownsapp ?? false,
          permanent: o?.permanent ?? o?.ownsapp ?? false,
          timestamp: "2023-11-14T22:13:20Z",
          ownersteamid: o?.ownersteamid ?? "0",
          sitelicense: o?.sitelicense ?? false,
          timedtrial: o?.timedtrial ?? false,
          usercanceled: o?.usercanceled ?? false,
          result: "OK",
        },
      });
    }
    return json(404, null);
  }
}

// ── one fetch for every fake ─────────────────────────────────────────────────────────────────

export interface CommerceFakes {
  apple: AppleFake;
  google: GoogleFake;
  steam: SteamFake;
  /** Hosts nothing should have called. */
  foreign: string[];
}

export function fakeFetch(
  f: CommerceFakes,
  at: () => number,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : {}),
    );
    const req: FakeRequest = {
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      url,
      authorization: headers.get("authorization"),
    };
    if (
      url.hostname === "api.storekit.apple.com" ||
      url.hostname === "api.storekit-sandbox.apple.com"
    )
      return f.apple.handle(req, at());
    if (url.hostname.endsWith("googleapis.com"))
      return f.google.handle(req, init);
    if (url.hostname === "partner.steam-api.com") return f.steam.handle(req);
    f.foreign.push(url.hostname);
    return json(404, null);
  };
}
