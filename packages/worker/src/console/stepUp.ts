/**
 * The one table of admin routes that need a fresh step-up, and the gate
 * that reads it. A route that is irreversible, exports personal data, or forces a key change
 * is listed here and calls `requireStepUp`; `test/adminStepUp.test.ts` walks this table so a
 * listed route cannot lose its gate and an unlisted one is visibly a decision.
 *
 * A step-up is `session.stepUpAt` (see ./session.ts): set only by a `prompt=login` flow the IdP
 * proved with `auth_time`, never by an ordinary sign-in.
 */

import {
  STEP_UP_MAX_AGE_SECONDS,
  isSteppedUp,
} from "../core/console/session.js";
import type { AdminSession } from "../core/console/session.js";
import { err } from "../core/console/respond.js";

export interface StepUpRoute {
  method: "GET" | "POST" | "DELETE";
  /** Path under `/manage/api`, with `:slug`, `:subject`, `:id` placeholders. */
  path: string;
  /** Why it is gated. */
  why: string;
}

export const STEP_UP_ROUTES: readonly StepUpRoute[] = [
  {
    method: "GET",
    path: "/products/:slug/users/:subject/export",
    why: "exports personal data",
  },
  {
    method: "POST",
    path: "/products/:slug/users/:subject/data/delete",
    why: "erases a user's data",
  },
  {
    method: "POST",
    path: "/products/:slug/users/:subject/licenses/:id/detach",
    why: "detaches a licence from its holder",
  },
  { method: "DELETE", path: "/products/:slug", why: "deletes a product" },
  {
    method: "POST",
    path: "/products/:slug/keys/activate (breakGlass)",
    why: "forces a signing key live, skipping the trust-cache window",
  },
  { method: "POST", path: "/products/kek", why: "re-seals stored secrets" },
  {
    method: "POST",
    path: "/products/:slug/users/:subject/licenses/:id/relink",
    why: "moves a licence to another account",
  },
  {
    method: "POST",
    path: "/products/:slug/users/relinks/:id/undo",
    why: "undoes a licence move",
  },
  {
    method: "POST",
    path: "/products/:slug/users/licenses/:id/(make-floating|reassign)",
    why: "changes who holds a licence",
  },
];

/** A 403 `step_up_required` when the session has no recent proven re-authentication, else null. */
export function requireStepUp(
  session: AdminSession,
  now: number,
): Response | null {
  if (isSteppedUp(session, now)) return null;
  return err(
    403,
    "step_up_required",
    "Sign in again to confirm it's you. This needs a sign-in from the last 5 minutes.",
    { maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS },
  );
}
