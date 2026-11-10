/**
 * When a registered client's request needs a FRESH sign-in (V5 §12.13.3 rule 2; I-21.8): a
 * `prompt=login`, `max_age=0`, or a session whose last sign-in is older than `max_age`. A sign-in
 * made after the request was created counts as fresh (its session is newer than the request), and
 * `auth_time` is then that sign-in's time. The session's own sign-in time is signed in its cookie
 * (`portalSessionAuthenticatedAt`), so a person cannot pass it a value.
 */

import { REQUEST_HANDLE_TTL_SECONDS } from "@polaris-key/protocol/identity";
import type { RegisteredAuthz } from "../passthrough/request.js";

/** The epoch second the request was made, from its record's expiry. */
export function requestCreatedAt(expiresAt: number): number {
  return expiresAt - REQUEST_HANDLE_TTL_SECONDS;
}

/** Must the person sign in again before this request may continue? */
export function needsFreshSignIn(
  reg: Pick<RegisteredAuthz, "prompt" | "maxAge">,
  authTime: number,
  now: number,
  createdAt: number,
): boolean {
  if (authTime >= createdAt) return false;
  if (reg.prompt.login || reg.maxAge === 0) return true;
  return reg.maxAge !== null && now - authTime > reg.maxAge;
}
