// @vitest-environment node
//
// @pkey-feature identity.choice
//
// The browser exchange primitive (I-46.3; WIRE-CONTRACT-V5 §12.11.2-.3) and `consent` on
// `choice.complete`, driven through the bearer engine against a scripted Worker: the nonce
// request, the token-exchange form and its `exchange` proof (checked with an independent
// Ed25519 verify), and every answer's mapping. Node environment: jsdom's cross-realm typed
// arrays make WebCrypto's Ed25519 verify reject every signature.

import { createHash, createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebDeviceKeyStore,
  memoryDeviceKeyStorage,
  type CacheRecordV3,
  type DeviceKeyPort,
  type Store,
} from "@polaris-key/client-core";
import { BearerSession } from "../src/browser/bearer/session.js";
import type { ExchangeOptions } from "../src/browser/bearer/exchange.js";
import { exchangeDiscoveryOf } from "../src/browser/discovery.js";
import { PolarisError } from "../src/core/types.js";

import {
  ACCESS,
  GRANT,
  HANDLE,
  SUBJECT_TOKEN,
  durableKeys,
  json,
  TOKEN_BODY,
  exchangeSession,
  nonceOf,
} from "./exchangeFixtures.js";

const NOW = 1_700_000_000;
const DEVICE = "EXCHANGEDEVICE0000000000000001";
const BASE = "https://key.plrs.im/acme/identity";

const CONSENT = {
  client: {
    appName: "acme",
    developerName: null,
    iconUrl: null,
    nameVerified: true,
  },
  as: { provider: "google", email: "ada@example.com" },
  items: [{ kind: "profile", claims: ["name", "picture", "email"] }],
  scopeHash: "327f7d9e9a356405aafdeb28138a0586ee84b663f9cb65798332291ce1b1652f",
  firstTime: true,
  changed: false,
};

function memStore(): Store & { token: string | null } {
  let cache: CacheRecordV3 | null = null;
  const self = {
    token: null as string | null,
    getToken: async () => self.token,
    setToken: async (t: string) => void (self.token = t),
    clearToken: async () => void (self.token = null),
    getDeviceId: async () => DEVICE,
    readCache: async () => cache,
    writeCache: async (rec: CacheRecordV3) => void (cache = rec),
    clearCache: async () => void (cache = null),
  };
  return self;
}

const lowerKeys = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((h ?? {}) as Record<string, string>))
    out[k.toLowerCase()] = v;
  return out;
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
  credentials?: RequestCredentials;
  redirect?: RequestRedirect;
  signal?: AbortSignal | null;
}

const DISCOVERY = {
  services: {
    identity: {
      enabled: true,
      exchange: {
        kinds: ["google", "apple"],
        google: { serverClientId: "1234-web.apps.googleusercontent.com" },
      },
      endpoints: {
        nonce: `${BASE}/nonce`,
        token: `${BASE}/token`,
        link: `${BASE}/link`,
        choiceLicenses: `${BASE}/choice/licenses`,
        choiceDevices: `${BASE}/choice/devices`,
        choiceComplete: `${BASE}/choice/complete`,
        choiceCancel: `${BASE}/choice/cancel`,
      },
    },
  },
};

type Respond = (call: Call, n: number) => Response;

function rig(
  token: Respond,
  o: { discovery?: Record<string, unknown> | null; complete?: Respond } = {},
) {
  const calls: Call[] = [];
  const store = memStore();
  let nonces = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: lowerKeys(init?.headers),
      body: String(init?.body ?? ""),
      credentials: init?.credentials,
      redirect: init?.redirect,
      signal: init?.signal,
    };
    calls.push(call);
    if (call.url === `${BASE}/nonce`) {
      nonces += 1;
      return json({ nonce: nonceOf(nonces), expiresIn: 300 });
    }
    if (call.url === `${BASE}/token`) return token(call, nonces);
    if (call.url === `${BASE}/choice/complete`)
      return (o.complete ?? (() => json(TOKEN_BODY)))(call, nonces);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const discovery = o.discovery === undefined ? DISCOVERY : o.discovery;
  const session = exchangeSession({
    fetchImpl,
    store,
    exchangeEndpoints: () => exchangeDiscoveryOf(discovery),
    choiceEndpoints: () =>
      (discovery as typeof DISCOVERY | null)?.services.identity.endpoints ??
      null,
  });
  return { session, calls, store, port: durableKeys() };
}

