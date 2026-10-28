// What the LAN and relay transports share (CC-08.3; WIRE-CONTRACT-V5 §15.3, §15.5): the account
// context and Noise ports a `PeerChannel` is built from, and the handling of the two documents a
// peer may push on an open session, `RING` and `TRUST`.
//
// Rules this module keeps:
//  - the device's X25519 private key never leaves the `DeviceKeyPort`: Noise is given a handle
//    whose static-key operations call `port.dh`;
//  - a pushed document is never trusted because a peer sent it. `RING` is re-verified and stored
//    by the identity client under its replacement rules; `TRUST` is verified against the usable
//    pins and applied by the client's trust custodian. Each outcome, stored or refused, is
//    reported as a `ConnectNotice`; none is dropped silently.

import {
  webCryptoNoisePorts,
  webCryptoX25519,
  type AccountContext,
  type NoisePorts,
} from "@polaris-key/client-core/peer";
import type { LanIdentity, LanSource } from "./lan.js";

/** A pushed document's outcome, for the host to log or show. */
export type ConnectNotice =
  | { type: "ring"; outcome: "stored"; epoch: number }
  | { type: "ring"; outcome: "refused"; reason: string }
  | { type: "trust"; outcome: "applied" }
  | { type: "trust"; outcome: "refused"; reason: string };

/** What storing a peer-pushed roster answers. */
export type RingAdoption =
  | { stored: true; epoch: number }
  | { stored: false; reason: string };

/** What applying a peer-pushed trust manifest answers. */
export type TrustApplication =
  | { applied: true }
  | { applied: false; reason: string };

export function peerAccount(
  id: LanIdentity,
  ring: () => { jws: string; epoch: number } | null,
): AccountContext {
  return {
    trust: id.trust,
    expectedAud: id.slug,
    certJws: id.certJws,
    ownSub: id.sub,
    ownDeviceId: id.deviceId,
    heldRing: () => ring() ?? { jws: id.ringJws, epoch: id.ringEpoch },
    discKeys: [id.keys.current, id.keys.previous],
  };
}

/** The static key is a handle: Noise asks for `publicKey` and `dh` on it and gets the device's. */
export function peerPorts(id: LanIdentity, handle: Uint8Array): NoisePorts {
  return {
    ...webCryptoNoisePorts,
    x25519: {
      publicKey: async (k) =>
        k === handle ? id.agreePublic : webCryptoX25519.publicKey(k),
      dh: async (k, p) => (k === handle ? id.dh(p) : webCryptoX25519.dh(k, p)),
    },
  };
}

const REFRESH_GAP_S = 60;

export class PeerDocs {
  #tail: Promise<unknown> = Promise.resolve();
  #lastRefresh = -Infinity;
  #fns = new Set<(n: ConnectNotice) => void>();

  constructor(
    private readonly src: LanSource,
    private readonly onStored: () => void,
  ) {}

  onNotice(fn: (n: ConnectNotice) => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  /** A roster a peer pushed (already verified once by the session). */
  ring(jws: string): void {
    this.#run(async () => {
      if (this.src.adoptRing === undefined)
        return this.#emit({
          type: "ring",
          outcome: "refused",
          reason: "unsupported",
        });
      const r = await this.src.adoptRing(jws);
      if (!r.stored)
        return this.#emit({
          type: "ring",
          outcome: "refused",
          reason: r.reason,
        });
      this.#emit({ type: "ring", outcome: "stored", epoch: r.epoch });
      this.onStored();
      // The certificate and K_disc that go with the new roster come from the Worker.
      this.wantRing();
    });
  }

  /** A trust manifest a peer pushed (not verified by the session). */
  trust(jws: string): void {
    this.#run(async () => {
      if (this.src.applyTrust === undefined)
        return this.#emit({
          type: "trust",
          outcome: "refused",
          reason: "unsupported",
        });
      const r = await this.src.applyTrust(jws);
      this.#emit(
        r.applied
          ? { type: "trust", outcome: "applied" }
          : { type: "trust", outcome: "refused", reason: r.reason },
      );
    });
  }

  /**
   * A peer is on a newer roster, or the relay said the roster changed: fetch it (a fresh
   * `identity({refresh: true})`, verified under the normal replacement rules). At most one a
   * minute.
   */
  wantRing(): void {
    const t = this.src.now();
    if (this.src.refresh === undefined || t - this.#lastRefresh < REFRESH_GAP_S)
      return;
    this.#lastRefresh = t;
    this.src
      .refresh()
      .then(this.onStored, () => undefined)
      .catch(() => undefined);
  }

  #run(f: () => Promise<void>): void {
    this.#tail = this.#tail.then(f).catch((e: unknown) => {
      this.#emit({
        type: "ring",
        outcome: "refused",
        reason: e instanceof Error ? e.message : "failed",
      });
    });
  }

  #emit(n: ConnectNotice): void {
    for (const f of [...this.#fns]) f(n);
  }
}

/** Schedule `fn` after `ms` with an unref'd timeout; returns the cancel. */
export const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const h = setTimeout(fn, ms);
  h.unref();
  return () => clearTimeout(h);
};

/** A queue that runs one async job at a time, in order; a failure does not stop the next. */
export function serialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * The previous K_disc survives a roster change only while no device left or changed its keys
 * (§15.4); otherwise only the newest key is kept.
 */
export function keysAfterRing(
  keys: string[],
  prior: { devices: { deviceId: string; signKey: string; agreeKey: string }[] },
  next: { devices: { deviceId: string; signKey: string; agreeKey: string }[] },
): string[] {
  if (keys.length !== 2) return keys;
  const intact = prior.devices.every((d) =>
    next.devices.some(
      (n) =>
        n.deviceId === d.deviceId &&
        n.signKey === d.signKey &&
        n.agreeKey === d.agreeKey,
    ),
  );
  return intact ? keys : [keys[0]!];
}
