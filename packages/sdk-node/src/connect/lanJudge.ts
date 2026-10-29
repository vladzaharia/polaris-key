// Which peer addresses the Node LAN adapter dials and accepts (WIRE-CONTRACT-V5 §15.4.1), around
// client-core's `lanVerdict`:
//  - the address TEXT is judged before a socket is opened, and the connected socket again (remote
//    and its own local address) before its first byte, on a dial and on an accept;
//  - the pre-handshake limiter counts per address (4), per group (16) and in total (32); the group
//    is the link for a link-local address (`fe80::/10%zone`: the same fe80 address on two links
//    is two hosts), the /24 for IPv4 and the /64 for any other IPv6 address (§15.4.1).

import {
  lanGroupKey,
  lanVerdict,
  type LanVerdict,
} from "@polaris-key/client-core/peer";
import { splitZone } from "./ip.js";

const REFUSED: LanVerdict = { dial: false, key: null };

/**
 * Judge an address before opening a socket. A global IPv6 address (or a ULA one) passes here when
 * it could be on-link; the connected socket decides with its own local address.
 */
export function textVerdict(host: string, allowLoopback: boolean): boolean {
  // The address itself stands in for "some local address in the same /64".
  return lanVerdict(host, splitZone(host).addr, allowLoopback).dial;
}

/** Judge a connected socket's addresses: after `connect`, and at `accept`, before any byte. */
export function socketVerdict(
  remote: string | undefined,
  local: string | undefined,
  allowLoopback: boolean,
): LanVerdict {
  if (remote === undefined || remote === "") return REFUSED;
  return lanVerdict(remote, local ?? null, allowLoopback);
}

export interface LimiterKeys {
  /** The per-address key: the verdict's key (a link-local one keeps its zone). */
  address: string;
  /** The group the address sits in: its link, /24 or /64 (client-core's `lanGroupKey`). */
  group: string | null;
}

/** The keys the limiter counts under, for an address `lanVerdict` allowed (`key`). */
export const limiterKeys = (key: string): LimiterKeys => ({
  address: key,
  group: lanGroupKey(key),
});

/** Counts of sockets that have not finished the handshake. */
export class PendingLimiter {
  readonly #total = new Set<unknown>();
  readonly #addr = new Map<string, number>();
  readonly #net = new Map<string, number>();

  constructor(
    private readonly max = 32,
    private readonly perAddress = 4,
    private readonly per64 = 16,
  ) {}

  get size(): number {
    return this.#total.size;
  }

  /** Take a slot for `who`; returns the release, or null when a limit is met. */
  take(who: unknown, k: LimiterKeys): (() => void) | null {
    if (this.#total.size >= this.max) return null;
    if ((this.#addr.get(k.address) ?? 0) >= this.perAddress) return null;
    if (k.group !== null && (this.#net.get(k.group) ?? 0) >= this.per64)
      return null;
    this.#total.add(who);
    this.#bump(this.#addr, k.address, 1);
    if (k.group !== null) this.#bump(this.#net, k.group, 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#total.delete(who);
      this.#bump(this.#addr, k.address, -1);
      if (k.group !== null) this.#bump(this.#net, k.group, -1);
    };
  }

  #bump(m: Map<string, number>, key: string, by: number): void {
    const n = (m.get(key) ?? 0) + by;
    if (n <= 0) m.delete(key);
    else m.set(key, n);
  }
}
