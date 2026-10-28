// What the relay and its sessions share (CC-09.2; WIRE-CONTRACT-V5 §15.3, §15.5): the account
// context and Noise ports a `PeerChannel` is built from, and the handling of the two documents a
// peer may push on an open session, `RING` and `TRUST`. The same rules as sdk-node `connect/channel.ts`.
//
// Rules this module keeps:
//  - the device's X25519 private key never leaves the `DeviceKeyPort`: Noise is given a handle
//    whose static-key operations call `port.dh`;
//  - a pushed document is never trusted because a peer sent it. `RING` is re-verified and stored
//    by the identity client under its replacement rules; `TRUST` is verified against the usable
//    pins and applied under the trust lock, with anti-rollback. Each outcome, stored or refused,
//    is reported as a `ConnectNotice`; none is dropped silently;
//  - pushed documents are handled one at a time, at most eight waiting; the roster is refreshed
//    at most once a minute, and a refresh the minute's slot refused is tried again after it.

import {
  webCryptoNoisePorts,
  webCryptoX25519,
  type AccountContext,
  type NoisePorts,
  type PeerSessionOptions,
} from "@polaris-key/client-core/peer";
import type { TrustSet } from "../offline.js";
import { defaultTimer } from "./redact.js";

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

/** What the relay needs of the held identity, read when used. */
export interface PeerIdentity {
  slug: string;
  trust: TrustSet;
  sub: string;
  deviceId: string;
  certJws: string;
  certExpiresAt: number;
  ringJws: string;
  ringEpoch: number;
  /** Every roster device id, this one included. */
  roster: string[];
  /** K_disc, newest first. */
  keys: { current: Uint8Array; previous: Uint8Array | null };
  /** The device's X25519 public key. */
  agreePublic: Uint8Array;
  /** X25519 with the device's private key; the key itself is not reachable. */
  dh: (peerPublic: Uint8Array) => Promise<Uint8Array | null>;
}

export interface PeerSource {
  load(): Promise<PeerIdentity>;
  /** Seconds since the epoch. */
  now(): number;
  /** Ask the Worker for a newer roster. Best effort. */
  refresh?(): Promise<void>;
  /** Verify and store a roster a peer pushed (the same replacement rules as the identity fetch). */
  adoptRing?(jws: string): Promise<RingAdoption>;
  /** Verify against the usable pins and apply a trust manifest a peer pushed. */
  applyTrust?(jws: string): Promise<TrustApplication>;
}

export function peerAccount(
  id: PeerIdentity,
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
export function peerPorts(id: PeerIdentity, handle: Uint8Array): NoisePorts {
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
  #retry: (() => void) | null = null;
  #retrying = false;
  #tries = 0;
  #lastBusy = -Infinity;
  #fns = new Set<(n: ConnectNotice) => void>();
  readonly #src: PeerSource;
  readonly #onStored: () => void;
  readonly #timer: (fn: () => void, ms: number) => () => void;

  constructor(
    src: PeerSource,
    onStored: () => void,
    timer: (fn: () => void, ms: number) => () => void = defaultTimer,
  ) {
    this.#src = src;
    this.#onStored = onStored;
    this.#timer = timer;
  }

  onNotice(fn: (n: ConnectNotice) => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  /** Stop a pending retry. */
  close(): void {
    this.#retry?.();
    this.#retry = null;
    this.#retrying = false;
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
    if (this.#retrying) return;
    this.#retrying = true;
    this.#retry = this.#timer(
      () => {
        this.#retrying = false;
        this.#retry = null;
        this.#want(true);
      },
      Math.max(1, seconds) * 1000,
    );
  }

  /** One at a time, at most `MAX_DOCS_QUEUED` waiting, and a document already waiting is not
   *  queued twice: the excess is refused visibly, not worked on. */
  #run(type: "ring" | "trust", jws: string, f: () => Promise<void>): void {
    const key = `${type}:${jws}`;
    // One slot is kept for a roster: a flood of manifests cannot starve it.
    const room = type === "ring" ? MAX_DOCS_QUEUED : MAX_DOCS_QUEUED - 1;
    if (this.#queued.has(key) || this.#queued.size >= room) {
      // Refused visibly, but a flood is one notice a second, not one callback per document.
      const t = performance.now();
      if (t - this.#lastBusy < 1000) return;
      this.#lastBusy = t;
      return this.#emit({ type, outcome: "refused", reason: "busy" });
    }
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

/** What the relay tells every `PeerChannel` it builds. */
export function channelBase(
  id: PeerIdentity,
  o: {
    caps?: readonly string[];
    label?: string;
    timer?: (fn: () => void, ms: number) => () => void;
    rekeyMessages?: number;
    rekeySeconds?: number;
  },
  now: () => number,
  ring: () => { jws: string; epoch: number } | null,
): Omit<PeerSessionOptions, "send" | "onEvent" | "mode" | "role"> {
  const handle = new Uint8Array(32);
  return {
    slug: id.slug,
    staticKey: handle,
    account: peerAccount(id, ring),
    caps: o.caps ?? ["app/1"],
    hello: { label: o.label, platform: "web", app: id.slug },
    ports: peerPorts(id, handle),
    now,
    timer: o.timer,
    rekeyMessages: o.rekeyMessages,
    rekeySeconds: o.rekeySeconds,
  };
}
