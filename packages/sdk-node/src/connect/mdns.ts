// The mDNS adapter (CC-08.2; WIRE-CONTRACT-V5 §15.4). `MdnsAdapter` is the seam the LAN service
// uses, so a test injects a fake. `MulticastDnsAdapter` implements it on `multicast-dns` 7.2.5
// (an optional dependency, loaded on first use) with our own PTR/SRV/TXT/A layer for the
// `_pkeypeer._tcp` service.
//
// Rules this module keeps:
//  - the host name in the advert is the instance name (`p1-….local`), never the machine's name;
//  - a browse hit is dropped unless its instance name has the advert shape and it names exactly
//    one SRV and one TXT;
//  - a response is ignored unless its source is inside a connected subnet (address and prefix) of
//    the receiving interface (RFC 6762 §11); on IPv6 there is one socket per interface, so the
//    interface is known, and a link-local source takes it as its zone: the zone the source itself
//    carries (`rinfo.address`) must equal it, and a link-local source with no zone is dropped. On
//    the one IPv4 socket the arrival interface is not known, so the test is the union of the
//    connected subnets of the interfaces that count (up, not loopback unless allowed, not a tunnel
//    or point-to-point): a source on another connected subnet passes it, which costs at most one
//    blind connect, never a trusted address;
//  - only a name a roster device can announce (`accept`) enters a table, no source owns a name,
//    and one source adds at most 16 new names a minute; an SRV port below 1024 is ignored. `dgram`
//    does not report a datagram's destination, so a unicast reply to port 5353 cannot be told
//    from a multicast one here (§15.4 says so);
//  - an A or AAAA record is believed only when its address equals the packet's own UDP source (an
//    IPv4-mapped source counts as its IPv4 address), so a neighbour cannot point another device's
//    name at an address of its choosing; there is no address filter when it is learned, the
//    dial-time `lanVerdict` (lanJudge.ts) decides what is dialled. A record with TTL 0 removes its
//    address. Names compare by ASCII fold. Each name keeps at most four addresses, in the order
//    they were first seen (§15.4 Addresses; the `mdnsAnswers` rows);
//  - IPv6 mDNS runs on ff02::fb on at most eight interfaces that are up, multicast-capable and
//    have an fe80 address, one udp6 socket each; the zone is the interface (its name on POSIX,
//    its `scopeid` on Windows);
//  - the tables of instances and addresses are bounded, entries expire after five minutes, and
//    when full the least recently refreshed entry is evicted, so a flood cannot stop discovery;
//  - a peer whose PTR TTL lapses without a refresh is reported down, like a goodbye (TTL 0);
//  - query replies are sent at most once a second per socket.

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { createSocket } from "node:dgram";
import { isInstanceName } from "@polaris-key/client-core/peer";
import { canonIp, foldMapped, inCidr, isLinkLocal, splitZone } from "./ip.js";

export const PEER_SERVICE = "_pkeypeer._tcp.local";
const MAX_INSTANCES = 256;
const MAX_TXT = 8;
/** Addresses kept per host name (§15.4), and how long a learned record is believed (ms). */
export const MAX_ADDRS = 4;
/** IPv6 interfaces used (§15.4). */
export const MAX_INTERFACES = 8;
const ENTRY_TTL_MS = 5 * 60_000;
const REPLY_GAP_MS = 1000;
const TTL = 120;
const SWEEP_MS = 5000;

export interface MdnsAdvert {
  /** `p1-` plus 16 base32 characters. */
  instance: string;
  port: number;
  /** `key=value` entries. */
  txt: readonly string[];
}

export interface MdnsFound {
  instance: string;
  /** The learned addresses, at most four, in the order first seen. A link-local one carries its `%zone`. */
  hosts: string[];
  port: number;
  txt: string[];
}

export interface MdnsHandle {
  stop(): Promise<void>;
}

export interface MdnsAdapter {
  advertise(advert: MdnsAdvert): Promise<MdnsHandle>;
  /**
   * `accept` says whether an instance name may enter the tables (the service passes the names
   * its roster can announce); default: every well-formed name.
   */
  browse(
    onUp: (found: MdnsFound) => void,
    onDown?: (instance: string) => void,
    accept?: (instance: string) => boolean,
  ): Promise<MdnsHandle>;
}

