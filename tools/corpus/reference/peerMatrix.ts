// Reference: the `pkey-peer/1` byte-level rules outside the Noise engine (WIRE-CONTRACT-V5
// §15.4 to §15.7; plans/CC-01-cloud-connect.md §2.4, §2.6, §2.7).
//
// Adverts, the prologue and the mode-a PSK, the short authentication code with its commit and
// reveal, TCP framing, records and reassembly, relay envelopes and handshake payloads. Written
// from the specification over `node:crypto` alone (the hash, HMAC and HKDF helpers are the Noise
// reference's), so it shares nothing with client-core.

import { createHash } from "node:crypto";
import { type Json, refParseStrict } from "./config.js";
import { bytesHex, hexBytes, hmac, refHkdf, sha256 } from "./noise.js";

const enc = new TextEncoder();
export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const cat = (...p: Uint8Array[]): Uint8Array =>
  Uint8Array.from(p.flatMap((x) => Array.from(x)));
export { bytesHex, hexBytes };

const u64be = (n: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};
const u32be = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const u16be = (n: number): Uint8Array => Uint8Array.of(n >> 8, n & 0xff);
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

// ── Adverts (§15.4) ──────────────────────────────────────────────────────────

export const REF_ADVERT_EPOCH_SECONDS = 900;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export const refAdvertEpoch = (now: number): number =>
  Math.floor(now / REF_ADVERT_EPOCH_SECONDS);

/** RFC 4648 base32, lower-case alphabet, no padding. */
export function refBase32Lower(b: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const x of b) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

/** A device id is 32 base64url characters: 24 bytes, the bytes the advert and the relay use. */
export const refDeviceIdBytes = (id: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new Error(`device id ${id}`);
  return Uint8Array.from(Buffer.from(id, "base64url"));
};

/** The mode-a instance name for a device in one epoch under one discovery key. */
export const refAccountInstance = (
  kDisc: Uint8Array,
  epoch: number,
  deviceId: string,
): string =>
  `p1-${refBase32Lower(
    hmac(
      kDisc,
      cat(
        utf8("pkey-peer/1 disc"),
        Uint8Array.of(0),
        u64be(epoch),
        refDeviceIdBytes(deviceId),
      ),
    ),
  ).slice(0, 16)}`;

/** The `h` TXT value of the approver and pair adverts. */
export const refProductTag = (slug: string, epoch: number): string =>
  bytesHex(
    hmac(
      sha256(utf8("pkey-peer/1 salt"), Uint8Array.of(0), utf8(slug)),
      cat(utf8("pkey-peer/1 pair"), Uint8Array.of(0), u64be(epoch)),
    ),
  ).slice(0, 16);

export const refInstanceShape = (name: string): boolean =>
  /^p1-[a-z2-7]{16}$/.test(name);

export type TxtVerdict =
  | { ok: true; mode: "a" | "v" | "p"; h?: string }
  | { ok: false; reason: "duplicate" | "version" | "mode" | "tag" };

/** Parse a TXT record's strings. An entry splits at its first `=`; one without `=` and a key the
 *  advert does not define are ignored; keys are case-sensitive; a repeated key refuses. */
export function refParseTxt(entries: string[]): TxtVerdict {
  const kv = new Map<string, string>();
  for (const e of entries) {
    const at = e.indexOf("=");
    if (at < 1) continue;
    const k = e.slice(0, at);
    if (kv.has(k)) return { ok: false, reason: "duplicate" };
    kv.set(k, e.slice(at + 1));
  }
  if (kv.get("v") !== "1") return { ok: false, reason: "version" };
  const m = kv.get("m");
  if (m !== "a" && m !== "v" && m !== "p") return { ok: false, reason: "mode" };
  if (m === "a") return { ok: true, mode: m };
  const h = kv.get("h");
  if (h === undefined || !/^[0-9a-f]{16}$/.test(h))
    return { ok: false, reason: "tag" };
  return { ok: true, mode: m, h };
}

export interface BrowseHit {
  deviceId: string;
  /** 0 the current epoch, 1 the previous one. */
  epochBack: 0 | 1;
  /** 0 the newest discovery key, 1 the previous one. */
  keyIndex: 0 | 1;
}

/** Find which roster device an account instance belongs to: the current and the previous
 *  15-minute epoch, under every delivered key, for every roster device. */
export function refBrowse(
  instance: string,
  kDiscs: Uint8Array[],
  now: number,
  roster: string[],
): BrowseHit | null {
  const epoch = refAdvertEpoch(now);
  for (const epochBack of [0, 1] as const)
    for (let i = 0; i < kDiscs.length && i < 2; i++)
      for (const deviceId of roster)
        if (
          refAccountInstance(kDiscs[i]!, epoch - epochBack, deviceId) ===
          instance
        )
          return { deviceId, epochBack, keyIndex: i as 0 | 1 };
  return null;
}

