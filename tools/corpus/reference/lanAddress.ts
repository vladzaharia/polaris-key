// Reference: the LAN address rule (WIRE-CONTRACT-V5 §15.4.1; plans/CC-IPV6.md §1).
//
// `lanVerdict(remote, local, allowLoopback)` answers whether a socket's peer may be dialled or
// accepted, and the key of the per-address connection count (G7). `refGroupKey` is the per-group
// count's key and `refCandidateTarget` the rule for a CANDIDATES entry. Written from the
// specification over 128-bit integers (BigInt), so it shares nothing with client-core's
// `peer/lanAddress.ts`, which works on eight 16-bit groups.
//
// The address grammar is vendored here, not taken from the platform: it is RFC 3986 section 3.2.2
// `IPv6address` (the RFC 4291 text forms) and `IPv4address` written out as regular expressions,
// so a Node upgrade cannot change what the corpus accepts.

export interface RefLanVerdict {
  dial: boolean;
  /** The G7 count key: dotted IPv4 or RFC 5952 IPv6 text; a link-local key keeps its zone. `null` when `dial` is false. */
  key: string | null;
}

export interface RefInterface {
  address: string;
  prefix: number;
  up: boolean;
  tunnel: boolean;
}

// RFC 3986: dec-octet, IPv4address, h16, ls32 and the nine IPv6address alternatives.
const DEC = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const V4 = `${DEC}\\.${DEC}\\.${DEC}\\.${DEC}`;
const H = "[0-9A-Fa-f]{1,4}";
const LS32 = `(?:${H}:${H}|${V4})`;
const V6 = new RegExp(
  `^(?:${[
    `(?:${H}:){6}${LS32}`,
    `::(?:${H}:){5}${LS32}`,
    `(?:${H})?::(?:${H}:){4}${LS32}`,
    `(?:(?:${H}:){0,1}${H})?::(?:${H}:){3}${LS32}`,
    `(?:(?:${H}:){0,2}${H})?::(?:${H}:){2}${LS32}`,
    `(?:(?:${H}:){0,3}${H})?::${H}:${LS32}`,
    `(?:(?:${H}:){0,4}${H})?::${LS32}`,
    `(?:(?:${H}:){0,5}${H})?::${H}`,
    `(?:(?:${H}:){0,6}${H})?::`,
  ].join("|")})$`,
);
const V4_RE = new RegExp(`^${V4}$`);
// §15.4.1: a zone is 1 to 15 characters of U+0021 to U+007E other than `%`.
const ZONE_RE = /^[!-$&-~]{1,15}$/;

type Parsed =
  | { kind: "v4"; n: number }
  | { kind: "v6"; n: bigint; zone: string | null };

function v4Value(s: string): number {
  return s.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}

