// The Cloud Sync key ring as the React adapters expose it (sync.keyring, U-38.2; WIRE-CONTRACT-V5
// §13.10, §13.11). One client per adapter: the browser's bearer engine implements it, and a cookie
// page, the desktop bridge and the local adapter answer the typed unsupported one below.
//
// A browser unlocks only with the recovery code (plan-cloud-sync Q8). The root `R` is held in the
// engine as a non-extractable key and, for a short session after it was made or recovered, as
// bytes. No type here carries `R`, and no error or status names a code.

import type { Unsupported } from "@polaris-key/client-core";
import { Feature } from "../constants.generated.js";
import { UnsupportedError } from "./caps.js";

/** Where the root lives: "durable" survives a reload, "memory" dies with the page. */
export type RingPersistence = "durable" | "memory";

/**
 * - `none`: the product has no key ring yet (the first device creates it).
 * - `locked`: a ring exists and this device holds no root for it. Unlock with the recovery code.
 * - `unlocked`: this device holds the root of the current ring.
 * - `ring-changed`: the served ring is not the one this browser pinned when it first acquired a
 *   root (see `RingStatus.changed`). Nothing was opened and the stored root was not replaced.
 *   Unlock with the recovery code, or call `acceptRingChange()` once the person confirmed.
 */
export type RingState = "none" | "locked" | "unlocked" | "ring-changed";

/** A ring's identity as pinned or served. It holds no secret. */
export interface RingIdentity {
  ringId: string;
  epoch: number;
  rootKid: string;
}

export interface RingStatus {
  state: RingState;
  ringId: string | null;
  epoch: number | null;
  /** Whether a recovery code has been set for the ring. */
  recoverySet: boolean;
  /** Where this device keeps its root; "memory" on a browser that cannot keep its keys. */
  persistence: RingPersistence;
  /**
   * Whether this device can create or reset a ring. False on a browser whose device keys die with
   * the page (the Worker needs registered keys for the ring's own wrap): it can still unlock.
   */
  canCreate: boolean;
  /** Set with `state: "ring-changed"`: what was pinned, what is served, and the device that
   *  wrapped for this one (empty when none did). */
  changed?: { pinned: RingIdentity; served: RingIdentity; by: string };
}

/** What a new ring or a new code hands back, once: show it, and keep nothing. */
export interface RingCode {
  /** The recovery code as shown to the person: 8 groups of 4. */
  recoveryCode: string;
  ringId: string;
  epoch: number;
}

/** The key ring client. Every method may throw `PolarisError`; unsupported ones throw `UnsupportedError`. */
export interface KeyringClient {
  /** Why the ring is unavailable on this transport, or null when it runs. */
  readonly unsupported: Unsupported | null;
  /** Reads the ring and unlocks from this device's wrap when it has one. */
  status(): Promise<RingStatus>;
  /** Makes the product's first ring, with this device's wrap and a new recovery code. */
  create(): Promise<RingCode>;
  /** Unlocks with the recovery code the person typed or pasted (`recovery-code-invalid` if wrong). */
  recover(code: string): Promise<RingStatus>;
  /** Replaces the recovery code (needs the root: recover first if this session lost it). */
  setRecoveryCode(): Promise<RingCode>;
  /** "Start over": a new ring and a new code; the old ring is kept for 30 days. */
  reset(): Promise<RingCode>;
  /** Re-seals the root of the ring a reset replaced under the new root, so it can still be read. */
  adoptPrevious(): Promise<void>;
  /** Wraps the root to another device of the same person (a primitive; the nearby channel calls it). */
  wrapTo(deviceId: string, agreeKey: string | Uint8Array): Promise<void>;
  /** Removes this device's own wrap. */
  removeWrap(deviceId: string): Promise<void>;
  /** Forgets the root on this device. The ring and its wraps stay on the server. */
  lock(): Promise<void>;
  /**
   * Sign-out: locks, clears the stored root and drops the pin, so the next person on this device
   * starts clean. The browser adapter calls it on sign-out and deactivation.
   */
  forget(): Promise<void>;
  /**
   * After `ring-changed`, and only once the person confirmed in UI: `confirmed` is the ring they
   * were shown (`status.changed.served`). If the Worker now serves another, the answer is
   * `ring-changed` again. When this device's wrap for the ring opens, the root is replaced and
   * the ring pinned; otherwise the stored root and pin stay and the recovery code is the way in.
   */
  acceptRingChange(confirmed: RingIdentity): Promise<RingStatus>;
  /** Whether this device holds the root right now (what the sync machine's `setRoot` takes). */
  hasRoot(): boolean;
  /** Called on every change of `hasRoot()`. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** A ring client for a transport that cannot hold a ring: every verb throws the typed unsupported. */
export function unsupportedKeyring(
  reason: Unsupported["reason"],
  detail: string,
): KeyringClient {
  const unsupported: Unsupported = {
    supported: false,
    feature: Feature.syncKeyring,
    reason,
    detail,
  };
  const refuse = (): Promise<never> =>
    Promise.reject(new UnsupportedError(unsupported));
  return {
    unsupported,
    status: refuse,
    create: refuse,
    recover: refuse,
    setRecoveryCode: refuse,
    reset: refuse,
    adoptPrevious: refuse,
    wrapTo: refuse,
    removeWrap: refuse,
    lock: refuse,
    forget: refuse,
    acceptRingChange: refuse,
    hasRoot: () => false,
    subscribe: () => () => undefined,
  };
}

/** The sync machine's root switch (`CloudSyncMachine.setRoot`): true while the ring is unlocked. */
export interface RootSwitch {
  setRoot(present: boolean): void;
}

/** Keeps a machine's lock in step with the client: sets it now and on every change. */
export function bindRingToMachine(
  ring: Pick<KeyringClient, "hasRoot" | "subscribe">,
  machine: RootSwitch,
): () => void {
  machine.setRoot(ring.hasRoot());
  return ring.subscribe(() => machine.setRoot(ring.hasRoot()));
}
