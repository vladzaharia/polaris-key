/// <reference types="@cloudflare/workers-types" />

/**
 * Identity as a per-product service (PX-W17; plans/PX-W17.md §2, §6; PORTAL.md G34).
 *
 * There is ONE Polaris Key account per person, platform-wide; it is never a per-product toggle.
 * What `services.identity` gates is sign-in THROUGH the product: the `/<p>/identity/*` routes,
 * which `dispatchService` already answers `404 not_found` while the toggle is off (the registry
 * contract: "off", "absent" and "no such route" look the same to a JSON caller). Licences still
 * attach to accounts whatever the toggle says (Activate License, Discover, verified email).
 *
 * This module adds the two things a JSON 404 cannot do:
 *
 *   - `identityNavigationRedirect`: a PERSON who follows a sign-in link of an Identity-off
 *     product (a browser navigation to one of `IDENTITY_NAVIGATION_ENTRIES`) is sent to the
 *     friendly card, `303 <origin>/signin?product=<slug>&error=identity_disabled`. Device and
 *     JSON callers never see it: they keep `404 not_found` (and `registration_closed` on
 *     `POST /<p>/devices/register`). The redirect discloses nothing discovery does not already
 *     publish (`identity: {enabled:false}`), and an unknown slug keeps today's 404 because the
 *     product never loads.
 *   - `identityEnabled`: the ONE place outside the registry that reads the toggle. Core's bind
 *     guard (`accountSubjects.ts`, `devices.ts`) uses it so no device of an Identity-off product
 *     ever carries `devices.subject`; LX-13/LX-15 use it to create grants licence-held; I-08 and
 *     I-11 use it for the portal's passthrough context and `/signin`.
 *
 * The redirect is Core code that runs BEFORE `dispatchService`, so the rule "a disabled
 * service's code never runs" still holds: no Identity code is reached.
 */

import { ErrorCode, wireError } from "../errors.js";
import type { Db } from "../../db/types.js";
import { parseServices, type ServicesMap } from "../services.js";

/** The query value the friendly card reads (`/signin?…&error=identity_disabled`). Mirrors
 *  `IDENTITY_DISABLED_ERROR_PARAM` in `@polaris-key/protocol/identity`. */
export const IDENTITY_DISABLED = ErrorCode.IdentityDisabled;

/**
 * The app-sign-in entries a person can navigate to, as paths under `/<p>/identity/`. I-21
 * appends `oauth/authorize` when the per-product issuer lands. `authorize` is reserved here
 * ahead of I-08's route so a link minted for it already lands on the card.
 */
export const IDENTITY_NAVIGATION_ENTRIES: readonly string[] = [
  "authorize",
  "auth/start",
  "auth/device",
  "auth/device/verify",
];

/** Does the product's stored enablement set have Identity on? An unknown product is `false`. */
export async function identityEnabled(
  db: Db,
  product: string,
): Promise<boolean> {
  const row = await db.first<{ services_json: string | null }>(
    "SELECT services_json FROM products WHERE slug = ?",
    product,
  );
  if (!row) return false;
  return parseServices(row.services_json).services.identity?.enabled === true;
}

/** PX-W17: the bind guard's refusal. A sign-in binding on a product whose Identity is off is a
 *  bug in the caller (every sign-in route is unreachable then), so it throws, not answers. */
export class IdentityDisabledBindError extends Error {
  constructor(product: string) {
    super(`refusing a device binding: Identity is off for ${product}`);
    this.name = "IdentityDisabledBindError";
  }
}

/** Throw `IdentityDisabledBindError` unless the product's Identity service is on. */
export async function assertIdentityBindable(
  db: Db,
  product: string,
): Promise<void> {
  if (!(await identityEnabled(db, product)))
    throw new IdentityDisabledBindError(product);
}

/** Does an `Accept` header list `text/html` (with a non-zero quality)? `*` wildcards do not
 *  count: an SDK that sends `* / *` or nothing is never a person. */
function acceptsHtml(accept: string | null): boolean {
  if (!accept) return false;
  for (const part of accept.split(",")) {
    const [type, ...params] = part.split(";").map((s) => s.trim());
    if (type?.toLowerCase() !== "text/html") continue;
    const q = params.find((p) => p.toLowerCase().startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

/**
 * Is this request a person's browser navigating, rather than a device or a script? A `GET` or
 * `HEAD` with `Sec-Fetch-Mode: navigate`, or one whose `Accept` lists `text/html`. Everything
 * else (every SDK, `curl` with its default `Accept`, a `fetch` from a page) is not.
 */
export function isNavigation(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (req.headers.get("sec-fetch-mode")?.toLowerCase() === "navigate")
    return true;
  return acceptsHtml(req.headers.get("accept"));
}

/**
 * The friendly refusal for a person who reached an app-sign-in entry of an Identity-off product:
 * `303` to the root portal's sign-in card. `null` when Identity is on, when the path is not a
 * navigation entry, or when the request is not a navigation; the caller then dispatches as
 * usual, and a JSON caller gets the registry's `404 not_found`.
 */
export function identityNavigationRedirect(
  req: Request,
  product: { slug: string; services: ServicesMap },
  rest: readonly string[],
): Response | null {
  if (product.services.identity?.enabled) return null;
  if (!IDENTITY_NAVIGATION_ENTRIES.includes(rest.join("/"))) return null;
  if (!isNavigation(req)) return null;
  const origin = new URL(req.url).origin;
  const params = new URLSearchParams({
    product: product.slug,
    error: IDENTITY_DISABLED,
  });
  return new Response(null, {
    status: 303,
    headers: {
      location: `${origin}/signin?${params.toString()}`,
      "cache-control": "no-store",
    },
  });
}

/**
 * The portal passthrough context's refusal (plans/PX-W17.md §2 rule 4):
 * `403 {"error":{"code":"identity_disabled"}}`. I-08 answers it from the passthrough context of
 * a product whose Identity is off; it is human-facing (the portal renders the card from it).
 */
export function identityDisabledResponse(): Response {
  return wireError(403, IDENTITY_DISABLED);
}
