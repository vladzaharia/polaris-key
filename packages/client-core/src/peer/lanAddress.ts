// The LAN address rule (WIRE-CONTRACT-V5 §15.4.1): which peer address a device may dial or
// accept on the local network, and the keys of the per-address and per-group connection counts.
//
// Pure and isomorphic: text in, a verdict out. The caller passes the connected socket's remote
// address and its own local address (the on-link tests for a ULA and a global IPv6 address need
// it), and applies the verdict before the first byte on a dial and before a slot and before any
// read on an accept.
//
// - Spelling: a zone is `%` and 1 to 15 characters of U+0021 to U+007E other than `%`; any other
//   zone, a second `%`, a zone on IPv4 and a zone on an IPv4-mapped address are malformed. The
//   verdict ignores a zone; the key of a link-local address keeps it.
// - An IPv4-mapped address (::ffff:0:0/96) is judged as its IPv4 address.
// - IPv4: 10/8, 172.16/12 and 192.168/16; 127/8 only with `allowLoopback`.
// - IPv6: fe80::/10; fc00::/7 (when `local` is known it must be IPv6 in the same /64); ::1 only
//   with `allowLoopback`; an address in 2000::/3 outside 2001::/32 (Teredo) and 2002::/16 (6to4)
//   only when the local address is IPv6 in the same /64.
// - Everything else is refused, including text that is not an address.
//
// `candidateTarget` is the rule for a CANDIDATES entry (§15.6): spelling, port, and a connected
// subnet of an up, non-tunnel local interface.

export interface LanVerdict {
  /** The address may be dialled or accepted. */
  dial: boolean;
  /**
   * The per-address count key: dotted IPv4, or RFC 5952 lower-case IPv6 text; a link-local
   * address keeps its zone (`fe80::1%en0`), any other drops it. `null` when `dial` is false. It
   * is the full address, never the /64.
   */
  key: string | null;
}

/** Eight 16-bit groups, or four IPv4 octets. */
type Addr = { v4: number[] } | { v6: number[] };

function parseV4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    // Decimal, no sign and no leading zero (some parsers read a leading zero as octal).
    if (!/^(?:0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** `fe80::1`, `::ffff:1.2.3.4`, a full eight-group form: groups, or null. */
function parseV6(s: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string, last: boolean): number[] | null => {
    if (part === "") return [];
    const items = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.includes(".")) {
        // Dotted IPv4 closes the address and stands for two groups.
        if (!last || i !== items.length - 1) return null;
        const o = parseV4(it);
        if (o === null) return null;
        out.push(o[0]! * 256 + o[1]!, o[2]! * 256 + o[3]!);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(it)) out.push(parseInt(it, 16));
      else return null;
    }
    return out;
  };
  if (halves.length === 1) {
    const g = groups(s, true);
    return g !== null && g.length === 8 ? g : null;
  }
  const head = groups(halves[0]!, false);
  const tail = groups(halves[1]!, true);
  if (head === null || tail === null) return null;
  // `::` stands for one or more zero groups.
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/** §15.4.1: 1 to 15 characters of U+0021 to U+007E other than `%`. */
const ZONE = /^[\u0021-\u0024\u0026-\u007e]{1,15}$/;

interface Parsed {
  addr: Addr;
  zone: string | null;
}

function parse(text: string): Parsed | null {
  let s = text;
  let zone: string | null = null;
  const pct = s.indexOf("%");
  if (pct >= 0) {
    zone = s.slice(pct + 1);
    if (!ZONE.test(zone)) return null; // empty, a second `%`, a control, a space, too long
    s = s.slice(0, pct);
    if (!s.includes(":")) return null; // only IPv6 carries a zone
  }
  if (s.includes(":")) {
    const g = parseV6(s);
    if (g === null) return null;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      if (zone !== null) return null; // a zone on a mapped address is ambiguous
      return {
        addr: { v4: [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255] },
        zone: null,
      };
    }
    return { addr: { v6: g }, zone };
  }
  const o = parseV4(s);
  return o === null ? null : { addr: { v4: o }, zone: null };
}

/** RFC 5952: lower case, no leading zeros, the first longest run of two or more zero groups is `::`. */
function text6(g: number[]): string {
  let at = -1;
  let len = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > len) {
      at = i;
      len = j - i;
    }
    i = j;
  }
  const join = (xs: number[]): string =>
    xs.map((x) => x.toString(16)).join(":");
  return len < 2
    ? join(g)
    : `${join(g.slice(0, at))}::${join(g.slice(at + len))}`;
}

function allowed4(o: number[], allowLoopback: boolean): boolean {
  const [a, b] = [o[0]!, o[1]!];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a === 127 && allowLoopback;
}

/**
 * Judge a peer address.
 *
 * @param remote the connected socket's remote address, with or without a zone
 * @param local the socket's own local address; `null` or `undefined` when unknown (a global
 *   IPv6 address is then refused, and a ULA address is judged on its own)
 * @param allowLoopback accept 127/8 and ::1. Tests and same-host peers only: production code
 *   never sets it and it is not public API
 */
