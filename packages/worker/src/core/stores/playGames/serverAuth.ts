/**
 * Play Games server-side sign-in (I-14.4, WIRE-CONTRACT-V5 §12.11.7): redeem the one-time server
 * auth code a device obtained for the product's Web client, then ask Google which player and
 * application it was granted to.
 *
 *     POST https://oauth2.googleapis.com/token       grant_type=authorization_code, code,
 *                                                    client_id, client_secret, redirect_uri=""
 *     GET  https://games.googleapis.com/games/v1/applications/<applicationId>/verify
 *
 * **The secret.** The Web client's secret is the product's `pgs-server-client` outlet credential,
 * pinned to the server client id. This file is the only code that opens that kind, and only to
 * send the secret to `oauth2.googleapis.com`. It is never logged, audited, returned or put in an
 * error: every outcome is a reason code.
 *
 * **Cache (D-9).** An opened secret is held in this isolate for at most 10 minutes, keyed by the
 * credential's non-secret version marker. A hit costs no open and no `outlet_credential.use`
 * audit row; a rotation changes the marker and so misses.
 *
 * **Gated hosts.** Every URL passes the core relying-party client's gate (https, no credentials,
 * default port, no reserved address) and must be on `PGS_HOSTS`. Redirects are never followed.
 *
 * **The access token is discarded.** It is used for the verify call only: never stored, logged,
 * audited or revoked. A refresh token is dropped and an ID token is never read.
 *
 * **Verify refused for scope (403).** When `applications.verify` answers 403, the player is read
 * from `players/me` with the same token instead. That call names no application, so it does not
 * show the grant was made to this application; the redemption, which only succeeds for this
 * product's own client id and secret, remains the binding.
 *
 * Core imports no service: the Identity provider (I-14.7) calls this and maps the result.
 */

import { GOOGLE_CLIENT_ID_RE } from "@polaris-key/manifest";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { gatedFetch, type OidcFetch } from "../../oidc/client.js";
import {
  listOutletCredentials,
  openOutletCredential,
  outletCredentialPin,
  outletCredentialVersion,
} from "../../outletCredentials.js";

/** The only hosts a Play Games call may reach. */
export const PGS_HOSTS: readonly string[] = [
  "oauth2.googleapis.com",
  "games.googleapis.com",
];

export const PGS_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GAMES_API = "https://games.googleapis.com/games/v1";

/** The longest an opened secret is kept in an isolate (D-9), in seconds. */
export const PGS_SECRET_CACHE_SECONDS = 600;
/** The most secrets held at once; the oldest goes first. */
const CACHE_MAX = 64;
/** The `use` its audit rows carry. */
const USE = "pgs:redeem";

const CODE_RE = /^[\x21-\x7e]{1,512}$/;
const APPLICATION_ID_RE = /^[0-9]{1,40}$/;
const PLAYER_ID_RE = /^[\x21-\x7e]{1,128}$/;

export type PgsRefusal =
  | "no_credential"
  | "bad_request"
  | "redeem_refused"
  | "redeem_malformed"
  | "verify_refused"
  | "verify_malformed";

export type PgsResult =
  | { ok: true; playerId: string; alternatePlayerId: string | null }
  /** The code or the setup is refused: the exchange answers `invalid_grant`. */
  | { ok: false; reason: "invalid_grant"; detail: PgsRefusal }
  /** Google was unreachable or failed: the exchange answers `503 unavailable`. */
  | { ok: false; reason: "unavailable"; detail: "network" | "server" };

const refused = (detail: PgsRefusal): PgsResult => ({
  ok: false,
  reason: "invalid_grant",
  detail,
});
const unavailable = (detail: "network" | "server"): PgsResult => ({
  ok: false,
  reason: "unavailable",
  detail,
});

// ── the credential ───────────────────────────────────────────────────────────────────────────

/** The active `pgs-server-client` credential of `product` pinned to `serverClientId`, or null.
 *  Reads metadata only; nothing is opened or audited. */
async function findCredentialId(
  db: Db,
  product: string,
  serverClientId: string,
): Promise<string | null> {
  if (!GOOGLE_CLIENT_ID_RE.test(serverClientId)) return null;
  for (const c of await listOutletCredentials(db, product)) {
    if (
      c.kind === "pgs-server-client" &&
      c.status === "active" &&
      outletCredentialPin(c) === serverClientId
    )
      return c.id;
  }
  return null;
}

/** Whether `product` holds a usable server credential pinned to `serverClientId`. Never opens it,
 *  so discovery can call it without an audit row. */
export async function pgsServerCredentialReady(
  db: Db,
  product: string,
  serverClientId: string,
): Promise<boolean> {
  const id = await findCredentialId(db, product, serverClientId);
  return (
    id !== null &&
    (await outletCredentialVersion(db, product, id, "pgs-server-client")) !==
      null
  );
}

// ── the isolate cache (D-9) ──────────────────────────────────────────────────────────────────

const secretCache = new Map<string, { secret: string; until: number }>();

