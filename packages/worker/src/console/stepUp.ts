/**
 * Why each step-up route needs one, and the gate that reads it. A route that is irreversible,
 * exports personal data, forces a key change or leaves a long-lived credential behind is listed
 * here. Since ST-29 the route table (`./routes.ts`, `stepUp: true`) is what the dispatcher
 * enforces, before the handler runs. The rows whose step-up depends on the request body (a
 * break-glass key activation; an alert destination PATCH, marked `(body)`) keep their own `requireStepUp` in the handler, and `(a|b)` spells two
 * table rows. `test/rbacRouteMatrix.test.ts` keeps this list and the table's step-up rows in step.
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
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path under `/manage/api`, with `:slug`, `:subject`, `:id` placeholders. */
  path: string;
  /** Why it is gated. */
  why: string;
}

export const STEP_UP_ROUTES: readonly StepUpRoute[] = [
  {
    method: "POST",
    path: "/platform/alerts",
    why: "aims the platform's alerts at a new address or URL",
  },
  {
    method: "DELETE",
    path: "/platform/alerts/:id",
    why: "removes an alert destination, which can silence alerts",
  },
  {
    method: "DELETE",
    path: "/products/:slug/alerts/:id",
    why: "removes an alert destination, which can silence alerts",
  },
  {
    method: "PATCH",
    path: "/platform/alerts/:id (body)",
    why: "retargets, re-secrets, narrows or turns off an alert destination (only turning one on skips it)",
  },
  {
    method: "POST",
    path: "/products/:slug/alerts",
    why: "aims a product's alerts at a new address or URL",
  },
  {
    method: "PATCH",
    path: "/products/:slug/alerts/:id (body)",
    why: "retargets, re-secrets, narrows or turns off an alert destination (only turning one on skips it)",
  },
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
    method: "PATCH",
    path: "/products/:slug/settings/:key (body)",
    why: "relaxes a control the key's adapter names: the device trust policy with fewer attested operations, log-only, or another App Attest or Play Integrity anchor",
  },
  {
    method: "DELETE",
    path: "/products/:slug/settings/:key (body)",
    why: "resets a non-default device trust policy, which relaxes it",
  },
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
    path: "/platform/migrations/apply",
    why: "changes stored data through a data-migration job",
  },
  {
    method: "POST",
    path: "/platform/migrations/down",
    why: "undoes a data-migration job's changes",
  },
  {
    method: "POST",
    path: "/products/:slug/config/mint/:id/approve",
    why: "lets the product's signing key mint tokens for its devices",
  },
  {
    method: "POST",
    path: "/platform/connections",
    why: "adds a sign-in provider and seals its secret",
  },
  {
    method: "PATCH",
    path: "/platform/connections/:id",
    why: "changes a sign-in provider, its secret or its on/off state",
  },
  {
    method: "DELETE",
    path: "/platform/connections/:id",
    why: "deletes a sign-in provider",
  },
  {
    method: "POST",
    path: "/platform/connections/:id/domains",
    why: "claims an email domain for a sign-in provider",
  },
  {
    method: "POST",
    path: "/platform/connections/:id/domains/verify",
    why: "lets a provider vouch for a domain's addresses",
  },
  {
    method: "PATCH",
    path: "/platform/connections/:id/domains/:domain",
    why: "requires a provider for every address on a domain",
  },
  {
    method: "DELETE",
    path: "/platform/connections/:id/domains/:domain",
    why: "releases a domain from a provider",
  },
  {
    method: "POST",
    path: "/tokens",
    why: "mints an admin API credential that outlives the session",
  },
  {
    method: "PUT",
    path: "/products/:slug/ci-publisher",
    why: "claims or edits the trusted publisher, which decides who may publish",
  },
  {
    method: "POST",
    path: "/products/:slug/ci-tokens",
    why: "issues a static CI token that outlives the session",
  },
  {
    method: "POST",
    path: "/products/:slug/distribution/feeds/tokens (body)",
    why: "mints a registry credential: a service token, a publish token or a license-bound token (every binding)",
  },
  {
    method: "POST",
    path: "/platform/feeds/tokens (body)",
    why: "mints a registry credential on the platform's feeds",
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
