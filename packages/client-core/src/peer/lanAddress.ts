// The LAN address rule (WIRE-CONTRACT-V5 §15.4.1): which peer address a device may dial or
// accept on the local network, and the key of the per-address connection count (G7).
//
// Pure and isomorphic: text in, a verdict out. The caller passes the connected socket's remote
// address and its own local address (the on-link test for a global IPv6 address needs it), and
// applies the verdict before the first byte on a dial and before a slot on an accept.
//
// - A zone (`%en0`) is ignored by the verdict and by the key. An empty zone is malformed.
// - An IPv4-mapped address (::ffff:0:0/96) is judged as its IPv4 address.
// - IPv4: 10/8, 172.16/12 and 192.168/16; 127/8 only with `allowLoopback`.
// - IPv6: fe80::/10 and fc00::/7; ::1 only with `allowLoopback`; an address in 2000::/3 outside
//   2001::/32 (Teredo) and 2002::/16 (6to4) only when the local address is IPv6 in the same /64.
// - Everything else is refused, including text that is not an address.

export interface LanVerdict {
  /** The address may be dialled or accepted. */
  dial: boolean;
  /**
   * The per-address count key: dotted IPv4, or RFC 5952 lower-case IPv6 text without a zone.
   * `null` when `dial` is false. It is the full address, never the /64.
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

function parse(text: string): Addr | null {
  let s = text;
  const pct = s.indexOf("%");
  if (pct >= 0) {
    if (pct === s.length - 1) return null; // an empty zone
    s = s.slice(0, pct);
    if (!s.includes(":")) return null; // only IPv6 carries a zone
  }
  if (s.includes(":")) {
    const g = parseV6(s);
    if (g === null) return null;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
      return { v4: [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255] };
    return { v6: g };
  }
  const o = parseV4(s);
  return o === null ? null : { v4: o };
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
 *   IPv6 address is then refused)
 * @param allowLoopback accept 127/8 and ::1 (tests and same-host peers only)
 */
export function lanVerdict(
  remote: string,
  local: string | null | undefined,
  allowLoopback: boolean,
): LanVerdict {
  const refuse: LanVerdict = { dial: false, key: null };
  const r = parse(remote);
  if (r === null) return refuse;
  if ("v4" in r)
    return allowed4(r.v4, allowLoopback)
      ? { dial: true, key: r.v4.join(".") }
      : refuse;
  const g = r.v6;
  const accept: LanVerdict = { dial: true, key: text6(g) };
  const g0 = g[0]!;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)
    return allowLoopback ? accept : refuse; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return accept; // fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return accept; // fc00::/7
  if ((g0 & 0xe000) !== 0x2000) return refuse; // not 2000::/3
  if (g0 === 0x2001 && g[1] === 0) return refuse; // Teredo 2001::/32
  if (g0 === 0x2002) return refuse; // 6to4 2002::/16
  if (local === null || local === undefined) return refuse;
  const l = parse(local);
  if (l === null || !("v6" in l)) return refuse;
  return l.v6.slice(0, 4).every((x, i) => x === g[i]) ? accept : refuse;
}
