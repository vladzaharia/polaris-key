// `peer-matrix.json` section `xfer` (CC-20.1; WIRE-CONTRACT-V5 §15.11, Direct Transfer `xfer/1`):
// the control-body and `CHUNK` codecs, the window and its timers, the order of checks on an
// `OFFER`, the hash before delivery, the late records and endings, the resume, the partial-file
// name and the limits. Every row is recomputed through `reference/xfer.ts` (`node:crypto` only;
// nothing from client-core). The partial-path vectors are also checked against a second,
// hand-concatenated SHA-256 here.

import { createHash } from "node:crypto";
import {
  REF_XFER_ACK_EVERY,
  REF_XFER_CONSENT_SECONDS,
  REF_XFER_DEFAULT_CHUNK,
  REF_XFER_ENDED_IDS,
  REF_XFER_IDLE_SECONDS,
  REF_XFER_MAX_CHUNK,
  REF_XFER_MAX_CONTROL,
  REF_XFER_MAX_PARTIALS,
  REF_XFER_MAX_SIZE,
  REF_XFER_MAX_TRANSFERS,
  REF_XFER_PARTIAL_SECONDS,
  REF_XFER_WINDOW,
  RefXferSide,
  type RefCtx,
  type RefEv,
  type RefPartial,
  refXferByte,
  refXferCancel,
  refXferChunk,
  refXferContentSha,
  refXferDisplayName,
  refXferDone,
  refXferOffer,
  refXferOffsetBody,
  refXferPartialPath,
} from "./reference/xfer.js";
import { bytesHex, hexBytes, sha256 } from "./reference/noise.js";
import { utf8 } from "./reference/peerMatrix.js";

const hex = bytesHex;
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
/** Fixed test material: SHA-256 of a label. Never used outside this file. */
const mat = (label: string): Uint8Array =>
  sha256(utf8(`pkey-xfer/1 matrix vector ${label}`));
/** A transfer id from a label: 16 bytes, 22 canonical base64url characters. */
const xid = (label: string): string => b64u(mat(label).slice(0, 16));
const PEER = hex(mat("peer static key"));

/** JSON with sorted member names, so a check does not depend on the order a row was written in. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : 1,
          ),
        )
      : x,
  );
}

function check(label: string, got: unknown, want: unknown): void {
  if (canon(got) !== canon(want))
    throw new Error(
      `xfer ${label}: reference gives ${JSON.stringify(got)}, row says ${JSON.stringify(want)}`,
    );
}

/** A copy of `s` with its last character changed so the unused low bits are not zero. */
function dirtyLastChar(s: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return s.slice(0, -1) + A[A.indexOf(s.slice(-1)) ^ 1]!;
}

const SHA = (size: number): string => refXferContentSha(size);
const MAXM = 1_048_576;

// ── codecs ───────────────────────────────────────────────────────────────────

interface OfferIn {
  id: string;
  text?: string;
  hex?: string;
  maxMessage?: number;
}

const goodOffer = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: xid("offer a"),
    size: 100,
    sha256: SHA(100),
    chunk: 10,
    ...over,
  });
/** A body with one member of the good offer replaced by raw JSON text. */
const rawMember = (name: string, rawJson: string): string => {
  const base = JSON.parse(goodOffer()) as Record<string, unknown>;
  const parts = Object.entries(base).map(([k, v]) =>
    k === name ? `"${k}":${rawJson}` : `"${k}":${JSON.stringify(v)}`,
  );
  if (!(name in base)) parts.push(`"${name}":${rawJson}`);
  return `{${parts.join(",")}}`;
};
const without = (name: string): string => {
  const o = JSON.parse(goodOffer()) as Record<string, unknown>;
  delete o[name];
  return JSON.stringify(o);
};

/** A good offer with a name whose one byte is 0xff, which is not UTF-8. */
function invalidUtf8(): string {
  const b = utf8(goodOffer({ name: "x" }));
  const at = b.indexOf(0x78, Buffer.from(b).indexOf('"name":"') + 8);
  b[at] = 0xff;
  return hex(b);
}

function buildOfferCodec(): unknown[] {
  const ID = xid("offer a");
  const A32 = "a".repeat(32);
  const rows: OfferIn[] = [
    {
      id: "minimal",
      text: JSON.stringify({ id: ID, size: 0, sha256: SHA(0), chunk: 1 }),
    },
    {
      id: "full",
      text: JSON.stringify({
        id: ID,
        name: "holiday photos.zip",
        type: "application/zip",
        size: REF_XFER_MAX_SIZE,
        sha256: SHA(100),
        cat: "docs",
        chunk: REF_XFER_MAX_CHUNK,
      }),
    },
    {
      id: "default-chunk",
      text: goodOffer({ chunk: REF_XFER_DEFAULT_CHUNK, size: 1_000_000 }),
    },
    {
      id: "member-order-free",
      text: `{"chunk":10,"sha256":"${SHA(100)}","size":100,"id":"${ID}"}`,
    },
    {
      id: "with-whitespace",
      text: ` { "id" : "${ID}" , "size" : 100 , "sha256" : "${SHA(100)}" , "chunk" : 10 } `,
    },
    { id: "unknown-members-ignored", text: goodOffer({ x: 1, y: { z: [1] } }) },
    { id: "id-21-characters", text: goodOffer({ id: ID.slice(0, 21) }) },
    { id: "id-23-characters", text: goodOffer({ id: `${ID}A` }) },
    { id: "id-non-canonical", text: goodOffer({ id: dirtyLastChar(ID) }) },
    { id: "id-padded", text: goodOffer({ id: `${ID.slice(0, 20)}==` }) },
    { id: "id-standard-alphabet", text: goodOffer({ id: "+".repeat(22) }) },
    { id: "id-not-string", text: goodOffer({ id: 7 }) },
    { id: "id-missing", text: without("id") },
    { id: "name-255-bytes", text: goodOffer({ name: "a".repeat(255) }) },
    { id: "name-256-bytes", text: goodOffer({ name: "a".repeat(256) }) },
    {
      id: "name-255-bytes-multibyte",
      text: goodOffer({ name: "€".repeat(85) }),
    },
    {
      id: "name-258-bytes-multibyte",
      text: goodOffer({ name: "€".repeat(86) }),
    },
    { id: "name-not-string", text: goodOffer({ name: 5 }) },
    { id: "name-null", text: goodOffer({ name: null }) },
    {
      id: "type-valid-symbols",
      text: goodOffer({ type: "application/vnd.a+json" }),
    },
    { id: "type-127-bytes", text: goodOffer({ type: `a/${"b".repeat(125)}` }) },
    { id: "type-128-bytes", text: goodOffer({ type: `a/${"b".repeat(126)}` }) },
    { id: "type-upper-case", text: goodOffer({ type: "Text/plain" }) },
    { id: "type-no-slash", text: goodOffer({ type: "textplain" }) },
    { id: "type-empty-subtype", text: goodOffer({ type: "text/" }) },
    {
      id: "type-parameter",
      text: goodOffer({ type: "text/plain; charset=utf-8" }),
    },
    { id: "type-not-string", text: goodOffer({ type: 1 }) },
    { id: "size-zero", text: goodOffer({ size: 0, sha256: SHA(0) }) },
    { id: "size-max", text: goodOffer({ size: REF_XFER_MAX_SIZE }) },
    { id: "size-over-max", text: goodOffer({ size: REF_XFER_MAX_SIZE + 1 }) },
    { id: "size-negative", text: goodOffer({ size: -1 }) },
    { id: "size-fraction-token", text: rawMember("size", "100.0") },
    { id: "size-exponent-token", text: rawMember("size", "1e2") },
    { id: "size-fraction", text: rawMember("size", "100.5") },
    { id: "size-string", text: goodOffer({ size: "100" }) },
    { id: "size-missing", text: without("size") },
    {
      id: "sha256-upper-case",
      text: goodOffer({ sha256: SHA(100).toUpperCase() }),
    },
    { id: "sha256-63", text: goodOffer({ sha256: SHA(100).slice(1) }) },
    { id: "sha256-65", text: goodOffer({ sha256: `${SHA(100)}0` }) },
    {
      id: "sha256-not-hex",
      text: goodOffer({ sha256: `g${SHA(100).slice(1)}` }),
    },
    { id: "sha256-missing", text: without("sha256") },
    { id: "cat-valid", text: goodOffer({ cat: "photos-2" }) },
    { id: "cat-32", text: goodOffer({ cat: A32 }) },
    { id: "cat-33", text: goodOffer({ cat: `${A32}a` }) },
    { id: "cat-empty", text: goodOffer({ cat: "" }) },
    { id: "cat-upper-case", text: goodOffer({ cat: "Docs" }) },
    { id: "cat-underscore", text: goodOffer({ cat: "my_docs" }) },
    { id: "cat-not-string", text: goodOffer({ cat: 3 }) },
    { id: "cat-absent-is-not-a-body-fault", text: without("cat") },
    { id: "chunk-one", text: goodOffer({ chunk: 1 }) },
    { id: "chunk-max", text: goodOffer({ chunk: REF_XFER_MAX_CHUNK }) },
    {
      id: "chunk-over-max",
      text: goodOffer({ chunk: REF_XFER_MAX_CHUNK + 1 }),
    },
    { id: "chunk-zero", text: goodOffer({ chunk: 0 }) },
    { id: "chunk-negative", text: goodOffer({ chunk: -4 }) },
    { id: "chunk-fraction-token", text: rawMember("chunk", "10.0") },
    { id: "chunk-exponent-token", text: rawMember("chunk", "6e4") },
    { id: "chunk-missing", text: without("chunk") },
    {
      id: "chunk-fits-max-message",
      text: goodOffer({ chunk: 4072 }),
      maxMessage: 4096,
    },
    {
      id: "chunk-over-max-message",
      text: goodOffer({ chunk: 4073 }),
      maxMessage: 4096,
    },
    { id: "not-json", text: "offer" },
    { id: "empty-body", text: "" },
    { id: "array", text: `[${goodOffer()}]` },
    { id: "trailing-comma", text: goodOffer().replace(/}$/, ",}") },
    { id: "trailing-garbage", text: `${goodOffer()} x` },
    {
      id: "duplicate-members",
      text: goodOffer().replace(/}$/, `,"size":100}`),
    },
    { id: "bom", hex: "efbbbf" + hex(utf8(goodOffer())) },
    { id: "invalid-utf8", hex: invalidUtf8() },
    {
      id: "body-4096-bytes",
      text:
        goodOffer()
          .replace(/}$/, "")
          .padEnd(REF_XFER_MAX_CONTROL - 1, " ") + "}",
    },
    {
      id: "body-4097-bytes",
      text:
        goodOffer().replace(/}$/, "").padEnd(REF_XFER_MAX_CONTROL, " ") + "}",
    },
  ];
  return rows.map((r) => {
    const bytes = r.hex !== undefined ? hexBytes(r.hex) : utf8(r.text!);
    const maxMessage = r.maxMessage ?? MAXM;
    const v = refXferOffer(bytes, maxMessage);
    return {
      id: r.id,
      ...(r.hex !== undefined ? { bodyHex: r.hex } : { body: r.text }),
      length: bytes.length,
      maxMessage,
      want: v.ok ? { ok: true, offer: v.offer } : { ok: false },
    };
  });
}

