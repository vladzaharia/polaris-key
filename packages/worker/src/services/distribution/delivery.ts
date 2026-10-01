/**
 * Distribution's `delivery` descriptor hook (`core/hooks.ts`), as P2b-01 ships it: no outlets
 * exist yet, so every deliverable travels by the default transport (`pkey-cdn`, our own CDN)
 * and there is no availability to report. P2b-03 adds availability records and P2b-04 rollouts
 * and delivery URLs; both replace this body, not its shape.
 *
 * Read-only by contract: a hook never writes.
 */

import {
  DEFAULT_TRANSPORT,
  type AvailabilityRecord,
  type Delivery,
  type HookContext,
} from "../../core/hooks.js";

export function defaultDelivery(_ctx: HookContext): Delivery {
  return {
    defaultTransport: DEFAULT_TRANSPORT,
    async availability(): Promise<AvailabilityRecord[]> {
      return [];
    },
  };
}
