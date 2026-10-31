/**
 * What a subject token is, and who it names (I-14.8; WIRE-CONTRACT-V5 §12.11.3 and §12.11.7).
 *
 * The exchange and the link offer both take a platform token and need the same things: which token
 * types this build serves (the two game types only while `launch.gameSignIn` is on) and the
 * verified identity behind a token of that type. Keeping them in one place keeps the two routes on
 * the same rules.
 *
 * A verifier's message is never carried out of here: a refusal is an `OidcVerifyError` and an
 * unreachable host an `OidcNetworkError`, and the callers answer them with the one refusal body
 * and `503 unavailable`.
 */

import {
  EXCHANGE_SUBJECT_TOKEN_TYPE,
  GAME_CENTER_SUBJECT_TOKEN_TYPE,
  PGS_SUBJECT_TOKEN_TYPE,
  type ExchangeKind,
} from "@polaris-key/protocol/identity";
import {
  OidcNetworkError,
  OidcVerifyError,
} from "../../../core/oidc/client.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { pgsServerCredentialReady } from "../../../core/stores/playGames/serverAuth.js";
import { launchGateOn } from "../../../core/settings/platformRead.js";
import type { PlatformSignInAudiences } from "../platformSignIn.js";
import { verifyGameCenterToken } from "../providers/gameCenter.js";
import { verifyNativeToken } from "../providers/native.js";
import { PGS_ISSUER_KEY, verifyPlayGamesCode } from "../providers/playGames.js";

/** The subject token types the grant knows, whichever are on. */
export type SubjectTokenType =
  | typeof EXCHANGE_SUBJECT_TOKEN_TYPE
  | typeof GAME_CENTER_SUBJECT_TOKEN_TYPE
  | typeof PGS_SUBJECT_TOKEN_TYPE;

/**
 * The type a request names, or `null` when this build does not serve it: an unknown type, or a
 * game type while the gate is off. The two answer alike (`400 invalid_request`).
 */
export async function servedTokenType(
  env: Env,
  db: Db,
  raw: string | null | undefined,
): Promise<SubjectTokenType | null> {
  if (raw === EXCHANGE_SUBJECT_TOKEN_TYPE) return raw;
  if (raw === GAME_CENTER_SUBJECT_TOKEN_TYPE || raw === PGS_SUBJECT_TOKEN_TYPE)
    return (await launchGateOn(env, db, "launch.gameSignIn")) ? raw : null;
  return null;
}

/** A verified token, whichever provider it came from. */
export interface SubjectIdentity {
  kind: ExchangeKind;
  issuerKey: string;
  subject: string;
  /** Play Games only: an id the player once had, tried after `subject` finds no link. */
  alternateSubject?: string | null;
  tenantScopes: string[];
  email: string | null;
  emailVerified: boolean;
}

/** Verify `token` as `type`. Throws `OidcVerifyError` (refused) or `OidcNetworkError` (host). */
export async function verifySubjectToken(
  type: SubjectTokenType,
  token: string,
  nonce: string,
  ctx: {
    env: Env;
    db: Db;
    product: string;
    audiences: PlatformSignInAudiences;
  },
): Promise<SubjectIdentity> {
  const { env, db, product, audiences } = ctx;
  if (type === EXCHANGE_SUBJECT_TOKEN_TYPE)
    return verifyNativeToken(
      token,
      nonce,
      audiences,
      env as unknown as Readonly<Record<string, unknown>>,
    );
  if (type === GAME_CENTER_SUBJECT_TOKEN_TYPE) {
    const g = await verifyGameCenterToken(token, env, product, audiences);
    return {
      kind: "gamecenter",
      issuerKey: "gamecenter",
      subject: g.subject,
      tenantScopes: [g.scope],
      email: null,
      emailVerified: false,
    };
  }
  const r = await verifyPlayGamesCode(env, db, product, audiences, token);
  if (!r.ok) {
    if (r.reason === "unavailable")
      throw new OidcNetworkError("play games unavailable");
    throw new OidcVerifyError("play games refused");
  }
  const id = r.identity;
  return {
    kind: "pgs",
    issuerKey: PGS_ISSUER_KEY,
    subject: id.subject,
    alternateSubject: id.alternateSubject,
    tenantScopes: id.tenantScopes,
    email: null,
    emailVerified: false,
  };
}

/**
 * The game kinds a product serves (discovery and the link offer): none while the gate is off.
 * Game Center needs it switched on with a team and a bundle id; Play Games needs its application
 * and server client id and a usable server credential (never opened here).
 */
export async function gameKindsOn(
  env: Env,
  db: Db,
  product: string,
  audiences: PlatformSignInAudiences,
): Promise<Array<"gamecenter" | "pgs">> {
  if (!(await launchGateOn(env, db, "launch.gameSignIn"))) return [];
  const out: Array<"gamecenter" | "pgs"> = [];
  if (
    audiences.gameCenter &&
    audiences.apple.teamId &&
    audiences.apple.bundleIds.length > 0
  )
    out.push("gamecenter");
  const { applicationId, serverClientId } = audiences.playGames;
  if (
    applicationId &&
    serverClientId &&
    (await pgsServerCredentialReady(db, product, serverClientId))
  )
    out.push("pgs");
  return out;
}