interface OffIn {
  id: string;
  kind: "ACCEPT" | "ACK";
  size: number;
  chunk: number;
  text: string;
}

function buildOffsetCodec(): unknown[] {
  const ID = xid("offer a");
  const o = (offset: unknown): string => JSON.stringify({ id: ID, offset });
  const rows: OffIn[] = [];
  for (const kind of ["ACCEPT", "ACK"] as const) {
    const k = kind.toLowerCase();
    const add = (id: string, text: string, size = 100, chunk = 10): void => {
      rows.push({ id: `${k}-${id}`, kind, size, chunk, text });
    };
    add("zero", o(0));
    add("multiple", o(50));
    add("at-size-multiple", o(100));
    add("not-a-multiple", o(15));
    add("over-size", o(110));
    add("negative", o(-10));
    add("fraction-token", `{"id":"${ID}","offset":50.0}`);
    add("exponent-token", `{"id":"${ID}","offset":5e1}`);
    add("string", o("50"));
    add("missing-offset", JSON.stringify({ id: ID }));
    add("missing-id", JSON.stringify({ offset: 0 }));
    add("bad-id", JSON.stringify({ id: ID.slice(1), offset: 0 }));
    add(
      "non-canonical-id",
      JSON.stringify({ id: dirtyLastChar(ID), offset: 0 }),
    );
    add(
      "unknown-members-ignored",
      JSON.stringify({ id: ID, offset: 20, x: 1 }),
    );
    add("not-json", "ok");
    add("duplicate-members", `{"id":"${ID}","offset":0,"offset":10}`);
    add("size-not-a-multiple-at-size", o(105), 105);
    add("size-not-a-multiple-below", o(95), 105);
    add("size-zero", o(0), 0, 10);
  }
  return rows.map((r) => {
    const v = refXferOffsetBody(r.kind, utf8(r.text), r);
    return {
      id: r.id,
      kind: r.kind,
      size: r.size,
      chunk: r.chunk,
      body: r.text,
      want: v.ok ? { ok: true, id: v.id, offset: v.offset } : { ok: false },
    };
  });
}

function buildDoneCodec(): unknown[] {
  const ID = xid("offer a");
  const S = SHA(100);
  const rows: { id: string; toward: "receiver" | "sender"; text: string }[] = [
    {
      id: "to-receiver",
      toward: "receiver",
      text: JSON.stringify({ id: ID, sha256: S }),
    },
    {
      id: "to-receiver-no-hash",
      toward: "receiver",
      text: JSON.stringify({ id: ID }),
    },
    {
      id: "to-receiver-upper-hash",
      toward: "receiver",
      text: JSON.stringify({ id: ID, sha256: S.toUpperCase() }),
    },
    {
      id: "to-receiver-short-hash",
      toward: "receiver",
      text: JSON.stringify({ id: ID, sha256: S.slice(2) }),
    },
    {
      id: "to-receiver-hash-not-string",
      toward: "receiver",
      text: JSON.stringify({ id: ID, sha256: 1 }),
    },
    {
      id: "to-receiver-bad-id",
      toward: "receiver",
      text: JSON.stringify({ id: ID.slice(1), sha256: S }),
    },
    {
      id: "to-receiver-unknown-members-ignored",
      toward: "receiver",
      text: JSON.stringify({ id: ID, sha256: S, extra: true }),
    },
    { id: "to-sender", toward: "sender", text: JSON.stringify({ id: ID }) },
    {
      id: "to-sender-with-hash",
      toward: "sender",
      text: JSON.stringify({ id: ID, sha256: S }),
    },
    {
      id: "to-sender-unknown-members-ignored",
      toward: "sender",
      text: JSON.stringify({ id: ID, extra: true }),
    },
    {
      id: "to-sender-bad-id",
      toward: "sender",
      text: JSON.stringify({ id: "x" }),
    },
    { id: "to-sender-not-json", toward: "sender", text: "done" },
  ];
  return rows.map((r) => {
    const v = refXferDone(utf8(r.text), r.toward);
    return {
      id: r.id,
      toward: r.toward,
      body: r.text,
      want: v.ok
        ? {
            ok: true,
            id: v.id,
            ...(v.sha256 !== undefined ? { sha256: v.sha256 } : {}),
          }
        : { ok: false },
    };
  });
}

function buildCancelCodec(): unknown[] {
  const ID = xid("offer a");
  const rows: { id: string; text: string }[] = [
    ...[
      "declined",
      "cancelled",
      "hash",
      "size",
      "category",
      "busy",
      "quota",
      "timeout",
    ].map((r) => ({
      id: `reason-${r}`,
      text: JSON.stringify({ id: ID, reason: r }),
    })),
    {
      id: "reason-unknown-string",
      text: JSON.stringify({ id: ID, reason: "disk-full" }),
    },
    { id: "reason-empty-string", text: JSON.stringify({ id: ID, reason: "" }) },
    {
      id: "reason-wrong-case",
      text: JSON.stringify({ id: ID, reason: "Timeout" }),
    },
    { id: "reason-missing", text: JSON.stringify({ id: ID }) },
    { id: "reason-number", text: JSON.stringify({ id: ID, reason: 1 }) },
    { id: "reason-null", text: JSON.stringify({ id: ID, reason: null }) },
    {
      id: "bad-id",
      text: JSON.stringify({ id: ID.slice(2), reason: "cancelled" }),
    },
    { id: "missing-id", text: JSON.stringify({ reason: "cancelled" }) },
    { id: "not-json", text: "cancel" },
    {
      id: "unknown-members-ignored",
      text: JSON.stringify({ id: ID, reason: "busy", x: 1 }),
    },
  ];
  return rows.map((r) => {
    const v = refXferCancel(utf8(r.text));
    return {
      id: r.id,
      body: r.text,
      want: v.ok ? { ok: true, id: v.id, reason: v.reason } : { ok: false },
    };
  });
}

function buildChunkCodec(): unknown[] {
  const ID = xid("offer a");
  const idHex = hex(Buffer.from(ID, "base64url"));
  const u64 = (n: bigint): string => n.toString(16).padStart(16, "0");
  interface C {
    id: string;
    size: number;
    chunk: number;
    expect: number;
    head: string;
    dataLength: number;
  }
  const row = (
    id: string,
    size: number,
    chunk: number,
    expect: number,
    offset: bigint,
    dataLength: number,
    head = idHex + u64(offset),
  ): C => ({ id, size, chunk, expect, head, dataLength });
  const rows: C[] = [
    row("full-chunk", 100, 10, 20, 20n, 10),
    row("first-chunk", 100, 10, 0, 0n, 10),
    row("final-partial-chunk", 105, 10, 100, 100n, 5),
    row("final-full-chunk", 100, 10, 90, 90n, 10),
    row("whole-transfer-one-short-chunk", 5, 10, 0, 0n, 5),
    row(
      "largest-chunk",
      REF_XFER_MAX_CHUNK,
      REF_XFER_MAX_CHUNK,
      0,
      0n,
      REF_XFER_MAX_CHUNK,
    ),
    row(
      "one-over-largest-chunk",
      REF_XFER_MAX_CHUNK + 1,
      REF_XFER_MAX_CHUNK,
      0,
      0n,
      REF_XFER_MAX_CHUNK + 1,
    ),
    row("body-23-bytes", 100, 10, 20, 20n, 0, (idHex + u64(20n)).slice(0, 46)),
    row("body-empty", 100, 10, 20, 20n, 0, ""),
    row("empty-data", 100, 10, 20, 20n, 0),
    row("data-over-chunk", 100, 10, 20, 20n, 11),
    row("offset-gap", 100, 10, 20, 30n, 10),
    row("offset-repeat", 100, 10, 20, 10n, 10),
    row("offset-zero-again", 100, 10, 20, 0n, 10),
    row("offset-huge", 100, 10, 20, 0xffffffffffffffffn, 10),
    row("past-size", 100, 10, 95, 95n, 10),
    row("non-final-short", 100, 10, 20, 20n, 5),
    row("short-ends-before-size", 105, 10, 100, 100n, 4),
  ];
  return rows.map((r) => {
    const body = new Uint8Array(r.head.length / 2 + r.dataLength);
    body.set(hexBytes(r.head), 0);
    body.fill(0xab, r.head.length / 2);
    const v = refXferChunk(body, r);
    return {
      id: r.id,
      size: r.size,
      chunk: r.chunk,
      expect: r.expect,
      head: r.head,
      dataLength: r.dataLength,
      want: v.ok
        ? { ok: true, id: v.id, offset: v.offset, length: v.length }
        : { ok: false },
    };
  });
}

