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
import type { PeerSessionOptions } from "@polaris-key/client-core/peer";
import type { LanIdentity, LanOptions, LanSource } from "./lan.js";

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
/** Pushed documents handled at once; the rest are refused as `busy`. */
const MAX_DOCS_QUEUED = 8;
const MAX_RETRIES = 5;

export class PeerDocs {
  #tail: Promise<unknown> = Promise.resolve();
  #queued = new Set<string>();
  #lastRefresh = -Infinity;
  #retry: NodeJS.Timeout | null = null;
  #tries = 0;
  #fns = new Set<(n: ConnectNotice) => void>();
  readonly #src: LanSource;
  readonly #onStored: () => void;

  constructor(src: LanSource, onStored: () => void) {
    this.#src = src;
    this.#onStored = onStored;
  }

  onNotice(fn: (n: ConnectNotice) => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  /** Stop a pending retry. */
  close(): void {
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
  }

  /** The newest roster a session handed up, held until an identity load catches up to it. */
  pushed: { jws: string; epoch: number } | null = null;

  /** What a link reports; spread into its options. */
  readonly hooks = {
    onRing: (jws: string, epoch: number): void => {
      if (this.pushed === null || epoch > this.pushed.epoch)
        this.pushed = { jws, epoch };
      this.ring(jws);
    },
    onTrust: (jws: string): void => this.trust(jws),
    onRingWanted: (): void => void this.wantRing(),
  };

  /** A roster a peer pushed (already verified once by the session). */
  ring(jws: string): void {
    this.#run("ring", jws, async () => {
      if (this.#src.adoptRing === undefined)
        return this.#emit({
          type: "ring",
          outcome: "refused",
          reason: "unsupported",
        });
      const r = await this.#src.adoptRing(jws);
      if (!r.stored)
        return this.#emit({
          type: "ring",
          outcome: "refused",
          reason: r.reason,
        });
      this.#emit({ type: "ring", outcome: "stored", epoch: r.epoch });
      this.#onStored();
      // The certificate and K_disc that go with the new roster come from the Worker. If the
      // minute's slot is taken, or the fetch fails, it is tried again.
      this.#want(true);
    });
  }

  /** A trust manifest a peer pushed (not verified by the session). */
  trust(jws: string): void {
    this.#run("trust", jws, async () => {
      if (this.#src.applyTrust === undefined)
        return this.#emit({
          type: "trust",
          outcome: "refused",
          reason: "unsupported",
        });
      const r = await this.#src.applyTrust(jws);
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
   * minute. True when a fetch started.
   */
  wantRing(): boolean {
    return this.#want(false);
  }

  #want(retry: boolean): boolean {
    const t = this.#src.now();
    if (this.#src.refresh === undefined) return false;
    if (t - this.#lastRefresh < REFRESH_GAP_S) {
      if (retry) this.#defer(this.#lastRefresh + REFRESH_GAP_S - t);
      return false;
    }
    this.#lastRefresh = t;
    this.#src
      .refresh()
      .then(
        () => {
          this.#tries = 0;
          this.#onStored();
        },
        () => {
          if (retry && ++this.#tries <= MAX_RETRIES) this.#defer(REFRESH_GAP_S);
        },
      )
      .catch(() => undefined);
    return true;
  }

  #defer(seconds: number): void {
    if (this.#retry !== null) return;
    this.#retry = setTimeout(
      () => {
        this.#retry = null;
        this.#want(true);
      },
      Math.max(1, seconds) * 1000,
    );
    this.#retry.unref();
  }

  /** One at a time, at most `MAX_DOCS_QUEUED` waiting, and a document already waiting is not
   *  queued twice: the excess is refused visibly, not worked on. */
  #run(type: "ring" | "trust", jws: string, f: () => Promise<void>): void {
    const key = `${type}:${jws}`;
    if (this.#queued.has(key) || this.#queued.size >= MAX_DOCS_QUEUED)
      return this.#emit({ type, outcome: "refused", reason: "busy" });
    this.#queued.add(key);
    this.#tail = this.#tail
      .then(f)
      .catch(() => this.#emit({ type, outcome: "refused", reason: "failed" }))
      .finally(() => this.#queued.delete(key));
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

/** What a transport tells every `PeerChannel` it builds (the same for LAN and relay). */
export function channelBase(
  id: LanIdentity,
  o: Pick<
    LanOptions,
    "caps" | "label" | "timer" | "rekeyMessages" | "rekeySeconds"
  >,
  now: () => number,
  ring: () => { jws: string; epoch: number } | null,
): Omit<PeerSessionOptions, "send" | "onEvent" | "mode" | "role"> {
  const handle = new Uint8Array(32);
  return {
    slug: id.slug,
    staticKey: handle,
    account: peerAccount(id, ring),
    caps: o.caps ?? ["app/1"],
    hello: { label: o.label, platform: process.platform, app: id.slug },
    ports: peerPorts(id, handle),
    now,
    timer: o.timer,
    rekeyMessages: o.rekeyMessages,
    rekeySeconds: o.rekeySeconds,
  };
}
