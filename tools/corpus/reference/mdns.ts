// Reference: a small DNS message codec and the mDNS address-learning rule
// (WIRE-CONTRACT-V5 §15.4 "Addresses"; plans/CC-IPV6.md §2, `mdnsAnswers`).
//
// Written from RFC 1035 §4 (names, compression) and RFC 6762 §18 (the mDNS header and the
// cache-flush bit). It shares nothing with `multicast-dns`, `dns-packet` or any SDK's codec, and
// it imports nothing: the encoder builds the vectors and the decoder reads them back, so a row
// that one half cannot round-trip fails the generator.

export type RefDnsType = "A" | "AAAA" | "PTR" | "SRV" | "TXT";

export type RefDnsRecord =
  | { name: string; type: "A" | "AAAA"; ttl: number; address: string }
  | { name: string; type: "PTR"; ttl: number; target: string }
  | {
      name: string;
      type: "SRV";
      ttl: number;
      port: number;
      target: string;
    }
  | { name: string; type: "TXT"; ttl: number; txt: string[] };

export interface RefDnsMessage {
  /** The answer section. */
  answers: RefDnsRecord[];
  /** The additional section. */
  additionals?: RefDnsRecord[];
  /** Compress names against earlier names in the message. Default false. */
  compress?: boolean;
}

const TYPE_CODE: Record<RefDnsType, number> = {
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
};
const CODE_TYPE = new Map<number, RefDnsType>(
  Object.entries(TYPE_CODE).map(([k, v]) => [v, k as RefDnsType]),
);

// ── addresses ────────────────────────────────────────────────────────────────

export function refAddressBytes(text: string): Uint8Array {
  if (!text.includes(":")) {
    const parts = text.split(".");
    if (
      parts.length !== 4 ||
      !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) < 256)
    )
      throw new Error(`mdns reference: not an IPv4 address: ${text}`);
    return Uint8Array.from(parts.map(Number));
  }
  // IPv6: split at "::", expand each side into 16-bit groups. A dotted IPv4 tail
  // (`::ffff:192.168.1.20`) stands for the last two groups.
  const gaps = text.split("::");
  if (gaps.length > 2) throw new Error(`mdns reference: bad IPv6: ${text}`);
  const side = (s: string, last: boolean): number[] => {
    if (s === "") return [];
    const items = s.split(":");
    const out: number[] = [];
    items.forEach((g, i) => {
      if (last && i === items.length - 1 && g.includes(".")) {
        const o = refAddressBytes(g);
        if (o.length !== 4)
          throw new Error(`mdns reference: bad IPv4 tail in ${text}`);
        out.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
        return;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g))
        throw new Error(`mdns reference: bad IPv6 group in ${text}`);
      out.push(parseInt(g, 16));
    });
    return out;
  };
  const head = side(gaps[0]!, gaps.length === 1);
  const tail = gaps.length === 2 ? side(gaps[1]!, true) : [];
  const fill = 8 - head.length - tail.length;
  if ((gaps.length === 2 && fill < 1) || (gaps.length === 1 && fill !== 0))
    throw new Error(`mdns reference: bad IPv6 length: ${text}`);
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  return Uint8Array.from(groups.flatMap((g) => [g >> 8, g & 255]));
}

/** Dotted IPv4, or RFC 5952 IPv6 text (lower case; the first longest run of two or more zero groups becomes `::`). */
export function refAddressText(b: Uint8Array): string {
  if (b.length === 4) return Array.from(b).join(".");
  if (b.length !== 16) throw new Error("mdns reference: not an address");
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((b[i]! << 8) | b[i + 1]!);
  const hex = (xs: number[]): string => xs.map((x) => x.toString(16)).join(":");
  // Longest run first, and the leftmost of equal runs: the first window of zero groups wins.
  for (let len = 8; len >= 2; len--)
    for (let at = 0; at + len <= 8; at++)
      if (g.slice(at, at + len).every((x) => x === 0))
        return `${hex(g.slice(0, at))}::${hex(g.slice(at + len))}`;
  return hex(g);
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// ── encoder ──────────────────────────────────────────────────────────────────

class Writer {
  readonly out: number[] = [];
  /** Lower-case name suffix → offset of its first label, for compression. */
  private readonly seen = new Map<string, number>();
  constructor(private readonly compress: boolean) {}

  u8(n: number): void {
    this.out.push(n & 255);
  }
  u16(n: number): void {
    this.out.push((n >> 8) & 255, n & 255);
  }
  u32(n: number): void {
    this.out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  }
  bytes(b: ArrayLike<number>): void {
    for (let i = 0; i < b.length; i++) this.out.push(b[i]! & 255);
  }

  name(text: string): void {
    const labels = text.split(".");
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join(".").toLowerCase();
      const known = this.seen.get(suffix);
      if (this.compress && known !== undefined) {
        this.u16(0xc000 | known);
        return;
      }
      if (this.out.length < 0x4000) this.seen.set(suffix, this.out.length);
      const l = labels[i]!;
      if (l.length === 0 || l.length > 63 || !/^[\x21-\x7e]+$/.test(l))
        throw new Error(`mdns reference: bad label in ${text}`);
      this.u8(l.length);
      for (const ch of l) this.u8(ch.charCodeAt(0));
    }
    this.u8(0);
  }
}