// ── machine rows ─────────────────────────────────────────────────────────────

const baseCtx = (over: Partial<RefCtx> = {}): RefCtx => ({
  mode: "a",
  capsLocal: ["app/1", "xfer/1"],
  capsRemote: ["app/1", "xfer/1"],
  maxMessage: MAXM,
  hostLimit: null,
  free: null,
  handler: "accept",
  cats: [],
  partials: [],
  peerKey: PEER,
  ...over,
});

interface Row {
  id: string;
  ctx: RefCtx;
  steps: RefEv[];
  want: unknown[];
}

/** A machine row: the steps run through the reference, which writes `want`. */
function mrow(id: string, over: Partial<RefCtx>, steps: RefEv[]): Row {
  const ctx = baseCtx(over);
  const side = new RefXferSide(ctx);
  const want = steps.map((s) => side.step(s));
  return { id, ctx, steps, want };
}

const offerText = (o: {
  id: string;
  size: number;
  chunk: number;
  sha256?: string;
  name?: string;
  type?: string;
  cat?: string;
}): string =>
  JSON.stringify({
    id: o.id,
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.type !== undefined ? { type: o.type } : {}),
    size: o.size,
    sha256: o.sha256 ?? SHA(o.size),
    ...(o.cat !== undefined ? { cat: o.cat } : {}),
    chunk: o.chunk,
  });

const rxOffer = (
  at: number,
  o: Parameters<typeof offerText>[0],
  more = false,
): RefEv => ({
  at,
  rx: "OFFER",
  body: offerText(o),
  ...(more ? { more } : {}),
});
const hostOffer = (
  at: number,
  id: string,
  size: number,
  chunk: number,
  extra: { seekable?: boolean; cat?: string } = {},
): RefEv => ({
  at,
  host: "offer",
  id,
  size,
  chunk,
  sha256: SHA(size),
  ...extra,
});

/** Assert that a row ends where the spec says, so a reference change cannot pass silently. */
function expectOut(r: Row, i: number, want: unknown): Row {
  check(`${r.id}[${i}]`, r.want[i], want);
  return r;
}

const T = (n: string): string => xid(`transfer ${n}`);

function buildWindow(): unknown[] {
  const rows: Row[] = [];
  const A = T("w1");
  const C1 = (
    at: number,
    id: string,
    offset: number,
    length: number,
  ): RefEv => ({
    at,
    rx: "CHUNK",
    id,
    offset,
    length,
  });
  // The sender: 16 chunks out, the 17th waits for an ACK.
  rows.push(
    expectOut(
      mrow("sender-16-outstanding-legal", {}, [
        hostOffer(0, A, 40, 1),
        { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      ]),
      1,
      { send: [{ t: "CHUNKS", id: A, offset: 0, bytes: 16 }] },
    ),
    expectOut(
      mrow("sender-17th-chunk-waits-for-an-ack", {}, [
        hostOffer(0, A, 40, 1),
        { at: 1, rx: "ACCEPT", id: A, offset: 0 },
        { at: 2, rx: "ACK", id: A, offset: 0 },
        { at: 3, rx: "ACK", id: A, offset: 1 },
        { at: 4, rx: "ACK", id: A, offset: 8 },
      ]),
      2,
      {},
    ),
    mrow("sender-ack-frees-the-window", {}, [
      hostOffer(0, A, 40, 1),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "ACK", id: A, offset: 8 },
      { at: 3, rx: "ACK", id: A, offset: 24 },
      { at: 4, rx: "ACK", id: A, offset: 40 },
    ]),
    mrow("sender-window-counts-from-the-accept-offset", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 40 },
    ]),
    mrow("sender-ack-decreasing-closes", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "ACK", id: A, offset: 8 },
      { at: 3, rx: "ACK", id: A, offset: 4 },
    ]),
    mrow("sender-ack-repeat-legal", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "ACK", id: A, offset: 8 },
      { at: 3, rx: "ACK", id: A, offset: 8 },
    ]),
    mrow("sender-ack-past-sent-closes", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "ACK", id: A, offset: 68 },
    ]),
    mrow("sender-ack-not-a-multiple-closes", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "ACK", id: A, offset: 6 },
    ]),
    mrow("sender-ack-at-size-not-a-multiple-legal", {}, [
      hostOffer(0, A, 10, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "ACK", id: A, offset: 10 },
    ]),
    mrow("sender-ack-before-accept-closes", {}, [
      hostOffer(0, A, 10, 4),
      { at: 1, rx: "ACK", id: A, offset: 0 },
    ]),
    mrow("sender-sends-done-after-the-last-byte", {}, [
      hostOffer(0, A, 10, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
    ]),
    // The receiver.
    mrow("receiver-in-order-chunks", {}, [
      rxOffer(0, { id: A, size: 10, chunk: 4 }),
      C1(1, A, 0, 4),
      C1(2, A, 4, 4),
      C1(3, A, 8, 2),
    ]),
    mrow("receiver-offset-gap-closes", {}, [
      rxOffer(0, { id: A, size: 20, chunk: 4 }),
      C1(1, A, 4, 4),
    ]),
    mrow("receiver-offset-repeat-closes", {}, [
      rxOffer(0, { id: A, size: 20, chunk: 4 }),
      C1(1, A, 0, 4),
      C1(2, A, 0, 4),
    ]),
    mrow("receiver-chunk-past-size-closes", {}, [
      rxOffer(0, { id: A, size: 6, chunk: 4 }),
      C1(1, A, 0, 4),
      C1(2, A, 4, 4),
    ]),
    mrow("receiver-non-final-short-chunk-closes", {}, [
      rxOffer(0, { id: A, size: 20, chunk: 4 }),
      C1(1, A, 0, 3),
    ]),
    mrow("receiver-final-short-chunk-legal", {}, [
      rxOffer(0, { id: A, size: 6, chunk: 4 }),
      C1(1, A, 0, 4),
      C1(2, A, 4, 2),
    ]),
    mrow("receiver-empty-chunk-closes", {}, [
      rxOffer(0, { id: A, size: 20, chunk: 4 }),
      C1(1, A, 0, 0),
    ]),
    mrow("receiver-chunk-over-chunk-closes", {}, [
      rxOffer(0, { id: A, size: 20, chunk: 4 }),
      C1(1, A, 0, 5),
    ]),
    mrow("receiver-chunk-before-accept-closes", { handler: "ask" }, [
      rxOffer(0, { id: A, size: 20, chunk: 4 }),
      C1(1, A, 0, 4),
    ]),
    mrow("receiver-chunk-with-more-closes", {}, [
      rxOffer(0, { id: A, size: 20, chunk: 4 }),
      { at: 1, rx: "CHUNK", id: A, offset: 0, length: 4, more: true },
    ]),
    // ACK cadence: every 8 chunks, and at size.
    mrow("receiver-ack-every-8-chunks", {}, [
      rxOffer(0, { id: A, size: 30, chunk: 1 }),
      ...Array.from({ length: 17 }, (_, i) => C1(1 + i, A, i, 1)),
    ]),
    mrow("receiver-ack-at-size", {}, [
      rxOffer(0, { id: A, size: 10, chunk: 4 }),
      C1(1, A, 0, 4),
      C1(2, A, 4, 4),
      C1(3, A, 8, 2),
    ]),
    mrow(
      "receiver-ack-counts-from-the-resume-offset",
      {
        partials: [
          {
            ref: "p1",
            id: A,
            sha256: SHA(40),
            size: 40,
            chunk: 1,
            bytes: 10,
            writtenAt: 0,
          },
        ],
      },
      [
        rxOffer(0, { id: A, size: 40, chunk: 1 }),
        ...Array.from({ length: 8 }, (_, i) => C1(1 + i, A, 10 + i, 1)),
      ],
    ),
    // The window as the receiver judges it: chunks past the last ACK it sent.
    mrow("receiver-window-16-legal", { withholdAcks: true }, [
      rxOffer(0, { id: A, size: 40, chunk: 1 }),
      ...Array.from({ length: 16 }, (_, i) => C1(1 + i, A, i, 1)),
    ]),
    mrow("receiver-window-17th-chunk-closes", { withholdAcks: true }, [
      rxOffer(0, { id: A, size: 40, chunk: 1 }),
      ...Array.from({ length: 17 }, (_, i) => C1(1 + i, A, i, 1)),
    ]),
  );
  // Timers.
  rows.push(
    expectOut(
      mrow("timer-no-idle-timer-during-consent", { handler: "ask" }, [
        rxOffer(0, { id: A, size: 10, chunk: 4 }),
        { at: 61, host: "tick" },
        { at: 119, host: "tick" },
        { at: 121, host: "tick" },
      ]),
      3,
      {
        send: [{ t: "CANCEL", id: A, reason: "timeout" }],
        withdraw: A,
      },
    ),
    expectOut(
      mrow("timer-consent-answered-in-time", { handler: "ask" }, [
        rxOffer(0, { id: A, size: 10, chunk: 4 }),
        { at: 100, host: "consent", id: A, answer: "accept" },
        { at: 150, host: "tick" },
        { at: 161, host: "tick" },
      ]),
      3,
      {
        send: [{ t: "CANCEL", id: A, reason: "timeout" }],
        partial: [{ keep: "n1" }],
        result: { id: A, outcome: "cancelled", reason: "timeout" },
      },
    ),
    mrow("timer-receiver-idle-from-accept", {}, [
      rxOffer(0, { id: A, size: 10, chunk: 4 }),
      { at: 59, host: "tick" },
      { at: 61, host: "tick" },
    ]),
    mrow("timer-receiver-idle-restarts-on-a-chunk", {}, [
      rxOffer(0, { id: A, size: 10, chunk: 4 }),
      C1(50, A, 0, 4),
      { at: 100, host: "tick" },
      { at: 111, host: "tick" },
    ]),
    mrow("timer-ping-is-not-progress", {}, [
      rxOffer(0, { id: A, size: 10, chunk: 4 }),
      { at: 50, rx: "PING" },
      { at: 59, rx: "PING" },
      { at: 61, host: "tick" },
    ]),
    mrow("timer-chunk-after-timeout-is-dropped", {}, [
      rxOffer(0, { id: A, size: 10, chunk: 4 }),
      { at: 61, host: "tick" },
      C1(62, A, 0, 4),
    ]),
    mrow("timer-receiver-waits-for-done-60-seconds", {}, [
      rxOffer(0, { id: A, size: 4, chunk: 4 }),
      C1(10, A, 0, 4),
      { at: 69, host: "tick" },
      { at: 71, host: "tick" },
    ]),
    mrow("timer-sender-offer-wait-is-consent-plus-idle", {}, [
      hostOffer(0, A, 10, 4),
      { at: 170, host: "tick" },
      { at: 179, host: "tick" },
      { at: 181, host: "tick" },
    ]),
    mrow("timer-sender-accept-stops-the-offer-timer", {}, [
      hostOffer(0, A, 100, 4),
      { at: 170, rx: "ACCEPT", id: A, offset: 0 },
      { at: 200, host: "tick" },
    ]),
    mrow("timer-sender-full-window-waits-60-seconds", {}, [
      hostOffer(0, A, 100, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 60, host: "tick" },
      { at: 62, host: "tick" },
    ]),
    mrow("timer-sender-ack-restarts-the-window-wait", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 50, rx: "ACK", id: A, offset: 8 },
      { at: 100, host: "tick" },
      { at: 111, host: "tick" },
    ]),
    mrow("timer-sender-done-wait-is-bounded", {}, [
      hostOffer(0, A, 8, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 60, host: "tick" },
      { at: 62, host: "tick" },
    ]),
    mrow("timer-sender-ping-is-not-progress", {}, [
      hostOffer(0, A, 100, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 40, rx: "PING" },
      { at: 62, host: "tick" },
    ]),
  );
  return rows;
}

