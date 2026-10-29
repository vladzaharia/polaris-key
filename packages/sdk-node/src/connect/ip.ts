// Address text helpers for the LAN adapters (WIRE-CONTRACT-V5 §15.4): canonical text, the
// IPv4-mapped fold and CIDR membership, on Node's own parsers. Kept apart from client-core's
// `lanVerdict`, which only answers for an address it allows; mDNS learning needs the canonical
// form of any address.

import { BlockList, isIPv4, isIPv6 } from "node:net";

/** `addr` without its `%zone`, and the zone (null: none). */
export function splitZone(text: string): { addr: string; zone: string | null } {
  const i = text.indexOf("%");
  return i < 0
    ? { addr: text, zone: null }
    : { addr: text.slice(0, i), zone: text.slice(i + 1) };
}

/**
 * The canonical text of an address: dotted IPv4, or RFC 5952 IPv6 (lower case, the first longest
 * run of zero groups as `::`; the WHATWG URL serializer writes exactly that). Null for text that
 * is not an address; a zone is not accepted here (use `splitZone` first).
 */
export function canonIp(text: string): string | null {
  if (isIPv4(text)) return text;
  if (text.includes("%") || !isIPv6(text)) return null;
  try {
    return new URL(`http://[${text}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

const MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** An IPv4-mapped address (canonical text) as dotted IPv4; anything else unchanged. */
export function foldMapped(canon: string): string {
  const m = MAPPED.exec(canon);
  if (m === null) return canon;
  const [hi, lo] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16)];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Is canonical text an IPv6 link-local address (fe80::/10)? */
export const isLinkLocal = (canon: string): boolean =>
  /^fe[89ab][0-9a-f]:/.test(canon);

/** Is `addr` (text; a zone is ignored; a mapped address counts as its IPv4) inside the CIDR block `cidr` (`10.0.0.5/8`, `fe80::1/64`)? */
export function inCidr(addr: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  const base = canonIp(splitZone(cidr.slice(0, Math.max(slash, 0))).addr);
  const a = canonIp(splitZone(addr).addr);
  if (slash < 0 || base === null || a === null) return false;
  const [x, family] = [
    foldMapped(a),
    base.includes(":") ? "ipv6" : "ipv4",
  ] as const;
  if (x.includes(":") !== (family === "ipv6")) return false;
  try {
    const list = new BlockList();
    list.addSubnet(base, Number(cidr.slice(slash + 1)), family);
    return list.check(x, family);
  } catch {
    return false;
  }
}
