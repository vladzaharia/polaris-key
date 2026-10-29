// Reference: the LAN address rule (WIRE-CONTRACT-V5 §15.4.1; plans/CC-IPV6.md §1).
//
// `lanVerdict(remote, local, allowLoopback)` answers whether a socket's peer may be dialled or
// accepted, and the key of the per-address connection count (G7). Written from the specification
// over 128-bit integers (BigInt), so it shares nothing with client-core's `peer/lanAddress.ts`,
// which works on eight 16-bit groups.

import { isIPv4, isIPv6 } from "node:net";

export interface RefLanVerdict {
  dial: boolean;
  /** The G7 count key: dotted IPv4 or RFC 5952 IPv6 text, no zone. `null` when `dial` is false. */
  key: string | null;
}

type Parsed = { v4: number } | { v6: bigint };

// Validation is `node:net`'s (the platform's own reading of IPv4 and IPv6 text); the value is
// built here, as one integer, so the rule below shares nothing with client-core's group arrays.
function parseV4(s: string): number | null {
  if (!isIPv4(s)) return null;
  return s.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}

function parseV6(s: string): bigint | null {
  if (!isIPv6(s)) return null;
  // Turn a dotted tail into two hex groups, then fill `::` with zero groups.
  const dot = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  let t = s;
  if (dot !== null) {
    const v4 = parseV4(dot[2]!)!;
    t = `${dot[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
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
  // A zone belongs to an IPv6 address only, and is not empty. It is ignored.
  const [bare = "", ...zone] = text.split("%");
  if (zone.length > 0 && (zone[0] === "" || !bare.includes(":"))) return null;
  if (bare.includes(":")) {
    const n = parseV6(bare);
    if (n === null) return null;
    // ::ffff:0:0/96 is the same address as its IPv4 form.
    return n >> 32n === 0xffffn ? { v4: Number(n & 0xffffffffn) } : { v6: n };
  }
  const v4 = parseV4(bare);
  return v4 === null ? null : { v4 };
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

export function refLanVerdict(
  remote: string,
  local: string | null | undefined,
  allowLoopback: boolean,
): RefLanVerdict {
  const no: RefLanVerdict = { dial: false, key: null };
  const r = parse(remote);
  if (r === null) return no;
  if ("v4" in r)
    return allowed4(r.v4, allowLoopback)
      ? { dial: true, key: dotted(r.v4) }
      : no;
  const n = r.v6;
  const yes: RefLanVerdict = { dial: true, key: text6(n) };
  if (n === 1n) return allowLoopback ? yes : no; // ::1
  if (top(n, 10) === 0x3fan) return yes; // fe80::/10
  if (top(n, 7) === 0x7en) return yes; // fc00::/7
  if (top(n, 3) !== 1n) return no; // not 2000::/3
  if (top(n, 32) === 0x20010000n) return no; // Teredo 2001::/32
  if (top(n, 16) === 0x2002n) return no; // 6to4 2002::/16
  if (local === null || local === undefined) return no;
  const l = parse(local);
  if (l === null || !("v6" in l)) return no;
  return top(l.v6, 64) === top(n, 64) ? yes : no;
}
