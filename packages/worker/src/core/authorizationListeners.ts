/**
 * Core's new-authorization listeners (PS-04, notes/S-21 §6.6): who hears that a device was just
 * authorized on a licence it did not hold a seat on before.
 *
 * `authorizeDevice` (`core/licensing/authz.ts`) is the one place every activation path binds a device to a
 * licence (key entry, enrol, a product sign-in, the browser session), so it is the one place that
 * can say "a device first bound to this licence". A service that needs to know contributes a
 * listener on its descriptor (`contributes.onAuthorization`, `core/contributions.ts`), so Core
 * never imports a service and the service never reads Core's device rows (rule 6). A listener
 * runs only while its service is enabled for the product. Identity's storefront contributes one to
 * count first activations of licences added from Discover
 * (`services/identity/portal/store/analytics.ts`).
 *
 * A listener is BOOKKEEPING, never policy: it runs only after the device is bound, it cannot
 * refuse or change the activation, and a listener that throws is ignored. With the request's
 * `waitUntil` the listeners run after the answer, off the response path.
 */

import type { Db } from "../db/types.js";
import type { Env } from "../platform/env.js";
import { contributedAuthorizationListeners } from "./contributions.js";
import type { ServicesMap } from "./services.js";
import type { WaitUntil } from "./licensing/refusals.js";

/** One new authorization: a device that now holds a seat on `licenseId` it did not hold before. */
export interface NewAuthorization {
  product: string;
  licenseId: string;
  deviceId: string;
  /**
   * The licence's FIRST device ever: no other device row names the licence, and this device was
   * never bound to it before (a re-authorization after a deauthorization is not first). Device
   * rows are kept when a device is deauthorized and deleted only with the licence, so "ever" holds
   * for the licence's life. Read after the bind, so two devices binding at the same instant can
   * both read first: listeners that count must accept that (rare) double count.
   */
  firstOnLicense: boolean;
}

export interface AuthorizationListenerContext {
  db: Db;
  env: Env;
  now: number;
}

export type AuthorizationListener = (
  ctx: AuthorizationListenerContext,
  event: NewAuthorization,
) => Promise<void>;

/** Is anyone listening for this product? `authorizeDevice` reads `firstOnLicense` only when someone is. */
export function hasAuthorizationListeners(services: ServicesMap): boolean {
  return contributedAuthorizationListeners(services).length > 0;
}

/**
 * Tell every listener about one new authorization. Total: a listener that throws or rejects is
 * ignored and the others still run, so bookkeeping can never fail an activation. With `waitUntil`
 * the work is handed to the runtime and this returns at once.
 */
export async function notifyNewAuthorization(
  ctx: AuthorizationListenerContext,
  event: NewAuthorization,
  services: ServicesMap,
  waitUntil?: WaitUntil,
): Promise<void> {
  const listeners = contributedAuthorizationListeners(services);
  await runListeners(listeners, (l) => l(ctx, event), waitUntil);
}

/**
 * Run bookkeeping listeners one after another, ignoring any that throws; with `waitUntil` the work
 * is handed to the runtime and this returns at once. Shared with the device lifecycle
 * (`core/devices/lifecycle.ts`).
 */
export async function runListeners<L>(
  listeners: readonly L[],
  call: (listener: L) => Promise<void>,
  waitUntil?: WaitUntil,
): Promise<void> {
  if (listeners.length === 0) return;
  const work = (async () => {
    for (const listener of listeners) {
      try {
        await call(listener);
      } catch {
        // Bookkeeping only: one listener's failure is not the caller's.
      }
    }
  })();
  if (waitUntil) {
    waitUntil(work);
    return;
  }
  await work;
}
