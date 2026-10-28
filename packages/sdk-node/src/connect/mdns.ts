// The mDNS adapter (CC-08.2; WIRE-CONTRACT-V5 §15.4). `MdnsAdapter` is the seam the LAN service
// uses, so a test injects a fake. `MulticastDnsAdapter` implements it on `multicast-dns` 7.2.5
// (an optional dependency, loaded on first use) with our own PTR/SRV/TXT/A layer for the
// `_pkeypeer._tcp` service.
//
// Rules this module keeps:
//  - the host name in the advert is the instance name (`p1-….local`), never the machine's name;
//  - a browse hit is dropped unless its instance name has the advert shape, it names exactly one
//    SRV and one TXT, and it has an address in a private, link-local or (opt-in) loopback range:
//    a LAN peer cannot make this device dial a public address;
//  - an A record is believed only when its address is the packet's own UDP source, so a neighbour
//    cannot point another device's name at an address of its choosing; each name keeps at most
//    four addresses and the first one seen is dialled (no ordering a neighbour can steer);
//  - the tables of instances and addresses are bounded, entries expire after five minutes, and
//    when full the least recently refreshed entry is evicted, so a flood cannot stop discovery;
//  - a peer whose PTR TTL lapses without a refresh is reported down, like a goodbye (TTL 0);
//  - query replies are sent at most once a second.

import { networkInterfaces } from "node:os";
import { isInstanceName } from "@polaris-key/client-core/peer";

export const PEER_SERVICE = "_pkeypeer._tcp.local";
const MAX_INSTANCES = 256;
const MAX_TXT = 8;
/** Addresses kept per host name, and how long a learned record is believed (ms). */
const MAX_ADDRS = 4;
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
  /** The address to dial. */
  host: string;
  port: number;
  txt: string[];
}

export interface MdnsHandle {
  stop(): Promise<void>;
}

export interface MdnsAdapter {
  advertise(advert: MdnsAdvert): Promise<MdnsHandle>;
  browse(
    onUp: (found: MdnsFound) => void,
    onDown?: (instance: string) => void,
  ): Promise<MdnsHandle>;
}

/** The part of a `multicast-dns` instance this adapter uses. */
export interface MdnsSocket {
  on(event: string, fn: (...args: any[]) => void): unknown;
  respond(packet: unknown, cb?: (err?: Error | null) => void): void;
  query(packet: unknown, cb?: (err?: Error | null) => void): void;
  destroy(cb?: () => void): void;
}

export interface MulticastDnsOptions {
  /** Make a socket. Default: `multicast-dns` with its defaults. */
  create?: () => Promise<MdnsSocket> | MdnsSocket;
  /** The addresses to put in the advert. Default: this machine's non-internal IPv4 addresses. */
  addresses?: () => string[];
  /** Accept (and advertise) 127.0.0.0/8. For tests and same-host peers only. */
  allowLoopback?: boolean;
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

function ownAddresses(allowLoopback: boolean): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? [])
      if (
        i.family === "IPv4" &&
        (!i.internal || allowLoopback) &&
        isLanAddress(i.address, allowLoopback)
      )
        out.push(i.address);
  return out;
}

interface Answer {
  name: string;
  type: string;
  ttl?: number;
  data: any;
}

export class MulticastDnsAdapter implements MdnsAdapter {
  constructor(private readonly o: MulticastDnsOptions = {}) {}

