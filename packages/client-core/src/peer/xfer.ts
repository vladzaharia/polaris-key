// WIRE-CONTRACT-V5 §15.11: Direct Transfer (`xfer/1`). The control-body codecs, the partial-file
// path and `XferMachine`, one side of one session as a state machine. A machine does no I/O: it
// reads records, the host's calls and a clock, and answers each with an output (records to send,
// questions for the host, effects on the kept partial files). `XferEndpoint` (./xferEndpoint.ts)
// runs a machine over a `PeerSession`; the host API above it is the SDK's. Written from the
// specification; `peer-matrix.json` `xfer` is the conformance check.

import { base64UrlDecode, base64UrlEncodeBytes } from "@polaris-key/jws";
import { cleanDisplayName } from "../deviceLabel.js";
import { Sha256 } from "../sync/sha256.js";
import { parseStrictObjectScanned } from "./payload.js";
import type { PeerCloseCode } from "./record.js";

export const XFER_MAX_CONTROL_BYTES = 4096;
export const XFER_MAX_SIZE = 2 ** 40;
export const XFER_DEFAULT_CHUNK = 61_440;
export const XFER_MAX_CHUNK = 65_492;
export const XFER_WINDOW = 16;
export const XFER_ACK_EVERY = 8;
export const XFER_MAX_TRANSFERS = 4;
export const XFER_CONSENT_SECONDS = 120;
export const XFER_IDLE_SECONDS = 60;
export const XFER_PARTIAL_SECONDS = 86_400;
export const XFER_MAX_PARTIALS_PER_PEER = 8;
export const XFER_ENDED_IDS = 64;
export const XFER_CHUNK_HEAD = 24;
export const XFER_CAP = "xfer/1";

export const XFER = {
  OFFER: 0x0020,
  ACCEPT: 0x0021,
  CHUNK: 0x0022,
  ACK: 0x0023,
  DONE: 0x0024,
  CANCEL: 0x0025,
} as const;

export const XFER_REASONS = [
  "declined",
  "cancelled",
  "hash",
  "size",
  "category",
  "busy",
  "quota",
  "timeout",
] as const;
export type XferReason = (typeof XFER_REASONS)[number];

/** True for the six xfer record types. */
export const isXferType = (type: number): boolean =>
  type >= XFER.OFFER && type <= XFER.CANCEL;

const SHA_RE = /^[0-9a-f]{64}$/;
const CAT_RE = /^[a-z0-9-]{1,32}$/;
const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const enc = new TextEncoder();

const hexOf = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A transfer id: 22 canonical base64url characters of 16 bytes. */
export function isXferId(v: unknown): v is string {
  if (typeof v !== "string" || !ID_RE.test(v)) return false;
  try {
    return base64UrlEncodeBytes(base64UrlDecode(v)) === v;
  } catch {
    return false;
  }
}

// ── Control bodies ───────────────────────────────────────────────────────────

interface Control {
  o: Record<string, unknown>;
  ni: { has(pointer: string): boolean };
}

function control(body: Uint8Array): Control | null {
  if (body.length > XFER_MAX_CONTROL_BYTES) return null;
  const s = parseStrictObjectScanned(body);
  return s === null ? null : { o: s.o, ni: s.nonWireIntegers };
}