function buildOffer(): unknown[] {
  const rows: Row[] = [];
  const A = T("o1");
  const B = T("o2");
  const O = { id: A, size: 100, chunk: 10 };
  const PA = ["xfer/1"];
  rows.push(
    // Step 1: mode and capability.
    mrow("not-allowed-in-mode-v", { mode: "v" }, [rxOffer(0, O)]),
    mrow("not-allowed-in-mode-p", { mode: "p" }, [rxOffer(0, O)]),
    mrow("not-allowed-in-mode-v-whatever-the-type", { mode: "v" }, [
      { at: 0, rx: "ACCEPT", id: A, offset: 0 },
    ]),
    mrow("not-allowed-without-the-local-cap", { capsLocal: ["app/1"] }, [
      rxOffer(0, O),
    ]),
    mrow("not-allowed-without-the-remote-cap", { capsRemote: ["app/1"] }, [
      rxOffer(0, O),
    ]),
    mrow("not-allowed-without-either-cap", { capsLocal: [], capsRemote: [] }, [
      rxOffer(0, O),
    ]),
    mrow("not-allowed-chunk-without-caps", { capsRemote: [] }, [
      { at: 0, rx: "CHUNK", id: A, offset: 0, length: 10 },
    ]),
    mrow("not-allowed-comes-before-the-body", { mode: "p" }, [
      { at: 0, rx: "OFFER", body: "not json" },
    ]),
    mrow("not-allowed-comes-before-more", { mode: "v" }, [rxOffer(0, O, true)]),
    mrow("caps-only-xfer-listed-is-enough", { capsLocal: PA, capsRemote: PA }, [
      rxOffer(0, O),
    ]),
    mrow("more-on-an-offer-closes", {}, [rxOffer(0, O, true)]),
    mrow("more-on-an-accept-closes", {}, [
      hostOffer(0, A, 10, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0, more: true },
    ]),
    // Step 2: the body.
    mrow("bad-body-closes", {}, [{ at: 0, rx: "OFFER", body: "{}" }]),
    mrow("bad-body-not-json-closes", {}, [
      { at: 0, rx: "OFFER", body: "offer" },
    ]),
    mrow("bad-body-chunk-over-max-message-closes", { maxMessage: 4096 }, [
      rxOffer(0, { id: A, size: 100, chunk: 4073 }),
    ]),
    mrow("body-chunk-fits-max-message", { maxMessage: 4096 }, [
      rxOffer(0, { id: A, size: 100, chunk: 4072 }),
    ]),
    mrow("bad-body-before-duplicate-id", {}, [
      rxOffer(0, O),
      { at: 1, rx: "OFFER", body: `{"id":"${A}"}` },
    ]),
    // Step 3: duplicate ids.
    mrow("duplicate-id-live-closes", { handler: "ask" }, [
      rxOffer(0, O),
      rxOffer(1, O),
    ]),
    mrow("duplicate-id-ended-closes", { handler: "none" }, [
      rxOffer(0, O),
      rxOffer(1, O),
    ]),
    mrow("duplicate-id-across-directions-closes", {}, [
      hostOffer(0, A, 10, 4),
      rxOffer(1, O),
    ]),
    mrow("duplicate-id-comes-before-busy", {}, [
      rxOffer(0, { id: A, size: 10, chunk: 4 }),
      rxOffer(1, { id: B, size: 10, chunk: 4 }),
      rxOffer(2, { id: T("o3"), size: 10, chunk: 4 }),
      rxOffer(3, { id: T("o4"), size: 10, chunk: 4 }),
      rxOffer(4, { id: A, size: 10, chunk: 4 }),
    ]),
    mrow("distinct-id-is-not-a-duplicate", { handler: "none" }, [
      rxOffer(0, O),
      rxOffer(1, { ...O, id: B }),
    ]),
    // Step 4: busy.
    mrow("fifth-transfer-is-busy", {}, [
      rxOffer(0, { id: T("b1"), size: 10, chunk: 4 }),
      rxOffer(1, { id: T("b2"), size: 10, chunk: 4 }),
      rxOffer(2, { id: T("b3"), size: 10, chunk: 4 }),
      rxOffer(3, { id: T("b4"), size: 10, chunk: 4 }),
      rxOffer(4, { id: T("b5"), size: 10, chunk: 4 }),
      { at: 5, rx: "PING" },
    ]),
    mrow("second-offer-while-the-host-is-asked-is-busy", { handler: "ask" }, [
      rxOffer(0, O),
      rxOffer(1, { ...O, id: B }),
      { at: 2, host: "consent", id: A, answer: "accept" },
    ]),
    mrow("second-offer-after-the-answer-is-not-busy", { handler: "ask" }, [
      rxOffer(0, O),
      { at: 1, host: "consent", id: A, answer: "accept" },
      rxOffer(2, { ...O, id: B }),
    ]),
    mrow("busy-keeps-the-session-open", {}, [
      rxOffer(0, { id: T("b1"), size: 10, chunk: 4 }),
      rxOffer(1, { id: T("b2"), size: 10, chunk: 4 }),
      rxOffer(2, { id: T("b3"), size: 10, chunk: 4 }),
      rxOffer(3, { id: T("b4"), size: 10, chunk: 4 }),
      rxOffer(4, { id: T("b5"), size: 10, chunk: 4 }),
      { at: 5, rx: "CHUNK", id: T("b1"), offset: 0, length: 4 },
    ]),
    mrow("busy-comes-before-category", { mode: "c", cats: ["docs"] }, [
      rxOffer(0, { id: T("b1"), size: 10, chunk: 4, cat: "docs" }),
      rxOffer(1, { id: T("b2"), size: 10, chunk: 4, cat: "docs" }),
      rxOffer(2, { id: T("b3"), size: 10, chunk: 4, cat: "docs" }),
      rxOffer(3, { id: T("b4"), size: 10, chunk: 4, cat: "docs" }),
      rxOffer(4, { id: T("b5"), size: 10, chunk: 4, cat: "other" }),
    ]),
    // Step 5: the category, before consent.
    mrow(
      "mode-c-category-allowed",
      { mode: "c", cats: ["docs", "photos"], handler: "ask" },
      [rxOffer(0, { ...O, cat: "photos" })],
    ),
    mrow(
      "mode-c-category-not-allowed-refused-before-consent",
      { mode: "c", cats: ["docs"], handler: "ask" },
      [rxOffer(0, { ...O, cat: "photos" })],
    ),
    mrow(
      "mode-c-no-category-refused-before-consent",
      { mode: "c", cats: ["docs"], handler: "ask" },
      [rxOffer(0, O)],
    ),
    mrow(
      "mode-c-no-links-categories-refuses-everything",
      { mode: "c", cats: [], handler: "ask" },
      [rxOffer(0, { ...O, cat: "docs" })],
    ),
    mrow(
      "mode-c-category-before-size",
      { mode: "c", cats: ["docs"], hostLimit: 10 },
      [rxOffer(0, { ...O, cat: "photos" })],
    ),
    mrow(
      "mode-a-category-is-display-data",
      { mode: "a", cats: [], handler: "ask" },
      [rxOffer(0, { ...O, cat: "anything" })],
    ),
    mrow("mode-a-no-category-is-fine", { mode: "a", handler: "ask" }, [
      rxOffer(0, O),
    ]),
    // Step 6: size and quota.
    mrow("size-over-host-limit", { hostLimit: 99 }, [rxOffer(0, O)]),
    mrow("size-at-host-limit", { hostLimit: 100 }, [rxOffer(0, O)]),
    mrow("size-comes-before-consent", { hostLimit: 99, handler: "ask" }, [
      rxOffer(0, O),
    ]),
    mrow("size-comes-before-no-handler", { hostLimit: 99, handler: "none" }, [
      rxOffer(0, O),
    ]),
    mrow("quota-no-room", { free: 99 }, [rxOffer(0, O)]),
    mrow("quota-exact-room", { free: 100 }, [rxOffer(0, O)]),
    mrow("quota-comes-before-consent", { free: 50, handler: "ask" }, [
      rxOffer(0, O),
    ]),
    mrow("size-comes-before-quota", { hostLimit: 50, free: 10 }, [
      rxOffer(0, O),
    ]),
    // Step 7: consent.
    mrow("no-handler-declines", { handler: "none" }, [rxOffer(0, O)]),
    mrow("handler-refusal-declines", { handler: "decline" }, [rxOffer(0, O)]),
    mrow("no-default-accept-in-mode-a", { handler: "none", mode: "a" }, [
      rxOffer(0, O),
    ]),
    mrow("host-asked-with-display-data", { handler: "ask" }, [
      rxOffer(0, { ...O, name: "report.pdf", type: "application/pdf" }),
    ]),
    mrow("host-accepts-later", { handler: "ask" }, [
      rxOffer(0, O),
      { at: 30, host: "consent", id: A, answer: "accept" },
    ]),
    mrow("host-declines-later", { handler: "ask" }, [
      rxOffer(0, O),
      { at: 30, host: "consent", id: A, answer: "decline" },
    ]),
    mrow("consent-times-out", { handler: "ask" }, [
      rxOffer(0, O),
      { at: 121, host: "tick" },
    ]),
    mrow(
      "sender-cancel-while-asking-withdraws-the-question",
      { handler: "ask" },
      [rxOffer(0, O), { at: 10, rx: "CANCEL", id: A, reason: "cancelled" }],
    ),
    mrow("consent-per-transfer-second-offer-asks-again", { handler: "ask" }, [
      rxOffer(0, O),
      { at: 1, host: "consent", id: A, answer: "accept" },
      rxOffer(2, { ...O, id: B }),
    ]),
    // Step 8: the accept.
    mrow("accept-at-zero", {}, [rxOffer(0, O)]),
    mrow("accept-size-zero", {}, [rxOffer(0, { id: A, size: 0, chunk: 4 })]),
    mrow("name-is-display-data-only", { handler: "ask" }, [
      rxOffer(0, {
        ...O,
        name: "../../etc/passwd",
        type: "application/x-msdownload",
      }),
    ]),
  );
  return rows;
}

