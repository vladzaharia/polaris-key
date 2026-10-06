// `client.events` (SDK parity pass §3.11): one multi-subscriber stream of what changed, in Node's
// idiom (an EventEmitter with typed events). A UI host (an Electron main process, a TUI) listens
// here instead of polling `status()`, `getConfig()` and `update.decide()`.
//
//   license          the gate's status changed (a sync, an activation, a deactivation, a bundle)
//   config           a resolved config value changed (a sync, or a local set/clear)
//   updateAvailable  `update.decide()` offered a newer build
//   packs            pack download/apply progress
//   store            the token store's backend or degradation changed

import { EventEmitter } from "node:events";
import type { PackProgress, StoreStatus } from "@polaris-key/client-core";
import type { LicenseState } from "@polaris-key/client-core";
import type { UpdateCheck } from "@polaris-key/protocol/update";
import type { ConfigChange } from "../config/client.js";

export interface PolarisEvents {
  license: [{ state: LicenseState; previous: LicenseState["status"] | null }];
  config: [ConfigChange];
  updateAvailable: [UpdateCheck];
  packs: [PackProgress];
  store: [StoreStatus | null];
}

export type PolarisEventName = keyof PolarisEvents;

/** A typed EventEmitter. A listener that throws never breaks the client: emits are guarded. */
export class PolarisEventEmitter extends EventEmitter<PolarisEvents> {
  /** Emit, swallowing listener failures (telemetry and UI must never fail a sync). */
  safeEmit<K extends PolarisEventName>(
    name: K,
    ...args: PolarisEvents[K]
  ): void {
    for (const l of this.listeners(name) as ((...a: unknown[]) => void)[]) {
      try {
        l(...(args as unknown[]));
      } catch {
        // The listener's failure is its own.
      }
    }
  }
}
