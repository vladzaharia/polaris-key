// Reference: Direct Transfer, `xfer/1` (WIRE-CONTRACT-V5 §15.11; plans/CC-16-CC-19-CC-20-slices.md
// D-17 to D-23).
//
// The control-body codecs, the `CHUNK` check, the partial-file path, the display name and one
// side of a session (`RefXferSide`: both the sender and the receiver machine, over the records
// of one session). Written from the specification over `node:crypto` alone (the strict-JSON
// parser, the label cleaning and the hash helpers are the other references'), so it shares
// nothing with client-core. `peer-matrix.json` `xfer` is recomputed through it.

import { createHash } from "node:crypto";
import { refCanonicalB64url } from "./b64url.js";
import { type Json, refParseStrict } from "./config.js";
import { bytesHex, hexBytes, sha256 } from "./noise.js";
import { refCapsIntersection, utf8 } from "./peerMatrix.js";
import { refIsSpace, refIsStrip } from "./device-label.js";

export const REF_XFER_MAX_CONTROL = 4096;
export const REF_XFER_MAX_SIZE = 2 ** 40;
export const REF_XFER_DEFAULT_CHUNK = 61_440;
export const REF_XFER_MAX_CHUNK = 65_492;
export const REF_XFER_WINDOW = 16;
export const REF_XFER_ACK_EVERY = 8;
export const REF_XFER_MAX_TRANSFERS = 4;
export const REF_XFER_CONSENT_SECONDS = 120;
export const REF_XFER_IDLE_SECONDS = 60;
export const REF_XFER_PARTIAL_SECONDS = 86_400;
export const REF_XFER_MAX_PARTIALS = 8;
export const REF_XFER_ENDED_IDS = 64;
export const REF_XFER_CHUNK_HEAD = 24;

const REF_XFER_TYPES: Record<string, string> = {
  OFFER: "0020",
  ACCEPT: "0021",
  CHUNK: "0022",
  ACK: "0023",
  DONE: "0024",
  CANCEL: "0025",
};
export const REF_XFER_REASONS = [
  "declined",
  "cancelled",
  "hash",
  "size",
  "category",
  "busy",
  "quota",
  "timeout",
];

const SHA_RE = /^[0-9a-f]{64}$/;
const CAT_RE = /^[a-z0-9-]{1,32}$/;
const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** A transfer id: 22 canonical base64url characters of 16 bytes. */
export const refXferIdOk = (v: unknown): v is string =>
  typeof v === "string" && ID_RE.test(v) && refCanonicalB64url(v);

/** The content every machine row transfers: byte i of a transfer is (7 i + 13) mod 256. */
export const refXferByte = (i: number): number => (i * 7 + 13) & 0xff;
export const refXferContent = (from: number, to: number): Uint8Array =>
  Uint8Array.from({ length: to - from }, (_, k) => refXferByte(from + k));
export const refXferContentSha = (size: number): string =>
  bytesHex(sha256(refXferContent(0, size)));

// ── Control bodies ───────────────────────────────────────────────────────────

type Obj = { [k: string]: Json };

/** Strict JSON of a control body: at most 4 KiB, UTF-8 without a BOM, one object. */
function refControl(body: Uint8Array, nonInteger: Set<string>): Obj | null {
  if (body.length > REF_XFER_MAX_CONTROL) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      body,
    );
  } catch {
    return null;
  }
  if (text.startsWith("﻿")) return null;
  const parsed = refParseStrict(text, nonInteger);
  if (!parsed.ok) return null;
  const v = parsed.value;
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/** An integer token in [0, max]: a number, not written with a fraction or exponent. */
function refInt(
  o: Obj,
  name: string,
  nonInteger: Set<string>,
  min: number,
  max: number,
): number | null {
  const v = o[name];
  if (typeof v !== "number" || nonInteger.has(name)) return null;
  if (!Number.isInteger(v) || v < min || v > max) return null;
  return v;
}

export interface RefOffer {
  id: string;
  name?: string;
  type?: string;
  size: number;
  sha256: string;
  cat?: string;
  chunk: number;
}

export type RefOfferVerdict = { ok: true; offer: RefOffer } | { ok: false };