  private async socket(): Promise<MdnsSocket> {
    if (this.o.create !== undefined) return this.o.create();
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

  async advertise(a: MdnsAdvert): Promise<MdnsHandle> {
    if (!isInstanceName(a.instance)) throw new RangeError("instance name");
    const s = await this.socket();
    s.on("error", () => undefined);
    s.on("warning", () => undefined);
    const addrs = (
      this.o.addresses ?? (() => ownAddresses(this.o.allowLoopback === true))
    )().filter((x) => isLanAddress(x, this.o.allowLoopback === true));
    const records = (ttl: number): Answer[] => [
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
      ...addrs.map(
        (data): Answer => ({ name: hostOf(a.instance), type: "A", ttl, data }),
      ),
    ];
    let lastReply = -Infinity;
    s.on("query", (q: { questions?: { name: string; type: string }[] }) => {
      const hit = (q.questions ?? []).some(
        (x) =>
          x.name === PEER_SERVICE ||
          x.name === fqdn(a.instance) ||
          x.name === hostOf(a.instance),
      );
      const t = Date.now();
      if (hit && t - lastReply >= REPLY_GAP_MS) {
        lastReply = t;
        s.respond({ answers: records(TTL) });
      }
    });
    s.respond({ answers: records(TTL) });
    const again = setTimeout(() => s.respond({ answers: records(TTL) }), 1000);
    again.unref();
    return {
      stop: () =>
        new Promise<void>((done) => {
          clearTimeout(again);
          try {
            s.respond({ answers: records(0) }, () => s.destroy(() => done()));
          } catch {
            s.destroy(() => done());
          }
        }),
    };
  }

  async browse(
    onUp: (f: MdnsFound) => void,
    onDown?: (instance: string) => void,
  ): Promise<MdnsHandle> {
    const s = await this.socket();
    s.on("error", () => undefined);
    s.on("warning", () => undefined);
    const loop = this.o.allowLoopback === true;
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
    const addr = new Map<string, { ips: string[]; at: number }>();
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
    const learn = (answers: Answer[], src: string | undefined): void => {
      const now = Date.now();
      for (const r of answers) {
        if (r.type === "A" && typeof r.data === "string") {
          // Only the sender's own address, and only a LAN one.
          if (
            src === undefined ||
            r.data !== src ||
            !isLanAddress(r.data, loop)
          )
            continue;
          let e = addr.get(r.name);
          if (e === undefined) {
            if (addr.size >= MAX_INSTANCES) trim(addr, now);
            e = { ips: [], at: now };
          } else addr.delete(r.name);
          if (!e.ips.includes(r.data) && e.ips.length < MAX_ADDRS)
            e.ips.push(r.data);
          e.at = now;
          addr.set(r.name, e); // most recently refreshed last
          continue;
        }
        const name = r.type === "PTR" ? r.data : r.name;
        const m = typeof name === "string" ? INSTANCE_FQDN.exec(name) : null;
        if (m === null || (r.type === "PTR" && r.name !== PEER_SERVICE))
          continue;
        const inst = m[1]!;
        if (r.type === "PTR" && r.ttl === 0) {
          if (seen.delete(inst)) onDown?.(inst);
          continue;
        }
        let e = seen.get(inst);
        if (e === undefined) {
          if (seen.size >= MAX_INSTANCES) trim(seen, now, dropped);
          e = { at: now, exp: now + TTL * 1000 };
        } else seen.delete(inst);
        e.at = now;
        // A PTR is the refresh signal: its own TTL (capped) restarts the clock. A goodbye (TTL 0)
        // was handled above.
        if (r.type === "PTR")
          e.exp = now + Math.min(r.ttl ?? TTL, ENTRY_TTL_MS / 1000) * 1000;
        seen.set(inst, e);
        if (r.type === "SRV" && r.data && Number.isInteger(r.data.port)) {
          if (r.data.port < 1 || r.data.port > 65535) continue;
          e.port = r.data.port;
          // Only our own host name shape: the target is the instance's `.local` name.
          if (r.data.target === hostOf(inst)) e.target = r.data.target;
        } else if (r.type === "TXT" && Array.isArray(r.data)) {
          e.txt = r.data
            .slice(0, MAX_TXT)
            .map((b: Buffer | string) =>
              typeof b === "string" ? b : b.toString("utf8"),
            );
        }
      }
      for (const [inst, e] of seen) {
        const ips =
          e.target === undefined ? undefined : addr.get(e.target)?.ips;
        if (
          e.port === undefined ||
          e.txt === undefined ||
          !ips ||
          ips.length === 0
        )
          continue;
        const host = ips[0]!;
        const sig = `${host}|${e.port}|${e.txt.join("\n")}`;
        if (e.up === sig) continue;
        e.up = sig;
        onUp({ instance: inst, host, port: e.port, txt: e.txt });
      }
    };
    s.on(
      "response",
      (
        res: { answers?: Answer[]; additionals?: Answer[] },
        rinfo?: { address?: string },
      ) =>
        learn(
          [...(res.answers ?? []), ...(res.additionals ?? [])],
          rinfo?.address,
        ),
    );
    const ask = (): void => {
      const questions: { name: string; type: string }[] = [
        { name: PEER_SERVICE, type: "PTR" },
      ];
      for (const [inst, e] of seen)
        if (e.up === undefined) {
          questions.push({ name: fqdn(inst), type: "SRV" });
          questions.push({ name: fqdn(inst), type: "TXT" });
          questions.push({ name: hostOf(inst), type: "A" });
        }
      s.query({ questions: questions.slice(0, 32) });
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
      stop: () =>
        new Promise<void>((done) => {
          clearTimeout(t1);
          clearInterval(t2);
          clearInterval(t3);
          s.destroy(() => done());
        }),
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