// ── Prologue and PSK (§15.5) ─────────────────────────────────────────────────

export const refPrologue = (slug: string, mode: string): Uint8Array =>
  cat(
    utf8("pkey-peer/1"),
    Uint8Array.of(0),
    utf8(slug),
    Uint8Array.of(0),
    utf8(mode),
    Uint8Array.of(0),
  );

/** HKDF-SHA256(salt empty, ikm = K_disc, info = label 0x00 slug), 32 bytes. */
export const refPeerPsk = (kDisc: Uint8Array, slug: string): Uint8Array =>
  refHkdf(
    new Uint8Array(0),
    kDisc,
    cat(utf8("pkey-peer/1 psk"), Uint8Array.of(0), utf8(slug)),
    32,
  );

// ── The short authentication code (§15.5) ───────────────────────────────────

export const refSasCommit = (nD: Uint8Array): Uint8Array => sha256(nD);

/** The code, 0..999999, from the handshake hash and both nonces. */
export function refSasValue(
  h: Uint8Array,
  nD: Uint8Array,
  nM: Uint8Array,
  mode: string,
): number {
  const okm = refHkdf(
    h,
    cat(nD, nM),
    cat(utf8("pkey-peer/1 sas"), Uint8Array.of(0), utf8(mode)),
    32,
  );
  return new DataView(okm.buffer, okm.byteOffset, 4).getUint32(0) % 1_000_000;
}

/** Six digits with the leading zeros, a space between the triples. */
export const refSasDisplay = (n: number): string => {
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
};

/** A nonce travels as 43 base64url characters (32 bytes); anything else is refused. */
export function refSasNonce(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const b = Uint8Array.from(Buffer.from(text, "base64url"));
  return b64u(b) === text && b.length === 32 ? b : null;
}

/** Does the revealed nonce match the commitment? Both are the base64url spelling. */
export function refSasRevealOk(c: string, nD: string): boolean {
  const commit = refSasNonce(c);
  const nonce = refSasNonce(nD);
  return (
    commit !== null &&
    nonce !== null &&
    createHash("sha256").update(nonce).digest("hex") === bytesHex(commit)
  );
}

// ── TCP framing (§15.6) ──────────────────────────────────────────────────────

export const REF_MAX_FRAME = 65535;

export function refFrameEncode(noise: Uint8Array): Uint8Array | null {
  if (noise.length < 1 || noise.length > REF_MAX_FRAME) return null;
  return cat(u16be(noise.length), noise);
}

export type FrameDecode =
  | { frames: Uint8Array[]; rest: Uint8Array }
  | { error: "peer_bad_frame" };