/** An `OFFER` body (§15.11 table). `maxMessage` is the receiver's own `HELLO` value. */
export function refXferOffer(
  body: Uint8Array,
  maxMessage: number,
): RefOfferVerdict {
  const no: RefOfferVerdict = { ok: false };
  const ni = new Set<string>();
  const o = refControl(body, ni);
  if (o === null) return no;
  if (!refXferIdOk(o.id)) return no;
  const out: RefOffer = {
    id: o.id,
    size: 0,
    sha256: "",
    chunk: 0,
  };
  if (o.name !== undefined) {
    if (typeof o.name !== "string" || utf8(o.name).length > 255) return no;
    out.name = o.name;
  }
  if (o.type !== undefined) {
    if (
      typeof o.type !== "string" ||
      utf8(o.type).length > 127 ||
      !TYPE_RE.test(o.type)
    )
      return no;
    out.type = o.type;
  }
  const size = refInt(o, "size", ni, 0, REF_XFER_MAX_SIZE);
  if (size === null) return no;
  out.size = size;
  if (typeof o.sha256 !== "string" || !SHA_RE.test(o.sha256)) return no;
  out.sha256 = o.sha256;
  if (o.cat !== undefined) {
    if (typeof o.cat !== "string" || !CAT_RE.test(o.cat)) return no;
    out.cat = o.cat;
  }
  const chunk = refInt(o, "chunk", ni, 1, REF_XFER_MAX_CHUNK);
  if (chunk === null || chunk + REF_XFER_CHUNK_HEAD > maxMessage) return no;
  out.chunk = chunk;
  return { ok: true, offer: out };
}

/** The offer parameters an offset is judged against. */
export interface RefParams {
  size: number;
  chunk: number;
}

/** An offset for `ACCEPT` (a multiple of chunk) or `ACK` (also `size` itself). */
const offsetOk = (v: number, p: RefParams, ack: boolean): boolean =>
  v >= 0 && v <= p.size && (v % p.chunk === 0 || (ack && v === p.size));

export type RefOffsetVerdict =
  | { ok: true; id: string; offset: number }
  | { ok: false };

/** An `ACCEPT` or `ACK` body, `{id, offset}`, judged against its `OFFER`. */
export function refXferOffsetBody(
  kind: "ACCEPT" | "ACK",
  body: Uint8Array,
  p: RefParams,
): RefOffsetVerdict {
  const ni = new Set<string>();
  const o = refControl(body, ni);
  if (o === null || !refXferIdOk(o.id)) return { ok: false };
  const offset = refInt(o, "offset", ni, 0, REF_XFER_MAX_SIZE);
  if (offset === null || !offsetOk(offset, p, kind === "ACK"))
    return { ok: false };
  return { ok: true, id: o.id, offset };
}

export type RefDoneVerdict =
  | { ok: true; id: string; sha256?: string }
  | { ok: false };

/**
 * A `DONE` body. Toward the receiver it carries `{id, sha256}`; toward the sender it is `{id}`
 * and a `sha256` there is a fault.
 */
export function refXferDone(
  body: Uint8Array,
  toward: "receiver" | "sender",
): RefDoneVerdict {
  const o = refControl(body, new Set());
  if (o === null || !refXferIdOk(o.id)) return { ok: false };
  if (toward === "sender")
    return o.sha256 === undefined ? { ok: true, id: o.id } : { ok: false };
  if (typeof o.sha256 !== "string" || !SHA_RE.test(o.sha256))
    return { ok: false };
  return { ok: true, id: o.id, sha256: o.sha256 };
}

export type RefCancelVerdict =
  | { ok: true; id: string; reason: string }
  | { ok: false };

/** A `CANCEL` body. A string outside the eight reasons reads as `cancelled`. */
export function refXferCancel(body: Uint8Array): RefCancelVerdict {
  const o = refControl(body, new Set());
  if (o === null || !refXferIdOk(o.id)) return { ok: false };
  if (typeof o.reason !== "string") return { ok: false };
  return {
    ok: true,
    id: o.id,
    reason: REF_XFER_REASONS.includes(o.reason) ? o.reason : "cancelled",
  };
}

export type RefChunkVerdict =
  | { ok: true; id: string; offset: number; length: number }
  | { ok: false };

/** What a `CHUNK` is judged against: its offer and the next offset the receiver expects. */
export interface RefChunkCtx extends RefParams {
  expect: number;
}

