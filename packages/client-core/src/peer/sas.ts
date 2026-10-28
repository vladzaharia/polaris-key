// WIRE-CONTRACT-V5 §15.5: the short authentication code of modes v and p, with its commit and
// reveal. Nonces and commitments travel as 43 canonical base64url characters.

import { hkdfSha256, sha256 } from "./noise.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const sasCommit = (nD: Uint8Array): Promise<Uint8Array> => sha256(nD);

function b64u(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 bytes as 43 base64url characters. */
export function encodeSasValue(b: Uint8Array): string {
  if (b.length !== 32) throw new RangeError("sas value");
  return b64u(b);
}

/** 43 canonical base64url characters to 32 bytes; anything else is null. */
export function decodeSasValue(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const b = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return b.length === 32 && b64u(b) === text ? b : null;
}

export type SasMember = "c" | "nM" | "nD";

/** The body of SAS_COMMIT, SAS_NONCE or SAS_REVEAL: compact JSON, one member. */
export const sasBody = (member: SasMember, value: Uint8Array): Uint8Array =>
  utf8(JSON.stringify({ [member]: encodeSasValue(value) }));

/** Read a body; null when it is anything but the canonical one-member object. */
export function parseSasBody(
  member: SasMember,
  body: Uint8Array,
): Uint8Array | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const m = new RegExp(`^\\{"${member}":"([A-Za-z0-9_-]+)"\\}$`).exec(text);
  return m === null ? null : decodeSasValue(m[1]!);
}

/** The code, 0..999999, from the handshake hash and both nonces. */
export async function sasValue(
  h: Uint8Array,
  nD: Uint8Array,
  nM: Uint8Array,
  mode: string,
): Promise<number> {
  const okm = await hkdfSha256(
    h,
    Uint8Array.from([...nD, ...nM]),
    Uint8Array.from([...utf8("pkey-peer/1 sas"), 0, ...utf8(mode)]),
    32,
  );
  return new DataView(okm.buffer, okm.byteOffset, 4).getUint32(0) % 1_000_000;
}

/** Six digits with leading zeros, a space between the triples. */
export function sasDisplay(n: number): string {
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** Does the revealed nonce match the commitment? Both are the base64url spelling. */
export async function sasRevealOk(c: string, nD: string): Promise<boolean> {
  const commit = decodeSasValue(c);
  const nonce = decodeSasValue(nD);
  if (commit === null || nonce === null) return false;
  const h = await sha256(nonce);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= h[i]! ^ commit[i]!;
  return diff === 0;
}