const google = (
  subjectToken: ExchangeOptions["subjectToken"] = async () => SUBJECT_TOKEN,
): ExchangeOptions => ({ kind: "google", subjectToken });

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

/** Check the proof the way the Worker does: Ed25519 over the six `pkey-proof/1` lines. */
function proofVerifies(
  signKey: string,
  proof: string,
  value: string,
  token: string,
): boolean {
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(signKey, "base64url"),
  ]);
  const message = [
    "pkey-proof/1",
    "exchange",
    "acme",
    DEVICE,
    value,
    b64u(createHash("sha256").update(token).digest()),
  ].join("\n");
  return verify(
    null,
    Buffer.from(message),
    createPublicKey({ key: spki, format: "der", type: "spki" }),
    Buffer.from(proof, "base64url"),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the exchange request", () => {
  it("asks for a nonce with both keys, then sends the grant with a proof that verifies", async () => {
    const r = rig(() => json(TOKEN_BODY));
    let seen = "";
    const out = await r.session.exchange(
      r.port,
      google(async (nonce) => {
        seen = nonce;
        return SUBJECT_TOKEN;
      }),
    );
    expect(out).toEqual({
      kind: "signedIn",
      subject: "ps_abc",
      scope: "profile email",
      activation: { licenseId: "lic-1" },
    });
    expect(r.store.token).toBe(ACCESS);

    const [nonceCall, tokenCall] = r.calls;
    const keys = (await r.port.publicKeys())!;
    expect(JSON.parse(nonceCall!.body)).toEqual({
      signKey: keys.signKey,
      agreeKey: keys.agreeKey,
    });
    expect(nonceCall!.headers["x-pkey-device"]).toBe(DEVICE);
    expect(nonceCall!.credentials).toBe("omit");
    // Neither POST follows a redirect, and both carry the request deadline.
    for (const c of r.calls) {
      expect(c.redirect).toBe("error");
      expect(c.signal).toBeInstanceOf(AbortSignal);
    }
    expect(seen).toBe(nonceOf(1));

    expect(tokenCall!.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(tokenCall!.headers.authorization).toBeUndefined();
    const form = new URLSearchParams(tokenCall!.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: "acme",
      subject_token: SUBJECT_TOKEN,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      nonce: nonceOf(1),
      device_key: keys.signKey,
      proof: form.get("proof"),
    });
    expect(
      proofVerifies(
        keys.signKey,
        form.get("proof")!,
        `${nonceOf(1)}.${keys.signKey}`,
        SUBJECT_TOKEN,
      ),
    ).toBe(true);
    // The proof is bound to this token and nonce: another token does not verify.
    expect(
      proofVerifies(
        keys.signKey,
        form.get("proof")!,
        `${nonceOf(1)}.${keys.signKey}`,
        "other",
      ),
    ).toBe(false);
  });

  it("sends license_choice and device_name only when given", async () => {
    const r = rig(() => json(TOKEN_BODY));
    await r.session.exchange(r.port, {
      ...google(),
      licenseChoice: "card",
      deviceName: "Ada's laptop",
    });
    const form = new URLSearchParams(r.calls[1]!.body);
    expect(form.get("license_choice")).toBe("card");
    expect(form.get("device_name")).toBe("Ada's laptop");
  });
});