/** The `CHUNK` rules of §15.11 that need only the body, the offer and the expected offset. */
export function refXferChunk(
  body: Uint8Array,
  c: RefChunkCtx,
): RefChunkVerdict {
  const no: RefChunkVerdict = { ok: false };
  if (body.length < REF_XFER_CHUNK_HEAD) return no;
  const id = Buffer.from(body.subarray(0, 16)).toString("base64url");
  const big = new DataView(body.buffer, body.byteOffset + 16, 8).getBigUint64(
    0,
  );
  const length = body.length - REF_XFER_CHUNK_HEAD;
  if (length === 0 || length > c.chunk) return no;
  if (big !== BigInt(c.expect)) return no;
  const offset = c.expect;
  if (offset + length > c.size) return no;
  if (length < c.chunk && offset + length !== c.size) return no;
  return { ok: true, id, offset, length };
}

/** A `CHUNK` body: id(16) || u64be offset || data (zero bytes here; the content is not judged). */
export function refXferChunkBody(
  id: string,
  offset: number,
  length: number,
): Uint8Array {
  const b = new Uint8Array(REF_XFER_CHUNK_HEAD + Math.max(0, length));
  b.set(Buffer.from(id, "base64url"), 0);
  new DataView(b.buffer).setBigUint64(16, BigInt(offset));
  return b;
}

// ── The name is display data ─────────────────────────────────────────────────

/**
 * The `name` as shown: §12.7.1 steps 1 and 2, NFC, then step 3 (collapse and trim) and step 5
 * (nothing left means no name); the 64-code-point cut is not applied. Null when no name.
 */
export function refXferDisplayName(raw: string): string | null {
  let s = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (refIsSpace(cp)) s += " ";
    else if (!refIsStrip(cp)) s += ch;
  }
  const shown = s.normalize("NFC").replace(/ +/g, " ").replace(/^ | $/g, "");
  return shown === "" ? null : shown;
}

/**
 * The partial file's name: hex(SHA-256("pkey-xfer/1 partial" || 0x00 || key || idBytes ||
 * sha256Bytes)). `key` is the 32 raw bytes of the remote static key.
 */
export function refXferPartialPath(
  keyHex: string,
  id: string,
  sha256Hex: string,
): string {
  return bytesHex(
    sha256(
      utf8("pkey-xfer/1 partial"),
      Uint8Array.of(0),
      hexBytes(keyHex),
      Uint8Array.from(Buffer.from(id, "base64url")),
      hexBytes(sha256Hex),
    ),
  );
}

// ── One side of a session ────────────────────────────────────────────────────

export interface RefPartial {
  ref: string;
  id: string;
  sha256: string;
  size: number;
  chunk: number;
  /** Bytes on disk. */
  bytes: number;
  /** Seconds (the row's clock) of the last write. */
  writtenAt: number;
  /** A live transfer in another session holds it. */
  held?: boolean;
  /** Bytes re-read and hashed since this session began; default `bytes`. */
  reread?: number;
  /** The bytes on disk are not the content (a hash failure test). */
  corrupt?: boolean;
  /** Another peer's key: never matched, never counted for this peer. */
  otherPeer?: boolean;
}

export interface RefCtx {
  mode: string;
  capsLocal: string[];
  capsRemote: string[];
  /** The receiver's own `HELLO` `maxMessage`. */
  maxMessage: number;
  /** The host's own size limit; null for none. */
  hostLimit: number | null;
  /** Bytes the store can still take; null for unlimited. */
  free: number | null;
  /** How the host answers an offer: at once, later (`ask`), at once with a refusal or not at all. */
  handler: "accept" | "ask" | "decline" | "none";
  /** The link's categories (modes c and l). */
  cats: string[];
  partials: RefPartial[];
  /** The remote static key, hex (the partial key). */
  peerKey: string;
  /** A receiver whose ACKs are not yet sent (its writer is behind): the window is judged from the last ACK sent. */
  withholdAcks?: boolean;
}

export type RefEv =
  | { at: number; rx: "PING" }
  | {
      at: number;
      rx: "OFFER";
      body: string;
      more?: boolean;
    }
  | { at: number; rx: "ACCEPT"; id: string; offset: number; more?: boolean }
  | {
      at: number;
      rx: "CHUNK";
      id: string;
      offset: number;
      length: number;
      data?: "corrupt";
      more?: boolean;
    }
  | { at: number; rx: "ACK"; id: string; offset: number; more?: boolean }
  | {
      at: number;
      rx: "DONE";
      id: string;
      sha256?: string;
      more?: boolean;
    }
  | { at: number; rx: "CANCEL"; id: string; reason: string; more?: boolean }
  | {
      at: number;
      host: "offer";
      id: string;
      size: number;
      chunk: number;
      sha256: string;
      cat?: string;
      seekable?: boolean;
    }
  | { at: number; host: "consent"; id: string; answer: "accept" | "decline" }
  | { at: number; host: "cancel"; id: string }
  | { at: number; host: "close" }
  | { at: number; host: "newSession" }
  | { at: number; host: "tick" };

