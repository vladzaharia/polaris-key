// The login card's providers (I-06) driven against recorded provider documents.
//
// Recorded, verbatim (test/fixtures/signin/): Google's and Apple's discovery documents (anonymous
// GETs, 2026-10-04), the shape of a Steam OpenID 2.0 positive assertion, Steam's
// `check_authentication` answer and a `GetPlayerSummaries` answer. ID tokens cannot be recorded
// (the providers sign them and they expire), so a local RSA key is served as the provider's JWKS
// and the tests mint tokens in the providers' own claim shapes. Every outbound call goes through
// the stubbed global fetch; the fake answers only the URLs the recorded documents name, so a
// request anywhere else is visible in `calls` and answered 599.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import { seal } from "../src/platform/keyvault.js";
import {
  SIGNIN_SECRET_IDS,
  signInSecretContext,
  type SignInProviderKind,
} from "../src/services/identity/providers/config.js";
import { resetProviderCaches } from "../src/services/identity/providers/discovery.js";
import { handlePortal } from "../src/services/identity/portal/index.js";
import { SIGNIN_BIND_COOKIE } from "../src/services/identity/providers/flow.js";
import { EMAIL_GATE_COOKIE } from "../src/core/accounts/accountCookies.js";
import { SETTINGS } from "../src/mount.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORIGIN = "https://key.plrs.im";

export function fixture(name: string): string {
  return readFileSync(join(HERE, "fixtures", "signin", name), "utf8");
}

export const GOOGLE_CLIENT_ID = "1234567890-polaris.apps.googleusercontent.com";
export const APPLE_SERVICES_ID = "im.plrs.key.signin";
export const APPLE_TEAM_ID = "ABCDE12345";
export const APPLE_KEY_ID = "KEYID12345";
export const STEAM_KEY = "0123456789ABCDEF0123456789ABCDEF";

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface Call {
  url: string;
  method: string;
  body: string;
}

export interface ProviderHarness {
  env: Env;
  db: SqliteDb;
  calls: Call[];
  /** Override a URL's answer (exact URL, or origin+path for query URLs). */
  routes: Map<string, () => Response | Promise<Response>>;
  /** The ID token the next token-endpoint call returns, per provider. */
  idToken: { google?: string; apple?: string };
  signGoogle(claims: Record<string, unknown>): Promise<string>;
  signApple(claims: Record<string, unknown>): Promise<string>;
  applePublicKey: CryptoKey;
  /** GET/POST a portal path the way the composition root does. */
  request(
    path: string,
    init?: RequestInit & { cookie?: string | null },
  ): Promise<Response>;
  /** Start `kind`, returning the provider URL, the state and the binding cookie. */
  start(
    kind: SignInProviderKind,
    returnTo?: string,
  ): Promise<{ location: URL; state: string; cookie: string }>;
}

