// WIRE-CONTRACT-V5 §15.6: records inside one Noise transport plaintext
// (`u16be type ‖ u8 flags ‖ body`), the type table, MORE reassembly and the order of checks.

export const MAX_PEER_MESSAGE_BYTES = 1_048_576;
/** A Noise message is at most 65,535 bytes; 16 are the tag and 3 the record header. */
export const MAX_RECORD_BODY = 65535 - 16 - 3;

/** Records in one MORE chain: a full 1 MiB message in the smallest records, plus one. */
export const MAX_CHAIN_RECORDS =
  Math.ceil(MAX_PEER_MESSAGE_BYTES / MAX_RECORD_BODY) + 1;

export type RecordMode = "a" | "v" | "p" | "c";
/**
 * The channel close codes (§15.6, §15.9), the registry's `peer` kind in
 * `conformance/parity/errors.json`: the SDK constants are generated from it, and
 * `test/peerSession.test.ts` fails when this list and the registry differ. This package sits below
 * the SDKs, so it keeps the list itself rather than importing their generated file.
 */
export const PEER_CLOSE_CODES = [
  "peer_revoked",
  "peer_expired",
  "peer_bad_frame",
  "peer_unknown_critical",
  "peer_not_allowed",
  "peer_busy",
  "peer_timeout",
  "peer_bye",
] as const;
export type PeerCloseCode = (typeof PEER_CLOSE_CODES)[number];

export const RECORD = {
  HELLO: 0x8001,
  RING: 0x0002,
  TRUST: 0x0003,
  PING: 0x0004,
  PONG: 0x0005,
  CANDIDATES: 0x0006,
  VOUCH_REQ: 0x8010,
  VOUCH_RESULT: 0x8011,
  CONFIRM: 0x8012,
  CONTACT: 0x0013,
  SAS_COMMIT: 0x8014,
  SAS_NONCE: 0x8015,
  SAS_REVEAL: 0x8016,
  KEYRING_WRAP: 0x0030,
  REKEY: 0x80fe,
  CLOSE: 0x80ff,
} as const;

interface TypeRow {
  from: number;
  to: number;
  name: string;
  modes: readonly RecordMode[];
  bodyLen?: number;
}
const ALL: RecordMode[] = ["a", "v", "p", "c"];
export const RECORD_TYPES: readonly TypeRow[] = [
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

export interface PeerRecord {
  type: number;
  flags: number;
  body: Uint8Array;
}

/**
 * A record from a Noise plaintext; null (the session closes with `peer_bad_frame`) when it is
 * shorter than the three header bytes or sets a flag bit other than `MORE`.
 */
export function parseRecord(plain: Uint8Array): PeerRecord | null {
  if (plain.length < 3 || (plain[2]! & 0xfe) !== 0) return null;
  return {
    type: (plain[0]! << 8) | plain[1]!,
    flags: plain[2]!,
    body: plain.slice(3),
  };
}

export function encodeRecord(r: PeerRecord): Uint8Array {
  const out = new Uint8Array(3 + r.body.length);
  out[0] = r.type >> 8;
  out[1] = r.type & 0xff;
  out[2] = r.flags;
  out.set(r.body, 3);
  return out;
}

/** A message split into records, `MORE` on all but the last. */
export function splitMessage(type: number, body: Uint8Array): Uint8Array[] {
  if (body.length > MAX_PEER_MESSAGE_BYTES)
    throw new RangeError("message size");
  const out: Uint8Array[] = [];
  let at = 0;
  do {
    const end = Math.min(body.length, at + MAX_RECORD_BODY);
    out.push(
      encodeRecord({
        type,
        flags: end < body.length ? 1 : 0,
        body: body.subarray(at, end),
      }),
    );
    at = end;
  } while (at < body.length);
  return out;
}

export type AssembleResult =
  | { kind: "message"; type: number; body: Uint8Array }
  | { kind: "pending" }
  | { kind: "ignored" }
  | { kind: "close"; code: PeerCloseCode };

/** Reads records in order, in a session of one mode (the checks run in the order §15.6 lists). */
export class RecordAssembler {
  private open: { type: number; parts: Uint8Array[]; size: number } | null =
    null;
  /** Set once a non-critical unknown type opened a chain that is being dropped. */
  private dropping: number | null = null;
  constructor(private readonly mode: RecordMode) {}

  push(r: PeerRecord): AssembleResult {
    const bad = (code: PeerCloseCode): AssembleResult => ({
      kind: "close",
      code,
    });
    if ((r.flags & 0xfe) !== 0) return bad("peer_bad_frame");
    const more = (r.flags & 1) !== 0;
    if (this.dropping !== null) {
      if (this.dropping !== r.type) return bad("peer_bad_frame");
      if (!more) this.dropping = null;
      return { kind: "ignored" };
    }
    if (this.open !== null && this.open.type !== r.type)
      return bad("peer_bad_frame");
    const row = RECORD_TYPES.find((t) => r.type >= t.from && r.type <= t.to);
    if (row === undefined) {
      if ((r.type & 0x8000) !== 0) return bad("peer_unknown_critical");
      if (more) this.dropping = r.type;
      return { kind: "ignored" };
    }
    if (!row.modes.includes(this.mode)) return bad("peer_not_allowed");
    // The corpus (`more-empty-parts`) accepts an empty MORE record, so the chain's record count
    // is what bounds the work.
    const size = (this.open?.size ?? 0) + r.body.length;
    if (size > MAX_PEER_MESSAGE_BYTES) return bad("peer_bad_frame");
    const parts = this.open?.parts ?? [];
    if (parts.length >= MAX_CHAIN_RECORDS) return bad("peer_bad_frame");
    parts.push(r.body);
    if (more) {
      this.open = { type: r.type, parts, size };
      return { kind: "pending" };
    }
    this.open = null;
    const body = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      body.set(p, at);
      at += p.length;
    }
    if (row.bodyLen !== undefined && body.length !== row.bodyLen)
      return bad("peer_bad_frame");
    return { kind: "message", type: r.type, body };
  }
}