/** Empty the isolate cache (tests; a rotation needs no call, its version changes). */
export function resetPgsSecretCache(): void {
  secretCache.clear();
}

async function clientSecret(
  env: Env,
  db: Db,
  product: string,
  credentialId: string,
  now: number,
): Promise<string | null> {
  const version = await outletCredentialVersion(
    db,
    product,
    credentialId,
    "pgs-server-client",
  );
  if (version === null) return null;
  const key = `${product}\n${credentialId}\n${version}`;
  const hit = secretCache.get(key);
  if (hit && hit.until > now) return hit.secret;
  secretCache.delete(key);
  const cred = await openOutletCredential(env, db, product, credentialId, USE, {
    kind: "pgs-server-client",
    now,
  });
  if (!cred) return null;
  // Keyed by the version of the blob that was opened, which may be newer than the one read above.
  const openedKey = `${product}\n${credentialId}\n${cred.version}`;
  while (secretCache.size >= CACHE_MAX) {
    const oldest = secretCache.keys().next().value;
    if (oldest === undefined) break;
    secretCache.delete(oldest);
  }
  secretCache.set(openedKey, {
    secret: cred.value.clientSecret,
    until: now + PGS_SECRET_CACHE_SECONDS,
  });
  return cred.value.clientSecret;
}

// ── the calls ────────────────────────────────────────────────────────────────────────────────

class Unreachable extends Error {}

async function call(
  url: string,
  init: RequestInit,
  fetchImpl: OidcFetch | undefined,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let r: { status: number; body: string };
  try {
    r = await gatedFetch("pgs", url, init, PGS_HOSTS, fetchImpl);
  } catch {
    throw new Unreachable();
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(r.body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

const serverFault = (status: number) => status >= 500 || status === 429;

export interface RedeemAndVerifyInput {
  product: string;
  /** `identity.platformSignIn.playGames.applicationId`: digits. */
  applicationId: string;
  /** `identity.platformSignIn.playGames.serverClientId`: the Web client the code was issued to. */
  serverClientId: string;
  /** The server auth code, exactly as the device returned it. */
  code: string;
  /** Unix seconds. */
  now?: number;
  fetchImpl?: OidcFetch;
}

/**
 * Redeem `code` and verify it for the application (see the header). Does not throw on any Google answer, and the result
 * carries no secret, token or response body.
 */
export async function redeemAndVerify(
  env: Env,
  db: Db,
  input: RedeemAndVerifyInput,
): Promise<PgsResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const { product, applicationId, serverClientId, code, fetchImpl } = input;
  if (
    !CODE_RE.test(code) ||
    !APPLICATION_ID_RE.test(applicationId) ||
    !GOOGLE_CLIENT_ID_RE.test(serverClientId)
  )
    return refused("bad_request");

  const credentialId = await findCredentialId(db, product, serverClientId);
  if (credentialId === null) return refused("no_credential");
  const secret = await clientSecret(env, db, product, credentialId, now);
  if (secret === null) return refused("no_credential");

  try {
    // 1. Redeem. No redirect URI: a server auth code is bound to the client, not to a redirect.
    const redeemed = await call(
      PGS_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: serverClientId,
          client_secret: secret,
          redirect_uri: "",
        }).toString(),
      },
      fetchImpl,
    );
    if (serverFault(redeemed.status)) return unavailable("server");
    if (redeemed.status < 200 || redeemed.status >= 300)
      return refused("redeem_refused");
    const access = redeemed.body?.access_token;
    const type = redeemed.body?.token_type;
    if (
      typeof access !== "string" ||
      access.length === 0 ||
      typeof type !== "string" ||
      type.toLowerCase() !== "bearer"
    )
      return refused("redeem_malformed");
    const headers = {
      authorization: `Bearer ${access}`,
      accept: "application/json",
    };

    // 2. Verify the application; a 403 falls back to the player behind the token.
    let verified = await call(
      `${GAMES_API}/applications/${applicationId}/verify`,
      { method: "GET", headers },
      fetchImpl,
    );
    let playerKey = "player_id";
    let alternateKey: string | null = "alternate_player_id";
    let kind = "games#applicationVerifyResponse";
    if (verified.status === 403) {
      verified = await call(
        `${GAMES_API}/players/me`,
        { method: "GET", headers },
        fetchImpl,
      );
      playerKey = "playerId";
      alternateKey = null;
      kind = "games#player";
    }
    if (serverFault(verified.status)) return unavailable("server");
    if (verified.status !== 200) return refused("verify_refused");
    const body = verified.body;
    const player = body?.[playerKey];
    if (
      !body ||
      body.kind !== kind ||
      typeof player !== "string" ||
      !PLAYER_ID_RE.test(player)
    )
      return refused("verify_malformed");
    const alt = alternateKey ? body[alternateKey] : undefined;
    return {
      ok: true,
      playerId: player,
      alternatePlayerId:
        typeof alt === "string" && PLAYER_ID_RE.test(alt) && alt !== player
          ? alt
          : null,
    };
  } catch (e) {
    if (e instanceof Unreachable) return unavailable("network");
    throw e;
  }
}