function buildHash(): unknown[] {
  const rows: Row[] = [];
  const A = T("h1");
  const C1 = (
    at: number,
    offset: number,
    length: number,
    data?: "corrupt",
  ): RefEv => ({
    at,
    rx: "CHUNK",
    id: A,
    offset,
    length,
    ...(data !== undefined ? { data } : {}),
  });
  const all = (corruptAt = -1): RefEv[] => [
    C1(1, 0, 4, corruptAt === 0 ? "corrupt" : undefined),
    C1(2, 4, 4, corruptAt === 4 ? "corrupt" : undefined),
    C1(3, 8, 2, corruptAt === 8 ? "corrupt" : undefined),
  ];
  const O10 = { id: A, size: 10, chunk: 4 };
  rows.push(
    expectOut(
      mrow("hash-match-delivers", {}, [
        rxOffer(0, O10),
        ...all(),
        { at: 4, rx: "DONE", id: A, sha256: SHA(10) },
      ]),
      4,
      {
        send: [{ t: "DONE", id: A }],
        result: { id: A, outcome: "delivered" },
        partial: [{ finalize: "n1" }],
      },
    ),
    mrow("hash-nothing-is-delivered-before-the-check", {}, [
      rxOffer(0, O10),
      ...all(),
      { at: 4, host: "tick" },
    ]),
    mrow("hash-done-differs-from-offer", {}, [
      rxOffer(0, O10),
      ...all(),
      { at: 4, rx: "DONE", id: A, sha256: SHA(11) },
    ]),
    mrow("hash-offer-differs-from-computed", {}, [
      rxOffer(0, { ...O10, sha256: SHA(11) }),
      ...all(),
      { at: 4, rx: "DONE", id: A, sha256: SHA(11) },
    ]),
    mrow("hash-one-corrupt-chunk", {}, [
      rxOffer(0, O10),
      ...all(4),
      { at: 4, rx: "DONE", id: A, sha256: SHA(10) },
    ]),
    mrow("hash-corrupt-last-chunk-deletes-the-partial", {}, [
      rxOffer(0, O10),
      ...all(8),
      { at: 4, rx: "DONE", id: A, sha256: SHA(10) },
    ]),
    mrow("hash-done-before-size-is-cancel-size", {}, [
      rxOffer(0, O10),
      C1(1, 0, 4),
      C1(2, 4, 4),
      { at: 3, rx: "DONE", id: A, sha256: SHA(10) },
    ]),
    mrow("hash-done-with-no-bytes-is-cancel-size", {}, [
      rxOffer(0, O10),
      { at: 1, rx: "DONE", id: A, sha256: SHA(10) },
    ]),
    mrow("hash-done-before-accept-closes", { handler: "ask" }, [
      rxOffer(0, O10),
      { at: 1, rx: "DONE", id: A, sha256: SHA(10) },
    ]),
    mrow("hash-size-zero-no-chunk", {}, [
      rxOffer(0, { id: A, size: 0, chunk: 4 }),
      { at: 1, rx: "DONE", id: A, sha256: SHA(0) },
    ]),
    mrow("hash-size-zero-wrong-hash", {}, [
      rxOffer(0, { id: A, size: 0, chunk: 4 }),
      { at: 1, rx: "DONE", id: A, sha256: SHA(1) },
    ]),
    mrow("hash-size-zero-chunk-closes", {}, [
      rxOffer(0, { id: A, size: 0, chunk: 4 }),
      C1(1, 0, 1),
    ]),
    mrow("hash-done-toward-receiver-without-hash-closes", {}, [
      rxOffer(0, O10),
      ...all(),
      { at: 4, rx: "DONE", id: A },
    ]),
    mrow("hash-done-toward-sender-with-hash-closes", {}, [
      hostOffer(0, A, 8, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "DONE", id: A, sha256: SHA(8) },
    ]),
    mrow("hash-sender-sends-the-offer-hash-in-done", {}, [
      hostOffer(0, A, 8, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
    ]),
    mrow("hash-sender-reads-done-as-delivered", {}, [
      hostOffer(0, A, 8, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "ACK", id: A, offset: 8 },
      { at: 3, rx: "DONE", id: A },
    ]),
  );
  return rows;
}

function buildEnding(): unknown[] {
  const rows: Row[] = [];
  const A = T("e1");
  const B = T("e2");
  const O = { id: A, size: 20, chunk: 4 };
  const C1 = (
    at: number,
    id: string,
    offset: number,
    length: number,
  ): RefEv => ({
    at,
    rx: "CHUNK",
    id,
    offset,
    length,
  });
  rows.push(
    mrow("in-flight-chunk-after-our-cancel-is-dropped", {}, [
      rxOffer(0, O),
      C1(1, A, 0, 4),
      { at: 2, host: "cancel", id: A },
      C1(3, A, 4, 4),
    ]),
    mrow("in-flight-chunk-after-their-cancel-is-dropped", {}, [
      rxOffer(0, O),
      { at: 1, rx: "CANCEL", id: A, reason: "cancelled" },
      C1(2, A, 0, 4),
    ]),
    mrow("in-flight-ack-after-our-cancel-is-dropped", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, host: "cancel", id: A },
      { at: 3, rx: "ACK", id: A, offset: 8 },
    ]),
    mrow("in-flight-ack-after-their-cancel-is-dropped", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "CANCEL", id: A, reason: "busy" },
      { at: 3, rx: "ACK", id: A, offset: 8 },
    ]),
    mrow("crossing-accept-after-our-cancel-is-dropped", {}, [
      hostOffer(0, A, 20, 4),
      { at: 1, host: "cancel", id: A },
      { at: 2, rx: "ACCEPT", id: A, offset: 0 },
    ]),
    mrow("crossing-cancel-after-our-cancel-is-dropped", {}, [
      hostOffer(0, A, 20, 4),
      { at: 1, host: "cancel", id: A },
      { at: 2, rx: "CANCEL", id: A, reason: "cancelled" },
    ]),
    mrow("crossing-done-after-our-cancel-is-dropped-by-the-receiver", {}, [
      rxOffer(0, O),
      { at: 1, host: "cancel", id: A },
      { at: 2, rx: "DONE", id: A, sha256: SHA(20) },
    ]),
    mrow("done-reaching-a-sender-that-cancelled-is-delivered", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, host: "cancel", id: A },
      { at: 3, rx: "DONE", id: A },
    ]),
    mrow("done-delivered-is-reported-once", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, host: "cancel", id: A },
      { at: 3, rx: "DONE", id: A },
      { at: 4, rx: "DONE", id: A },
    ]),
    mrow("done-reaching-a-sender-the-peer-cancelled-is-dropped", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "CANCEL", id: A, reason: "cancelled" },
      { at: 3, rx: "DONE", id: A },
    ]),
    mrow("cancel-after-our-done-is-ignored-by-the-receiver", {}, [
      rxOffer(0, { id: A, size: 0, chunk: 4 }),
      { at: 1, rx: "DONE", id: A, sha256: SHA(0) },
      { at: 2, rx: "CANCEL", id: A, reason: "cancelled" },
    ]),
    mrow("done-ends-the-transfer-for-the-sender", {}, [
      hostOffer(0, A, 0, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "DONE", id: A },
      { at: 3, rx: "CANCEL", id: A, reason: "cancelled" },
    ]),
    mrow("sender-sends-no-cancel-after-its-done", {}, [
      hostOffer(0, A, 8, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, host: "cancel", id: A },
      { at: 3, rx: "DONE", id: A },
    ]),
    mrow("sender-sends-cancel-timeout-after-its-done", {}, [
      hostOffer(0, A, 8, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 62, host: "tick" },
    ]),
    mrow("sender-cancel-before-done-is-sent", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, host: "cancel", id: A },
    ]),
    // Unknown ids.
    ...(["ACCEPT", "CHUNK", "ACK", "DONE", "CANCEL"] as const).map((t) =>
      mrow(`unknown-id-${t.toLowerCase()}-closes`, {}, [
        t === "CHUNK"
          ? C1(0, B, 0, 4)
          : t === "DONE"
            ? { at: 0, rx: "DONE", id: B, sha256: SHA(4) }
            : t === "CANCEL"
              ? { at: 0, rx: "CANCEL", id: B, reason: "cancelled" }
              : { at: 0, rx: t, id: B, offset: 0 },
      ]),
    ),
    mrow("chunk-for-an-id-we-offered-closes", {}, [
      hostOffer(0, A, 20, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      C1(2, A, 0, 4),
    ]),
    mrow("accept-for-an-id-we-received-closes", {}, [
      rxOffer(0, O),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
    ]),
    mrow("ack-for-an-id-we-received-closes", {}, [
      rxOffer(0, O),
      { at: 1, rx: "ACK", id: A, offset: 0 },
    ]),
    mrow("done-without-hash-for-an-id-we-received-closes", {}, [
      rxOffer(0, O),
      { at: 1, rx: "DONE", id: A },
    ]),
    mrow("done-before-the-senders-own-done-closes", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "DONE", id: A },
    ]),
    mrow("second-accept-closes", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, rx: "ACCEPT", id: A, offset: 0 },
    ]),
    mrow("accept-offset-not-a-multiple-closes", {}, [
      hostOffer(0, A, 40, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 6 },
    ]),
    mrow("accept-offset-over-size-closes", {}, [
      hostOffer(0, A, 40, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 44 },
    ]),
    mrow("accept-at-size-sends-only-done", {}, [
      hostOffer(0, A, 40, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 40 },
    ]),
    mrow("cancel-reason-unknown-reads-as-cancelled", {}, [
      hostOffer(0, A, 40, 4),
      { at: 1, rx: "CANCEL", id: A, reason: "disk-full" },
    ]),
    mrow("cancel-reason-quota-is-reported", {}, [
      hostOffer(0, A, 40, 4),
      { at: 1, rx: "CANCEL", id: A, reason: "quota" },
    ]),
    mrow("closed-session-ends-the-transfer", {}, [
      hostOffer(0, A, 200, 4),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
      { at: 2, host: "close" },
    ]),
    mrow("nothing-happens-after-a-close", {}, [
      { at: 0, rx: "ACK", id: A, offset: 0 },
      hostOffer(1, B, 4, 4),
    ]),
  );
  // The last XFER_ENDED_IDS ended ids are remembered, the 65th pushes the first out.
  const refused = (n: number): RefEv[] =>
    Array.from({ length: n }, (_, i) =>
      rxOffer(i, { id: xid(`ended ${i}`), size: 10, chunk: 4 }),
    );
  rows.push(
    mrow("ended-64-ids-are-remembered-chunk-dropped", { handler: "none" }, [
      ...refused(REF_XFER_ENDED_IDS),
      C1(100, xid("ended 0"), 0, 4),
    ]),
    mrow(
      "ended-65th-id-pushes-the-first-out-chunk-closes",
      { handler: "none" },
      [...refused(REF_XFER_ENDED_IDS + 1), C1(100, xid("ended 0"), 0, 4)],
    ),
    mrow("ended-65th-id-the-second-is-still-remembered", { handler: "none" }, [
      ...refused(REF_XFER_ENDED_IDS + 1),
      C1(100, xid("ended 1"), 0, 4),
    ]),
    mrow("ended-forgotten-id-can-be-offered-again", { handler: "none" }, [
      ...refused(REF_XFER_ENDED_IDS + 1),
      rxOffer(100, { id: xid("ended 0"), size: 10, chunk: 4 }),
    ]),
    mrow("ended-remembered-id-cannot-be-offered-again", { handler: "none" }, [
      ...refused(REF_XFER_ENDED_IDS),
      rxOffer(100, { id: xid("ended 0"), size: 10, chunk: 4 }),
    ]),
  );
  return rows;
}

