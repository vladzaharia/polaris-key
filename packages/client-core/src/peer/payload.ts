// WIRE-CONTRACT-V5 §15.5: handshake payloads. Strict JSON (§1.2), an object, at most 8 KiB.

import { scanStrictJson } from "@polaris-key/jws";
import type { PeerMode } from "./noise.js";

export const MAX_HANDSHAKE_PAYLOAD = 8192;
export const MAX_CAPS = 32;
const CAP_RE = /^[a-z0-9]+\/[0-9]+$/;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export type PayloadVerdict =
  | { ok: true; caps: string[]; ring?: number; cert?: string }
  | { ok: false };

/** Parse a payload as strict JSON; null on any failure. */
export function parseStrictObject(
  bytes: Uint8Array,
): Record<string, unknown> | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
  if (text.startsWith("\ufeff")) return null;
  if (!scanStrictJson(text).ok) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Judge one handshake payload: message 1, or message 2 or 3 in a mode. */
export function parseHandshakePayload(
  mode: PeerMode,
  message: 1 | 2 | 3,
  bytes: Uint8Array,
): PayloadVerdict {
  const no: PayloadVerdict = { ok: false };
  if (bytes.length > MAX_HANDSHAKE_PAYLOAD) return no;
  const o = parseStrictObject(bytes);
  if (o === null || o.v !== 1) return no;
  if (message === 1) return "cert" in o ? no : { ok: true, caps: [] };
  const caps = o.caps;
  if (
    !Array.isArray(caps) ||
    caps.length > MAX_CAPS ||
    !caps.every((c) => typeof c === "string" && CAP_RE.test(c))
  )
    return no;
  const list = caps as string[];
  if (mode !== "a") return "cert" in o ? no : { ok: true, caps: list };
  if (typeof o.cert !== "string" || o.cert === "") return no;
  if (typeof o.ring !== "number" || !Number.isSafeInteger(o.ring) || o.ring < 1)
    return no;
  return { ok: true, caps: list, ring: o.ring, cert: o.cert };
}

/** The capabilities both sides list, once each, in byte order. */
export const capsIntersection = (
  a: readonly string[],
  b: readonly string[],
): string[] => [...new Set(a.filter((c) => b.includes(c)))].sort();

/** The bytes of message 1's payload. */
export const payload1 = (): Uint8Array => utf8('{"v":1}');

/** The bytes of message 2 or 3: `cert` and `ring` in mode a only. */
export function payload23(
  mode: PeerMode,
  caps: readonly string[],
  account?: { cert: string; ring: number },
): Uint8Array {
  const o: Record<string, unknown> = { v: 1 };
  if (mode === "a") {
    if (account === undefined) throw new RangeError("account payload");
    o.cert = account.cert;
    o.ring = account.ring;
  }
  o.caps = [...caps];
  const bytes = utf8(JSON.stringify(o));
  if (bytes.length > MAX_HANDSHAKE_PAYLOAD)
    throw new RangeError("payload size");
  return bytes;
}
