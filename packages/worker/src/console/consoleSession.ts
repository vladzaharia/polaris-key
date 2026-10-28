/**
 * The console's live check for a v2 cookie (ST-30 slice 2a): resolve `aid` + `sid` to who the
 * session is today (`consoleSubject`, Identity), at most once per `LIVE_CHECK_SECONDS` per session
 * per isolate. A revoked session, a disabled, merged or deleted account, or a sign-out therefore
 * ends access within that window; the cookie's 8 h expiry is the outer bound only for an outage
 * that makes the read fail (which refuses, never grants).
 *
 * The answer, positive or negative, is remembered for the window. A read that THROWS (database
 * down) is not remembered and not swallowed: the request fails, and the next one asks again.
 */

import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import {
  consoleSubject,
  endConsoleSession,
} from "../services/identity/public.js";
import { isAdminSessionRevoked } from "../core/console/sessionRevocation.js";
import {
  LIVE_CHECK_SECONDS,
  type ConsoleCookieClaims,
  type LiveSubject,
  type ResolvedConsoleSubject,
} from "../core/console/session.js";

const CACHE_LIMIT = 500;

interface Entry {
  at: number;
  subject: ResolvedConsoleSubject | null;
}
const cache = new Map<string, Entry>();

const keyOf = (c: { aid: string; sid: string }): string => `${c.sid}|${c.aid}`;

/** Test hook (and sign-out): forget what was checked. */
export function resetConsoleSessionCache(): void {
  cache.clear();
}

/** The `LiveSubject` for one request: cached `consoleSubject`, then the sign-out mark. */
export function liveSubjectFor(env: Env, db: Db, now: number): LiveSubject {
  return async (claims: ConsoleCookieClaims) => {
    const key = keyOf(claims);
    const hit = cache.get(key);
    if (hit && now >= hit.at && now - hit.at < LIVE_CHECK_SECONDS)
      return hit.subject;
    let subject = await consoleSubject(
      env,
      db,
      { aid: claims.aid, sid: claims.sid },
      now,
    );
    // "Sign out" also writes the operator's mark (sessionRevocation.ts): it ends every cookie that
    // operator holds.
    if (
      subject &&
      (await isAdminSessionRevoked(env, { sub: subject.sub, exp: claims.exp }))
    )
      subject = null;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, { at: now, subject });
    return subject;
  };
}

/** End a v2 session now: its row, and what this isolate remembered of it. */
export async function endConsoleCookieSession(
  env: Env,
  db: Db,
  claims: { aid?: string; sid?: string },
  now: number,
): Promise<void> {
  if (!claims.sid || !claims.aid) return;
  cache.delete(keyOf({ aid: claims.aid, sid: claims.sid }));
  await endConsoleSession(env, db, claims.sid, now);
}