describe("the answers", () => {
  it("confirm is a PendingConsent that holds the grant out of sight", async () => {
    const r = rig(() =>
      json({
        status: "confirm",
        grant: GRANT,
        expiresIn: 300,
        consent: CONSENT,
      }),
    );
    const out = await r.session.exchange(r.port, google());
    if (out.kind !== "pendingConsent") throw new Error(out.kind);
    expect(out.grant).toBe(GRANT);
    expect(out.consent.as).toEqual({
      provider: "google",
      email: "ada@example.com",
    });
    expect(out.consent.firstTime).toBe(true);
    expect(JSON.stringify(out)).not.toContain(GRANT);
    expect({ ...out }).not.toHaveProperty("grant");
    expect(r.store.token).toBeNull();
  });

  it("choose is a PendingSignIn", async () => {
    const r = rig(() =>
      json({
        status: "choose",
        grant: GRANT,
        expiresIn: 300,
        choices: { state: "pick" },
      }),
    );
    const out = await r.session.exchange(r.port, google());
    if (out.kind !== "pendingSignIn") throw new Error(out.kind);
    expect(out.grant).toBe(GRANT);
    expect(out.choices).toEqual({ state: "pick" });
    expect(JSON.stringify(out)).not.toContain(GRANT);
    expect(r.store.token).toBeNull();
  });

  it("403 interstitial_required no_link is needsSignIn with the handle", async () => {
    const r = rig(() =>
      json(
        {
          error: "interstitial_required",
          reason: "no_link",
          url: "https://key.plrs.im/acme/identity/authorize",
          linkHandle: HANDLE,
          expiresIn: 600,
        },
        403,
      ),
    );
    const out = await r.session.exchange(r.port, google());
    if (out.kind !== "needsSignIn") throw new Error(out.kind);
    expect(out.reason).toBe("no_link");
    expect(out.linkHandle).toBe(HANDLE);
    expect(out.expiresIn).toBe(600);
    expect(JSON.stringify(out)).not.toContain(HANDLE);
    expect(r.store.token).toBeNull();
  });

  it("an unknown reason reads as no_link; terms carries no handle", async () => {
    const answer = (reason: string) =>
      rig(() =>
        json(
          {
            error: "interstitial_required",
            reason,
            url: "https://key.plrs.im/acme/identity/authorize",
            linkHandle: HANDLE,
          },
          403,
        ),
      );
    const a = answer("future");
    const unknown = await a.session.exchange(a.port, google());
    expect(unknown).toMatchObject({ kind: "needsSignIn", reason: "no_link" });
    expect((unknown as { linkHandle?: string }).linkHandle).toBeUndefined();
    const b = answer("terms");
    const terms = await b.session.exchange(b.port, google());
    if (terms.kind !== "needsSignIn") throw new Error(terms.kind);
    expect(terms.reason).toBe("terms");
    expect(terms.linkHandle).toBeUndefined();
  });

  it("flat refusals are typed errors that name no secret", async () => {
    const r = rig(() => json({ error: "invalid_grant" }, 400));
    const err = await r.session.exchange(r.port, google()).catch((e) => e);
    expect(err).toBeInstanceOf(PolarisError);
    expect(err.code).toBe("invalid_grant");
    expect(err.status).toBe(400);
    expect(err.message).not.toContain(SUBJECT_TOKEN);
    expect(err.message).not.toContain(nonceOf(1));
    expect(r.store.token).toBeNull();

    const limited = rig(() =>
      json({ error: "rate_limited" }, 429, { "retry-after": "7" }),
    );
    const e2 = await limited.session
      .exchange(limited.port, google())
      .catch((e) => e);
    expect(e2).toMatchObject({ code: "rate_limited", retryAfterSeconds: 7 });

    const server = rig(() => json({ error: "boom" }, 503));
    const e3 = await server.session
      .exchange(server.port, google())
      .catch((e) => e);
    expect(e3).toMatchObject({ code: "server-error", status: 503 });
  });

  it("a 403 that is not the interstitial is its own typed error", async () => {
    const r = rig(() => json({ error: "device_limit" }, 403));
    const err = await r.session.exchange(r.port, google()).catch((e) => e);
    expect(err).toMatchObject({ code: "device_limit", status: 403 });
  });

  it("a malformed 200 is bad-response, not a sign-in", async () => {
    const r = rig(() =>
      json({ status: "confirm", grant: "not-a-grant", consent: CONSENT }),
    );
    const err = await r.session.exchange(r.port, google()).catch((e) => e);
    expect(err).toMatchObject({ code: "bad_response" });
    expect(r.store.token).toBeNull();
  });
});