/** Cut a byte stream into frames; a trailing partial frame is `rest`. A zero length closes. */
export function refFrameDecode(stream: Uint8Array): FrameDecode {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (stream.length - i >= 2) {
    const len = (stream[i]! << 8) | stream[i + 1]!;
    if (len === 0) return { error: "peer_bad_frame" };
    if (stream.length - i - 2 < len) break;
    frames.push(stream.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return { frames, rest: stream.slice(i) };
}

// ── Records (§15.6) ──────────────────────────────────────────────────────────

export const REF_MAX_PEER_MESSAGE = 1_048_576;
/** A record body is at most 65535 − 16 (tag) − 3 (header); a full message in the smallest
 *  records is ceil(1 MiB / 65516) = 17, plus one. */
export const REF_MAX_CHAIN_RECORDS = 18;
export type PeerMode = "a" | "v" | "p" | "c";
const ALL: PeerMode[] = ["a", "v", "p", "c"];

export interface TypeRow {
  /** Inclusive range, hex of the 16-bit type. */
  from: number;
  to: number;
  name: string;
  modes: PeerMode[];
  /** Fixed body length, when the type has one. */
  bodyLen?: number;
}

export const REF_TYPES: TypeRow[] = [
  { from: 0x8001, to: 0x8001, name: "HELLO", modes: ALL },
  { from: 0x0002, to: 0x0002, name: "RING", modes: ["a"] },
  { from: 0x0003, to: 0x0003, name: "TRUST", modes: ["a"] },
  { from: 0x0004, to: 0x0004, name: "PING", modes: ALL, bodyLen: 8 },
  { from: 0x0005, to: 0x0005, name: "PONG", modes: ALL, bodyLen: 8 },
  { from: 0x0006, to: 0x0006, name: "CANDIDATES", modes: ["a"] },
  { from: 0x8010, to: 0x8010, name: "VOUCH_REQ", modes: ["v"] },
  { from: 0x8011, to: 0x8011, name: "VOUCH_RESULT", modes: ["v"] },
  { from: 0x8012, to: 0x8012, name: "CONFIRM", modes: ["p"] },
  { from: 0x0013, to: 0x0013, name: "CONTACT", modes: ["p"] },
  { from: 0x8014, to: 0x8014, name: "SAS_COMMIT", modes: ["v", "p"] },
  { from: 0x8015, to: 0x8015, name: "SAS_NONCE", modes: ["v", "p"] },
  { from: 0x8016, to: 0x8016, name: "SAS_REVEAL", modes: ["v", "p"] },
  { from: 0x0020, to: 0x0025, name: "XFER", modes: ["a", "c"] },
  { from: 0x0030, to: 0x003f, name: "SYNC", modes: ["v"] },
  { from: 0x0100, to: 0x7fff, name: "APP", modes: ["a", "c"] },
  { from: 0x8100, to: 0xfffd, name: "APP_CRITICAL", modes: ["a", "c"] },
  { from: 0x80fe, to: 0x80fe, name: "REKEY", modes: ALL, bodyLen: 0 },
  { from: 0x80ff, to: 0x80ff, name: "CLOSE", modes: ALL },
];

export type PeerClose =
  | "peer_bad_frame"
  | "peer_unknown_critical"
  | "peer_not_allowed";

export interface RefRecord {
  type: number;
  flags: number;
  body: Uint8Array;
}

export function refRecordParse(plain: Uint8Array): RefRecord | null {
  if (plain.length < 3) return null;
  return {
    type: (plain[0]! << 8) | plain[1]!,
    flags: plain[2]!,
    body: plain.slice(3),
  };
}

export const refRecordEncode = (r: RefRecord): Uint8Array =>
  cat(u16be(r.type), Uint8Array.of(r.flags), r.body);

export type SessionOutcome =
  | { delivered: { type: number; body: Uint8Array }[] }
  | { close: PeerClose; after: number };

/** Feed a session's records in order: the delivered messages, or the close code and the number
 *  of records read before it (0-based index of the record that closed). */
export function refRecordSession(
  mode: PeerMode,
  records: RefRecord[],
): SessionOutcome {
  const delivered: { type: number; body: Uint8Array }[] = [];
  type Chain = { type: number; parts: Uint8Array[]; size: number };
  let open = null as Chain | null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const close = (code: PeerClose): SessionOutcome => ({
      close: code,
      after: i,
    });
    if ((r.flags & 0xfe) !== 0) return close("peer_bad_frame");
    if (open !== null && open.type !== r.type) return close("peer_bad_frame");
    const row = REF_TYPES.find((t) => r.type >= t.from && r.type <= t.to);
    const critical = (r.type & 0x8000) !== 0;
    if (row === undefined) {
      if (critical) return close("peer_unknown_critical");
      open = null;
      continue;
    }
    if (!row.modes.includes(mode)) return close("peer_not_allowed");
    const size: number = (open?.size ?? 0) + r.body.length;
    if (size > REF_MAX_PEER_MESSAGE) return close("peer_bad_frame");
    if ((open?.parts.length ?? 0) >= REF_MAX_CHAIN_RECORDS)
      return close("peer_bad_frame");
    const parts: Uint8Array[] = [...(open?.parts ?? []), r.body];
    if ((r.flags & 1) !== 0) {
      open = { type: r.type, parts, size };
      continue;
    }
    open = null;
    const body = cat(...parts);
    if (row.bodyLen !== undefined && body.length !== row.bodyLen)
      return close("peer_bad_frame");
    delivered.push({ type: r.type, body });
  }
  return { delivered };
}

// ── Relay envelopes (§15.7) ──────────────────────────────────────────────────

export const REF_RELAY_MAX_MESSAGE = 65564;

export type RelayMessage =
  | { op: "send"; to: Uint8Array; session: number; noise: Uint8Array }
  | { op: "list" }
  | { op: "ping"; data: Uint8Array }
  | { op: "recv"; from: Uint8Array; session: number; noise: Uint8Array }
  | { op: "members"; devices: Uint8Array[] }
  | { op: "ring"; epoch: number }
  | { op: "pong"; data: Uint8Array }
  | { op: "gone"; device: Uint8Array }
  | { op: "limit"; reason: 1 | 2 | 3 | 4 };

const OPS: Record<RelayMessage["op"], number> = {
  send: 0x01,
  list: 0x02,
  ping: 0x03,
  recv: 0x81,
  members: 0x82,
  ring: 0x83,
  pong: 0x84,
  gone: 0x85,
  limit: 0x86,
};

export function refRelayEncode(m: RelayMessage): Uint8Array {
  const op = Uint8Array.of(OPS[m.op]);
  switch (m.op) {
    case "send":
      return cat(op, m.to, u32be(m.session), m.noise);
    case "recv":
      return cat(op, m.from, u32be(m.session), m.noise);
    case "list":
      return op;
    case "ping":
    case "pong":
      return cat(op, m.data);
    case "members":
      return cat(op, Uint8Array.of(m.devices.length), ...m.devices);
    case "ring":
      return cat(op, u64be(m.epoch));
    case "gone":
      return cat(op, m.device);
    case "limit":
      return cat(op, Uint8Array.of(m.reason));
  }
}

/** Decode one binary message. `dir` is who sent it: the client (to the room) or the room. */
export function refRelayDecode(
  dir: "toRoom" | "toClient",
  b: Uint8Array,
): RelayMessage | null {
  if (b.length < 1 || b.length > REF_RELAY_MAX_MESSAGE) return null;
  const op = b[0]!;
  const rest = b.slice(1);
  const view = new DataView(b.buffer, b.byteOffset);
  if (dir === "toRoom") {
    if (op === 0x01 && rest.length >= 29)
      return {
        op: "send",
        to: rest.slice(0, 24),
        session: view.getUint32(25),
        noise: rest.slice(28),
      };
    if (op === 0x02 && rest.length === 0) return { op: "list" };
    if (op === 0x03 && rest.length === 8) return { op: "ping", data: rest };
    return null;
  }
  if (op === 0x81 && rest.length >= 29)
    return {
      op: "recv",
      from: rest.slice(0, 24),
      session: view.getUint32(25),
      noise: rest.slice(28),
    };
  if (op === 0x82 && rest.length >= 1 && rest.length === 1 + rest[0]! * 24)
    return {
      op: "members",
      devices: Array.from({ length: rest[0]! }, (_, i) =>
        rest.slice(1 + i * 24, 25 + i * 24),
      ),
    };
  if (op === 0x83 && rest.length === 8)
    return {
      op: "ring",
      epoch: Number(new DataView(rest.buffer, rest.byteOffset).getBigUint64(0)),
    };
  if (op === 0x84 && rest.length === 8) return { op: "pong", data: rest };
  if (op === 0x85 && rest.length === 24) return { op: "gone", device: rest };
  if (op === 0x86 && rest.length === 1 && rest[0]! >= 1 && rest[0]! <= 4)
    return { op: "limit", reason: rest[0]! as 1 | 2 | 3 | 4 };
  return null;
}

// ── Handshake payloads (§15.5) ───────────────────────────────────────────────

export const REF_MAX_PAYLOAD = 8192;
const CAP_RE = /^[a-z0-9]+\/[0-9]+$/;

export type PayloadVerdict =
  | { ok: true; caps: string[]; ring?: number; cert?: string }
  | { ok: false };

const isInt = (v: Json | undefined): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);