function v6Value(s: string): bigint {
  // A dotted tail becomes two hex groups, then `::` is filled with zero groups.
  const dot = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  let t = s;
  if (dot !== null) {
    const v = v4Value(dot[2]!);
    t = `${dot[1]}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const [head = "", tail] = t.split("::");
  const side = (x: string): string[] => (x === "" ? [] : x.split(":"));
  const h = side(head);
  const rest = tail === undefined ? [] : side(tail);
  const zeros =
    tail === undefined
      ? []
      : new Array<string>(8 - h.length - rest.length).fill("0");
  return [...h, ...zeros, ...rest].reduce(
    (n, g) => (n << 16n) | BigInt(parseInt(g, 16)),
    0n,
  );
}

function parse(text: string): Parsed | null {
  const i = text.indexOf("%");
  const bare = i < 0 ? text : text.slice(0, i);
  const zone = i < 0 ? null : text.slice(i + 1);
  if (zone !== null && (!ZONE_RE.test(zone) || !bare.includes(":")))
    return null;
  if (bare.includes(":")) {
    if (!V6.test(bare)) return null;
    const n = v6Value(bare);
    // ::ffff:0:0/96 is the same address as its IPv4 form; with a zone it is ambiguous.
    if (n >> 32n === 0xffffn)
      return zone !== null ? null : { kind: "v4", n: Number(n & 0xffffffffn) };
    return { kind: "v6", n, zone };
  }
  return V4_RE.test(bare) ? { kind: "v4", n: v4Value(bare) } : null;
}

const dotted = (n: number): string =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** RFC 5952: lower case, no leading zeros, the first longest run of two or more zero groups as `::`. */
function text6(n: bigint): string {
  const full = Array.from({ length: 8 }, (_, i) =>
    ((n >> BigInt((7 - i) * 16)) & 0xffffn).toString(16),
  ).join(":");
  // Runs of zero groups, as the text of the whole address; a strictly longer run wins, so ties keep the first.
  let best: { at: number; len: number } | null = null;
  for (const m of full.matchAll(/(?<=^|:)0(?::0)+(?=:|$)/g))
    if (best === null || m[0].length > best.len)
      best = { at: m.index, len: m[0].length };
  if (best === null) return full;
  const left = full.slice(0, best.at).replace(/:$/, "");
  const right = full.slice(best.at + best.len).replace(/^:/, "");
  return `${left}::${right}`;
}

const inRange = (n: number, prefix: number, bits: number): boolean =>
  n >>> (32 - bits) === prefix >>> (32 - bits);
const top = (n: bigint, bits: number): bigint => n >> BigInt(128 - bits);

function allowed4(n: number, allowLoopback: boolean): boolean {
  if (inRange(n, 0x0a000000, 8)) return true; // 10/8
  if (inRange(n, 0xac100000, 12)) return true; // 172.16/12
  if (inRange(n, 0xc0a80000, 16)) return true; // 192.168/16
  return allowLoopback && inRange(n, 0x7f000000, 8);
}

function sameSlash64(n: bigint, local: string): boolean {
  const l = parse(local);
  return l !== null && l.kind === "v6" && top(l.n, 64) === top(n, 64);
}

export function refLanVerdict(
  remote: string,
  local: string | null | undefined,
  allowLoopback: boolean,
): RefLanVerdict {
  const no: RefLanVerdict = { dial: false, key: null };
  const r = parse(remote);
  if (r === null) return no;
  if (r.kind === "v4")
    return allowed4(r.n, allowLoopback) ? { dial: true, key: dotted(r.n) } : no;
  const n = r.n;
  const yes: RefLanVerdict = { dial: true, key: text6(n) };
  if (n === 1n) return allowLoopback ? yes : no; // ::1
  if (top(n, 10) === 0x3fan)
    return {
      dial: true,
      key: r.zone === null ? text6(n) : `${text6(n)}%${r.zone}`,
    }; // fe80::/10
  if (top(n, 7) === 0x7en) {
    // fc00::/7 is routed: with a known local address it must be IPv6 in the same /64.
    if (local === null || local === undefined) return yes;
    return sameSlash64(n, local) ? yes : no;
  }
  if (top(n, 3) !== 1n) return no; // not 2000::/3
  if (top(n, 32) === 0x20010000n) return no; // Teredo 2001::/32
  if (top(n, 16) === 0x2002n) return no; // 6to4 2002::/16
  if (local === null || local === undefined) return no;
  return sameSlash64(n, local) ? yes : no;
}

/**
 * The per-group count key of a verdict key (§15.4.1): `fe80::/10%zone` for a link-local address
 * (`fe80::/10` with no zone), `a.b.c.0/24` for IPv4, `<masked address>/64` for any other IPv6
 * address; `null` for no key.
 */
export function refGroupKey(key: string | null): string | null {
  if (key === null) return null;
  const p = parse(key);
  if (p === null) return null;
  if (p.kind === "v4") return `${key.split(".").slice(0, 3).join(".")}.0/24`;
  if (top(p.n, 10) === 0x3fan)
    return p.zone === null ? "fe80::/10" : `fe80::/10%${p.zone}`;
  return `${text6((p.n >> 64n) << 64n)}/64`;
}

export interface RefCandidate {
  host: string;
  port: number;
}

function inNet(a: Parsed, net: Parsed, prefix: number): boolean {
  if (a.kind === "v4" && net.kind === "v4") {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    return (
      BigInt(a.n) >> BigInt(32 - prefix) ===
      BigInt(net.n) >> BigInt(32 - prefix)
    );
  }
  if (a.kind === "v6" && net.kind === "v6") {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
    return a.n >> BigInt(128 - prefix) === net.n >> BigInt(128 - prefix);
  }
  return false;
}

const same = (a: Parsed, b: Parsed): boolean =>
  a.kind === b.kind && a.n === b.n;

/**
 * A CANDIDATES `addrs` entry (§15.6): the target to dial, or `null`. Spelling first (IPv4
 * `a.b.c.d:port`, IPv6 `[addr]:port` in RFC 5952 text, no zone, no mapped form, no `fe80::/10`,
 * port 1024 to 65535 in plain decimal), then: not a local address, and inside a connected subnet
 * of an up, non-tunnel interface whose address passes `lanVerdict` as `local`.
 */
export function refCandidateTarget(
  entry: string,
  interfaces: readonly RefInterface[],
): RefCandidate | null {
  const m = /^(?:\[([^\][]*)\]|([^\][:]*)):([^:\][]*)$/.exec(entry);
  if (m === null) return null;
  const bracketed = m[1] !== undefined;
  const host = (bracketed ? m[1] : m[2])!;
  if (!/^[1-9][0-9]{3,4}$/.test(m[3]!)) return null;
  const port = Number(m[3]);
  if (port < 1024 || port > 65535) return null;
  if (bracketed !== host.includes(":")) return null;
  if (host.includes("%")) return null;
  const a = parse(host);
  if (a === null) return null;
  if (a.kind === "v4" && dotted(a.n) !== host) return null;
  if (a.kind === "v6" && (text6(a.n) !== host || top(a.n, 10) === 0x3fan))
    return null;
  const nets = interfaces.map((i) => ({ i, p: parse(i.address) }));
  if (nets.some(({ p }) => p !== null && same(p, a))) return null;
  for (const { i, p } of nets) {
    if (!i.up || i.tunnel || p === null || !inNet(a, p, i.prefix)) continue;
    if (refLanVerdict(host, i.address, false).dial) return { host, port };
  }
  return null;
}