describe("pinned endpoints", () => {
  const withEndpoints = (nonce: string, tokenUrl: string) => ({
    services: {
      identity: {
        ...DISCOVERY.services.identity,
        endpoints: {
          ...DISCOVERY.services.identity.endpoints,
          nonce,
          token: tokenUrl,
        },
      },
    },
  });

  it.each([
    [
      "a nonce endpoint on another origin",
      "https://evil.example/n",
      `${BASE}/token`,
    ],
    [
      "a token endpoint on another origin",
      `${BASE}/nonce`,
      "https://evil.example/t",
    ],
    [
      "a plaintext token endpoint",
      `${BASE}/nonce`,
      "http://key.plrs.im/acme/identity/token",
    ],
    ["a scheme that is not http", `${BASE}/nonce`, "javascript:alert(1)"],
  ])("refuses %s and dials nothing", async (_n, nonce, tokenUrl) => {
    const r = rig(() => json(TOKEN_BODY), {
      discovery: withEndpoints(nonce, tokenUrl),
    });
    let asked = false;
    const out = await r.session.exchange(
      r.port,
      google(async () => {
        asked = true;
        return SUBJECT_TOKEN;
      }),
    );
    expect(out).toEqual({ kind: "unavailable", reason: "endpoint" });
    expect(r.calls).toHaveLength(0);
    expect(asked).toBe(false);
  });
});