/** Judge one handshake payload: message 1, or message 2 or 3 in a mode. */
export function refHandshakePayload(
  mode: "a" | "v" | "p",
  message: 1 | 2 | 3,
  bytes: Uint8Array,
): PayloadVerdict {
  const no: PayloadVerdict = { ok: false };
  if (bytes.length > REF_MAX_PAYLOAD) return no;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return no;
  }
  if (text.startsWith("\ufeff")) return no;
  const parsed = refParseStrict(text);
  if (!parsed.ok) return no;
  const o = parsed.value;
  if (o === null || typeof o !== "object" || Array.isArray(o)) return no;
  if (o.v !== 1) return no;
  if (message === 1) return "cert" in o ? no : { ok: true, caps: [] };
  const caps = o.caps;
  if (
    !Array.isArray(caps) ||
    caps.length > 32 ||
    !caps.every((c) => typeof c === "string" && CAP_RE.test(c))
  )
    return no;
  const list = caps as string[];
  if (mode !== "a") return "cert" in o ? no : { ok: true, caps: list };
  if (typeof o.cert !== "string" || o.cert === "") return no;
  if (!isInt(o.ring) || o.ring < 1) return no;
  return { ok: true, caps: list, ring: o.ring, cert: o.cert };
}

/** The session's capabilities: those both sides list, once each, in byte order. */
export const refCapsIntersection = (a: string[], b: string[]): string[] =>
  [...new Set(a.filter((c) => b.includes(c)))].sort();