export type RefSend =
  | {
      t: "OFFER";
      id: string;
      size: number;
      chunk: number;
      sha256: string;
      cat?: string;
    }
  | { t: "ACCEPT"; id: string; offset: number }
  | { t: "CHUNKS"; id: string; offset: number; bytes: number }
  | { t: "ACK"; id: string; offset: number }
  | { t: "DONE"; id: string; sha256?: string }
  | { t: "CANCEL"; id: string; reason: string };

export interface RefOut {
  send?: RefSend[];
  close?: string;
  ask?: {
    id: string;
    name?: string;
    type?: string;
    size: number;
    cat?: string;
  };
  withdraw?: string;
  result?: { id: string; outcome: string; reason?: string };
  partial?: Record<string, unknown>[];
  refused?: string;
  drop?: boolean;
}

interface Tr {
  id: string;
  dir: "in" | "out";
  st: "asking" | "offered" | "active" | "doneSent";
  size: number;
  chunk: number;
  sha: string;
  cat?: string;
  name?: string;
  type?: string;
  /** When the current wait began. */
  since: number;
  // in
  recv: number;
  sinceAck: number;
  ackedEnd: number;
  hash?: ReturnType<typeof createHash>;
  partial?: string;
  accepted?: boolean;
  // out
  sentEnd: number;
  ackEnd: number;
  seekable: boolean;
  full: boolean;
}

interface Ended {
  id: string;
  dir: "in" | "out";
  /** `we-cancelled` lets a late `DONE` count as delivery. */
  how: "we-cancelled" | "other";
}

const reasonOf = (r: string): string =>
  REF_XFER_REASONS.includes(r) ? r : "cancelled";

/** One side of one `pkey-peer/1` session, driven by records, host calls and the clock. */
export class RefXferSide {
  private tr = new Map<string, Tr>();
  private ended: Ended[] = [];
  private closed = false;
  private partials: RefPartial[];
  private nextNew = 1;
  private clock = 0;
  /** The step's output being built. */
  private o: RefOut = {};

  constructor(private ctx: RefCtx) {
    this.partials = ctx.partials.map((p) => ({ ...p }));
  }

  // ── output helpers ─────────────────────────────────────────────────────────