/** An integer token in [min, max]: a number not written with a fraction or an exponent. */
function intOf(
  c: Control,
  name: string,
  min: number,
  max: number,
): number | null {
  const v = c.o[name];
  if (typeof v !== "number" || c.ni.has(`/${name}`)) return null;
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

export interface XferOfferBody {
  id: string;
  name?: string;
  type?: string;
  size: number;
  sha256: string;
  cat?: string;
  chunk: number;
}

/** An `OFFER` body; `maxMessage` is the reader's own `HELLO` value. Null is a `peer_bad_frame`. */
export function parseXferOffer(
  body: Uint8Array,
  maxMessage: number,
): XferOfferBody | null {
  const c = control(body);
  if (c === null || !isXferId(c.o.id)) return null;
  const out: XferOfferBody = { id: c.o.id, size: 0, sha256: "", chunk: 0 };
  const { name, type, cat } = c.o;
  if (name !== undefined) {
    if (typeof name !== "string" || enc.encode(name).length > 255) return null;
    out.name = name;
  }
  if (type !== undefined) {
    if (
      typeof type !== "string" ||
      enc.encode(type).length > 127 ||
      !TYPE_RE.test(type)
    )
      return null;
    out.type = type;
  }
  const size = intOf(c, "size", 0, XFER_MAX_SIZE);
  if (size === null) return null;
  out.size = size;
  if (typeof c.o.sha256 !== "string" || !SHA_RE.test(c.o.sha256)) return null;
  out.sha256 = c.o.sha256;
  if (cat !== undefined) {
    if (typeof cat !== "string" || !CAT_RE.test(cat)) return null;
    out.cat = cat;
  }
  const chunk = intOf(c, "chunk", 1, XFER_MAX_CHUNK);
  if (chunk === null || chunk + XFER_CHUNK_HEAD > maxMessage) return null;
  out.chunk = chunk;
  return out;
}

/** The sender's `OFFER` body. */
export function xferOfferBody(o: XferOfferBody): Uint8Array {
  return enc.encode(
    JSON.stringify({
      id: o.id,
      ...(o.name !== undefined ? { name: o.name } : {}),
      ...(o.type !== undefined ? { type: o.type } : {}),
      size: o.size,
      sha256: o.sha256,
      ...(o.cat !== undefined ? { cat: o.cat } : {}),
      chunk: o.chunk,
    }),
  );
}

export const xferOffsetBody = (id: string, offset: number): Uint8Array =>
  enc.encode(JSON.stringify({ id, offset }));
export const xferDoneBody = (id: string, sha256?: string): Uint8Array =>
  enc.encode(JSON.stringify(sha256 === undefined ? { id } : { id, sha256 }));
export const xferCancelBody = (id: string, reason: XferReason): Uint8Array =>
  enc.encode(JSON.stringify({ id, reason }));

/** A `CHUNK` body: `id(16) ‖ u64be offset ‖ data`. */
export function xferChunkBody(
  id: string,
  offset: number,
  data: Uint8Array,
): Uint8Array {
  const b = new Uint8Array(XFER_CHUNK_HEAD + data.length);
  b.set(base64UrlDecode(id), 0);
  new DataView(b.buffer).setBigUint64(16, BigInt(offset));
  b.set(data, XFER_CHUNK_HEAD);
  return b;
}

function parseId(c: Control | null): string | null {
  return c !== null && isXferId(c.o.id) ? c.o.id : null;
}

/** The offer parameters an offset is judged against. */
export interface XferParams {
  size: number;
  chunk: number;
}

/** An offset for `ACCEPT` (a multiple of chunk) or `ACK` (also `size` itself). */
const offsetOk = (v: number, p: XferParams, ack: boolean): boolean =>
  v >= 0 && v <= p.size && (v % p.chunk === 0 || (ack && v === p.size));

/** An `ACCEPT` or `ACK` body, `{id, offset}`, judged against its `OFFER`. Null is a fault. */
export function parseXferOffset(
  kind: "ACCEPT" | "ACK",
  body: Uint8Array,
  p: XferParams,
): { id: string; offset: number } | null {
  const c = control(body);
  const id = parseId(c);
  if (c === null || id === null) return null;
  const offset = intOf(c, "offset", 0, XFER_MAX_SIZE);
  return offset !== null && offsetOk(offset, p, kind === "ACK")
    ? { id, offset }
    : null;
}

/** A `DONE` body: `{id, sha256}` toward the receiver, `{id}` toward the sender. */
export function parseXferDone(
  body: Uint8Array,
  toward: "receiver" | "sender",
): { id: string; sha256?: string } | null {
  const c = control(body);
  const id = parseId(c);
  if (c === null || id === null) return null;
  if (toward === "sender") return c.o.sha256 === undefined ? { id } : null;
  const sha = c.o.sha256;
  return typeof sha === "string" && SHA_RE.test(sha)
    ? { id, sha256: sha }
    : null;
}

/** A `CANCEL` body. A string outside the eight reasons reads as `cancelled`. */
export function parseXferCancel(
  body: Uint8Array,
): { id: string; reason: XferReason } | null {
  const c = control(body);
  const id = parseId(c);
  if (c === null || id === null || typeof c.o.reason !== "string") return null;
  return { id, reason: reasonOf(c.o.reason) };
}

/** A `CHUNK` body judged against its offer and the next offset the receiver expects. */
export function parseXferChunk(
  body: Uint8Array,
  c: XferParams & { expect: number },
): { id: string; offset: number; length: number } | null {
  if (body.length < XFER_CHUNK_HEAD) return null;
  const id = base64UrlEncodeBytes(body.subarray(0, 16));
  const at = new DataView(body.buffer, body.byteOffset + 16, 8).getBigUint64(0);
  const length = body.length - XFER_CHUNK_HEAD;
  if (length === 0 || length > c.chunk || at !== BigInt(c.expect)) return null;
  if (c.expect + length > c.size) return null;
  if (length < c.chunk && c.expect + length !== c.size) return null;
  return { id, offset: c.expect, length };
}

const reasonOf = (r: string): XferReason =>
  (XFER_REASONS as readonly string[]).includes(r)
    ? (r as XferReason)
    : "cancelled";

/** The partial file's name (§15.11 "The name is display data"): derived from the resume key only. */
export function xferPartialPath(
  key: Uint8Array,
  id: string,
  sha256: string,
): string {
  const h = new Sha256();
  h.update(enc.encode("pkey-xfer/1 partial"));
  h.update(Uint8Array.of(0));
  h.update(key);
  h.update(base64UrlDecode(id));
  const sha = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    sha[i] = parseInt(sha256.slice(i * 2, i * 2 + 2), 16);
  h.update(sha);
  return hexOf(h.digest());
}

// ── The machine ──────────────────────────────────────────────────────────────

/** A kept partial file of the peer key (§15.11 "Resume"). */
export interface XferPartial {
  /** The store's name for it: `xferPartialPath` for the key, the transfer id and the hash. */
  ref: string;
  id: string;
  sha256: string;
  size: number;
  chunk: number;
  /** Bytes on disk. */
  bytes: number;
  /** Seconds (the machine's clock) of the last write. */
  writtenAt: number;
  /** A live transfer in another session holds it. */
  held?: boolean;
  /**
   * Bytes re-read and hashed since the session began; default `bytes`. A receiver never offers an
   * offset it has not re-read (§15.11).
   */
  reread?: number;
}

/** What the host is asked about an `OFFER`. `name` is already cleaned display data. */
export interface XferAsk {
  id: string;
  name?: string;
  type?: string;
  size: number;
  cat?: string;
}

/** How the host answers an offer at once, or `ask` for an answer later through `consent`. */
export type XferHandler = (ask: XferAsk) => "accept" | "decline" | "ask";

export type XferSend =
  | {
      t: "OFFER";
      id: string;
      size: number;
      chunk: number;
      sha256: string;
      cat?: string;
      name?: string;
      type?: string;
    }
  | { t: "ACCEPT"; id: string; offset: number }
  /** The consecutive `CHUNK` records one step sends: `chunk` bytes each, the last the remainder. */
  | { t: "CHUNKS"; id: string; offset: number; bytes: number }
  | { t: "ACK"; id: string; offset: number }
  | { t: "DONE"; id: string; sha256?: string }
  | { t: "CANCEL"; id: string; reason: XferReason };

/** An effect on the kept partial files, or bytes for one; the driver applies them in order. */
export type XferPartialEffect =
  | { create: string }
  | { truncate: string; to: number }
  | { discard: string }
  | { evict: string }
  | { keep: string }
  | { delete: string }
  | { finalize: string }
  | { write: string; offset: number; data: Uint8Array };

export type XferResult =
  | { id: string; outcome: "delivered" }
  | { id: string; outcome: "cancelled"; reason: XferReason }
  | { id: string; outcome: "closed" };

export interface XferOut {
  send: XferSend[];
  close?: PeerCloseCode;
  ask?: XferAsk;
  withdraw: string[];
  results: XferResult[];
  partial: XferPartialEffect[];
  /** The host's own send was refused locally: too many live transfers. */
  refused?: "busy";
  /** A late record for an ended id, dropped without effect. */
  drop?: true;
}

export interface XferMachineOptions {
  /** The session's mode: transfers run in `a` and `c` only. */
  mode: string;
  /** The session's capabilities (the intersection of both payloads). */
  caps: readonly string[];
  /** This side's own `HELLO` `maxMessage`. */
  maxMessage: number;
  /** The host's own size limit. */
  hostLimit?: number | null;
  /** Bytes the store can still take; null for unlimited. */
  free?: () => number | null;
  /** No handler: every `OFFER` is declined. */
  handler: XferHandler | null;
  /** The link's categories (mode c). */
  categories?: readonly string[];
  /** The remote static key: 32 raw bytes (the certificate's `agreeKey`, or the pinned contact key). */
  peerKey: Uint8Array;
  /** The kept partials of this peer key. */
  partials?: readonly XferPartial[];
  /**
   * A hasher fed with the first `offset` bytes of a kept partial, which the store has re-read
   * (`offset` is a multiple of the chunk size not above the bytes re-read). Without it a resume
   * starts at 0.
   */
  rehash?: (ref: string, offset: number) => Sha256;
  /** A name for a new partial file; default `xferPartialPath`. */
  newRef?: (id: string, sha256: string) => string;
  /** The window is judged from the last `ACK` actually sent; set when `ACK`s are held back. */
  withholdAcks?: boolean;
}

interface Tr {
  id: string;
  dir: "in" | "out";
  st: "asking" | "offered" | "active" | "doneSent";
  size: number;
  chunk: number;
  sha: string;
  /** When the current wait began. */
  since: number;
  recv: number;
  sinceAck: number;
  ackedEnd: number;
  hash?: Sha256;
  partial?: string;
  accepted: boolean;
  sentEnd: number;
  ackEnd: number;
  seekable: boolean;
  full: boolean;
}

interface Ended {
  id: string;
  dir: "in" | "out";
  /** Lets a late `DONE` count as delivery. */
  cancelledHere: boolean;
}

export interface XferOfferArgs {
  id: string;
  size: number;
  chunk: number;
  sha256: string;
  cat?: string;
  name?: string;
  type?: string;
  /** False when the source cannot restart at an `ACCEPT` offset above 0. Default true. */
  seekable?: boolean;
}

export class XferMachine {
  private tr = new Map<string, Tr>();
  private ended: Ended[] = [];
  private closed = false;
  private parts: XferPartial[];
  private clock = 0;
  private out: XferOut = blank();

  constructor(private readonly o: XferMachineOptions) {
    if (o.peerKey.length !== 32) throw new RangeError("peerKey");
    this.parts = (o.partials ?? []).map((p) => ({ ...p }));
  }

  /** The kept partials now (a new session starts from these with `held` cleared). */
  partials(): XferPartial[] {
    return this.parts.map((p) => ({ ...p }));
  }

  /** The number of live transfers. */
  get live(): number {
    return this.tr.size;
  }

  /** The clock value at which the next wait runs out, or null when none is running. */
  nextDeadline(): number | null {
    let best: number | null = null;
    for (const t of this.tr.values()) {
      const lim = this.limit(t);
      if (lim === null) continue;
      const at = t.since + lim;
      if (best === null || at < best) best = at;
    }
    return best;
  }

  // ── events ─────────────────────────────────────────────────────────────────

  /** Only the clock moves. */
  tick(at: number): XferOut {
    return this.begin(at, () => undefined);
  }

  /** A record the session read: one of the six xfer types, with `more` its flag. */
  receive(at: number, type: number, body: Uint8Array, more = false): XferOut {
    return this.begin(at, () => this.onRecord(type, body, more));
  }

  /** The host sends: `OFFER`. */
  offer(at: number, a: XferOfferArgs): XferOut {
    if (
      !isXferId(a.id) ||
      !Number.isInteger(a.size) ||
      a.size < 0 ||
      a.size > XFER_MAX_SIZE ||
      !Number.isInteger(a.chunk) ||
      a.chunk < 1 ||
      a.chunk > XFER_MAX_CHUNK ||
      !SHA_RE.test(a.sha256)
    )
      throw new RangeError("offer");
    if (this.tr.has(a.id) || this.ended.some((e) => e.id === a.id))
      throw new RangeError("transfer id already used");
    return this.begin(at, () => {
      if (this.tr.size >= XFER_MAX_TRANSFERS) {
        this.out.refused = "busy";
        return;
      }
      const t = this.newTr(a.id, "out", a.size, a.chunk, a.sha256);
      t.st = "offered";
      t.seekable = a.seekable !== false;
      this.tr.set(t.id, t);
      this.send({
        t: "OFFER",
        id: a.id,
        size: a.size,
        chunk: a.chunk,
        sha256: a.sha256,
        ...(a.cat !== undefined ? { cat: a.cat } : {}),
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.type !== undefined ? { type: a.type } : {}),
      });
    });
  }

  /** The host's answer to an `ask`. */
  consent(at: number, id: string, answer: "accept" | "decline"): XferOut {
    return this.begin(at, () => {
      const t = this.tr.get(id);
      if (t === undefined || t.st !== "asking") return;
      if (answer === "decline") {
        this.send({ t: "CANCEL", id, reason: "declined" });
        this.end(t, true);
        return;
      }
      this.accept(t);
    });
  }

  /** The host cancels a transfer. */
  cancel(at: number, id: string): XferOut {
    return this.begin(at, () => {
      const t = this.tr.get(id);
      if (t === undefined) return;
      // After its DONE a sender sends no CANCEL other than timeout.
      if (t.dir === "out" && t.st === "doneSent") return;
      this.send({ t: "CANCEL", id, reason: "cancelled" });
      if (t.st === "asking") this.out.withdraw.push(id);
      else if (t.dir === "in" && t.partial !== undefined)
        this.eff({ delete: t.partial });
      this.result(t, { id, outcome: "cancelled", reason: "cancelled" });
      this.end(t, true);
    });
  }

  /**
   * The host's source failed before the transfer's `DONE` went out: cancel an outgoing transfer
   * in any state. (`cancel` refuses once the `DONE` is sent.)
   */
  fail(at: number, id: string): XferOut {
    return this.begin(at, () => {
      const t = this.tr.get(id);
      if (t === undefined || t.dir !== "out") return;
      this.send({ t: "CANCEL", id, reason: "cancelled" });
      this.result(t, { id, outcome: "cancelled", reason: "cancelled" });
      this.end(t, true);
    });
  }

  /** The session ended. Does nothing when a fault already ended it; see `abandon`. */
  close(at: number): XferOut {
    if (this.closed) return blank();
    return this.begin(at, () => this.shutdown());
  }

  /**
   * The session closed (for any reason): report every live transfer `closed` and keep the
   * partials. Idempotent, and it also answers after a fault the machine itself raised.
   */
  abandon(at: number): XferOut {
    this.out = blank();
    this.clock = at;
    this.shutdown();
    this.closed = true;
    return this.out;
  }

  /** A new session on the same machine keeps the partials, none held and none re-read. */
  newSession(at: number): XferOut {
    this.out = blank();
    this.clock = at;
    this.tr.clear();
    this.ended = [];
    this.closed = false;
    this.parts = this.parts.map((p) => {
      const { reread: _r, ...rest } = p;
      return { ...rest, held: false };
    });
    return this.out;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private begin(at: number, fn: () => void): XferOut {
    this.out = blank();
    if (this.closed) return this.out;
    this.clock = at;
    this.expire(at);
    fn();
    return this.out;
  }

  private shutdown(): void {
    for (const t of this.tr.values()) {
      if (t.st === "asking") this.out.withdraw.push(t.id);
      else if (t.dir === "in" && t.partial !== undefined)
        this.eff({ keep: t.partial });
      this.result(t, { id: t.id, outcome: "closed" });
    }
    this.tr.clear();
    this.closed = true;
  }

  private send(s: XferSend): void {
    this.out.send.push(s);
  }

  private eff(e: XferPartialEffect): void {
    this.out.partial.push(e);
    const gone = "delete" in e ? e.delete : "finalize" in e ? e.finalize : null;
    if (gone !== null) this.parts = this.parts.filter((p) => p.ref !== gone);
  }

  private fault(): void {
    this.out.close = "peer_bad_frame";
    this.closed = true;
  }

  /** A transfer the host was never told about (still asking) reports no result. */
  private result(t: Tr, r: XferResult): void {
    if (t.st === "asking") return;
    this.out.results.push(r);
  }

  private remember(
    id: string,
    dir: "in" | "out",
    cancelledHere: boolean,
  ): void {
    this.ended.push({ id, dir, cancelledHere });
    while (this.ended.length > XFER_ENDED_IDS) this.ended.shift();
  }

  private end(t: Tr, cancelledHere: boolean): void {
    this.tr.delete(t.id);
    this.remember(t.id, t.dir, cancelledHere);
  }

  private newTr(
    id: string,
    dir: "in" | "out",
    size: number,
    chunk: number,
    sha: string,
  ): Tr {
    return {
      id,
      dir,
      st: "asking",
      size,
      chunk,
      sha,
      since: this.clock,
      recv: 0,
      sinceAck: 0,
      ackedEnd: 0,
      accepted: false,
      sentEnd: 0,
      ackEnd: 0,
      seekable: true,
      full: false,
    };
  }

  // ── the clock ──────────────────────────────────────────────────────────────

  /** Seconds this transfer may wait in its current state; null while nothing is awaited. */
  private limit(t: Tr): number | null {
    if (t.dir === "in")
      return t.st === "asking" ? XFER_CONSENT_SECONDS : XFER_IDLE_SECONDS;
    if (t.st === "offered") return XFER_CONSENT_SECONDS + XFER_IDLE_SECONDS;
    if (t.st === "doneSent") return XFER_IDLE_SECONDS;
    return t.full ? XFER_IDLE_SECONDS : null;
  }

  /** Every wait that ran out by `at` ends with `CANCEL timeout`; the partial is kept. */
  private expire(at: number): void {
    for (const t of [...this.tr.values()]) {
      const lim = this.limit(t);
      if (lim === null || at - t.since < lim) continue;
      this.send({ t: "CANCEL", id: t.id, reason: "timeout" });
      if (t.st === "asking") this.out.withdraw.push(t.id);
      else if (t.dir === "in" && t.partial !== undefined)
        this.eff({ keep: t.partial });
      this.result(t, { id: t.id, outcome: "cancelled", reason: "timeout" });
      this.end(t, true);
    }
  }

  // ── records ────────────────────────────────────────────────────────────────

  private onRecord(type: number, body: Uint8Array, more: boolean): void {
    // Step 1: the mode and the capability.
    if (
      (this.o.mode !== "a" && this.o.mode !== "c") ||
      !this.o.caps.includes(XFER_CAP)
    ) {
      this.out.close = "peer_not_allowed";
      this.closed = true;
      return;
    }
    if (more || !isXferType(type)) return this.fault();
    if (type === XFER.OFFER) return this.onOffer(body);
    if (type === XFER.CHUNK) return this.onChunk(body);
    const c = control(body);
    const id = parseId(c);
    if (c === null || id === null) return this.fault();
    // The generic member checks, before the id is looked up.
    let offset = 0;
    let sha: string | undefined;
    let reason: XferReason = "cancelled";
    if (type === XFER.ACCEPT || type === XFER.ACK) {
      const v = intOf(c, "offset", 0, XFER_MAX_SIZE);
      if (v === null) return this.fault();
      offset = v;
    } else if (type === XFER.DONE) {
      if (c.o.sha256 !== undefined) {
        if (typeof c.o.sha256 !== "string" || !SHA_RE.test(c.o.sha256))
          return this.fault();
        sha = c.o.sha256;
      }
    } else {
      if (typeof c.o.reason !== "string") return this.fault();
      reason = reasonOf(c.o.reason);
    }
    const t = this.tr.get(id);
    if (t === undefined) return this.late(id, type, sha);
    if (type === XFER.ACCEPT) return this.onAccept(t, offset);
    if (type === XFER.ACK) return this.onAck(t, offset);
    if (type === XFER.DONE) return this.onDone(t, sha);
    this.onCancel(t, reason);
  }

  /** A record for an id that is not live: dropped when remembered, else a fault. */
  private late(id: string, type: number, sha: string | undefined): void {
    const e = this.ended.find((x) => x.id === id);
    if (e === undefined) return this.fault();
    if (
      type === XFER.DONE &&
      e.dir === "out" &&
      e.cancelledHere &&
      sha === undefined
    ) {
      this.out.results.push({ id, outcome: "delivered" });
      e.cancelledHere = false;
      return;
    }
    this.out.drop = true;
  }

  private onOffer(body: Uint8Array): void {
    const f = parseXferOffer(body, this.o.maxMessage);
    if (f === null) return this.fault();
    if (this.tr.has(f.id) || this.ended.some((e) => e.id === f.id))
      return this.fault();
    const t = this.newTr(f.id, "in", f.size, f.chunk, f.sha256);
    const refuse = (reason: XferReason): void => {
      this.send({ t: "CANCEL", id: f.id, reason });
      this.remember(f.id, "in", true);
    };
    // Step 4: busy.
    const kept = this.parts.find((p) => p.id === f.id && p.sha256 === f.sha256);
    if (
      this.tr.size >= XFER_MAX_TRANSFERS ||
      [...this.tr.values()].some((x) => x.st === "asking") ||
      kept?.held === true
    )
      return refuse("busy");
    // Step 5: the category, before the person is asked.
    if (
      this.o.mode === "c" &&
      (f.cat === undefined || !(this.o.categories ?? []).includes(f.cat))
    )
      return refuse("category");
    // Step 6: size and quota; a resume counts only the bytes still to come.
    const limit = this.o.hostLimit ?? null;
    if (limit !== null && f.size > limit) return refuse("size");
    const free = this.o.free?.() ?? null;
    const need = f.size - (this.resumable(f, kept) ? kept!.bytes : 0);
    if (free !== null && need > free) return refuse("quota");
    // Step 7: consent.
    const ask: XferAsk = { id: f.id, size: f.size };
    const shown = f.name === undefined ? null : cleanDisplayName(f.name);
    if (shown !== null) ask.name = shown;
    if (f.type !== undefined) ask.type = f.type;
    if (f.cat !== undefined) ask.cat = f.cat;
    const answer = this.o.handler === null ? "decline" : this.o.handler(ask);
    if (answer === "decline") return refuse("declined");
    this.tr.set(t.id, t);
    if (answer === "ask") {
      this.out.ask = ask;
      return;
    }
    this.accept(t);
  }

  private resumable(
    f: { size: number; chunk: number },
    p: XferPartial | undefined,
  ): boolean {
    return (
      p !== undefined &&
      p.size === f.size &&
      p.chunk === f.chunk &&
      this.clock - p.writtenAt <= XFER_PARTIAL_SECONDS
    );
  }

  /** Step 8: the resume lookup, then `ACCEPT`. */
  private accept(t: Tr): void {
    const m = this.parts.find((p) => p.id === t.id && p.sha256 === t.sha);
    let offset = 0;
    let hash = new Sha256();
    if (m !== undefined && this.resumable(t, m)) {
      const read = Math.min(m.reread ?? m.bytes, m.bytes);
      const want = Math.min(Math.floor(read / t.chunk) * t.chunk, t.size);
      if (this.o.rehash !== undefined && want > 0) {
        offset = want;
        hash = this.o.rehash(m.ref, offset);
      }
      t.partial = m.ref;
      this.eff({ truncate: m.ref, to: offset });
      m.bytes = offset;
      m.writtenAt = this.clock;
      delete m.reread;
    } else {
      if (m !== undefined) {
        this.eff({ discard: m.ref });
        this.parts = this.parts.filter((p) => p !== m);
      }
      if (t.size > 0) {
        if (this.parts.length >= XFER_MAX_PARTIALS_PER_PEER) {
          const oldest = this.parts.reduce((a, b) =>
            b.writtenAt < a.writtenAt ? b : a,
          );
          this.eff({ evict: oldest.ref });
          this.parts = this.parts.filter((p) => p !== oldest);
        }
        const ref = (
          this.o.newRef ?? ((i, s) => xferPartialPath(this.o.peerKey, i, s))
        )(t.id, t.sha);
        this.eff({ create: ref });
        this.parts.push({
          ref,
          id: t.id,
          sha256: t.sha,
          size: t.size,
          chunk: t.chunk,
          bytes: 0,
          writtenAt: this.clock,
        });
        t.partial = ref;
      }
    }
    t.hash = hash;
    t.recv = offset;
    t.ackedEnd = offset;
    t.st = "active";
    t.accepted = true;
    t.since = this.clock;
    this.send({ t: "ACCEPT", id: t.id, offset });
  }

  private onAccept(t: Tr, offset: number): void {
    if (t.dir !== "out" || t.accepted || t.st !== "offered")
      return this.fault();
    if (!offsetOk(offset, t, false)) return this.fault();
    t.accepted = true;
    if (offset > 0 && !t.seekable) {
      this.send({ t: "CANCEL", id: t.id, reason: "cancelled" });
      this.result(t, { id: t.id, outcome: "cancelled", reason: "cancelled" });
      this.end(t, true);
      return;
    }
    t.st = "active";
    t.sentEnd = offset;
    t.ackEnd = offset;
    t.since = this.clock;
    this.pump(t, true);
  }

  /** The sender sends what the window allows, then `DONE` once the last byte is out. */
  private pump(t: Tr, first: boolean): void {
    const from = t.sentEnd;
    const room = XFER_WINDOW * t.chunk - (t.sentEnd - t.ackEnd);
    const upTo = Math.min(t.size, t.sentEnd + Math.max(0, room));
    let end = t.sentEnd;
    while (end < upTo) end = Math.min(t.size, end + t.chunk);
    if (end > from) {
      this.send({ t: "CHUNKS", id: t.id, offset: from, bytes: end - from });
      t.sentEnd = end;
    }
    if (t.sentEnd === t.size) {
      this.send({ t: "DONE", id: t.id, sha256: t.sha });
      t.st = "doneSent";
      t.full = false;
      t.since = this.clock;
      return;
    }
    // The idle wait for an `ACK` starts when the window fills, and again on progress.
    const full = t.sentEnd - t.ackEnd >= XFER_WINDOW * t.chunk;
    if (full && (!t.full || end > from || first)) t.since = this.clock;
    t.full = full;
  }

  private onAck(t: Tr, offset: number): void {
    if (t.dir !== "out" || !t.accepted) return this.fault();
    if (offset < t.ackEnd || offset > t.sentEnd || !offsetOk(offset, t, true))
      return this.fault();
    t.ackEnd = offset;
    if (t.st === "active") this.pump(t, false);
  }

  private onChunk(body: Uint8Array): void {
    if (body.length < XFER_CHUNK_HEAD) return this.fault();
    const id = base64UrlEncodeBytes(body.subarray(0, 16));
    const t = this.tr.get(id);
    if (t === undefined) return this.late(id, XFER.CHUNK, undefined);
    if (t.dir !== "in" || t.st !== "active") return this.fault();
    const v = parseXferChunk(body, {
      size: t.size,
      chunk: t.chunk,
      expect: t.recv,
    });
    if (v === null) return this.fault();
    // The window: more than `XFER_WINDOW` chunks past the last `ACK` this side sent.
    if (v.offset + v.length - t.ackedEnd > XFER_WINDOW * t.chunk)
      return this.fault();
    const data = body.subarray(XFER_CHUNK_HEAD);
    const end = v.offset + v.length;
    t.hash!.update(data);
    const offset = t.recv;
    t.recv = end;
    t.sinceAck += 1;
    t.since = this.clock;
    const p = this.parts.find((x) => x.ref === t.partial);
    if (p !== undefined) {
      p.bytes = end;
      p.writtenAt = this.clock;
      this.out.partial.push({
        write: p.ref,
        offset,
        data: data.slice(),
      });
    }
    if (t.sinceAck >= XFER_ACK_EVERY || end === t.size) {
      t.sinceAck = 0;
      if (this.o.withholdAcks !== true) {
        this.send({ t: "ACK", id: t.id, offset: end });
        t.ackedEnd = end;
      }
    }
  }

  private onDone(t: Tr, sha: string | undefined): void {
    if (t.dir === "out") {
      // A `DONE` toward the sender carries no hash, and only follows its own `DONE`.
      if (sha !== undefined || t.st !== "doneSent") return this.fault();
      this.result(t, { id: t.id, outcome: "delivered" });
      this.end(t, false);
      return;
    }
    if (sha === undefined || t.st !== "active") return this.fault();
    const cancel = (reason: XferReason): void => {
      this.send({ t: "CANCEL", id: t.id, reason });
      if (t.partial !== undefined) this.eff({ delete: t.partial });
      this.result(t, { id: t.id, outcome: "cancelled", reason });
      this.end(t, true);
    };
    if (t.recv < t.size) return cancel("size");
    if (sha !== t.sha || hexOf(t.hash!.digest()) !== t.sha)
      return cancel("hash");
    this.send({ t: "DONE", id: t.id });
    if (t.partial !== undefined) this.eff({ finalize: t.partial });
    this.result(t, { id: t.id, outcome: "delivered" });
    this.end(t, false);
  }

  private onCancel(t: Tr, reason: XferReason): void {
    if (t.st === "asking") this.out.withdraw.push(t.id);
    else if (t.dir === "in" && t.partial !== undefined)
      this.eff(
        reason === "timeout" ? { keep: t.partial } : { delete: t.partial },
      );
    this.result(t, { id: t.id, outcome: "cancelled", reason });
    this.end(t, false);
  }
}

function blank(): XferOut {
  return { send: [], withdraw: [], results: [], partial: [] };
}