/** The part of a `multicast-dns` instance this adapter uses. */
export interface MdnsSocket {
  on(event: string, fn: (...args: any[]) => void): unknown;
  respond(packet: unknown, cb?: (err?: Error | null) => void): void;
  query(packet: unknown, cb?: (err?: Error | null) => void): void;
  destroy(cb?: () => void): void;
}

/** An interface the IPv6 sockets use. */
export interface MdnsInterface {
  name: string;
  /** What follows `%` in an address on this link: the name on POSIX, the `scopeid` on Windows. */
  zone: string;
  /** Its fe80::/10 addresses, without a zone. They go in the AAAA records of an advert. */
  addresses: string[];
  /** Its connected subnets as CIDR text (`fe80::1/64`, `fd12::5/64`). */
  nets: string[];
}

export interface MulticastDnsOptions {
  /** Make the IPv4 socket. Default: `multicast-dns` with its defaults. */
  create?: () => Promise<MdnsSocket> | MdnsSocket;
  /** The IPv4 addresses to put in the advert. Default: this machine's non-internal RFC 1918 addresses. */
  addresses?: () => string[];
  /** Accept (and advertise) 127.0.0.0/8. For tests and same-host peers only. */
  allowLoopback?: boolean;
  /**
   * IPv6: one socket per interface. Default: on, except when `create` is injected (a test has
   * then chosen its sockets). `false` is IPv4 only.
   */
  v6?:
    | false
    | {
        interfaces?: () => MdnsInterface[];
        create?: (i: MdnsInterface) => Promise<MdnsSocket> | MdnsSocket;
      };
  /** The connected IPv4 subnets (CIDR) a response on the IPv4 socket must come from. Default: this machine's. */
  subnets?: () => string[];
}

/** An address a LAN peer may legitimately have: RFC 1918, or loopback if allowed. Link-local (169.254/16) and CGNAT (100.64/10) are not dialled. */
export function isLanAddress(ip: string, allowLoopback = false): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a === 127 && allowLoopback;
}

const fqdn = (instance: string): string => `${instance}.${PEER_SERVICE}`;
const hostOf = (instance: string): string => `${instance}.local`;
const INSTANCE_FQDN = /^(p1-[a-z2-7]{16})\._pkeypeer\._tcp\.local$/;

/** This machine's IPv4 interface addresses (the loopback ones only when allowed). */
function ipv4Entries(
  allowLoopback: boolean,
  all: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): NetworkInterfaceInfo[] {
  return Object.values(all)
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === "IPv4" && (!i.internal || allowLoopback));
}

function ownAddresses(allowLoopback: boolean): string[] {
  return ipv4Entries(allowLoopback)
    .map((i) => i.address)
    .filter((x) => isLanAddress(x, allowLoopback));
}

const ZERO_MAC = /^(?:00:){5}00$/;

/**
 * The interfaces IPv6 mDNS uses: up (Node lists only interfaces that have an address), with an
 * fe80 address, multicast-capable (approximated by a hardware address: loopback and point-to-point
 * tunnels have none; a socket that cannot join the group is dropped later), at most eight, in name
 * order.
 */
export function ownInterfaces(allowLoopback = false): MdnsInterface[] {
  const out: MdnsInterface[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    const v6 = (list ?? []).filter((i) => i.family === "IPv6");
    const ll = v6.filter((i) => isLinkLocal(canonIp(i.address) ?? ""));
    const first = ll[0];
    if (first === undefined) continue;
    if (first.internal ? !allowLoopback : ZERO_MAC.test(first.mac)) continue;
    out.push({
      name,
      zone: process.platform === "win32" ? String(first.scopeid) : name,
      addresses: ll.map((i) => i.address),
      nets: v6.map((i) => i.cidr).filter((c): c is string => c !== null),
    });
  }
  return out
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .slice(0, MAX_INTERFACES);
}

/**
 * This machine's connected IPv4 subnets, of the interfaces that count for the source test
 * (§15.4): up, loopback only when allowed, and not a tunnel or point-to-point interface (a VPN,
 * `utun`: no hardware address).
 */