function buildResume(): unknown[] {
  const rows: Row[] = [];
  const X = T("r1");
  const SZ = 100;
  const S = SHA(SZ);
  const part = (over: Partial<RefPartial> = {}): RefPartial => ({
    ref: "p1",
    id: X,
    sha256: S,
    size: SZ,
    chunk: 10,
    bytes: 50,
    writtenAt: 0,
    ...over,
  });
  const O = { id: X, size: SZ, chunk: 10 };
  const C1 = (
    at: number,
    offset: number,
    length = 10,
    data?: "corrupt",
  ): RefEv => ({
    at,
    rx: "CHUNK",
    id: X,
    offset,
    length,
    ...(data !== undefined ? { data } : {}),
  });
  rows.push(
    expectOut(
      mrow(
        "same-tuple-resumes-at-the-verified-offset",
        { partials: [part()] },
        [rxOffer(100, O)],
      ),
      0,
      {
        send: [{ t: "ACCEPT", id: X, offset: 50 }],
        partial: [{ truncate: "p1", to: 50 }],
      },
    ),
    mrow(
      "verified-offset-is-a-multiple-of-chunk",
      { partials: [part({ bytes: 55 })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "verified-offset-capped-to-the-re-read-bytes",
      { partials: [part({ bytes: 80, reread: 35 })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "verified-offset-below-one-chunk-is-zero",
      { partials: [part({ bytes: 80, reread: 9 })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "verified-offset-nothing-re-read",
      { partials: [part({ bytes: 80, reread: 0 })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "complete-partial-resumes-at-the-last-multiple",
      { partials: [part({ bytes: 100 })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "complete-partial-with-a-short-last-chunk",
      { partials: [part({ bytes: 105, size: 105, sha256: SHA(105) })] },
      [rxOffer(100, { id: X, size: 105, chunk: 10 })],
    ),
    mrow(
      "resume-truncates-before-the-accept",
      { partials: [part({ bytes: 70, reread: 40 })] },
      [rxOffer(100, O)],
    ),
    mrow("different-sha256-is-a-new-transfer", { partials: [part()] }, [
      rxOffer(100, { ...O, sha256: SHA(99) }),
    ]),
    mrow("different-id-is-a-new-transfer", { partials: [part()] }, [
      rxOffer(100, { ...O, id: T("r2") }),
    ]),
    mrow(
      "different-agree-key-is-a-new-transfer",
      { partials: [part({ otherPeer: true })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "same-tuple-other-size-discards",
      { partials: [part({ size: 90, sha256: S })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "same-tuple-other-chunk-discards",
      { partials: [part({ chunk: 20 })] },
      [rxOffer(100, O)],
    ),
    mrow("expired-partial-discards", { partials: [part()] }, [
      rxOffer(REF_XFER_PARTIAL_SECONDS + 1, O),
    ]),
    mrow("partial-just-inside-24-hours-resumes", { partials: [part()] }, [
      rxOffer(REF_XFER_PARTIAL_SECONDS - 1, O),
    ]),
    mrow(
      "partial-held-by-a-live-transfer-is-busy",
      { partials: [part({ held: true })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "partial-held-for-another-key-is-not-busy",
      { partials: [part({ held: true, otherPeer: true })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "resumed-transfer-asks-the-host-again",
      { handler: "ask", partials: [part()] },
      [rxOffer(100, O), { at: 110, host: "consent", id: X, answer: "accept" }],
    ),
    mrow(
      "resume-declined-keeps-the-partial",
      { handler: "ask", partials: [part()] },
      [rxOffer(100, O), { at: 110, host: "consent", id: X, answer: "decline" }],
    ),
    mrow(
      "quota-on-resume-counts-only-the-bytes-to-come",
      { free: 45, partials: [part({ bytes: 60 })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "quota-on-resume-still-refuses-when-short",
      { free: 30, partials: [part({ bytes: 60 })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "quota-on-new-transfer-counts-everything",
      { free: 45, partials: [part({ size: 90 })] },
      [rxOffer(100, O)],
    ),
    mrow(
      "ninth-partial-evicts-the-oldest",
      {
        partials: Array.from({ length: REF_XFER_MAX_PARTIALS }, (_, i) =>
          part({
            ref: `p${i + 1}`,
            id: T(`ev${i}`),
            sha256: SHA(10 + i),
            size: 10 + i,
            bytes: 4,
            writtenAt: 100 - i * 10,
          }),
        ),
      },
      [rxOffer(200, O)],
    ),
    mrow(
      "eighth-partial-evicts-nothing",
      {
        partials: Array.from({ length: REF_XFER_MAX_PARTIALS - 1 }, (_, i) =>
          part({
            ref: `p${i + 1}`,
            id: T(`ev${i}`),
            sha256: SHA(10 + i),
            size: 10 + i,
            bytes: 4,
            writtenAt: 100 - i * 10,
          }),
        ),
      },
      [rxOffer(200, O)],
    ),
    mrow(
      "partials-of-another-key-are-not-counted-or-evicted",
      {
        partials: [
          part({
            ref: "o1",
            id: T("ev9"),
            sha256: SHA(9),
            size: 9,
            bytes: 4,
            writtenAt: 1,
            otherPeer: true,
          }),
          ...Array.from({ length: REF_XFER_MAX_PARTIALS }, (_, i) =>
            part({
              ref: `p${i + 1}`,
              id: T(`ev${i}`),
              sha256: SHA(10 + i),
              size: 10 + i,
              bytes: 4,
              writtenAt: 100 - i * 10,
            }),
          ),
        ],
      },
      [rxOffer(200, O)],
    ),
    mrow(
      "other-cancel-after-accept-deletes-the-partial",
      { partials: [part()] },
      [rxOffer(100, O), { at: 101, rx: "CANCEL", id: X, reason: "cancelled" }],
    ),
    mrow("cancel-timeout-keeps-the-partial", { partials: [part()] }, [
      rxOffer(100, O),
      { at: 101, rx: "CANCEL", id: X, reason: "timeout" },
    ]),
    mrow("cancel-unknown-reason-deletes-the-partial", { partials: [part()] }, [
      rxOffer(100, O),
      { at: 101, rx: "CANCEL", id: X, reason: "whatever" },
    ]),
    mrow("host-cancel-deletes-the-partial", { partials: [part()] }, [
      rxOffer(100, O),
      { at: 101, host: "cancel", id: X },
    ]),
    mrow("our-idle-timeout-keeps-the-partial", { partials: [part()] }, [
      rxOffer(100, O),
      { at: 161, host: "tick" },
    ]),
    mrow("session-close-keeps-the-partial", { partials: [part()] }, [
      rxOffer(100, O),
      { at: 101, host: "close" },
    ]),
    mrow("interrupted-then-resumed-in-a-new-session", {}, [
      rxOffer(0, O),
      C1(1, 0),
      C1(2, 10),
      C1(3, 20),
      { at: 4, host: "close" },
      { at: 5, host: "newSession" },
      rxOffer(6, O),
    ]),
    mrow("resumed-transfer-completes-with-the-hash-of-all-bytes", {}, [
      rxOffer(0, { id: X, size: 30, chunk: 10 }),
      C1(1, 0),
      { at: 2, host: "close" },
      { at: 3, host: "newSession" },
      rxOffer(4, { id: X, size: 30, chunk: 10 }),
      C1(5, 10),
      C1(6, 20),
      { at: 7, rx: "DONE", id: X, sha256: SHA(30) },
    ]),
    mrow("hash-failure-never-resumes", {}, [
      rxOffer(0, { id: X, size: 30, chunk: 10 }),
      C1(1, 0),
      C1(2, 10, 10, "corrupt"),
      C1(3, 20),
      { at: 4, rx: "DONE", id: X, sha256: SHA(30) },
      { at: 5, host: "newSession" },
      rxOffer(6, { id: X, size: 30, chunk: 10 }),
    ]),
    mrow(
      "corrupt-partial-fails-the-hash-after-a-resume",
      {
        partials: [
          part({ size: 30, sha256: SHA(30), bytes: 20, corrupt: true }),
        ],
      },
      [
        rxOffer(0, { id: X, size: 30, chunk: 10 }),
        C1(1, 20),
        { at: 2, rx: "DONE", id: X, sha256: SHA(30) },
      ],
    ),
    // The sender.
    mrow("sender-resumes-from-the-accept-offset", {}, [
      hostOffer(0, X, 100, 10),
      { at: 1, rx: "ACCEPT", id: X, offset: 50 },
    ]),
    mrow("sender-without-seek-cancels-a-non-zero-offset", {}, [
      hostOffer(0, X, 100, 10, { seekable: false }),
      { at: 1, rx: "ACCEPT", id: X, offset: 50 },
    ]),
    mrow("sender-without-seek-sends-from-zero", {}, [
      hostOffer(0, X, 100, 10, { seekable: false }),
      { at: 1, rx: "ACCEPT", id: X, offset: 0 },
    ]),
    mrow("sender-without-seek-done-after-cancel-is-delivered", {}, [
      hostOffer(0, X, 100, 10, { seekable: false }),
      { at: 1, rx: "ACCEPT", id: X, offset: 50 },
      { at: 2, rx: "DONE", id: X },
    ]),
  );
  return rows;
}

function buildLimits(): unknown[] {
  const rows: Row[] = [];
  const id = (n: number): string => T(`l${n}`);
  const live = (n: number): RefEv[] =>
    Array.from({ length: n }, (_, i) =>
      rxOffer(i, { id: id(i), size: 10, chunk: 4 }),
    );
  const out = (from: number, n: number): RefEv[] =>
    Array.from({ length: n }, (_, i) => hostOffer(from + i, id(10 + i), 10, 4));
  rows.push(
    mrow("four-incoming-then-a-fifth-is-busy", {}, [
      ...live(4),
      rxOffer(4, { id: id(9), size: 10, chunk: 4 }),
    ]),
    mrow("four-outgoing-then-a-fifth-is-refused", {}, [
      ...out(0, 4),
      hostOffer(4, id(19), 10, 4),
    ]),
    mrow("two-in-and-two-out-count-together", {}, [
      ...live(2),
      ...out(2, 2),
      rxOffer(4, { id: id(9), size: 10, chunk: 4 }),
      hostOffer(5, id(19), 10, 4),
    ]),
    mrow("three-in-and-one-out", {}, [
      ...live(3),
      ...out(3, 1),
      rxOffer(4, { id: id(9), size: 10, chunk: 4 }),
    ]),
    mrow("an-ended-transfer-frees-a-slot", {}, [
      ...live(4),
      { at: 4, host: "cancel", id: id(0) },
      rxOffer(5, { id: id(9), size: 10, chunk: 4 }),
    ]),
    mrow("a-refused-offer-takes-no-slot", { handler: "none" }, [
      ...live(4),
      rxOffer(4, { id: id(9), size: 10, chunk: 4 }),
    ]),
    mrow("a-delivered-transfer-frees-a-slot", {}, [
      ...live(3),
      rxOffer(3, { id: id(8), size: 0, chunk: 4 }),
      { at: 4, rx: "DONE", id: id(8), sha256: SHA(0) },
      rxOffer(5, { id: id(9), size: 10, chunk: 4 }),
    ]),
    mrow("size-at-the-bound", {}, [
      rxOffer(0, {
        id: id(0),
        size: REF_XFER_MAX_SIZE,
        chunk: 61_440,
        sha256: "0".repeat(64),
      }),
    ]),
    mrow("size-over-the-bound-closes", {}, [
      {
        at: 0,
        rx: "OFFER",
        body: offerText({
          id: id(0),
          size: REF_XFER_MAX_SIZE + 1,
          chunk: 61_440,
          sha256: "0".repeat(64),
        }),
      },
    ]),
    mrow("window-buffer-is-bounded-by-the-ack-cadence", {}, [
      rxOffer(0, { id: id(0), size: 100, chunk: 1 }),
      ...Array.from({ length: 24 }, (_, i) => ({
        at: 1 + i,
        rx: "CHUNK" as const,
        id: id(0),
        offset: i,
        length: 1,
      })),
    ]),
    mrow("host-offer-ids-do-not-take-incoming-slots-once-ended", {}, [
      ...out(0, 4),
      { at: 4, host: "cancel", id: id(10) },
      rxOffer(5, { id: id(9), size: 10, chunk: 4 }),
    ]),
  );
  return rows;
}

// ── name ─────────────────────────────────────────────────────────────────────

function buildName(): unknown {
  const key = (l: string): string => hex(mat(`key ${l}`));
  const sha = (l: string): string => hex(mat(`sha ${l}`));
  const idOf = (l: string): string => xid(`name id ${l}`);
  const base = { key: key("a"), xferId: idOf("a"), sha256: sha("a") };
  const manual = (k: string, id: string, s: string): string =>
    createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from("pkey-xfer/1 partial", "utf8"),
          Buffer.from([0]),
          Buffer.from(k, "hex"),
          Buffer.from(id, "base64url"),
          Buffer.from(s, "hex"),
        ]),
      )
      .digest("hex");
  const paths = [
    { id: "base", ...base },
    { id: "other-key", ...base, key: key("b") },
    { id: "other-id", ...base, xferId: idOf("b") },
    { id: "other-sha256", ...base, sha256: sha("b") },
    { id: "all-different", key: key("b"), xferId: idOf("b"), sha256: sha("b") },
    {
      id: "zero-key",
      key: "00".repeat(32),
      xferId: idOf("a"),
      sha256: sha("a"),
    },
    { id: "ff-key", key: "ff".repeat(32), xferId: idOf("a"), sha256: sha("a") },
  ].map((r) => {
    const path = refXferPartialPath(r.key, r.xferId, r.sha256);
    check(`partial path ${r.id}`, path, manual(r.key, r.xferId, r.sha256));
    if (!/^[0-9a-f]{64}$/.test(path)) throw new Error("xfer: path shape");
    return { ...r, path };
  });
  if (new Set(paths.map((p) => p.path)).size !== paths.length)
    throw new Error("xfer: partial path collision");
  const names: { id: string; name: string; type?: string }[] = [
    { id: "plain", name: "report.pdf", type: "application/pdf" },
    { id: "parent-directory", name: "../x" },
    { id: "deep-parent-directory", name: "../../../etc/passwd" },
    { id: "slash", name: "a/b" },
    { id: "leading-slash", name: "/etc/passwd" },
    { id: "backslash", name: "a\\b" },
    { id: "leading-dot", name: ".hidden" },
    { id: "dot-dot", name: ".." },
    { id: "drive-letter", name: "C:\\x" },
    { id: "unc", name: "\\\\host\\share\\x" },
    { id: "nul-in-name", name: "a\u0000b" },
    { id: "reserved-device-name", name: "CON" },
    {
      id: "type-claims-executable",
      name: "notes.txt",
      type: "application/x-msdownload",
    },
    { id: "name-only-controls", name: "\u202e\u0007" },
    { id: "name-with-spaces", name: "  two   words  " },
  ];
  const rows = names.map((n) => {
    const display = refXferDisplayName(n.name);
    const offer = {
      id: base.xferId,
      ...(n.name !== "" ? { name: n.name } : {}),
      ...(n.type !== undefined ? { type: n.type } : {}),
      size: 100,
      sha256: base.sha256,
      chunk: 10,
    };
    // The body is built so that its name is the JSON string, escapes and all.
    const body = JSON.stringify(offer);
    const v = refXferOffer(utf8(body), MAXM);
    if (!v.ok) throw new Error(`xfer name ${n.id}: body does not parse`);
    return {
      id: n.id,
      body,
      display,
      ...(n.type !== undefined ? { type: n.type } : {}),
      path: refXferPartialPath(base.key, base.xferId, base.sha256),
    };
  });
  if (new Set(rows.map((r) => r.path)).size !== 1)
    throw new Error("xfer: the name changed a path");
  check("name display parent", rows[1]!.display, "../x");
  check("name display nul", rows[10]!.display, "ab");
  return { key: base.key, paths, rows };
}

// ── the section ──────────────────────────────────────────────────────────────

/**
 * Direct Transfer in mode `l` (§15.11, §15.12): the same machine, with mode `l` allowed and the
 * category rule of mode `c` applying. They sit in `peer-matrix.json` `local.xfer`, not in `xfer`,
 * so that a runner without mode `l` skips them (feature connect.local).
 */
export function buildLocalXfer(): unknown[] {
  const A = T("l1");
  const O = { id: A, size: 100, chunk: 10 };
  const O10 = { id: A, size: 10, chunk: 4 };
  const rows: Row[] = [
    mrow(
      "mode-l-category-allowed-asks",
      { mode: "l", cats: ["docs"], handler: "ask" },
      [rxOffer(0, { ...O, cat: "docs" })],
    ),
    mrow(
      "mode-l-category-not-allowed-refused-before-consent",
      { mode: "l", cats: ["docs"], handler: "ask" },
      [rxOffer(0, { ...O, cat: "photos" })],
    ),
    mrow(
      "mode-l-no-category-refused-before-consent",
      { mode: "l", cats: ["docs"], handler: "ask" },
      [rxOffer(0, O)],
    ),
    mrow(
      "mode-l-no-links-categories-refuses-everything",
      { mode: "l", cats: [], handler: "ask" },
      [rxOffer(0, { ...O, cat: "docs" })],
    ),
    mrow(
      "mode-l-category-before-size",
      { mode: "l", cats: ["docs"], hostLimit: 10 },
      [rxOffer(0, { ...O, cat: "photos" })],
    ),
    mrow("mode-l-delivers", { mode: "l", cats: ["docs"] }, [
      rxOffer(0, { ...O10, cat: "docs" }),
      { at: 1, rx: "CHUNK", id: A, offset: 0, length: 4 },
      { at: 2, rx: "CHUNK", id: A, offset: 4, length: 4 },
      { at: 3, rx: "CHUNK", id: A, offset: 8, length: 2 },
      { at: 4, rx: "DONE", id: A, sha256: SHA(10) },
    ]),
    mrow("mode-l-sends-with-its-category", { mode: "l", cats: ["docs"] }, [
      hostOffer(0, A, 40, 1, { cat: "docs" }),
      { at: 1, rx: "ACCEPT", id: A, offset: 0 },
    ]),
  ];
  return rows.map((r) => ({
    id: r.id,
    ctx: r.ctx,
    steps: r.steps,
    want: r.want,
  }));
}

export function buildXfer(): unknown {
  return {
    note:
      "Direct Transfer, xfer/1 (15.11). Constants: control body at most 4096 bytes, size at most 2^40, default chunk 61440, largest chunk 65492, window 16 chunks, an ACK at least every 8 chunks, 4 live transfers per session, consent 120 s, idle 60 s, a partial lives 86400 s, 8 partials per peer, the last 64 ended ids remembered. " +
      "`codecs`: `offer` (`{id, body | bodyHex, length, maxMessage, want}`; `maxMessage` is the reader's own HELLO value and the chunk plus 24 must fit it; `want` is `{ok:false}` or `{ok, offer}` with only the members present), `offsetBodies` (ACCEPT and ACK `{id, kind, size, chunk, body, want}`; an ACK may equal size, an ACCEPT may not unless it is a multiple of chunk), `done` (`toward` receiver needs a lower-case hex sha256, toward sender must not carry one), `cancel` (a string reason outside the eight reads as cancelled), `chunk` (`{id, size, chunk, expect, head, dataLength, want}`: the body is `head` as hex followed by dataLength bytes of 0xab; `expect` is the next offset the receiver wants). Every `ok:false` is a peer_bad_frame fault. " +
      "`window`, `offer`, `hash`, `ending`, `resume`, `limits`: one side of a session as a machine, `{id, ctx, steps, want}`; `want` has one entry per step, the output of that step, and after a close nothing more happens. `ctx`: `mode`, `capsLocal` and `capsRemote` (the handshake payload `caps`; the session's are the intersection), `maxMessage` (this side's own HELLO value), `hostLimit` and `free` (bytes, null for none), `handler` (how the host answers an offer: `accept` at once, `ask` later through a `consent` step, `decline`, `none` for no handler), `cats` (the link's categories, mode c), `partials` (kept partial files of this peer key: `{ref, id, sha256, size, chunk, bytes, writtenAt, held?, reread?, corrupt?, otherPeer?}`; `held` a live transfer in another session holds it, `reread` the bytes re-read and hashed since the session began, default `bytes`, `corrupt` its bytes are not the content, `otherPeer` it belongs to another remote key), `peerKey` (hex of the 32 raw bytes) and `withholdAcks` (this receiver has sent no ACK yet, so the window is judged from the accept offset). " +
      "A step carries `at` (seconds on the row's clock; a wait that ran out by then ends first with CANCEL timeout, and no row stands on the exact edge) and one of: `rx` (a record read: OFFER with its `body` text; ACCEPT and ACK `{id, offset}`; CHUNK `{id, offset, length}` whose data is the transfer's content, `data: corrupt` XORs each byte with 0xff; DONE `{id, sha256?}`; CANCEL `{id, reason}`; PING; `more` sets the MORE flag) or `host` (`offer` starts a send with `{id, size, chunk, sha256, cat?, seekable?}`; `consent` answers the question with `accept` or `decline`; `cancel`; `close` the session ends; `newSession` a new session on the same machine keeps the partials; `tick` only moves the clock). " +
      "The content of every transfer is byte i = (7 i + 13) mod 256, so each sha256 in a row is the SHA-256 of that content and a CHUNK needs no data in the row. An output holds the keys that apply: `send` (OFFER, ACCEPT, ACK, DONE, CANCEL `{id, reason}`, and CHUNKS `{id, offset, bytes}`, the consecutive CHUNK records one step sends, `chunk` bytes each and the last the remainder), `close` (a peer_* code), `ask` (the host is asked: id, name as shown, type, size, cat), `withdraw` (the question is withdrawn), `result` (`delivered` once the receiver's hash matched or the sender read DONE `{id}`; `cancelled` with its reason; `closed`; reported only for a transfer that reached ACCEPT), `partial` (effects on the kept files: `create`, `truncate` to an offset, `discard`, `evict`, `keep`, `delete`, `finalize`), `refused` (the host's own send was refused locally: busy) and `drop` (a late record for an ended id, without effect). A refusal CANCEL ends that id at once. " +
      "`name`: `paths` (`{id, key, xferId, sha256, path}`: hex of SHA-256('pkey-xfer/1 partial' || 0x00 || key || idBytes || sha256Bytes), key 32 raw bytes, id 16 decoded bytes, sha256 32 decoded bytes) and `rows` (an OFFER `body` whose name is a path-like string: the path of its partial file is the same for all, `display` is the name as shown, the §12.7.1 cleaning without the 64 code point cut, null when nothing is left, and `type` is passed on as given and never used). Append-only: a new row keeps peerMatrixVersion; a changed row or rule bumps it.",
    constants: {
      maxControlBytes: REF_XFER_MAX_CONTROL,
      maxSize: REF_XFER_MAX_SIZE,
      defaultChunk: REF_XFER_DEFAULT_CHUNK,
      maxChunk: REF_XFER_MAX_CHUNK,
      window: REF_XFER_WINDOW,
      ackEvery: REF_XFER_ACK_EVERY,
      maxTransfers: REF_XFER_MAX_TRANSFERS,
      consentSeconds: REF_XFER_CONSENT_SECONDS,
      idleSeconds: REF_XFER_IDLE_SECONDS,
      partialSeconds: REF_XFER_PARTIAL_SECONDS,
      maxPartialsPerPeer: REF_XFER_MAX_PARTIALS,
      endedIds: REF_XFER_ENDED_IDS,
      contentByte: "(7 i + 13) mod 256",
      contentByte0: refXferByte(0),
    },
    codecs: {
      offer: buildOfferCodec(),
      offsetBodies: buildOffsetCodec(),
      done: buildDoneCodec(),
      cancel: buildCancelCodec(),
      chunk: buildChunkCodec(),
    },
    window: buildWindow(),
    offer: buildOffer(),
    hash: buildHash(),
    ending: buildEnding(),
    resume: buildResume(),
    name: buildName(),
    limits: buildLimits(),
  };
}