function writeRecord(w: Writer, r: RefDnsRecord): void {
  w.name(r.name);
  w.u16(TYPE_CODE[r.type]);
  // IN, with the cache-flush bit on every record a responder owns (not on the shared PTR).
  w.u16(r.type === "PTR" ? 1 : 0x8001);
  w.u32(r.ttl);
  // RDLENGTH is patched once the data is written (names inside it may be compressed).
  const lenAt = w.out.length;
  w.u16(0);
  const start = w.out.length;
  switch (r.type) {
    case "A":
    case "AAAA": {
      const b = refAddressBytes(r.address);
      if (b.length !== (r.type === "A" ? 4 : 16))
        throw new Error(`mdns reference: ${r.type} given ${r.address}`);
      w.bytes(b);
      break;
    }
    case "PTR":
      w.name(r.target);
      break;
    case "SRV":
      w.u16(0);
      w.u16(0);
      w.u16(r.port);
      w.name(r.target);
      break;
    case "TXT":
      if (r.txt.length === 0) w.u8(0);
      for (const s of r.txt) {
        w.u8(s.length);
        for (const ch of s) w.u8(ch.charCodeAt(0));
      }
      break;
  }
  const n = w.out.length - start;
  w.out[lenAt] = (n >> 8) & 255;
  w.out[lenAt + 1] = n & 255;
}

/** An mDNS response (id 0, QR and AA set, no questions). */
export function refDnsEncode(m: RefDnsMessage): Uint8Array {
  const w = new Writer(m.compress === true);
  const ad = m.additionals ?? [];
  w.u16(0);
  w.u16(0x8400);
  w.u16(0);
  w.u16(m.answers.length);
  w.u16(0);
  w.u16(ad.length);
  for (const r of m.answers) writeRecord(w, r);
  for (const r of ad) writeRecord(w, r);
  return Uint8Array.from(w.out);
}

// ── decoder ──────────────────────────────────────────────────────────────────

export interface RefDecodedRecord {
  section: "answer" | "authority" | "additional";
  name: string;
  /** `null` for a type this reference does not read. */
  type: RefDnsType | null;
  ttl: number;
  /** A and AAAA: the 4 or 16 address bytes. */
  address?: Uint8Array;
  /** PTR and SRV: the target name. */
  target?: string;
  port?: number;
  txt?: string[];
}

