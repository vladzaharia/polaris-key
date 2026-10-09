/**
 * Server-side revocation for the stateless admin cookie.
 *
 * The cookie stays an HMAC token (no per-request lookup of a session row), but sign-out now
 * writes a per-operator "revoked at" mark into the single-use store, and a session minted at or
 * before that mark is refused. Sign-out therefore ends every cookie that operator holds, not just
 * the browser that clicked it, and a replayed cookie after logout is a 401. The mark lives as
 * long as a session could (the session TTL), after which every older cookie has expired anyway.
 *
 * Failure policy follows the store's: a read that cannot reach it answers "not revoked" (the
 * 8 h expiry still bounds the cookie); a write that cannot reach it throws, and logout reports it.
 */

import type { Env } from "../env.js";
import { hashKey } from "../crypto.js";
import {
  artefactRef,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../core/singleUse.js";
import { ADMIN_SESSION_TTL_SECONDS, type AdminSession } from "./session.js";

async function revocationRef(env: Env, sub: string): Promise<ArtefactRef> {
  return artefactRef("admin-revoked", await hashKey(sub, env.KEY_HASH_PEPPER));
}

/** Refuse every session of `sub` minted at or before `now`. Throws if the store is unreachable. */
export async function revokeAdminSessions(
  env: Env,
  sub: string,
  now: number,
): Promise<void> {
  await putArtefact(
    env,
    await revocationRef(env, sub),
    String(now),
    ADMIN_SESSION_TTL_SECONDS,
  );
}

/** True when `session` was minted at or before its operator's revocation mark. */
export async function isAdminSessionRevoked(
  env: Env,
  session: AdminSession,
): Promise<boolean> {
  const raw = await getArtefact(env, await revocationRef(env, session.sub));
  if (raw === null) return false;
  const mark = Number(raw);
  if (!Number.isFinite(mark)) return true;
  // Every session is issued with the same TTL, so its mint time is exact (as the portal's).
  const iat = session.exp - ADMIN_SESSION_TTL_SECONDS;
  return iat <= mark;
}