export function lanVerdict(
  remote: string,
  local: string | null | undefined,
  allowLoopback: boolean,
): LanVerdict {
  const refuse: LanVerdict = { dial: false, key: null };
  const p = parse(remote);
  if (p === null) return refuse;
  const r = p.addr;
  if ("v4" in r)
    return allowed4(r.v4, allowLoopback)
      ? { dial: true, key: r.v4.join(".") }
      : refuse;
  const g = r.v6;
  const accept: LanVerdict = { dial: true, key: text6(g) };
  const g0 = g[0]!;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)
    return allowLoopback ? accept : refuse; // ::1
  if ((g0 & 0xffc0) === 0xfe80)
    return {
      dial: true,
      key: p.zone === null ? text6(g) : `${text6(g)}%${p.zone}`,
    }; // fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) {
    // fc00::/7 is routed, so it is on-link only when the local address says so.
    if (local === null || local === undefined) return accept;
    return sameSlash64(g, local) ? accept : refuse;
  }
  if ((g0 & 0xe000) !== 0x2000) return refuse; // not 2000::/3
  if (g0 === 0x2001 && g[1] === 0) return refuse; // Teredo 2001::/32
  if (g0 === 0x2002) return refuse; // 6to4 2002::/16
  if (local === null || local === undefined) return refuse;
  return sameSlash64(g, local) ? accept : refuse;
}

/** `local` is IPv6 (not mapped) and shares the first 64 bits with `g`. */
function sameSlash64(g: number[], local: string): boolean {
  const l = parse(local);
  if (l === null || !("v6" in l.addr)) return false;
  return l.addr.v6.slice(0, 4).every((x, i) => x === g[i]);
}

/**
 * The key of the per-group count (§15.4.1) for a verdict `key`: `fe80::/10%zone` for a link-local
 * address (`fe80::/10` when the key has no zone), `a.b.c.0/24` for IPv4, the /64
 * (`2001:db8:1:2::/64`) for any other IPv6 address; `null` for no key. One neighbour cannot rotate
 * out of its link, its /24 or its /64 by changing source address.
 */
export function lanGroupKey(key: string | null): string | null {
  if (key === null) return null;
  const p = parse(key);
  if (p === null) return null;
  if ("v4" in p.addr) return `${p.addr.v4.slice(0, 3).join(".")}.0/24`;
  const g = p.addr.v6;
  if ((g[0]! & 0xffc0) === 0xfe80)
    return p.zone === null ? "fe80::/10" : `fe80::/10%${p.zone}`;
  return `${text6([...g.slice(0, 4), 0, 0, 0, 0])}/64`;
}

/** One address of a local interface, as the platform reports it. */
export interface LocalInterfaceAddress {
  address: string;
  /** The prefix length of the connected subnet. */
  prefix: number;
  up: boolean;
  /** A VPN, tunnel, point-to-point or pseudo-interface (Teredo, 6to4, ISATAP). */
  tunnel: boolean;
}

export interface CandidateTarget {
  /** The address to connect to: dotted IPv4 or RFC 5952 IPv6 text, never a zone. */
  host: string;
  port: number;
}

/** `a.b.c.d:port` or `[addr]:port` with a literal-only port: 1024 to 65535, no sign or zero. */
function splitEntry(entry: string): { host: string; port: number } | null {
  const m = /^(?:\[([^\][]*)\]|([0-9.]+)):([1-9][0-9]{3,4})$/.exec(entry);
  if (m === null) return null;
  const port = Number(m[3]);
  if (port < 1024 || port > 65535) return null;
  const bracket = m[1] !== undefined;
  const host = (bracket ? m[1] : m[2])!;
  // Brackets mean IPv6 and only IPv6.
  if (bracket !== host.includes(":")) return null;
  return { host, port };
}

function inSubnet(a: Addr, net: Addr, prefix: number): boolean {
  if ("v4" in a && "v4" in net) {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const x = a.v4.reduce((n, o) => n * 256 + o, 0);
    const y = net.v4.reduce((n, o) => n * 256 + o, 0);
    return (
      prefix === 0 ||
      Math.floor(x / 2 ** (32 - prefix)) === Math.floor(y / 2 ** (32 - prefix))
    );
  }
  if ("v6" in a && "v6" in net) {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
    for (let i = 0; i < 8 && prefix > 0; i++, prefix -= 16) {
      const bits = Math.min(prefix, 16);
      const shift = 16 - bits;
      if (a.v6[i]! >> shift !== net.v6[i]! >> shift) return false;
    }
    return true;
  }
  return false;
}

const canonical = (a: Addr): string =>
  "v4" in a ? a.v4.join(".") : text6(a.v6);

/**
 * §15.6, CANDIDATES addresses: the target a receiver may dial for one `addrs` entry, or `null`.
 * The entry's spelling is fixed (`a.b.c.d:port`, `[addr]:port` in RFC 5952 text with no zone, no
 * IPv4-mapped form and no `fe80::/10`), the port is 1024 to 65535, the address is not one of the
 * device's own and it lies in a connected subnet of an up, non-tunnel interface whose own
 * address then passes `lanVerdict` as `local`.
 */
export function candidateTarget(
  entry: string,
  interfaces: readonly LocalInterfaceAddress[],
): CandidateTarget | null {
  const e = splitEntry(entry);
  if (e === null) return null;
  const p = parse(e.host);
  if (p === null || p.zone !== null) return null;
  const a = p.addr;
  if ("v6" in a) {
    if (text6(a.v6) !== e.host) return null; // not RFC 5952 text
    if ((a.v6[0]! & 0xffc0) === 0xfe80) return null; // link-local means nothing off its link
  } else if (a.v4.join(".") !== e.host) return null;
  const own = interfaces.map((i) => parse(i.address));
  if (own.some((o) => o !== null && canonical(o.addr) === canonical(a)))
    return null;
  for (const i of interfaces) {
    if (!i.up || i.tunnel) continue;
    const l = parse(i.address);
    if (l === null || !inSubnet(a, l.addr, i.prefix)) continue;
    if (lanVerdict(e.host, i.address, false).dial)
      return { host: e.host, port: e.port };
  }
  return null;
}
