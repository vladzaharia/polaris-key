/**
 * The login card's Worker half (I-07): the pre-authentication routes under `/api/signin/`, the
 * magic-link landing page, the email gate, profile import and copied avatars. The card's UI is the
 * portal SPA's (PX-12, PX-21); every route here is a root portal route on key.plrs.im, documented
 * on the docs site's portal page (`services/identity/portal.md`, rule 10 for portal routes).
 *
 *   POST /api/signin/email/start           identifier-first email start: a code and a link
 *   POST /api/signin/email/verify          redeem the code for this browser's flow
 *   POST /api/signin/flow                  the asking browser's poll after a link elsewhere
 *   GET  /api/signin/confirm-email         the email gate's state
 *   POST /api/signin/confirm-email         confirm the provider's email or a typed one (+ terms)
 *   POST /api/signin/confirm-email/verify  the code for a typed or unverified address
 *   POST /api/signin/confirm-email/join    take the join offer (proof of both)
 *   POST /api/signin/confirm-email/cancel  abandon the sign-in
 *   GET  /api/signin/confirm-email/picture the provider's picture, proxied for the gate
 */

import type { Db, Env } from "../../../core/platform.js";
import {
  handleSigninEmailStart,
  handleSigninEmailVerify,
  handleSigninFlowPoll,
} from "./emailSignIn.js";
import { handleEmailGate } from "./gate.js";
import { cardJson } from "./http.js";

export {
  handleMagicConfirm,
  handleMagicLanding,
  handleSigninEmailStart,
} from "./emailSignIn.js";
export { beginProviderSignIn, type ProviderSignIn } from "./gate.js";
export {
  avatarUrl,
  deleteAccountAvatars,
  serveAvatar,
  AVATAR_KEY_PATTERN,
} from "./avatars.js";
export { markNudgeShown, nudgeDue } from "./finish.js";
export { turnstileSiteKey } from "./turnstile.js";

/** `/api/signin/…`, with `segments` the path after `/api`. */
export async function handleCardApi(
  req: Request,
  env: Env,
  db: Db,
  segments: string[],
  now: number,
): Promise<Response> {
  const [, first, ...rest] = segments;
  if (first === "email" && rest.length === 1 && rest[0] === "start")
    return handleSigninEmailStart(req, env, db, now);
  if (first === "email" && rest.length === 1 && rest[0] === "verify")
    return handleSigninEmailVerify(req, env, db, now);
  if (first === "flow" && rest.length === 0)
    return handleSigninFlowPoll(req, env, db, now);
  if (first === "confirm-email")
    return handleEmailGate(req, env, db, rest, now);
  return cardJson({ error: "not_found" }, 404);
}
