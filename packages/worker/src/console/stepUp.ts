/**
 * Why each step-up route needs one, and the gate that reads it. A route that is irreversible,
 * exports personal data, or forces a key change is listed here. Since ST-29 the route table
 * (`./routes.ts`, `stepUp: true`) is what the dispatcher enforces, before the handler runs. The
 * one row whose step-up depends on the request body (a break-glass key activation) keeps its own
 * `requireStepUp` in the handler, and `(a|b)` spells two table rows. `test/rbacRouteMatrix.test.ts`
 * keeps this list and the table's step-up rows in step.
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
  {
    method: "POST",
    path: "/platform/override-migration/run",
    why: "rewrites every product's licence overrides",
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