export const ownSubnets = (
  allowLoopback: boolean,
  all?: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] =>
  ipv4Entries(allowLoopback, all)
    .filter((i) => i.internal || !ZERO_MAC.test(i.mac))
    .flatMap((i) => (i.cidr === null ? [] : [i.cidr]));

/** ASCII fold: `A-Z` to `a-z` and nothing else. */
export const foldName = (name: string): string =>
  name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

interface Answer {
  name: string;
  type: string;
  ttl?: number;
  data: any;
}

/** One address record as the DNS decoder gives it. */
export interface AddressRecord {
  name: string;
  type: "A" | "AAAA";
  ttl?: number;
  /** The address text. */
  data: string;
}

/**
 * The addresses learned for each host name (§15.4 Addresses; the `mdnsAnswers` rows). The rule
 * is the whole of learning: a record counts only when its address equals the packet's source (an
 * IPv4-mapped source as its IPv4), whatever the address is; TTL 0 removes; names fold by ASCII;
 * four per name, first seen first. Bounded in names: the least recently refreshed is evicted.
 */
export class AddressBook {
  readonly #m = new Map<string, { ips: string[]; at: number }>();
  constructor(private readonly maxNames = MAX_INSTANCES) {}

  /**
   * Apply one record from a packet sent by `source` and received on `zone` (null: none).
   * `admit` is asked before a new name takes a place (the per-source limit); a link-local
   * address with no arrival zone is not learned.
   */
  learn(
    r: AddressRecord,
    source: string,
    zone: string | null,
    now: number,
    admit: () => boolean = () => true,
  ): void {
    const want = canonIp(splitZone(source).addr);
    const got = canonIp(r.data);
    if (want === null || got === null || foldMapped(want) !== got) return;
    if (isLinkLocal(got) && zone === null) return;
    const address = isLinkLocal(got) ? `${got}%${zone}` : got;
    const name = foldName(r.name);
    let e = this.#m.get(name);
    if (r.ttl === 0) {
      if (e === undefined) return;
      e.ips = e.ips.filter((x) => x !== address);
      if (e.ips.length === 0) this.#m.delete(name);
      return;
    }
    if (e === undefined) {
      if (!admit()) return;
      if (this.#m.size >= this.maxNames) this.trim(now);
      e = { ips: [], at: now };
    } else this.#m.delete(name);
    if (!e.ips.includes(address) && e.ips.length < MAX_ADDRS)
      e.ips.push(address);
    e.at = now;
    this.#m.set(name, e); // most recently refreshed last
  }

  /** The addresses held for `name`, first seen first. */
  hosts(name: string): string[] {
    return [...(this.#m.get(foldName(name))?.ips ?? [])];
  }

  /** Seed the table (a conformance row's `prior`). */
  hold(name: string, address: string, now = 0): void {
    const n = foldName(name);
    const e = this.#m.get(n) ?? { ips: [], at: now };
    e.ips.push(address);
    this.#m.set(n, e);
  }

  /** The table as `{name, address}` entries, grouped by name, each name first seen first. */
  table(): { name: string; address: string }[] {
    return [...this.#m].flatMap(([name, e]) =>
      e.ips.map((address) => ({ name, address })),
    );
  }

  /** Drop expired entries, then the oldest while full. */
  trim(now: number): void {
    for (const [k, v] of this.#m)
      if (now - v.at > ENTRY_TTL_MS) this.#m.delete(k);
    while (this.#m.size >= this.maxNames) {
      const k = this.#m.keys().next().value;
      if (k === undefined) break;
      this.#m.delete(k);
    }
  }
}

/** New names one source may add in a window, and how many sources are tracked (§15.4). */
export const MAX_NEW_PER_SOURCE = 16;
export const NEW_WINDOW_MS = 60_000;
const MAX_SOURCES = 256;

/**
 * At most `MAX_NEW_PER_SOURCE` new names per source in `NEW_WINDOW_MS`, so one host cannot
 * crowd the tables. The least recently seen source is forgotten when `MAX_SOURCES` are tracked.
 */
export class NewNameLimiter {
  readonly #m = new Map<string, number[]>();

  /** May `source` add one more new name now? Counts the name when it may. */
  admit(source: string, now: number): boolean {
    const held = (this.#m.get(source) ?? []).filter(
      (t) => now - t < NEW_WINDOW_MS,
    );
    this.#m.delete(source);
    const ok = held.length < MAX_NEW_PER_SOURCE;
    if (ok) held.push(now);
    this.#m.set(source, held);
    while (this.#m.size > MAX_SOURCES) {
      const k = this.#m.keys().next().value;
      if (k === undefined) break;
      this.#m.delete(k);
    }
    return ok;
  }
}

const HOST_NAME = /^(p1-[a-z2-7]{16})\.local$/;

/** Decide whether a response may teach anything: its source is inside one of the receiving interface's connected subnets (RFC 6762 §11). */
export function sourceInSubnets(
  source: string,
  nets: readonly string[],
): boolean {
  return nets.some((n) => inCidr(source, n));
}

async function defaultSocket(): Promise<MdnsSocket> {
  let mod: any;
  try {
    mod = await import("multicast-dns" as string);
  } catch (e) {
    throw new MdnsUnavailableError(
      "multicast-dns is not installed; LAN discovery is off.",
      e,
    );
  }
  return (mod.default ?? mod)() as MdnsSocket;
}

/** An IPv6 socket for one interface: ff02::fb, `ipv6Only` so it never shares IPv4 traffic with the udp4 socket. */
async function defaultSocket6(i: MdnsInterface): Promise<MdnsSocket> {
  let mod: any;
  try {
    mod = await import("multicast-dns" as string);
  } catch (e) {
    throw new MdnsUnavailableError(
      "multicast-dns is not installed; LAN discovery is off.",
      e,
    );
  }
  const socket = createSocket({
    type: "udp6",
    reuseAddr: true,
    ipv6Only: true,
  });
  return (mod.default ?? mod)({
    type: "udp6",
    ip: "ff02::fb",
    interface: `::%${i.zone}`,
    socket,
  }) as MdnsSocket;
}

/** A socket and the interface it is on (null: the IPv4 socket). */
interface Face {
  s: MdnsSocket;
  iface: MdnsInterface | null;
}

export class MulticastDnsAdapter implements MdnsAdapter {
  constructor(private readonly o: MulticastDnsOptions = {}) {}

  /** The IPv4 socket, then one IPv6 socket per usable interface. A socket that cannot be made is skipped. */
  private async faces(): Promise<Face[]> {
    const out: Face[] = [
      { s: await (this.o.create ?? defaultSocket)(), iface: null },
    ];
    const v6 = this.o.v6;
    if (v6 === false || (v6 === undefined && this.o.create !== undefined))
      return out;
    const list = (
      v6?.interfaces ?? (() => ownInterfaces(this.o.allowLoopback === true))
    )().slice(0, MAX_INTERFACES);
    for (const iface of list)
      try {
        out.push({ s: await (v6?.create ?? defaultSocket6)(iface), iface });
      } catch (e) {
        if (e instanceof MdnsUnavailableError) throw e;
      }
    return out;
  }

  async advertise(a: MdnsAdvert): Promise<MdnsHandle> {
    if (!isInstanceName(a.instance)) throw new RangeError("instance name");
    const faces = await this.faces();
    const addrs = (
      this.o.addresses ?? (() => ownAddresses(this.o.allowLoopback === true))
    )().filter((x) => isLanAddress(x, this.o.allowLoopback === true));
    const records = (ttl: number, iface: MdnsInterface | null): Answer[] => [
      { name: PEER_SERVICE, type: "PTR", ttl, data: fqdn(a.instance) },
      {
        name: fqdn(a.instance),
        type: "SRV",
        ttl,
        data: {
          port: a.port,
          target: hostOf(a.instance),
          priority: 0,
          weight: 0,
        },
      },
      {
        name: fqdn(a.instance),
        type: "TXT",
        ttl: ttl === 0 ? 0 : 4500,
        data: [...a.txt],
      },
      // An A record leaves on the IPv4 socket and an AAAA on the interface's own: a browser
      // believes only an address equal to the packet's source.
      ...(iface === null
        ? addrs.map(
            (data): Answer => ({
              name: hostOf(a.instance),
              type: "A",
              ttl,
              data,
            }),
          )
        : iface.addresses.slice(0, MAX_ADDRS).map(
            (data): Answer => ({
              name: hostOf(a.instance),
              type: "AAAA",
              ttl,
              data,
            }),
          )),
    ];
    for (const { s, iface } of faces) {
      s.on("error", () => undefined);
      s.on("warning", () => undefined);
      let lastReply = -Infinity;
      s.on("query", (q: { questions?: { name: string; type: string }[] }) => {
        const hit = (q.questions ?? []).some((x) => {
          const n = foldName(x.name);
          return (
            n === PEER_SERVICE ||
            n === fqdn(a.instance) ||
            n === hostOf(a.instance)
          );
        });
        const t = Date.now();
        if (hit && t - lastReply >= REPLY_GAP_MS) {
          lastReply = t;
          s.respond({ answers: records(TTL, iface) });
        }
      });
      s.respond({ answers: records(TTL, iface) });
    }
    const again = setTimeout(() => {
      for (const { s, iface } of faces)
        s.respond({ answers: records(TTL, iface) });
    }, 1000);
    again.unref();
    return {
      stop: () =>
        Promise.all(
          faces.map(
            ({ s, iface }) =>
              new Promise<void>((done) => {
                clearTimeout(again);
                try {
                  s.respond({ answers: records(0, iface) }, () =>
                    s.destroy(() => done()),
                  );
                } catch {
                  s.destroy(() => done());
                }
              }),
          ),
        ).then(() => undefined),
    };
  }

  async browse(
    onUp: (f: MdnsFound) => void,
    onDown?: (instance: string) => void,
    accept: (instance: string) => boolean = () => true,
  ): Promise<MdnsHandle> {
    const faces = await this.faces();
    const loop = this.o.allowLoopback === true;
    const subnets4 = this.o.subnets ?? (() => ownSubnets(loop));
    type Seen = {
      port?: number;
      target?: string;
      txt?: string[];
      up?: string;
      at: number;
      /** When the advert's PTR record lapses unless it is refreshed (ms since epoch). */
      exp: number;
    };
    const seen = new Map<string, Seen>();
    const book = new AddressBook();
    const fresh = new NewNameLimiter();
    /** Drop expired entries; when `room` is wanted and the table is full, evict the oldest. */
    const trim = <V extends { at: number }>(
      m: Map<string, V>,
      now: number,
      gone?: (k: string, v: V) => void,
    ): void => {
      for (const [k, v] of m)
        if (now - v.at > ENTRY_TTL_MS) {
          m.delete(k);
          gone?.(k, v);
        }
      while (m.size >= MAX_INSTANCES) {
        const [k, v] = m.entries().next().value!;
        m.delete(k);
        gone?.(k, v);
      }
    };
    const dropped = (k: string, v: Seen): void => {
      if (v.up !== undefined) onDown?.(k);
    };
    const learn = (
      answers: Answer[],
      src: string,
      zone: string | null,
      from: string,
    ): void => {
      const now = Date.now();
      for (const r of answers) {
        if (
          (r.type === "A" || r.type === "AAAA") &&
          typeof r.data === "string"
        ) {
          // Only the host name of an accepted instance has a place in the book.
          const h = HOST_NAME.exec(foldName(r.name));
          if (h === null || !accept(h[1]!)) continue;
          book.learn(
            { name: r.name, type: r.type, ttl: r.ttl, data: r.data },
            src,
            zone,
            now,
            () => fresh.admit(from, now),
          );
          continue;
        }
        const name = r.type === "PTR" ? r.data : r.name;
        const m =
          typeof name === "string" ? INSTANCE_FQDN.exec(foldName(name)) : null;
        if (
          m === null ||
          (r.type === "PTR" && foldName(r.name) !== PEER_SERVICE)
        )
          continue;
        const inst = m[1]!;
        if (!accept(inst)) continue;
        if (
          r.type === "SRV" &&
          !(
            r.data &&
            Number.isInteger(r.data.port) &&
            r.data.port >= 1024 &&
            r.data.port <= 65535
          )
        )
          continue; // a port a random listen cannot have drawn
        if (r.type === "PTR" && r.ttl === 0) {
          if (seen.delete(inst)) onDown?.(inst);
          continue;
        }
        let e = seen.get(inst);
        if (e === undefined) {
          // No source owns a name; each may add 16 new ones a minute.
          if (!fresh.admit(from, now)) continue;
          if (seen.size >= MAX_INSTANCES) trim(seen, now, dropped);
          e = { at: now, exp: now + TTL * 1000 };
        } else seen.delete(inst);
        e.at = now;
        // A PTR is the refresh signal: its own TTL (capped) restarts the clock. A goodbye (TTL 0)
        // was handled above.
        if (r.type === "PTR")
          e.exp = now + Math.min(r.ttl ?? TTL, ENTRY_TTL_MS / 1000) * 1000;
        seen.set(inst, e);
        if (r.type === "SRV") {
          e.port = r.data.port;
          // Only our own host name shape: the target is the instance's `.local` name.
          if (
            typeof r.data.target === "string" &&
            foldName(r.data.target) === hostOf(inst)
          )
            e.target = hostOf(inst);
        } else if (r.type === "TXT" && Array.isArray(r.data)) {
          e.txt = r.data
            .slice(0, MAX_TXT)
            .map((b: Buffer | string) =>
              typeof b === "string" ? b : b.toString("utf8"),
            );
        }
      }
      for (const [inst, e] of seen) {
        const hosts = e.target === undefined ? [] : book.hosts(e.target);
        if (e.port === undefined || e.txt === undefined) continue;
        if (hosts.length === 0) {
          // Every address was withdrawn: the peer cannot be dialled until one is learned again.
          if (e.up !== undefined) {
            e.up = undefined;
            onDown?.(inst);
          }
          continue;
        }
        const sig = `${hosts.join(",")}|${e.port}|${e.txt.join("\n")}`;
        if (e.up === sig) continue;
        e.up = sig;
        onUp({ instance: inst, hosts, port: e.port, txt: e.txt });
      }
    };
    for (const { s, iface } of faces) {
      s.on("error", () => undefined);
      s.on("warning", () => undefined);
      s.on(
        "response",
        (
          res: { answers?: Answer[]; additionals?: Answer[] },
          rinfo?: { address?: string },
        ) => {
          // A response with no source, or from outside the link's subnets, teaches nothing.
          const from = rinfo?.address;
          if (typeof from !== "string") return;
          const { addr: src, zone: sourceZone } = splitZone(from);
          if (!sourceInSubnets(src, iface === null ? subnets4() : iface.nets))
            return;
          // A link-local source names its link: the zone it carries must be the interface this
          // socket is on, and one with no zone, or another, is not ours.
          const canon = canonIp(src);
          if (
            canon !== null &&
            isLinkLocal(foldMapped(canon)) &&
            (iface === null || sourceZone === null || sourceZone !== iface.zone)
          )
            return;
          learn(
            [...(res.answers ?? []), ...(res.additionals ?? [])],
            src,
            iface === null ? null : iface.zone,
            from,
          );
        },
      );
    }
    const ask = (): void => {
      const questions: { name: string; type: string }[] = [
        { name: PEER_SERVICE, type: "PTR" },
      ];
      for (const [inst, e] of seen)
        if (e.up === undefined) {
          questions.push({ name: fqdn(inst), type: "SRV" });
          questions.push({ name: fqdn(inst), type: "TXT" });
          questions.push({ name: hostOf(inst), type: "A" });
          questions.push({ name: hostOf(inst), type: "AAAA" });
        }
      for (const { s } of faces) s.query({ questions: questions.slice(0, 32) });
    };
    ask();
    const t1 = setTimeout(ask, 1000);
    const t2 = setInterval(ask, 30_000);
    // An advert whose TTL lapsed without a refresh is gone, as if it had said goodbye.
    const t3 = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of seen)
        if (v.exp <= now) {
          seen.delete(k);
          dropped(k, v);
        }
    }, SWEEP_MS);
    t1.unref();
    t2.unref();
    t3.unref();
    return {
      stop: () => {
        clearTimeout(t1);
        clearInterval(t2);
        clearInterval(t3);
        return Promise.all(
          faces.map(
            ({ s }) => new Promise<void>((done) => s.destroy(() => done())),
          ),
        ).then(() => undefined);
      },
    };
  }
}

export class MdnsUnavailableError extends Error {
  readonly reason = "mdns_unavailable";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "MdnsUnavailableError";
  }
}
