// Address text helpers for the LAN adapters (WIRE-CONTRACT-V5 §15.4): strict parsing, RFC 5952
// text and CIDR membership. Kept apart from client-core's `lanVerdict`, which only answers for an
// address it allows; mDNS learning needs the canonical form of any address.

/** Four octets (IPv4) or sixteen bytes (IPv6); null when `text` is not an address. A zone is not accepted. */
export function ipBytes(text: string): Uint8Array | null {
  if (!text.includes(":")) {
    const parts = text.split(".");
    if (parts.length !== 4) return null;
    const out: number[] = [];
    for (const p of parts) {
      if (!/^(?:0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return null;
      out.push(Number(p));
    }
    return Uint8Array.from(out);
  }
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const side = (s: string, last: boolean): number[] | null => {
    if (s === "") return [];
    const items = s.split(":");
    const out: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.includes(".")) {
        if (!last || i !== items.length - 1) return null;
        const o = ipBytes(it);
        if (o === null || o.length !== 4) return null;
        out.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(it)) out.push(parseInt(it, 16));
      else return null;
    }
    return out;
  };
  const head = side(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? side(halves[1]!, true) : [];
  if (head === null || tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const g = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  return Uint8Array.from(g.flatMap((x) => [x >> 8, x & 255]));
}

/** An IPv4-mapped address (::ffff:a.b.c.d) as its IPv4 bytes; anything else unchanged. */
export function foldMapped(b: Uint8Array): Uint8Array {
  return b.length === 16 &&
    b.subarray(0, 10).every((x) => x === 0) &&
    b[10] === 0xff &&
    b[11] === 0xff
    ? b.slice(12)
    : b;
}

/** Dotted IPv4, or RFC 5952 IPv6 text: lower case, the first longest run of two or more zero groups is `::`. */
export function ipText(b: Uint8Array): string {
  if (b.length === 4) return Array.from(b).join(".");
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((b[i]! << 8) | b[i + 1]!);
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

/** `addr` without its `%zone`, and the zone (null: none). */
export function splitZone(text: string): { addr: string; zone: string | null } {
  const i = text.indexOf("%");
  return i < 0
    ? { addr: text, zone: null }
    : { addr: text.slice(0, i), zone: text.slice(i + 1) };
}

/** Is `addr` (text, a zone is ignored) inside the CIDR block `cidr` (`10.0.0.5/8`, `fe80::1/64`)? */
export function inCidr(addr: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash < 0) return false;
  const a = ipBytes(splitZone(addr).addr);
  const n = ipBytes(splitZone(cidr.slice(0, slash)).addr);
  const prefix = Number(cidr.slice(slash + 1));
  if (a === null || n === null || !Number.isInteger(prefix) || prefix < 0)
    return false;
  const x = foldMapped(a);
  if (x.length !== n.length || prefix > n.length * 8) return false;
  for (let i = 0; i < prefix; i++) {
    const m = 0x80 >> (i % 8);
    if ((x[i >> 3]! & m) !== (n[i >> 3]! & m)) return false;
  }
  return true;
}