export function refDnsDecode(p: Uint8Array): {
  response: boolean;
  records: RefDecodedRecord[];
} {
  const bad = (why: string): never => {
    throw new Error(`mdns reference: malformed packet (${why})`);
  };
  let at = 0;
  const u8 = (): number => {
    if (at >= p.length) bad("short");
    return p[at++]!;
  };
  const u16 = (): number => (u8() << 8) | u8();
  const u32 = (): number => ((u16() << 16) | u16()) >>> 0;

  /** Read a name at `pos`; return it and the position just after it (before any pointer's target). */
  const nameAt = (pos: number): { text: string; next: number } => {
    const labels: string[] = [];
    let next = -1;
    let cur = pos;
    for (let hops = 0; hops < 64; hops++) {
      if (cur >= p.length) bad("name past end");
      const len = p[cur]!;
      if (len === 0)
        return { text: labels.join("."), next: next < 0 ? cur + 1 : next };
      if ((len & 0xc0) === 0xc0) {
        if (cur + 1 >= p.length) bad("short pointer");
        const to = ((len & 0x3f) << 8) | p[cur + 1]!;
        // A pointer goes strictly backwards, so a name cannot loop.
        if (to >= cur) bad("forward pointer");
        if (next < 0) next = cur + 2;
        cur = to;
        continue;
      }
      if ((len & 0xc0) !== 0) bad("label type");
      if (cur + 1 + len > p.length) bad("label past end");
      labels.push(String.fromCharCode(...p.subarray(cur + 1, cur + 1 + len)));
      cur += 1 + len;
    }
    return bad("too many hops");
  };

  u16(); // id
  const flags = u16();
  const qd = u16();
  const an = u16();
  const ns = u16();
  const ar = u16();
  for (let i = 0; i < qd; i++) {
    at = nameAt(at).next;
    u16();
    u16();
  }
  const records: RefDecodedRecord[] = [];
  const sections: [RefDecodedRecord["section"], number][] = [
    ["answer", an],
    ["authority", ns],
    ["additional", ar],
  ];
  for (const [section, count] of sections)
    for (let i = 0; i < count; i++) {
      const n = nameAt(at);
      at = n.next;
      const code = u16();
      u16(); // class, with the cache-flush bit
      const ttl = u32();
      const rdlen = u16();
      const end = at + rdlen;
      if (end > p.length) bad("rdata past end");
      const type = CODE_TYPE.get(code) ?? null;
      const rec: RefDecodedRecord = { section, name: n.text, type, ttl };
      if (type === "A" || type === "AAAA") {
        if (rdlen !== (type === "A" ? 4 : 16)) bad("address length");
        rec.address = p.slice(at, end);
      } else if (type === "PTR") {
        rec.target = nameAt(at).text;
      } else if (type === "SRV") {
        if (rdlen < 7) bad("short SRV");
        rec.port = (p[at + 4]! << 8) | p[at + 5]!;
        rec.target = nameAt(at + 6).text;
      } else if (type === "TXT") {
        rec.txt = [];
        for (let o = at; o < end; ) {
          const l = p[o]!;
          if (o + 1 + l > end) bad("TXT string past end");
          if (l > 0 || rdlen > 1)
            rec.txt.push(String.fromCharCode(...p.subarray(o + 1, o + 1 + l)));
          o += 1 + l;
        }
      }
      records.push(rec);
      at = end;
    }
  return { response: (flags & 0x8000) !== 0, records };
}

// ── the learning rule ────────────────────────────────────────────────────────

export interface RefLearned {
  name: string;
  address: string;
}

/** The most addresses one name keeps. */
export const REF_MAX_ADDRESSES = 4;

/** ASCII fold: `A-Z` to `a-z` and nothing else (a name is not Unicode-folded). */
export const refFoldName = (name: string): string =>
  name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** An IPv4-mapped source (`::ffff:a.b.c.d`) is judged as its IPv4 address (§15.4.1). */
function foldMapped(b: Uint8Array): Uint8Array {
  return b.length === 16 &&
    b.subarray(0, 10).every((x) => x === 0) &&
    b[10] === 0xff &&
    b[11] === 0xff
    ? b.slice(12)
    : b;
}

/**
 * §15.4 "Addresses": a browser believes an A or AAAA record only when its address equals the
 * packet's source address, and that is the only test when it learns (the dial-time check of
 * §15.4.1 decides what may be dialled). An IPv4-mapped source is judged as its IPv4 address. A
 * link-local address (`fe80::/10`) takes the arrival interface as its zone. A name keeps at most
 * 4 addresses, of any family, in first-seen order. An address record with a TTL of 0 removes the
 * address it names (the same address, with the same zone), under the same equality rule. Names
 * compare case-insensitively by ASCII fold and are held in lower case. Records are applied in
 * packet order. `prior` is what the browser already held (in first-seen order); the result is the
 * table after this packet.
 *
 * The record's section (answer or additional) does not matter, and neither does a goodbye
 * (TTL 0) on a PTR: only address records teach or remove addresses.
 */
export function refMdnsLearn(
  packet: Uint8Array,
  source: string,
  zone: string | null,
  prior: RefLearned[],
): RefLearned[] {
  let table = prior.map((l) => ({
    name: refFoldName(l.name),
    address: l.address,
  }));
  const src = foldMapped(refAddressBytes(source));
  for (const r of refDnsDecode(packet).records) {
    if ((r.type !== "A" && r.type !== "AAAA") || r.address === undefined)
      continue;
    if (!sameBytes(r.address, src)) continue;
    const name = refFoldName(r.name);
    const text = refAddressText(r.address);
    const linkLocal =
      r.address.length === 16 &&
      r.address[0] === 0xfe &&
      (r.address[1]! & 0xc0) === 0x80;
    const address = linkLocal && zone !== null ? `${text}%${zone}` : text;
    if (r.ttl === 0) {
      table = table.filter((l) => !(l.name === name && l.address === address));
      continue;
    }
    if (table.some((l) => l.name === name && l.address === address)) continue;
    if (table.filter((l) => l.name === name).length >= REF_MAX_ADDRESSES)
      continue;
    table.push({ name, address });
  }
  return table;
}