describe("unavailable", () => {
  it("is a 404 on the nonce route", async () => {
    const off = rig(() => json({}));
    // The nonce route answers 404 when identity is off: script it through a fetch of its own.
    const session = new BearerSession({
      baseUrl: "https://key.plrs.im",
      product: "acme",
      version: "1.0.0",
      fetchImpl: (async () =>
        json({ error: { code: "not_found" } }, 404)) as typeof fetch,
      now: () => NOW,
      pinned: { k: "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI" },
      store: memStore(),
      enabled: () => true,
      exchangeEndpoints: () => exchangeDiscoveryOf(DISCOVERY),
    });
    let asked = false;
    expect(
      await session.exchange(
        off.port,
        google(async () => {
          asked = true;
          return SUBJECT_TOKEN;
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "product" });
    expect(asked).toBe(false);
  });

  it("is a 404 on the token route", async () => {
    const r = rig(() => json({ error: "not_found" }, 404));
    expect(await r.session.exchange(r.port, google())).toEqual({
      kind: "unavailable",
      reason: "product",
    });
  });

  it("dials nothing without an exchange member, for an unlisted kind or on a memory-only store", async () => {
    const none = rig(() => json(TOKEN_BODY), {
      discovery: {
        services: {
          identity: {
            enabled: true,
            endpoints: DISCOVERY.services.identity.endpoints,
          },
        },
      },
    });
    expect(await none.session.exchange(none.port, google())).toEqual({
      kind: "unavailable",
      reason: "product",
    });
    expect(none.calls).toHaveLength(0);

    const apple = rig(() => json(TOKEN_BODY), {
      discovery: {
        services: {
          identity: {
            ...DISCOVERY.services.identity,
            exchange: { kinds: ["apple"] },
          },
        },
      },
    });
    expect(await apple.session.exchange(apple.port, google())).toEqual({
      kind: "unavailable",
      reason: "kind",
    });
    expect(apple.calls).toHaveLength(0);

    const mem = rig(() => json(TOKEN_BODY));
    const memoryOnly: DeviceKeyPort = {
      ...durableKeys(),
      persistence: () => "memory",
    };
    expect(await mem.session.exchange(memoryOnly, google())).toEqual({
      kind: "unavailable",
      reason: "device-keys",
    });
    expect(mem.calls).toHaveLength(0);
  });
});

describe("the nonce is single use", () => {
  it("asks for a new nonce on every attempt, and none is retried", async () => {
    const r = rig(() => json({ error: "invalid_grant" }, 400));
    const nonces: string[] = [];
    const opts = google(async (n) => {
      nonces.push(n);
      return SUBJECT_TOKEN;
    });
    await r.session.exchange(r.port, opts).catch(() => undefined);
    await r.session.exchange(r.port, opts).catch(() => undefined);
    expect(nonces).toEqual([nonceOf(1), nonceOf(2)]);
    expect(r.calls.map((c) => c.url.split("/").pop())).toEqual([
      "nonce",
      "token",
      "nonce",
      "token",
    ]);
  });

  it("a provider that fails ends the attempt before any token request", async () => {
    const r = rig(() => json(TOKEN_BODY));
    await expect(
      r.session.exchange(
        r.port,
        google(async () => {
          throw new Error("user dismissed");
        }),
      ),
    ).rejects.toThrow("user dismissed");
    expect(r.calls.map((c) => c.url.split("/").pop())).toEqual(["nonce"]);
  });
});

describe("secrets stay out of logs", () => {
  it("writes nothing to the console on any answer", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    for (const answer of [
      () =>
        json({
          status: "confirm",
          grant: GRANT,
          expiresIn: 300,
          consent: CONSENT,
        }),
      () => json({ error: "invalid_grant" }, 400),
      () => json(TOKEN_BODY),
    ]) {
      const r = rig(answer);
      await r.session.exchange(r.port, google()).catch(() => undefined);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("choice.complete with consent", () => {
  /** Complete a grant; what the Worker was sent is parsed from the request body. */
  async function complete(
    opts?: { consent: { claims: string[] } },
    withChoice = true,
  ) {
    const sent: Record<string, unknown>[] = [];
    const r = rig(() => json({}), {
      complete: (c) => {
        sent.push(JSON.parse(c.body) as Record<string, unknown>);
        return json(TOKEN_BODY);
      },
    });
    const out = await r.session.choiceComplete(
      GRANT,
      withChoice ? { kind: "create" } : undefined,
      opts,
    );
    return { out, body: sent[0], token: r.store.token };
  }

  it("sends the consent with the choice and stores the token", async () => {
    const r = await complete({ consent: { claims: ["name", "email"] } });
    expect(r.out).toMatchObject({ kind: "ok", subject: "ps_abc" });
    expect(r.body).toEqual({
      grant: GRANT,
      choice: { kind: "create" },
      consent: { claims: ["name", "email"] },
    });
    expect(r.token).toBe(ACCESS);
  });

  it("sends no consent member when none is given", async () => {
    expect((await complete()).body).toEqual({
      grant: GRANT,
      choice: { kind: "create" },
    });
  });

  it("completes a confirm grant with consent alone, no choice member", async () => {
    const r = await complete({ consent: { claims: ["name"] } }, false);
    expect(r.out).toMatchObject({ kind: "ok" });
    expect(r.out).not.toHaveProperty("attachable");
    expect(r.body).toEqual({ grant: GRANT, consent: { claims: ["name"] } });
    expect(r.token).toBe(ACCESS);
  });

  it("a refusal for the missing consent is a result and stores nothing", async () => {
    const r = rig(() => json({}), {
      complete: () => json({ error: "bad_request" }, 400),
    });
    const out = await r.session.choiceComplete(GRANT, { kind: "create" });
    expect(out).toMatchObject({
      kind: "refused",
      code: "bad_request",
      httpStatus: 400,
    });
    expect(r.store.token).toBeNull();
  });
});

describe("sync after the token is stored", () => {
  it("is still signed in when the sync fails, and says so", async () => {
    const r = rig(() => json(TOKEN_BODY));
    vi.spyOn(
      r.session as unknown as { syncAfterSignIn(): Promise<void> },
      "syncAfterSignIn",
    ).mockRejectedValue(new PolarisError("network-error", "offline"));
    const out = await r.session.exchange(r.port, google());
    expect(out).toMatchObject({ kind: "signedIn", subject: "ps_abc" });
    expect((out as { syncError?: PolarisError }).syncError?.code).toBe(
      "network-error",
    );
    expect(r.store.token).toBe(ACCESS);
  });
});

describe("exchangeDiscoveryOf", () => {
  it("reads kinds, the Google client id and the endpoints", () => {
    expect(exchangeDiscoveryOf(DISCOVERY)).toEqual({
      kinds: ["google", "apple"],
      google: { serverClientId: "1234-web.apps.googleusercontent.com" },
      nonceEndpoint: `${BASE}/nonce`,
      tokenEndpoint: `${BASE}/token`,
      linkEndpoint: `${BASE}/link`,
    });
  });

  it("answers null without the member, the endpoints, a known kind or the service", () => {
    const id = DISCOVERY.services.identity;
    const of = (identity: Record<string, unknown>) =>
      exchangeDiscoveryOf({ services: { identity } });
    expect(exchangeDiscoveryOf(null)).toBeNull();
    expect(of({ ...id, exchange: undefined })).toBeNull();
    expect(of({ ...id, exchange: { kinds: ["steam"] } })).toBeNull();
    expect(of({ ...id, exchange: { kinds: [] } })).toBeNull();
    expect(of({ ...id, endpoints: { token: id.endpoints.token } })).toBeNull();
    expect(of({ ...id, enabled: false })).toBeNull();
  });
});