export function cookieFrom(res: Response, name: string): string | null {
  const all = (
    res.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  for (const c of all) {
    const first = c.split(";")[0] ?? "";
    const [n, ...v] = first.split("=");
    if (n === name) return `${n}=${v.join("=")}`;
  }
  return null;
}

export function setCookies(res: Response): string[] {
  return (
    (
      res.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]
  );
}

export async function makeProviderHarness(
  opts: { configure?: SignInProviderKind[] } = {},
): Promise<ProviderHarness> {
  resetProviderCaches();
  const db = makeTestDb();
  // The portal answers while at least one product has it on (the default).
  await seedProduct(db, "djdl");
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";

  const idpKeys = await generateKeyPair("RS256");
  const jwks = {
    keys: [
      {
        ...(await exportJWK(idpKeys.publicKey)),
        alg: "RS256",
        kid: "idp-1",
        use: "sig",
      },
    ],
  };
  const appleKeys = await generateKeyPair("ES256", { extractable: true });
  const p8 = await exportPKCS8(appleKeys.privateKey);

  const configure = opts.configure ?? ["google", "apple", "steam"];
  const sealFor = (kind: SignInProviderKind, v: string) =>
    seal(env, v, signInSecretContext(SIGNIN_SECRET_IDS[kind]));
  if (configure.includes("google")) {
    env.SIGNIN_GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
    env.SIGNIN_GOOGLE_CLIENT_SECRET = await sealFor("google", "google-secret");
  }
  if (configure.includes("apple")) {
    env.SIGNIN_APPLE_SERVICES_ID = APPLE_SERVICES_ID;
    env.SIGNIN_APPLE_TEAM_ID = APPLE_TEAM_ID;
    env.SIGNIN_APPLE_KEY_ID = APPLE_KEY_ID;
    env.SIGNIN_APPLE_PRIVATE_KEY = await sealFor("apple", p8);
  }
  if (configure.includes("steam")) {
    env.SIGNIN_STEAM_WEB_API_KEY = await sealFor("steam", STEAM_KEY);
  }

  const calls: Call[] = [];
  const idToken: ProviderHarness["idToken"] = {};
  const jsonRes = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  const routes = new Map<string, () => Response | Promise<Response>>([
    [
      "https://accounts.google.com/.well-known/openid-configuration",
      () => new Response(fixture("google-openid-configuration.json")),
    ],
    ["https://www.googleapis.com/oauth2/v3/certs", () => jsonRes(jwks)],
    [
      "https://oauth2.googleapis.com/token",
      () =>
        jsonRes({
          access_token: "ya29.dropped",
          expires_in: 3599,
          token_type: "Bearer",
          scope: "openid email profile",
          id_token: idToken.google,
        }),
    ],
    [
      "https://appleid.apple.com/.well-known/openid-configuration",
      () => new Response(fixture("apple-openid-configuration.json")),
    ],
    ["https://appleid.apple.com/auth/keys", () => jsonRes(jwks)],
    [
      "https://appleid.apple.com/auth/token",
      () =>
        jsonRes({
          access_token: "apple.dropped",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "apple.refresh.dropped",
          id_token: idToken.apple,
        }),
    ],
    [
      "https://steamcommunity.com/openid/login",
      () => new Response(fixture("steam-check-authentication.txt")),
    ],
    [
      "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/",
      () => new Response(fixture("steam-player-summaries.json")),
    ],
  ]);

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const body =
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : "";
      calls.push({ url, method: init?.method ?? "GET", body });
      const u = new URL(url);
      const route = routes.get(url) ?? routes.get(`${u.origin}${u.pathname}`);
      return route ? route() : new Response("unexpected", { status: 599 });
    },
  );

  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "idp-1" })
      .sign(idpKeys.privateKey);

  const harness: ProviderHarness = {
    env,
    db,
    calls,
    routes,
    idToken,
    applePublicKey: appleKeys.publicKey as CryptoKey,
    signGoogle: sign,
    signApple: sign,
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.cookie) headers.set("cookie", init.cookie);
      const req = new Request(`${ORIGIN}${path}`, { ...init, headers });
      const pathname = new URL(req.url).pathname;
      return handlePortal(req, env, db, pathname, {
        now: nowSec(),
        settings: SETTINGS,
      });
    },
    async start(kind, returnTo) {
      const qs = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";
      const res = await harness.request(`/login/${kind}${qs}`);
      if (res.status !== 302) {
        throw new Error(`start ${kind} answered ${res.status}`);
      }
      const location = new URL(res.headers.get("location")!);
      const cookie = cookieFrom(res, SIGNIN_BIND_COOKIE);
      if (!cookie) throw new Error("no binding cookie");
      const state =
        kind === "steam"
          ? new URL(
              location.searchParams.get("openid.return_to")!,
            ).searchParams.get("state")!
          : location.searchParams.get("state")!;
      return { location, state, cookie };
    },
  };
  return harness;
}

export function googleClaims(
  nonce: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const t = nowSec();
  return {
    iss: "https://accounts.google.com",
    azp: GOOGLE_CLIENT_ID,
    aud: GOOGLE_CLIENT_ID,
    sub: "110169484474386276334",
    email: "Ada@Example.com",
    email_verified: true,
    at_hash: "HK6E_P6Dh8Y93mRNtsDB1Q",
    nonce,
    name: "Ada Lovelace",
    picture: "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c",
    given_name: "Ada",
    family_name: "Lovelace",
    iat: t,
    exp: t + 3600,
    ...over,
  };
}

export function appleClaims(
  nonce: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const t = nowSec();
  return {
    iss: "https://appleid.apple.com",
    aud: APPLE_SERVICES_ID,
    exp: t + 600,
    iat: t,
    sub: "001234.0a1b2c3d4e5f60718293a4b5c6d7e8f9.1234",
    nonce,
    c_hash: "x2b5vZkNJ0wbcLMr4vT3dg",
    email: "q7x9k2@privaterelay.appleid.com",
    email_verified: "true",
    is_private_email: "true",
    auth_time: t,
    nonce_supported: true,
    ...over,
  };
}

/** The nonce the flow recorded, read back from the provider URL. */
export function nonceOf(location: URL): string {
  return location.searchParams.get("nonce")!;
}

/**
 * I-07's email gate, as the card drives it: a first provider sign-in opens the gate (no account,
 * no session) and redirects to the card. `gateView` reads the step the card renders; `passGate`
 * answers it (by default: confirm the provider's own email, which needs no code when the
 * provider verified it).
 */
export async function gateView(
  h: ProviderHarness,
  callback: Response,
): Promise<{
  provider: string;
  email: {
    provider: string | null;
    providerVerified: boolean;
    relay: boolean;
  };
  profile: { name: string | null; picture: string | null };
}> {
  const gate = cookieFrom(callback, EMAIL_GATE_COOKIE);
  if (!gate) throw new Error("the callback opened no email gate");
  const res = await h.request("/api/signin/confirm-email", { cookie: gate });
  if (res.status !== 200) throw new Error(`gate view answered ${res.status}`);
  return res.json();
}

export async function passGate(
  h: ProviderHarness,
  callback: Response,
  body: Record<string, unknown> = { choice: "provider" },
): Promise<Response> {
  const gate = cookieFrom(callback, EMAIL_GATE_COOKIE);
  if (!gate) throw new Error("the callback opened no email gate");
  return h.request("/api/signin/confirm-email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
    cookie: gate,
  });
}
