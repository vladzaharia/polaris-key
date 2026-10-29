// Which peer addresses the Node LAN adapter dials and accepts (WIRE-CONTRACT-V5 §15.4.1), around
// client-core's `lanVerdict`:
//  - the address TEXT is judged before a socket is opened, and the connected socket again (remote
//    and its own local address) before its first byte, on a dial and on an accept;
//  - a mapped address (::ffff:a.b.c.d) with a zone is refused;
//  - the pre-handshake limiter counts per address (4) and per /64 (16), inside a total (32); a
//    link-local key carries its zone, because the same fe80 address on two links is two hosts.

import { lanVerdict, type LanVerdict } from "@polaris-key/client-core/peer";
import { foldMapped, ipBytes, ipText, splitZone } from "./ip.js";

const REFUSED: LanVerdict = { dial: false, key: null };

const isMappedText = (addr: string): boolean => {
  const b = ipBytes(addr);
  return (
    b !== null &&
    b.length === 16 &&
    foldMapped(b).length === 4 &&
    addr.includes(":")
  );
};

/**
 * Judge an address before opening a socket. A global IPv6 address passes here when it could be
 * on-link; the connected socket decides with its own local address.
 */
export function textVerdict(host: string, allowLoopback: boolean): boolean {
  const { addr, zone } = splitZone(host);
  if (zone !== null && isMappedText(addr)) return false;
  return lanVerdict(host, addr, allowLoopback).dial;
}

/** Judge a connected socket's addresses: after `connect`, and at `accept`, before any byte. */
export function socketVerdict(
  remote: string | undefined,
  local: string | undefined,
  allowLoopback: boolean,
): LanVerdict {
  if (remote === undefined || remote === "") return REFUSED;
  const { addr, zone } = splitZone(remote);
  if (zone !== null && isMappedText(addr)) return REFUSED;
  return lanVerdict(remote, local ?? null, allowLoopback);
}

export interface LimiterKeys {
  /** The per-address key: the verdict's key, plus the zone for a link-local address. */
  address: string;
  /** The /64 the address sits in (with the zone for a link-local one); null for IPv4. */
  net64: string | null;
}

/** The keys the limiter counts under, for an address `lanVerdict` allowed (`key`). */
export function limiterKeys(remote: string, key: string): LimiterKeys {
  const b = ipBytes(key);
  if (b === null || b.length === 4) return { address: key, net64: null };
  const { zone } = splitZone(remote);
  const linkLocal = b[0] === 0xfe && (b[1]! & 0xc0) === 0x80;
  const z = linkLocal && zone !== null ? `%${zone}` : "";
  const prefix = ipText(
    Uint8Array.from([...b.subarray(0, 8), ...new Array<number>(8).fill(0)]),
  );
  return { address: `${key}${z}`, net64: `${prefix}/64${z}` };
}

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
    if (k.net64 !== null && (this.#net.get(k.net64) ?? 0) >= this.per64)
      return null;
    this.#total.add(who);
    this.#bump(this.#addr, k.address, 1);
    if (k.net64 !== null) this.#bump(this.#net, k.net64, 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#total.delete(who);
      this.#bump(this.#addr, k.address, -1);
      if (k.net64 !== null) this.#bump(this.#net, k.net64, -1);
    };
  }

  #bump(m: Map<string, number>, key: string, by: number): void {
    const n = (m.get(key) ?? 0) + by;
    if (n <= 0) m.delete(key);
    else m.set(key, n);
  }
}