  private send(s: RefSend): void {
    (this.o.send ??= []).push(s);
  }
  private eff(e: Record<string, unknown>): void {
    (this.o.partial ??= []).push(e);
    const gone = e.delete ?? e.finalize;
    if (gone !== undefined)
      this.partials = this.partials.filter((p) => p.ref !== gone);
  }
  private fault(): void {
    this.o.close = "peer_bad_frame";
    this.closed = true;
  }
  private result(t: Tr, outcome: string, reason?: string): void {
    if (t.st === "asking") return;
    this.o.result = {
      id: t.id,
      outcome,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  private live(): Tr[] {
    return [...this.tr.values()];
  }
  private remember(id: string, dir: "in" | "out", how: Ended["how"]): void {
    this.ended.push({ id, dir, how });
    while (this.ended.length > REF_XFER_ENDED_IDS) this.ended.shift();
  }
  private end(t: Tr, how: Ended["how"]): void {
    this.tr.delete(t.id);
    this.remember(t.id, t.dir, how);
  }
  private caps(): boolean {
    return refCapsIntersection(
      this.ctx.capsLocal,
      this.ctx.capsRemote,
    ).includes("xfer/1");
  }

  // ── the clock ──────────────────────────────────────────────────────────────

  /** Every wait that ran out by `at` ends with `CANCEL timeout`. */
  private expire(at: number): void {
    for (const t of this.live()) {
      let limit: number;
      if (t.dir === "in") {
        limit =
          t.st === "asking" ? REF_XFER_CONSENT_SECONDS : REF_XFER_IDLE_SECONDS;
      } else if (t.st === "offered") {
        limit = REF_XFER_CONSENT_SECONDS + REF_XFER_IDLE_SECONDS;
      } else if (t.st === "doneSent") limit = REF_XFER_IDLE_SECONDS;
      else if (t.full) limit = REF_XFER_IDLE_SECONDS;
      else continue;
      if (at - t.since <= limit) continue;
      this.send({ t: "CANCEL", id: t.id, reason: "timeout" });
      if (t.st === "asking") this.o.withdraw = t.id;
      else if (t.dir === "in" && t.partial !== undefined)
        this.eff({ keep: t.partial });
      this.result(t, "cancelled", "timeout");
      this.end(t, "we-cancelled");
    }
  }

  // ── step ───────────────────────────────────────────────────────────────────

  step(ev: RefEv): RefOut {
    this.o = {};
    if (this.closed && !("host" in ev && ev.host === "newSession"))
      return this.o;
    this.clock = ev.at;
    this.expire(ev.at);
    if ("host" in ev) this.host(ev);
    else this.rx(ev);
    return this.o;
  }

  private host(ev: Extract<RefEv, { host: string }>): void {
    if (ev.host === "tick") return;
    if (ev.host === "newSession") {
      this.tr.clear();
      this.ended = [];
      this.closed = false;
      this.partials = this.partials.map((p) => ({ ...p, held: false }));
      for (const p of this.partials) delete p.reread;
      return;
    }
    if (ev.host === "close") {
      for (const t of this.live()) {
        if (t.st === "asking") this.o.withdraw = t.id;
        else if (t.dir === "in" && t.partial !== undefined)
          this.eff({ keep: t.partial });
        this.result(t, "closed");
      }
      this.tr.clear();
      this.closed = true;
      return;
    }
    if (ev.host === "offer") {
      if (this.live().length >= REF_XFER_MAX_TRANSFERS) {
        this.o.refused = "busy";
        return;
      }
      const t = this.newTr(ev.id, "out", ev.size, ev.chunk, ev.sha256);
      t.st = "offered";
      t.cat = ev.cat;
      t.seekable = ev.seekable !== false;
      this.tr.set(t.id, t);
      this.send({
        t: "OFFER",
        id: ev.id,
        size: ev.size,
        chunk: ev.chunk,
        sha256: ev.sha256,
        ...(ev.cat !== undefined ? { cat: ev.cat } : {}),
      });
      return;
    }
    if (ev.host === "consent") {
      const t = this.tr.get(ev.id);
      if (t === undefined || t.st !== "asking") return;
      if (ev.answer === "decline") {
        this.send({ t: "CANCEL", id: t.id, reason: "declined" });
        this.end(t, "we-cancelled");
        return;
      }
      this.accept(t);
      return;
    }
    // host cancel
    const t = this.tr.get(ev.id);
    if (t === undefined) return;
    // After its DONE a sender sends no CANCEL other than timeout.
    if (t.dir === "out" && t.st === "doneSent") return;
    this.send({ t: "CANCEL", id: t.id, reason: "cancelled" });
    if (t.st === "asking") this.o.withdraw = t.id;
    else if (t.dir === "in" && t.partial !== undefined)
      this.eff({ delete: t.partial });
    this.result(t, "cancelled", "cancelled");
    this.end(t, "we-cancelled");
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
      sentEnd: 0,
      ackEnd: 0,
      seekable: true,
      full: false,
    };
  }

  // ── records ────────────────────────────────────────────────────────────────

  private rx(ev: Extract<RefEv, { rx: string }>): void {
    if (ev.rx === "PING") return;
    // Step 1: the mode and the capability.
    if (
      this.ctx.mode !== "a" &&
      this.ctx.mode !== "c" &&
      this.ctx.mode !== "l"
    ) {
      this.o.close = "peer_not_allowed";
      this.closed = true;
      return;
    }
    if (!this.caps()) {
      this.o.close = "peer_not_allowed";
      this.closed = true;
      return;
    }
    if ("more" in ev && ev.more === true) return this.fault();
    if (ev.rx === "OFFER") return this.onOffer(ev.body);
    const id = ev.id;
    const t = this.tr.get(id);
    if (t === undefined) {
      const e = this.ended.find((x) => x.id === id);
      if (e === undefined) return this.fault();
      // A record for an ended id: dropped, except a DONE that reaches a sender that cancelled.
      if (
        ev.rx === "DONE" &&
        e.dir === "out" &&
        e.how === "we-cancelled" &&
        ev.sha256 === undefined
      ) {
        this.o.result = { id, outcome: "delivered" };
        e.how = "other";
        return;
      }
      this.o.drop = true;
      return;
    }
    switch (ev.rx) {
      case "ACCEPT":
        return this.onAccept(t, ev.offset);
      case "CHUNK":
        return this.onChunk(t, ev.offset, ev.length, ev.data === "corrupt");
      case "ACK":
        return this.onAck(t, ev.offset);
      case "DONE":
        return this.onDone(t, ev.sha256);
      case "CANCEL":
        return this.onCancel(t, ev.reason);
    }
  }

  private onOffer(text: string): void {
    const v = refXferOffer(utf8(text), this.ctx.maxMessage);
    if (!v.ok) return this.fault();
    const f = v.offer;
    if (this.tr.has(f.id) || this.ended.some((e) => e.id === f.id))
      return this.fault();
    const t = this.newTr(f.id, "in", f.size, f.chunk, f.sha256);
    t.cat = f.cat;
    t.name = f.name;
    t.type = f.type;
    const refuse = (reason: string): void => {
      this.send({ t: "CANCEL", id: f.id, reason });
      this.remember(f.id, "in", "we-cancelled");
    };
    // Step 4: busy.
    const matching = this.partials.find(
      (p) => !p.otherPeer && p.id === f.id && p.sha256 === f.sha256,
    );
    if (
      this.live().length >= REF_XFER_MAX_TRANSFERS ||
      this.live().some((x) => x.st === "asking") ||
      (matching !== undefined && matching.held === true)
    )
      return refuse("busy");
    // Step 5: the category, before the person is asked.
    if (
      (this.ctx.mode === "c" || this.ctx.mode === "l") &&
      (f.cat === undefined || !this.ctx.cats.includes(f.cat))
    )
      return refuse("category");
    // Step 6: size and quota; a resume counts only the bytes still to come.
    if (this.ctx.hostLimit !== null && f.size > this.ctx.hostLimit)
      return refuse("size");
    const resumable = this.resumable(f, matching);
    const need = f.size - (resumable ? matching!.bytes : 0);
    if (this.ctx.free !== null && need > this.ctx.free) return refuse("quota");
    // Step 7: consent.
    if (this.ctx.handler === "none" || this.ctx.handler === "decline")
      return refuse("declined");
    this.tr.set(t.id, t);
    if (this.ctx.handler === "ask") {
      const shown = f.name === undefined ? null : refXferDisplayName(f.name);
      this.o.ask = {
        id: f.id,
        ...(shown !== null ? { name: shown } : {}),
        ...(f.type !== undefined ? { type: f.type } : {}),
        size: f.size,
        ...(f.cat !== undefined ? { cat: f.cat } : {}),
      };
      return;
    }
    this.accept(t);
  }

  private resumable(
    f: { size: number; chunk: number },
    p: RefPartial | undefined,
  ): boolean {
    return (
      p !== undefined &&
      p.size === f.size &&
      p.chunk === f.chunk &&
      this.clock - p.writtenAt <= REF_XFER_PARTIAL_SECONDS
    );
  }

  /** Step 8: the resume lookup, then `ACCEPT`. */
  private accept(t: Tr): void {
    const m = this.partials.find(
      (p) => !p.otherPeer && p.id === t.id && p.sha256 === t.sha,
    );
    let offset = 0;
    if (m !== undefined && this.resumable(t, m)) {
      const read = Math.min(m.reread ?? m.bytes, m.bytes);
      offset = Math.min(Math.floor(read / t.chunk) * t.chunk, t.size);
      t.partial = m.ref;
      this.eff({ truncate: m.ref, to: offset });
      m.bytes = offset;
      m.writtenAt = this.clock;
      delete m.reread;
    } else {
      if (m !== undefined) {
        this.eff({ discard: m.ref });
        this.partials = this.partials.filter((p) => p !== m);
      }
      if (t.size > 0) {
        const mine = this.partials.filter((p) => !p.otherPeer);
        if (mine.length >= REF_XFER_MAX_PARTIALS) {
          const oldest = mine.reduce((a, b) =>
            b.writtenAt < a.writtenAt ? b : a,
          );
          this.eff({ evict: oldest.ref });
          this.partials = this.partials.filter((p) => p !== oldest);
        }
        const ref = `n${this.nextNew++}`;
        this.eff({ create: ref });
        this.partials.push({
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
    const h = createHash("sha256");
    const prior = this.partials.find((p) => p.ref === t.partial);
    const bytes = refXferContent(0, offset);
    if (prior?.corrupt === true) bytes.forEach((b, i) => (bytes[i] = b ^ 0xff));
    h.update(bytes);
    t.hash = h;
    t.recv = offset;
    t.ackedEnd = offset;
    t.st = "active";
    t.accepted = true;
    t.since = this.clock;
    this.send({ t: "ACCEPT", id: t.id, offset });
  }

  private onAccept(t: Tr, offset: number): void {
    if (t.dir !== "out" || t.accepted === true) return this.fault();
    if (t.st !== "offered") return this.fault();
    if (!offsetOk(offset, t, false)) return this.fault();
    t.accepted = true;
    if (offset > 0 && !t.seekable) {
      this.send({ t: "CANCEL", id: t.id, reason: "cancelled" });
      this.result(t, "cancelled", "cancelled");
      this.end(t, "we-cancelled");
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
    const room = REF_XFER_WINDOW * t.chunk - (t.sentEnd - t.ackEnd);
    const upTo = Math.min(t.size, t.sentEnd + Math.max(0, room));
    // Whole chunks only until the end.
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
    const full = t.sentEnd - t.ackEnd >= REF_XFER_WINDOW * t.chunk;
    if (full && (!t.full || end > from || first)) t.since = this.clock;
    t.full = full;
  }

  private onAck(t: Tr, offset: number): void {
    if (t.dir !== "out" || !t.accepted) return this.fault();
    if (
      offset < t.ackEnd ||
      offset > t.sentEnd ||
      (offset % t.chunk !== 0 && offset !== t.size)
    )
      return this.fault();
    t.ackEnd = offset;
    if (t.st === "active") this.pump(t, false);
  }

  private onChunk(
    t: Tr,
    offset: number,
    length: number,
    corrupt: boolean,
  ): void {
    if (t.dir !== "in" || t.st !== "active") return this.fault();
    const v = refXferChunk(refXferChunkBody(t.id, offset, length), {
      size: t.size,
      chunk: t.chunk,
      expect: t.recv,
    });
    if (!v.ok) return this.fault();
    // The window: more than XFER_WINDOW chunks past the last ACK this side sent.
    if (offset + length - t.ackedEnd > REF_XFER_WINDOW * t.chunk)
      return this.fault();
    const data = refXferContent(offset, offset + length);
    if (corrupt) data.forEach((b, i) => (data[i] = b ^ 0xff));
    t.hash!.update(data);
    t.recv = offset + length;
    t.sinceAck += 1;
    t.since = this.clock;
    const p = this.partials.find((x) => x.ref === t.partial);
    if (p !== undefined) {
      p.bytes = t.recv;
      p.writtenAt = this.clock;
    }
    if (t.sinceAck >= REF_XFER_ACK_EVERY || t.recv === t.size) {
      t.sinceAck = 0;
      if (this.ctx.withholdAcks !== true) {
        this.send({ t: "ACK", id: t.id, offset: t.recv });
        t.ackedEnd = t.recv;
      }
    }
  }

  private onDone(t: Tr, sha: string | undefined): void {
    if (t.dir === "out") {
      if (sha !== undefined || t.st !== "doneSent") return this.fault();
      this.result(t, "delivered");
      this.end(t, "other");
      return;
    }
    if (sha === undefined || t.st !== "active") return this.fault();
    const cancel = (reason: string): void => {
      this.send({ t: "CANCEL", id: t.id, reason });
      if (t.partial !== undefined) this.eff({ delete: t.partial });
      this.result(t, "cancelled", reason);
      this.end(t, "we-cancelled");
    };
    if (t.recv < t.size) return cancel("size");
    if (sha !== t.sha) return cancel("hash");
    if (t.hash!.digest("hex") !== t.sha) return cancel("hash");
    this.send({ t: "DONE", id: t.id });
    if (t.partial !== undefined) this.eff({ finalize: t.partial });
    this.result(t, "delivered");
    this.end(t, "other");
  }

  private onCancel(t: Tr, reason: string): void {
    const r = reasonOf(reason);
    if (t.st === "asking") this.o.withdraw = t.id;
    else if (t.dir === "in" && t.partial !== undefined)
      this.eff(r === "timeout" ? { keep: t.partial } : { delete: t.partial });
    this.result(t, "cancelled", r);
    this.end(t, "other");
  }
}
