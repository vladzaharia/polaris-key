// `sync-vectors.json`: Cloud Sync end-to-end encryption known answers (WIRE-CONTRACT-V5 §13.10,
// §13.8.1; plans/CC-01-cloud-sync.md §2.4). `syncVectorsVersion` 1.
//
// Slice U-34.3 adds `cdcCases`, `chunkCases` and `manifestCases`.
// Slice U-34.1 holds `hkdfCases`, `envelopeCases`, `blindCases` and `transferPlanCases`; U-34.2
// adds `hpkeAnchor`, `wrapCases`, `recoveryCodeCases` and `adoptCases`. The
// remaining sections (`cdcCases`, `chunkCases`,
// `fileStreamCases`, `manifestCases`) append in later U-34 slices without changing the version.
// Every row is recomputed through `reference/syncVectors.ts` (`node:crypto` only; nothing from
// client-core), and the HKDF rows are cross-checked against `crypto.hkdfSync`.

import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  REF_E2E_OVERHEAD,
  REF_ENVELOPE_FIXED,
  REF_PAD_BLOCK,
  cat,
  fromHex,
  refBlind,
  refCanonicalJson,
  refHkdf,
  refKAdopt,
  refKChunk,
  refKCid,
  refKColl,
  refKFile,
  refKMsg,
  refKNames,
  refKRec,
  refAdoptAad,
  refEncodeCode,
  refHpkeContext,
  refHpkeSeal,
  refKid,
  refOpenBlob,
  refOpenValue,
  refParseCode,
  refRecoveryAad,
  refSealBlob,
  refUnwrap,
  refWrapInfo,
  refX25519Public,
  refSealValue,
  refTransferPlan,
  refBe32,
  REF_CDC,
  REF_CODEC_RAW,
  REF_CODEC_ZSTD,
  refCdc,
  refChunkId,
  refEncodeManifest,
  refOpenChunk,
  refParseManifest,
  refSealChunk,
  refSealChunkWithNonce,
  refStream,
  refZstdRawFrame,
  type RefManifest,
  toHex,
  utf8,
} from "./reference/syncVectors.js";

/** Fixed test material: SHA-256 of a label. Never used outside this file. */
const mat = (l: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(`pkey-sync vector ${l}`).digest());
const ROOT = mat("root");
const RING_ID = "rg_AAAAAAAAAAAAAAAAAAAAAA";
const NONE = new Uint8Array(0);

interface HkdfCase {
  id: string;
  description: string;
  label: string;
  ikmHex: string;
  saltHex: string;
  infoHex: string;
  length: number;
  okmHex: string;
}

function hkdfRow(
  id: string,
  description: string,
  label: string,
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
  expect: Uint8Array,
): HkdfCase {
  const okm = refHkdf(ikm, salt, info, length);
  const node = new Uint8Array(hkdfSync("sha256", ikm, salt, info, length));
  if (toHex(okm) !== toHex(node))
    throw new Error(`syncVectors ${id}: reference disagrees with node:crypto`);
  if (toHex(okm) !== toHex(expect))
    throw new Error(`syncVectors ${id}: derivation helper disagrees`);
  return {
    id,
    description,
    label,
    ikmHex: toHex(ikm),
    saltHex: toHex(salt),
    infoHex: toHex(info),
    length,
    okmHex: toHex(okm),
  };
}

const L = (s: string): Uint8Array => utf8(`pkey-sync/1 ${s}`);
const SALT16 = mat("salt16").subarray(0, 16);
const SALT32 = mat("salt32");
const CHUNK_ID = mat("chunk id");
const CODE16 = mat("recovery code").subarray(0, 16);

function buildHkdfCases(): HkdfCase[] {
  const kSet = refKColl(ROOT, "$settings");
  const kSaves = refKColl(ROOT, "saves");
  const rows: HkdfCase[] = [
    // RFC 5869 appendix A: anchors the extract and expand halves of the reference.
    hkdfRow(
      "rfc5869-case-1",
      "RFC 5869 appendix A.1: the published known answer, so the reference is anchored outside this file.",
      "rfc5869",
      new Uint8Array(22).fill(0x0b),
      fromHex("000102030405060708090a0b0c"),
      fromHex("f0f1f2f3f4f5f6f7f8f9"),
      42,
      fromHex(
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
      ),
    ),
    hkdfRow(
      "rfc5869-case-3",
      "RFC 5869 appendix A.3: empty salt and empty info (an empty salt is 32 zero bytes).",
      "rfc5869",
      new Uint8Array(22).fill(0x0b),
      NONE,
      NONE,
      42,
      fromHex(
        "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
      ),
    ),
    hkdfRow(
      "kid",
      "kid = HKDF(R, empty, 'pkey-sync/1 kid', 16): in every envelope header, in the clear.",
      "kid",
      ROOT,
      NONE,
      L("kid"),
      16,
      refKid(ROOT),
    ),
    hkdfRow(
      "k-coll-settings",
      "K_coll('$settings'): the info is the label, a NUL, then the collection name.",
      "coll",
      ROOT,
      NONE,
      cat(L("coll\0"), utf8("$settings")),
      32,
      kSet,
    ),
    hkdfRow(
      "k-coll-saves",
      "K_coll for a concrete collection name.",
      "coll",
      ROOT,
      NONE,
      cat(L("coll\0"), utf8("saves")),
      32,
      kSaves,
    ),
    hkdfRow(
      "k-names",
      "K_names: keys every blinded name.",
      "names",
      ROOT,
      NONE,
      L("names"),
      32,
      refKNames(ROOT),
    ),
    hkdfRow(
      "k-cid-saves",
      "K_cid(c): keys the chunk ids of one collection.",
      "chunk-id",
      ROOT,
      NONE,
      cat(L("chunk-id\0"), utf8("saves")),
      32,
      refKCid(ROOT, "saves"),
    ),
    hkdfRow(
      "k-msg",
      "K_msg: one key per value, from K_coll and a fresh 16-byte salt.",
      "value",
      kSet,
      SALT16,
      L("value"),
      32,
      refKMsg(kSet, SALT16),
    ),
    hkdfRow(
      "k-file",
      "K_file: one key per file version, from K_coll and a 32-byte salt.",
      "file",
      kSaves,
      SALT32,
      L("file"),
      32,
      refKFile(kSaves, SALT32),
    ),
    hkdfRow(
      "k-chunk",
      "K_chunk: one key per chunk id (the 32 raw bytes of the id are the salt).",
      "chunk",
      kSaves,
      CHUNK_ID,
      L("chunk"),
      32,
      refKChunk(kSaves, CHUNK_ID),
    ),
    hkdfRow(
      "k-rec",
      "K_rec: the recovery code (16 bytes) is the key material and the ringId text is the salt.",
      "recovery",
      CODE16,
      utf8(RING_ID),
      L("recovery"),
      32,
      refKRec(CODE16, RING_ID),
    ),
    hkdfRow(
      "k-adopt",
      "K_adopt: wraps a foreign root after an account merge.",
      "adopt",
      ROOT,
      NONE,
      L("adopt"),
      32,
      refKAdopt(ROOT),
    ),
  ];
  const ids = new Set<string>();
  for (const r of rows) {
    if (ids.has(r.id)) throw new Error(`syncVectors: duplicate id ${r.id}`);
    ids.add(r.id);
  }
  return rows;
}

// ── Envelopes (pkey-sync-value/1) ────────────────────────────────────────────────────────────

interface EnvelopeCase {
  id: string;
  description: string;
  rootHex: string;
  collection: string;
  name: string;
  aliases: string[];
  /** Present on a seal row: the plaintext the envelope was built from. */
  seal?: { saltHex: string; value: unknown };
  envelopeHex: string;
  expect:
    | { result: "ok"; name: string; value: unknown }
    | { result: "invalid"; reason: string };
}

const salt = (l: string): Uint8Array => mat(`value salt ${l}`).subarray(0, 16);

function sealRow(
  id: string,
  description: string,
  collection: string,
  name: string,
  value: unknown,
  saltLabel: string,
  extra: { expectLen?: number } = {},
): EnvelopeCase {
  const s = salt(saltLabel);
  const env = refSealValue(ROOT, collection, name, value, s);
  if (extra.expectLen !== undefined && env.length !== extra.expectLen)
    throw new Error(
      `syncVectors ${id}: envelope is ${env.length} bytes, row says ${extra.expectLen}`,
    );
  if ((env.length - REF_ENVELOPE_FIXED) % REF_PAD_BLOCK !== 0)
    throw new Error(`syncVectors ${id}: shape rule broken`);
  return {
    id,
    description,
    rootHex: toHex(ROOT),
    collection,
    name,
    aliases: [],
    seal: { saltHex: toHex(s), value },
    envelopeHex: toHex(env),
    expect: { result: "ok", name, value },
  };
}

/** Flips one bit of byte `i` (negative index counts from the end). */
function flip(b: Uint8Array, i: number): void {
  const at = i < 0 ? b.length + i : i;
  b.set([(b[at] ?? 0) ^ 0x01], at);
}

function mutate(
  base: EnvelopeCase,
  id: string,
  description: string,
  edit: (b: Uint8Array) => Uint8Array,
  reason: string,
  over: Partial<Pick<EnvelopeCase, "name" | "aliases" | "collection">> = {},
): EnvelopeCase {
  const env = edit(new Uint8Array(fromHex(base.envelopeHex)));
  return {
    id,
    description,
    rootHex: base.rootHex,
    collection: over.collection ?? base.collection,
    name: over.name ?? base.name,
    aliases: over.aliases ?? [],
    envelopeHex: toHex(env),
    expect: { result: "invalid", reason },
  };
}

function buildEnvelopeCases(): EnvelopeCase[] {
  const base = sealRow(
    "seal-string",
    'A string setting: P = {"k":"theme","v":"dark"} (27 bytes) padded with 0x80 and zeros to 64; the envelope is 33 + 64 + 16 = 113 bytes, the smallest there is.',
    "$settings",
    "theme",
    "dark",
    "a",
    { expectLen: REF_E2E_OVERHEAD },
  );
  const rows: EnvelopeCase[] = [
    base,
    sealRow(
      "seal-object-key-order",
      "Canonical JSON sorts object keys and has no whitespace, so the plaintext is identical whatever order the writer built the object in.",
      "$settings",
      "audio",
      { z: 1, a: [true, null, "x"], m: { b: 2, a: 1 } },
      "b",
    ),
    sealRow(
      "seal-unicode",
      "Non-ASCII text is UTF-8 in P, never escaped; the record name stays the person's own string.",
      "saves",
      "slot-éあ",
      "über \u{1f3ae}",
      "c",
    ),
    sealRow(
      "seal-pad-boundary-exact",
      "P is exactly 63 bytes: padding is the single 0x80 byte and the envelope is 113 bytes.",
      "$settings",
      "k",
      "x".repeat(63 - '{"k":"k","v":""}'.length),
      "d",
      { expectLen: 113 },
    ),
    sealRow(
      "seal-pad-boundary-full-block",
      "P is exactly 64 bytes: a whole block of padding is added (0x80 then 63 zeros), so padding is never zero bytes and the envelope is 177 bytes.",
      "$settings",
      "k",
      "x".repeat(64 - '{"k":"k","v":""}'.length),
      "e",
      { expectLen: 177 },
    ),
    sealRow(
      "seal-pad-boundary-over",
      "P is 65 bytes: padded to 128, so the envelope is 177 bytes.",
      "$settings",
      "k",
      "x".repeat(65 - '{"k":"k","v":""}'.length),
      "f",
      { expectLen: 177 },
    ),
    sealRow(
      "seal-null-value",
      'A null value is a value: {"k":..., "v":null}.',
      "saves",
      "rec",
      null,
      "g",
    ),
  ];
  const aliased = sealRow(
    "seal-old-name",
    "Sealed under the old name 'volume' before a catalog rename.",
    "$settings",
    "volume",
    7,
    "h",
  );
  rows.push({
    ...aliased,
    id: "open-alias",
    description:
      "The reader accepts a 'k' equal to an 'aliases' source: the catalog renamed 'volume' to 'masterVolume'.",
    name: "masterVolume",
    aliases: ["volume"],
    expect: { result: "ok", name: "volume", value: 7 },
  });
  const env = (b: Uint8Array): Uint8Array => b;
  rows.push(
    mutate(
      base,
      "tamper-ciphertext",
      "One flipped ciphertext bit: authentication fails.",
      (b) => {
        flip(b, 40);
        return b;
      },
      "auth",
    ),
    mutate(
      base,
      "tamper-tag",
      "One flipped tag bit.",
      (b) => {
        flip(b, b.length - 1);
        return b;
      },
      "auth",
    ),
    mutate(
      base,
      "tamper-salt",
      "A changed salt derives another key (and changes the aad).",
      (b) => {
        flip(b, 20);
        return b;
      },
      "auth",
    ),
    mutate(
      base,
      "wrong-collection",
      "The same envelope read under another collection: another K_coll, so authentication fails.",
      env,
      "auth",
      {
        collection: "saves",
      },
    ),
    mutate(
      base,
      "wrong-kid",
      "A kid that is not this ring's: refused before any decryption, so the caller can look for another root.",
      (b) => {
        flip(b, 1);
        return b;
      },
      "kid",
    ),
    mutate(
      base,
      "wrong-version",
      "Version byte 0x02.",
      (b) => {
        b.set([0x02]);
        return b;
      },
      "version",
    ),
    mutate(
      base,
      "truncated-shape",
      "One byte short: (length - 49) mod 64 is not 0.",
      (b) => b.subarray(0, b.length - 1),
      "shape",
    ),
    mutate(
      base,
      "extended-shape",
      "One byte long.",
      (b) => cat(b, Uint8Array.of(0)),
      "shape",
    ),
    mutate(
      base,
      "short-below-minimum",
      "49 bytes (header and tag only) is below the 113-byte minimum.",
      (b) => b.subarray(0, 49),
      "shape",
    ),
    mutate(base, "empty", "No bytes.", () => new Uint8Array(0), "shape"),
    mutate(
      base,
      "wrong-name",
      "Authentic, but 'k' is 'theme' and the reader expects 'language': invalid, never returned as the other setting's value.",
      env,
      "name",
      {
        name: "language",
      },
    ),
  );
  // Authentic envelopes whose plaintext breaks the P rules: sealed here with the reference's own
  // key schedule, so the failure is the padding or the JSON and not the tag.
  const padLess = new Uint8Array(64).fill(0x41);
  const badZeroFill = cat(
    utf8('{"k":"theme","v":1}'),
    Uint8Array.of(0x80, 0x00, 0x01),
  );
  const notJson = cat(utf8("not json"), Uint8Array.of(0x80));
  const extraMember = cat(
    utf8('{"k":"theme","v":1,"x":2}'),
    Uint8Array.of(0x80),
  );
  for (const [id, description, p, reason] of [
    [
      "bad-padding-no-marker",
      "Authentic, but the padded plaintext ends in no 0x80 marker.",
      padLess,
      "padding",
    ],
    [
      "bad-padding-nonzero-fill",
      "Authentic, but a non-zero byte follows the 0x80 marker.",
      badZeroFill,
      "padding",
    ],
    ["bad-json", "Authentic, but P is not JSON.", notJson, "json"],
    [
      "bad-json-extra-member",
      "Authentic, but P has a member besides 'k' and 'v'.",
      extraMember,
      "json",
    ],
  ] as const) {
    const padded = padTo64(p);
    rows.push({
      id,
      description,
      rootHex: base.rootHex,
      collection: "$settings",
      name: "theme",
      aliases: [],
      envelopeHex: toHex(sealPlain(padded, salt(id))),
      expect: { result: "invalid", reason },
    });
  }
  // Every row is recomputed through the reference reader.
  const ids = new Set<string>();
  for (const r of rows) {
    if (ids.has(r.id)) throw new Error(`syncVectors: duplicate id ${r.id}`);
    ids.add(r.id);
    const got = refOpenValue(
      fromHex(r.rootHex),
      r.collection,
      r.name,
      r.aliases,
      fromHex(r.envelopeHex),
    );
    const want = r.expect;
    const ok =
      want.result === "ok"
        ? got.ok &&
          got.name === want.name &&
          refCanonicalJson(got.value) === refCanonicalJson(want.value)
        : !got.ok && got.reason === want.reason;
    if (!ok)
      throw new Error(
        `syncVectors ${r.id}: reference reads ${JSON.stringify(got)}, row says ${JSON.stringify(want)}`,
      );
  }
  return rows;
}

/** Bytes padded to a multiple of 64 already (the caller included the marker): zero-extend only. */
function padTo64(p: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(p.length / 64) * 64);
  out.set(p);
  return out;
}

/** Seals already-padded plaintext as a `$settings` value envelope (the negative rows). */
function sealPlain(padded: Uint8Array, s: Uint8Array): Uint8Array {
  const header = cat(Uint8Array.of(0x01), refKid(ROOT), s);
  const key = refKMsg(refKColl(ROOT, "$settings"), s);
  const c = createCipheriv("aes-256-gcm", key, new Uint8Array(12));
  c.setAAD(header);
  return cat(
    header,
    new Uint8Array(
      Buffer.concat([c.update(padded), c.final(), c.getAuthTag()]),
    ),
  );
}

// ── Blinded names ────────────────────────────────────────────────────────────────────────────

interface BlindCase {
  id: string;
  description: string;
  rootHex: string;
  kind: string;
  ctx: string;
  n: string;
  blinded: string;
}

function buildBlindCases(): BlindCase[] {
  const kn = refKNames(ROOT);
  const row = (
    id: string,
    description: string,
    kind: string,
    ctx: string,
    n: string,
  ): BlindCase => {
    const blinded = refBlind(kn, kind, ctx, n);
    if (!/^x:[A-Za-z0-9_-]{43}$/.test(blinded))
      throw new Error(`syncVectors ${id}: bad blinded shape`);
    return { id, description, rootHex: toHex(ROOT), kind, ctx, n, blinded };
  };
  const rows = [
    row(
      "setting",
      "An open-setting key under the declared key that scopes it.",
      "setting",
      "$settings",
      "custom.hotkey",
    ),
    row(
      "member",
      "A merge member name: ctx is the declared merge setting.",
      "member",
      "keybinds",
      "jump",
    ),
    row(
      "record",
      "A record id: ctx is the collection.",
      "record",
      "saves",
      "slot-1",
    ),
    row(
      "field",
      "A field name inside a record collection.",
      "field",
      "saves",
      "playtime",
    ),
    row(
      "element",
      "A union element is its canonical JSON.",
      "element",
      "favorites",
      '{"id":7,"tag":"a"}',
    ),
    row(
      "record-unicode",
      "A person-chosen id with non-ASCII text.",
      "record",
      "saves",
      "café \u{1f3ae}",
    ),
    row(
      "record-empty-name",
      "An empty name is still blinded.",
      "record",
      "saves",
      "",
    ),
    row(
      "kind-separates",
      "Same ctx and name as 'record-slot-1', another kind: a different value.",
      "field",
      "saves",
      "slot-1",
    ),
    row(
      "ctx-separates",
      "Same kind and name as 'record-slot-1', another ctx: a different value.",
      "record",
      "autosaves",
      "slot-1",
    ),
    row(
      "nul-framing",
      "The 0x00 separators frame the fields; a one-character ctx and name.",
      "record",
      "a",
      "b",
    ),
  ];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`syncVectors: duplicate id ${r.id}`);
    seen.add(r.id);
  }
  const values = new Set(rows.map((r) => r.blinded));
  if (values.size !== rows.length)
    throw new Error("syncVectors: two blind rows collide");
  return rows;
}

// ── The transfer planner ─────────────────────────────────────────────────────────────────────

const MIB = 1024 * 1024;

function buildTransferPlanCases(): unknown[] {
  const rows: Array<[string, string, number, boolean]> = [
    ["empty-file", "An empty file is a single PUT.", 0, false],
    ["single-small", "A small file.", 1000, false],
    ["single-at-limit", "Exactly 16 MiB is still one PUT.", 16 * MIB, false],
    [
      "multipart-just-over",
      "One byte over 16 MiB: multipart with 8 MiB parts (3 parts).",
      16 * MIB + 1,
      false,
    ],
    ["multipart-100-mib", "100 MiB: 8 MiB parts, 13 parts.", 100 * MIB, false],
    [
      "multipart-1-gib",
      "1 GiB: ceil(size / 9,999) is 107,386 bytes, rounded up to 1 MiB, below the 8 MiB floor.",
      1024 * MIB,
      false,
    ],
    [
      "multipart-1-gib-exact-parts",
      "A size that is an exact multiple of the part size has no short part.",
      800 * MIB,
      false,
    ],
    [
      "delta-below-minimum",
      "files.delta, but under 1 MiB: not chunked, single.",
      MIB - 1,
      true,
    ],
    ["delta-at-minimum", "files.delta and exactly 1 MiB: chunks.", MIB, true],
    [
      "delta-large",
      "files.delta and 500 MiB: chunks, never multipart.",
      500 * MIB,
      true,
    ],
    ["delta-off-large", "files.delta off and 1 MiB: still single.", MIB, false],
    [
      "too-large",
      "One byte over 1 GiB is refused (SYNC_FILE_MAX_BYTES).",
      1024 * MIB + 1,
      false,
    ],
    [
      "too-large-delta",
      "The cap applies to chunked collections too.",
      1024 * MIB + 1,
      true,
    ],
  ];
  return rows.map(([id, description, size, delta]) => {
    const p = refTransferPlan(size, delta);
    return {
      id,
      description,
      size,
      delta,
      expect: { mode: p.mode, partBytes: p.partBytes, parts: p.parts },
    };
  });
}

// ── Wrap, recovery and adopt (§13.11) ────────────────────────────────────────────────────────

const ANCHOR_PATH = new URL("./inputs/hpke-anchors.json", import.meta.url);

interface HpkeAnchorFile {
  description: string;
  source: { id: string; url: string; sha256: string };
  sha256: string;
  vector: Record<string, unknown> & {
    encryption: { aad: string; ct: string; nonce: string; pt: string };
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v);
}

/** The RFC 9180 vector, hash-checked, and the reference's agreement with every intermediate. */
function buildHpkeAnchor(): unknown {
  const f = JSON.parse(readFileSync(ANCHOR_PATH, "utf8")) as HpkeAnchorFile;
  const sum = createHash("sha256").update(canonical(f.vector)).digest("hex");
  if (sum !== f.sha256)
    throw new Error(
      `hpke anchor: vector hash ${sum} is not the pinned ${f.sha256}`,
    );
  const v = f.vector as Record<string, string>;
  const c = refHpkeContext(
    fromHex(v.pkRm!),
    fromHex(v.skEm!),
    fromHex(v.info!),
  );
  const e = f.vector.encryption;
  const sealed = refHpkeSeal(
    fromHex(v.pkRm!),
    fromHex(v.skEm!),
    fromHex(v.info!),
    fromHex(e.aad),
    fromHex(e.pt),
  );
  const got = {
    pkEm: toHex(refX25519Public(fromHex(v.skEm!))),
    pkRm: toHex(refX25519Public(fromHex(v.skRm!))),
    enc: toHex(c!.enc),
    shared_secret: toHex(c!.sharedSecret),
    key: toHex(c!.key),
    base_nonce: toHex(c!.baseNonce),
    ct: toHex(sealed.ct),
  };
  const want = {
    pkEm: v.pkEm,
    pkRm: v.pkRm,
    enc: v.enc,
    shared_secret: v.shared_secret,
    key: v.key,
    base_nonce: v.base_nonce,
    ct: e.ct,
  };
  for (const k of Object.keys(want) as (keyof typeof want)[])
    if (got[k] !== want[k])
      throw new Error(
        `hpke anchor ${k}: reference gives ${got[k]}, RFC says ${want[k]}`,
      );
  return {
    note: "RFC 9180 test vector for mode_base, KEM 0x0020, KDF 0x0001 and AEAD 0x0002, copied from the pinned upstream file (sequence 0 only; hex). `source.sha256` pins the whole upstream file, `sha256` the vector as sorted-key compact JSON. A runner checks enc, shared_secret, key, base_nonce and the ciphertext; the raw layout (enc, then ciphertext followed by the tag) is what CryptoKit and Tink expose.",
    source: f.source,
    sha256: f.sha256,
    vector: f.vector,
  };
}

const sk = (l: string): Uint8Array => mat(`hpke key ${l}`);
const WRAP_PRODUCT = "demo";
const WRAP_DEVICE = "dev_0123456789abcdef";
const WRAP_EPOCH = 1;

interface WrapCase {
  id: string;
  description: string;
  product: string;
  deviceId: string;
  ringId: string;
  epoch: number;
  kidHex: string;
  recipientPrivateHex: string;
  wrap: { kem: number; encHex: string; ctHex: string };
  expectRootHex: string | null;
  seal?: {
    rootHex: string;
    recipientPublicHex: string;
    ephemeralPrivateHex: string;
    infoHex: string;
  };
}

function buildWrapCases(): WrapCase[] {
  const skR = sk("recipient");
  const pkR = refX25519Public(skR);
  const skE = sk("ephemeral");
  const kid = refKid(ROOT);
  const info = refWrapInfo(WRAP_PRODUCT, WRAP_DEVICE, RING_ID, WRAP_EPOCH);
  const good = refHpkeSeal(pkR, skE, info, kid, ROOT);
  const base = {
    product: WRAP_PRODUCT,
    deviceId: WRAP_DEVICE,
    ringId: RING_ID,
    epoch: WRAP_EPOCH,
    kidHex: toHex(kid),
    recipientPrivateHex: toHex(skR),
    wrap: { kem: 0x0020, encHex: toHex(good.enc), ctHex: toHex(good.ct) },
  };
  const row = (
    id: string,
    description: string,
    over: Partial<Omit<WrapCase, "id" | "description" | "expectRootHex">>,
    withSeal = false,
  ): WrapCase => {
    const r: WrapCase = {
      id,
      description,
      ...base,
      ...over,
      expectRootHex: null,
    };
    const open = refUnwrap(
      fromHex(r.recipientPrivateHex),
      r.product,
      r.deviceId,
      r.ringId,
      r.epoch,
      fromHex(r.kidHex),
      {
        kem: r.wrap.kem,
        enc: fromHex(r.wrap.encHex),
        ct: fromHex(r.wrap.ctHex),
      },
    );
    r.expectRootHex = open === null ? null : toHex(open);
    if (withSeal)
      r.seal = {
        rootHex: toHex(ROOT),
        recipientPublicHex: toHex(pkR),
        ephemeralPrivateHex: toHex(skE),
        infoHex: toHex(info),
      };
    return r;
  };
  const flipHex = (h: string, at: number): string => {
    const b = fromHex(h);
    b[at]! ^= 1;
    return toHex(b);
  };
  const w = base.wrap;
  const rows: WrapCase[] = [
    row(
      "wrap-root",
      "A root wrapped to a device key; sealing it again with the ephemeral key gives the same bytes.",
      {},
      true,
    ),
    row(
      "wrap-epoch-2",
      "Another epoch is another info and another wrap.",
      {
        epoch: 2,
        wrap: (() => {
          const g = refHpkeSeal(
            pkR,
            skE,
            refWrapInfo(WRAP_PRODUCT, WRAP_DEVICE, RING_ID, 2),
            kid,
            ROOT,
          );
          return { kem: 0x0020, encHex: toHex(g.enc), ctHex: toHex(g.ct) };
        })(),
      },
      false,
    ),
    row("wrong-product", "The product is part of info.", { product: "other" }),
    row("wrong-device", "The device id is part of info.", {
      deviceId: "dev_other",
    }),
    row("wrong-ring", "The ring id is part of info.", {
      ringId: "rg_BBBBBBBBBBBBBBBBBBBBBB",
    }),
    row("wrong-epoch", "The epoch is part of info.", { epoch: 2 }),
    row("wrong-kid", "The kid is the associated data.", {
      kidHex: flipHex(base.kidHex, 0),
    }),
    row("wrong-key", "A different recipient key cannot open it.", {
      recipientPrivateHex: toHex(sk("stranger")),
    }),
    row("unknown-kem", "Only kem 32 (X25519) is understood.", {
      wrap: { ...w, kem: 16 },
    }),
    row("tampered-ct", "A flipped ciphertext bit fails authentication.", {
      wrap: { ...w, ctHex: flipHex(w.ctHex, 0) },
    }),
    row("tampered-tag", "A flipped tag bit fails authentication.", {
      wrap: { ...w, ctHex: flipHex(w.ctHex, 47) },
    }),
    row("tampered-enc", "A flipped encapsulated-key bit derives another key.", {
      wrap: { ...w, encHex: flipHex(w.encHex, 5) },
    }),
    row("short-enc", "An encapsulated key must be 32 bytes.", {
      wrap: { ...w, encHex: w.encHex.slice(2) },
    }),
    row("low-order-enc", "An all-zero encapsulated key is refused.", {
      wrap: { ...w, encHex: "00".repeat(32) },
    }),
  ];
  if (rows[0]!.expectRootHex !== toHex(ROOT))
    throw new Error("syncVectors: the wrap does not open");
  return rows;
}

const CODE_A = mat("recovery code a").subarray(0, 16);
const NONCE_A = mat("recovery nonce").subarray(0, 12);

function buildRecoveryCodeCases(): unknown[] {
  const codes: Array<[string, string, Uint8Array]> = [
    ["code-random", "An arbitrary code.", CODE_A],
    ["code-zero", "The all-zero code.", new Uint8Array(16)],
    ["code-ones", "The all-ones code.", new Uint8Array(16).fill(255)],
    [
      "code-b",
      "Another arbitrary code.",
      mat("recovery code b").subarray(0, 16),
    ],
  ];
  const rows: unknown[] = codes.map(([id, description, code]) => {
    const text = refEncodeCode(code);
    if (toHex(refParseCode(text)!) !== toHex(code))
      throw new Error("syncVectors: code does not round-trip");
    return { kind: "code", id, description, codeHex: toHex(code), text };
  });
  const canon = refEncodeCode(CODE_A);
  const flat = canon.replaceAll("-", "");
  const swap = (s: string, from: string, to: string): string =>
    s.replace(from, to);
  const parseRow = (
    id: string,
    description: string,
    input: string,
  ): unknown => {
    const c = refParseCode(input);
    return {
      kind: "parse",
      id,
      description,
      input,
      expectCodeHex: c === null ? null : toHex(c),
    };
  };
  const zeroText = refEncodeCode(new Uint8Array(16));
  rows.push(
    parseRow("parse-lowercase", "Case is ignored.", canon.toLowerCase()),
    parseRow(
      "parse-spaces",
      "Spaces and hyphens are ignored.",
      canon.replaceAll("-", " "),
    ),
    parseRow("parse-no-separators", "No separators at all.", flat),
    parseRow(
      "parse-padded",
      "Leading and trailing whitespace.",
      ` \n${canon}\t `,
    ),
    parseRow("parse-o-is-zero", "O reads as 0.", zeroText.replaceAll("0", "O")),
    parseRow(
      "parse-i-l-are-one",
      "I and L read as 1.",
      swap(refEncodeCode(mat("recovery code c").subarray(0, 16)), "1", "I"),
    ),
    parseRow(
      "parse-bad-checksum",
      "Another first character fails the checksum.",
      (flat[0] === "0" ? "1" : "0") + flat.slice(1),
    ),
    parseRow("parse-short", "31 characters.", flat.slice(1)),
    parseRow("parse-long", "33 characters.", `${flat}0`),
    parseRow(
      "parse-bad-char",
      "U is not in the alphabet.",
      `U${flat.slice(1)}`,
    ),
    parseRow("parse-empty", "Nothing.", ""),
  );
  // The recovery blob (K_rec, aad with the ring, epoch and kid).
  const kid = refKid(ROOT);
  const blobFor = (
    code: Uint8Array,
    ringId: string,
    epoch: number,
    k: Uint8Array,
  ): Uint8Array =>
    refSealBlob(
      refKRec(code, ringId),
      NONCE_A,
      refRecoveryAad(ringId, epoch, k),
      ROOT,
    );
  const blob = blobFor(CODE_A, RING_ID, 1, kid);
  const blobRow = (
    id: string,
    description: string,
    over: {
      codeHex?: string;
      ringId?: string;
      epoch?: number;
      kidHex?: string;
      blobHex?: string;
    },
    withSeal = false,
  ): unknown => {
    const r = {
      kind: "blob",
      id,
      description,
      codeHex: toHex(CODE_A),
      ringId: RING_ID,
      epoch: 1,
      kidHex: toHex(kid),
      blobHex: toHex(blob),
      ...over,
    };
    const out = refOpenBlob(
      refKRec(fromHex(r.codeHex), r.ringId),
      refRecoveryAad(r.ringId, r.epoch, fromHex(r.kidHex)),
      fromHex(r.blobHex),
    );
    return {
      ...r,
      expectRootHex: out === null ? null : toHex(out),
      ...(withSeal
        ? { seal: { rootHex: toHex(ROOT), nonceHex: toHex(NONCE_A) } }
        : {}),
    };
  };
  const flip = (h: string, at: number): string => {
    const b = fromHex(h);
    b[at]! ^= 1;
    return toHex(b);
  };
  const bh = toHex(blob);
  rows.push(
    blobRow(
      "blob-root",
      "The root sealed under the code; sealing again with the nonce gives the same bytes.",
      {},
      true,
    ),
    blobRow("blob-epoch-2", "Another epoch is another blob.", {
      epoch: 2,
      blobHex: toHex(blobFor(CODE_A, RING_ID, 2, kid)),
    }),
    blobRow("blob-wrong-code", "Another code cannot open it.", {
      codeHex: toHex(mat("recovery code b").subarray(0, 16)),
    }),
    blobRow("blob-wrong-ring", "The ring id is the salt and part of aad.", {
      ringId: "rg_BBBBBBBBBBBBBBBBBBBBBB",
    }),
    blobRow("blob-wrong-epoch", "The epoch is part of aad.", { epoch: 2 }),
    blobRow("blob-wrong-kid", "The kid is part of aad.", {
      kidHex: flip(toHex(kid), 3),
    }),
    blobRow("blob-bad-version", "Version 2 is refused.", {
      blobHex: `02${bh.slice(2)}`,
    }),
    blobRow("blob-tampered", "A flipped bit fails authentication.", {
      blobHex: flip(bh, 20),
    }),
    blobRow("blob-truncated", "A short blob is refused.", {
      blobHex: bh.slice(0, bh.length - 2),
    }),
  );
  return rows;
}

function buildAdoptCases(): unknown[] {
  const oldRoot = mat("old root");
  const from = {
    fromRingId: "rg_BBBBBBBBBBBBBBBBBBBBBB",
    epoch: 3,
    kid: refKid(oldRoot),
  };
  const nonce = mat("adopt nonce").subarray(0, 12);
  const blob = refSealBlob(
    refKAdopt(ROOT),
    nonce,
    refAdoptAad(from.fromRingId, from.epoch, from.kid),
    oldRoot,
  );
  const flip = (h: string, at: number): string => {
    const b = fromHex(h);
    b[at]! ^= 1;
    return toHex(b);
  };
  const row = (
    id: string,
    description: string,
    over: {
      currentRootHex?: string;
      fromRingId?: string;
      epoch?: number;
      kidHex?: string;
      blobHex?: string;
    },
    withSeal = false,
  ): unknown => {
    const r = {
      id,
      description,
      currentRootHex: toHex(ROOT),
      fromRingId: from.fromRingId,
      epoch: from.epoch,
      kidHex: toHex(from.kid),
      blobHex: toHex(blob),
      ...over,
    };
    const out = refOpenBlob(
      refKAdopt(fromHex(r.currentRootHex)),
      refAdoptAad(r.fromRingId, r.epoch, fromHex(r.kidHex)),
      fromHex(r.blobHex),
    );
    return {
      ...r,
      expectRootHex: out === null ? null : toHex(out),
      ...(withSeal
        ? { seal: { oldRootHex: toHex(oldRoot), nonceHex: toHex(nonce) } }
        : {}),
    };
  };
  const bh = toHex(blob);
  return [
    row(
      "adopt-root",
      "A previous root sealed under K_adopt of the current one; sealing again with the nonce gives the same bytes.",
      {},
      true,
    ),
    row(
      "adopt-wrong-current",
      "Another current root derives another K_adopt.",
      { currentRootHex: toHex(oldRoot) },
    ),
    row("adopt-wrong-ring", "The source ring id is part of aad.", {
      fromRingId: RING_ID,
    }),
    row("adopt-wrong-epoch", "The source epoch is part of aad.", { epoch: 4 }),
    row("adopt-wrong-kid", "The source kid is part of aad.", {
      kidHex: flip(toHex(from.kid), 0),
    }),
    row("adopt-bad-version", "Version 2 is refused.", {
      blobHex: `02${bh.slice(2)}`,
    }),
    row("adopt-tampered", "A flipped bit fails authentication.", {
      blobHex: flip(bh, 30),
    }),
    row(
      "adopt-recovery-label",
      "A blob sealed under K_rec with a recovery aad does not open as an adopt blob.",
      {
        blobHex: toHex(
          refSealBlob(
            refKRec(CODE_A, from.fromRingId),
            nonce,
            refRecoveryAad(from.fromRingId, from.epoch, from.kid),
            oldRoot,
          ),
        ),
      },
    ),
  ];
}

// ── Content-defined chunking, chunk objects and the manifest (§13.8.3) ───────────────────────

type CdcInput =
  | { kind: "stream"; label: string; length: number }
  | { kind: "byte"; value: number; length: number };

function cdcInput(i: CdcInput): Uint8Array {
  return i.kind === "stream"
    ? refStream(`pkey-sync vector cdc ${i.label}`, i.length)
    : new Uint8Array(i.length).fill(i.value);
}

function buildCdcCases(): unknown[] {
  const real = REF_CDC.avg;
  const rows: Array<[string, string, number, CdcInput]> = [
    [
      "empty",
      "An empty input has no chunks.",
      real,
      { kind: "byte", value: 0, length: 0 },
    ],
    [
      "one-byte",
      "One byte is one chunk.",
      real,
      { kind: "byte", value: 7, length: 1 },
    ],
    [
      "exactly-min",
      "An input of exactly min (avg / 4) bytes is one chunk: a remainder of at most min is never cut.",
      1024,
      { kind: "stream", label: "min", length: 256 },
    ],
    [
      "min-plus-one",
      "One byte past min: the scan starts at offset min and sees one byte.",
      1024,
      { kind: "stream", label: "min1", length: 257 },
    ],
    [
      "exactly-max",
      "An input of exactly max (avg * 4) bytes of zeros: the gear hash of zeros never meets either mask, so the cut is at max.",
      1024,
      { kind: "byte", value: 0, length: 4096 },
    ],
    [
      "max-plus-one",
      "One byte past max: a max chunk and a one-byte remainder.",
      1024,
      { kind: "byte", value: 0, length: 4097 },
    ],
    [
      "zeros-real",
      "3 MiB of zeros at the real parameters: three max chunks.",
      real,
      { kind: "byte", value: 0, length: 3 * 1024 * 1024 },
    ],
    [
      "stream-small-1k",
      "Pseudo-random input, avg 1 KiB (min 256, max 4 KiB).",
      1024,
      { kind: "stream", label: "a", length: 64 * 1024 },
    ],
    [
      "stream-small-4k",
      "Pseudo-random input, avg 4 KiB (min 1 KiB, max 16 KiB).",
      4096,
      { kind: "stream", label: "b", length: 256 * 1024 },
    ],
    [
      "stream-real-avg",
      "Pseudo-random input at the real parameters: avg 256 KiB, min 64 KiB, max 1 MiB.",
      real,
      { kind: "stream", label: "c", length: 6 * 1024 * 1024 + 12345 },
    ],
    [
      "stream-real-tail",
      "The same stream cut 100 bytes shorter: the cuts before the tail are unchanged.",
      real,
      { kind: "stream", label: "c", length: 6 * 1024 * 1024 + 12245 },
    ],
  ];
  return rows.map(([id, description, avg, input]) => {
    const buf = cdcInput(input);
    const lens = refCdc(buf, avg);
    if (lens.reduce((a, b) => a + b, 0) !== buf.length)
      throw new Error(`syncVectors ${id}: chunks do not tile the input`);
    const min = avg / 4;
    const max = avg * 4;
    lens.forEach((n, k) => {
      if (n > max || (n < min && k !== lens.length - 1))
        throw new Error(`syncVectors ${id}: chunk ${k} out of bounds`);
    });
    return { id, description, avg, min, max, input, lens };
  });
}

const CHUNK_ROOT = mat("chunk root");
const CHUNK_COLL = "saves";

interface ChunkIdCase {
  id: string;
  description: string;
  kind: "id";
  rootHex: string;
  collection: string;
  plainHex: string;
  e2eIdHex: string;
  serverIdHex: string;
}
interface ChunkObjectCase {
  id: string;
  description: string;
  kind: "object";
  rootHex: string;
  collection: string;
  idHex: string;
  objectHex: string;
  seal?: { codec: number; bodyHex: string };
  expect:
    | { result: "ok"; plainHex: string; codec: number }
    | { result: "invalid"; reason: string };
}

interface ChunkPairCase {
  id: string;
  description: string;
  kind: "pair";
  rootHex: string;
  collection: string;
  idHex: string;
  plainHex: string;
  rawObjectHex: string;
  zstdObjectHex: string;
  rawNonceHex: string;
  zstdNonceHex: string;
}

function buildChunkCases(): Array<
  ChunkIdCase | ChunkObjectCase | ChunkPairCase
> {
  const rows: Array<ChunkIdCase | ChunkObjectCase | ChunkPairCase> = [];
  const idRow = (id: string, description: string, plain: Uint8Array) => {
    rows.push({
      id,
      description,
      kind: "id",
      rootHex: toHex(CHUNK_ROOT),
      collection: CHUNK_COLL,
      plainHex: toHex(plain),
      e2eIdHex: toHex(refChunkId(CHUNK_ROOT, CHUNK_COLL, plain)),
      serverIdHex: toHex(refChunkId(null, CHUNK_COLL, plain)),
    });
  };
  const plainA = refStream("pkey-sync vector chunk a", 300);
  const plainB = refStream("pkey-sync vector chunk b", 5);
  idRow(
    "id-300-bytes",
    "E2E id is HMAC-SHA256(K_cid(c), chunk); server id is SHA-256(chunk).",
    plainA,
  );
  idRow(
    "id-empty",
    "Ids are defined for an empty chunk too (the manifest refuses such a record).",
    new Uint8Array(0),
  );
  rows.push({
    id: "id-collection-scoped",
    description:
      "The same plaintext in another collection has another E2E id (K_cid is per collection) and the same server id.",
    kind: "id",
    rootHex: toHex(CHUNK_ROOT),
    collection: "other",
    plainHex: toHex(plainA),
    e2eIdHex: toHex(refChunkId(CHUNK_ROOT, "other", plainA)),
    serverIdHex: toHex(refChunkId(null, "other", plainA)),
  });
  const idA = refChunkId(CHUNK_ROOT, CHUNK_COLL, plainA);
  const rawA = refSealChunk(CHUNK_ROOT, CHUNK_COLL, idA, REF_CODEC_RAW, plainA);
  const frameA = refZstdRawFrame(plainA);
  const zstdA = refSealChunk(
    CHUNK_ROOT,
    CHUNK_COLL,
    idA,
    REF_CODEC_ZSTD,
    frameA,
  );
  const obj = (
    id: string,
    description: string,
    idBytes: Uint8Array,
    object: Uint8Array,
    expect: ChunkObjectCase["expect"],
    seal?: ChunkObjectCase["seal"],
    collection = CHUNK_COLL,
  ) => {
    const got = refOpenChunk(CHUNK_ROOT, collection, idBytes, object);
    const want =
      expect.result === "ok"
        ? got.ok &&
          toHex(got.plain) === expect.plainHex &&
          got.codec === expect.codec
        : !got.ok && got.reason === expect.reason;
    if (!want) throw new Error(`syncVectors chunk ${id}: reference disagrees`);
    rows.push({
      id,
      description,
      kind: "object",
      rootHex: toHex(CHUNK_ROOT),
      collection,
      idHex: toHex(idBytes),
      objectHex: toHex(object),
      ...(seal === undefined ? {} : { seal }),
      expect,
    });
  };
  obj(
    "object-raw",
    "codec 0: 0x01 0x00, the 12-byte synthetic nonce HMAC-SHA256(K_chunk, 0x01 0x00 body)[0:12], then AES-256-GCM of the chunk under K_chunk(id), aad = 0x01 0x00 id.",
    idA,
    rawA,
    { result: "ok", plainHex: toHex(plainA), codec: 0 },
    { codec: 0, bodyHex: toHex(plainA) },
  );
  obj(
    "object-zstd",
    "codec 1: the body is one zstd frame with its content size (here raw blocks); a reader decodes both codecs.",
    idA,
    zstdA,
    { result: "ok", plainHex: toHex(plainA), codec: 1 },
    { codec: 1, bodyHex: toHex(frameA) },
  );
  const ids = (b: Uint8Array) => new Uint8Array(b);
  const flipAt = (b: Uint8Array, i: number) => {
    const c = ids(b);
    c[i] = c[i]! ^ 1;
    return c;
  };
  obj(
    "refuse-shape",
    "Fewer than 2 + 12 + 16 bytes.",
    idA,
    rawA.subarray(0, 29),
    {
      result: "invalid",
      reason: "shape",
    },
  );
  obj(
    "refuse-version",
    "Version byte 0x02.",
    idA,
    (() => {
      const c = ids(rawA);
      c[0] = 2;
      return c;
    })(),
    { result: "invalid", reason: "version" },
  );
  obj(
    "refuse-codec",
    "Codec 2 is unknown (checked before any decryption).",
    idA,
    (() => {
      const c = ids(rawA);
      c[1] = 2;
      return c;
    })(),
    { result: "invalid", reason: "codec" },
  );
  obj(
    "refuse-auth-tag",
    "A flipped bit in the tag.",
    idA,
    flipAt(rawA, rawA.length - 1),
    { result: "invalid", reason: "auth" },
  );
  obj(
    "refuse-auth-codec-swapped",
    "Codec 0 relabelled 1: the codec is in the associated data.",
    idA,
    (() => {
      const c = ids(rawA);
      c[1] = 1;
      return c;
    })(),
    { result: "invalid", reason: "auth" },
  );
  obj(
    "refuse-auth-wrong-id",
    "A chunk object opened under another id.",
    refChunkId(CHUNK_ROOT, CHUNK_COLL, plainB),
    rawA,
    { result: "invalid", reason: "auth" },
  );
  obj(
    "refuse-auth-wrong-collection",
    "A chunk object opened in another collection.",
    idA,
    rawA,
    { result: "invalid", reason: "auth" },
    undefined,
    "other",
  );
  obj(
    "refuse-nonce-not-synthetic",
    "Sealed correctly under a zero nonce: the tag verifies, but the nonce is not HMAC-SHA256(K_chunk, 0x01 codec body)[0:12], so the reader refuses it before the frame.",
    idA,
    refSealChunkWithNonce(
      CHUNK_ROOT,
      CHUNK_COLL,
      idA,
      REF_CODEC_RAW,
      plainA,
      new Uint8Array(12),
    ),
    { result: "invalid", reason: "nonce" },
  );
  obj(
    "refuse-decode-garbage",
    "Codec 1 whose body is not a zstd frame.",
    idA,
    refSealChunk(CHUNK_ROOT, CHUNK_COLL, idA, REF_CODEC_ZSTD, plainA),
    { result: "invalid", reason: "decode" },
  );
  obj(
    "refuse-decode-no-content-size",
    "Codec 1 whose frame header declares no content size.",
    idA,
    refSealChunk(
      CHUNK_ROOT,
      CHUNK_COLL,
      idA,
      REF_CODEC_ZSTD,
      Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x01, 0x00, 0x00),
    ),
    { result: "invalid", reason: "decode" },
  );
  obj(
    "refuse-size-declared",
    "Codec 1 whose frame declares 2 MiB: refused before decoding (max is 1 MiB).",
    idA,
    refSealChunk(
      CHUNK_ROOT,
      CHUNK_COLL,
      idA,
      REF_CODEC_ZSTD,
      Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x00, 0x00, 0x00, 0x20, 0x00),
    ),
    { result: "invalid", reason: "size" },
  );
  obj(
    "refuse-id-mismatch",
    "Sealed under idA with a body that is not the chunk idA names: it opens, and the keyed hash of the plaintext differs from the id.",
    idA,
    refSealChunk(CHUNK_ROOT, CHUNK_COLL, idA, REF_CODEC_RAW, plainB),
    { result: "invalid", reason: "id" },
  );
  // The same id sealed with both codecs: the bodies differ, so the nonces differ and both open.
  const nonceRaw = rawA.subarray(2, 14);
  const nonceZstd = zstdA.subarray(2, 14);
  if (toHex(nonceRaw) === toHex(nonceZstd))
    throw new Error("syncVectors chunk pair: nonces must differ");
  rows.push({
    id: "pair-codecs-same-id",
    description:
      "One chunk id sealed with codec 0 and with codec 1: the bodies differ, so the synthetic nonces differ (a shared key and nonce would leak both plaintexts) and each object opens to the same chunk.",
    kind: "pair",
    rootHex: toHex(CHUNK_ROOT),
    collection: CHUNK_COLL,
    idHex: toHex(idA),
    plainHex: toHex(plainA),
    rawObjectHex: toHex(rawA),
    zstdObjectHex: toHex(zstdA),
    rawNonceHex: toHex(nonceRaw),
    zstdNonceHex: toHex(nonceZstd),
  });
  return rows;
}

const MF_SHA = new Uint8Array(
  createHash("sha256").update("pkey-sync vector manifest").digest(),
);
const mid = (l: string): Uint8Array => mat(`manifest chunk ${l}`);

interface ManifestCase {
  id: string;
  description: string;
  manifestHex: string;
  expect:
    | {
        result: "ok";
        plainSize: number;
        plainSha256Hex: string;
        records: Array<{ idHex: string; plainLen: number }>;
      }
    | { result: "invalid"; reason: string };
}

function buildManifestCases(): ManifestCase[] {
  const good: RefManifest = {
    plainSize: 70000 + 70000 + 1234,
    plainSha256: MF_SHA,
    records: [
      { id: mid("a"), plainLen: 70000 },
      { id: mid("b"), plainLen: 70000 },
      { id: mid("a"), plainLen: 1234 },
    ],
  };
  const rows: ManifestCase[] = [];
  const ok = (id: string, description: string, m: RefManifest) => {
    const bytes = refEncodeManifest(m);
    const p = refParseManifest(bytes);
    if (!p.ok) throw new Error(`syncVectors manifest ${id}: reference refuses`);
    rows.push({
      id,
      description,
      manifestHex: toHex(bytes),
      expect: {
        result: "ok",
        plainSize: m.plainSize,
        plainSha256Hex: toHex(m.plainSha256),
        records: m.records.map((r) => ({
          idHex: toHex(r.id),
          plainLen: r.plainLen,
        })),
      },
    });
  };
  ok(
    "empty-file",
    "An empty file: no records, plainSize 0, the SHA-256 of nothing.",
    {
      plainSize: 0,
      plainSha256: new Uint8Array(createHash("sha256").digest()),
      records: [],
    },
  );
  ok("one-chunk", "One record: 64 + 48 = 112 bytes.", {
    plainSize: 5,
    plainSha256: MF_SHA,
    records: [{ id: mid("a"), plainLen: 5 }],
  });
  ok(
    "repeated-id",
    "Three records, one id twice: file order, duplicates allowed (content repeats).",
    good,
  );
  const base = refEncodeManifest(good);
  const bad = (
    id: string,
    description: string,
    reason: string,
    edit: (b: Uint8Array) => Uint8Array,
  ) => {
    const bytes = edit(new Uint8Array(base));
    const p = refParseManifest(bytes);
    if (p.ok || p.reason !== reason)
      throw new Error(
        `syncVectors manifest ${id}: reference says ${p.ok ? "ok" : p.reason}`,
      );
    rows.push({
      id,
      description,
      manifestHex: toHex(bytes),
      expect: { result: "invalid", reason },
    });
  };
  const set = (at: number, v: number[]) => (b: Uint8Array) => {
    b.set(v, at);
    return b;
  };
  const hi = (at: number, v: number[]) => (b: Uint8Array) => set(at, v)(b);
  bad("refuse-shape", "Shorter than the 64-byte header.", "shape", (b) =>
    b.subarray(0, 63),
  );
  bad("refuse-magic", "The magic is not PKSYNCCH.", "magic", set(0, [0x58]));
  bad("refuse-version", "version 2.", "version", set(8, [2]));
  bad("refuse-record-size", "recordSize 64.", "recordSize", set(10, [64]));
  bad("refuse-flags", "Header flags are not zero.", "flags", set(12, [1]));
  bad(
    "refuse-reserved",
    "Header reserved is not zero.",
    "reserved",
    set(20, [1]),
  );
  bad(
    "refuse-count",
    "chunkCount 16,385 (over SYNC_MAX_CHUNKS_PER_FILE), checked before the length.",
    "count",
    set(16, [0x01, 0x40, 0, 0]),
  );
  bad("refuse-length-short", "A record is missing.", "length", (b) =>
    b.subarray(0, b.length - 48),
  );
  bad(
    "refuse-length-long",
    "A trailing byte.",
    "length",
    (b) => new Uint8Array([...b, 0]),
  );
  bad(
    "refuse-plain-size-over-cap",
    "plainSize 1 GiB + 1.",
    "size",
    set(24, [1, 0, 0, 0x40, 0, 0, 0, 0]),
  );
  bad(
    "refuse-record-flags",
    "A record's flags are not zero.",
    "record",
    set(64 + 48 + 36, [1]),
  );
  bad(
    "refuse-record-reserved",
    "A record's reserved is not zero.",
    "record",
    set(64 + 40, [1]),
  );
  bad(
    "refuse-chunk-len-zero",
    "A record of length 0.",
    "chunkLen",
    set(64 + 32, [0, 0, 0, 0]),
  );
  bad(
    "refuse-chunk-len-over-max",
    "A record over 1 MiB.",
    "chunkLen",
    set(64 + 32, [1, 0, 0x10, 0]),
  );
  bad(
    "refuse-size-sum",
    "The records do not add up to plainSize.",
    "size",
    set(24, [0x41]),
  );
  bad(
    "order-magic-before-version",
    "Bad magic and bad version: magic.",
    "magic",
    (b) => hi(8, [9])(set(0, [0])(b)),
  );
  bad(
    "order-flags-before-count",
    "Bad flags and a short body: flags comes first.",
    "flags",
    (b) => set(12, [1])(b.subarray(0, 100)),
  );
  bad(
    "order-count-before-length",
    "Count over the cap and a short body: count.",
    "count",
    (b) => set(16, [0x01, 0x40, 0, 0])(b.subarray(0, 100)),
  );
  bad(
    "order-record-before-chunk-len",
    "A bad flag in record 2 and a zero length in record 1: record 1 is checked first, so chunkLen.",
    "chunkLen",
    (b) => set(64 + 48 + 36, [1])(set(64 + 32, [0, 0, 0, 0])(b)),
  );
  bad(
    "order-chunk-len-before-size",
    "A zero length also breaks the sum: chunkLen.",
    "chunkLen",
    set(64 + 32, [0, 0, 0, 0]),
  );
  return rows;
}

// ── Canonical JSON (§13.10.3): the input of a blinded element name ──────────────────────────

interface CanonicalJsonCase {
  id: string;
  description: string;
  /** JSON text. A runner reads every number as an IEEE double (Python: parse_int=float). */
  inputJson?: string;
  /** A number JSON text cannot spell. */
  special?: "NaN" | "Infinity" | "-Infinity";
  expect: { result: "ok"; canonical: string } | { result: "invalid" };
}

const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// The oracle is the engine's own JSON.stringify, with the two refusals the contract adds.
function oracleCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(oracleCanonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${oracleCanonical(k)}:${oracleCanonical(o[k])}`)
      .join(",")}}`;
  }
  if (typeof v === "number" && !Number.isFinite(v))
    throw new RangeError("not finite");
  if (typeof v === "string" && LONE_SURROGATE.test(v))
    throw new RangeError("lone surrogate");
  return JSON.stringify(v);
}

function buildCanonicalJsonCases(): CanonicalJsonCase[] {
  const rows: CanonicalJsonCase[] = [];
  const ok = (
    id: string,
    description: string,
    inputJson: string,
    canonical: string,
  ) => {
    const got = oracleCanonical(JSON.parse(inputJson));
    if (got !== canonical)
      throw new Error(`syncVectors canonicalJson ${id}: oracle says ${got}`);
    rows.push({
      id,
      description,
      inputJson,
      expect: { result: "ok", canonical },
    });
  };
  const bad = (id: string, description: string, inputJson: string) => {
    let threw = false;
    try {
      oracleCanonical(JSON.parse(inputJson));
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`syncVectors canonicalJson ${id}: not refused`);
    rows.push({ id, description, inputJson, expect: { result: "invalid" } });
  };
  const special = (
    id: string,
    description: string,
    s: "NaN" | "Infinity" | "-Infinity",
  ) =>
    rows.push({ id, description, special: s, expect: { result: "invalid" } });

  ok("int", "Integers print as digits.", "[0,1,-1,42,100]", "[0,1,-1,42,100]");
  ok(
    "float",
    "Shortest round-trip digits.",
    "[0.1,1.5,0.30000000000000004]",
    "[0.1,1.5,0.30000000000000004]",
  );
  ok(
    "integral-float",
    "An integral float is an integer.",
    "[2.0,100.0,-3.0]",
    "[2,100,-3]",
  );
  ok("negative-zero", "-0 prints 0.", "[-0,-0.0]", "[0,0]");
  ok(
    "exp-small-1e-5",
    "1e-5 is decimal: 0.00001 (Python repr says 1e-05).",
    "1e-5",
    "0.00001",
  );
  ok(
    "exp-boundary-1e-6",
    "1e-6 is the smallest decimal spelling.",
    "1e-6",
    "0.000001",
  );
  ok(
    "exp-small-1e-7",
    "Below 1e-6 the exponent has no padding: 1e-7.",
    "1e-7",
    "1e-7",
  );
  ok(
    "exp-small-mantissa",
    "A mantissa with digits: 1.5e-7.",
    "1.5e-7",
    "1.5e-7",
  );
  ok(
    "exp-small-negative",
    "A negative number keeps its sign.",
    "-1e-7",
    "-1e-7",
  );
  ok("exp-min-denormal", "The smallest double.", "5e-324", "5e-324");
  ok(
    "integral-2-pow-53",
    "2**53 is exact.",
    "9007199254740992",
    "9007199254740992",
  );
  ok(
    "integral-2-pow-53-plus-1",
    "9007199254740993 reads as the nearest double, 2**53.",
    "9007199254740993",
    "9007199254740992",
  );
  ok("integral-1e16", "1e16 prints in full.", "1e16", "10000000000000000");
  ok(
    "integral-2-pow-60",
    "2**60: the shortest digits padded with zeros, not the exact integer.",
    "1152921504606846976",
    "1152921504606847000",
  );
  ok(
    "integral-large-float",
    "123456789012345678901.0: shortest digits, zero padded.",
    "123456789012345678901.0",
    "123456789012345680000",
  );
  ok(
    "integral-exponent-spelling",
    "The same value spelled with an exponent.",
    "1.2345678901234568e20",
    "123456789012345680000",
  );
  ok(
    "exp-large-1e21",
    "From 1e21 the exponent form carries a plus sign.",
    "1e21",
    "1e+21",
  );
  ok(
    "exp-large-mantissa",
    "1.5e21 keeps its mantissa digits.",
    "1.5e21",
    "1.5e+21",
  );
  ok("exp-large-1e300", "1e300.", "1e300", "1e+300");
  ok(
    "exp-max-double",
    "The largest double.",
    "1.7976931348623157e308",
    "1.7976931348623157e+308",
  );
  ok(
    "keys-sorted",
    "Keys sort at every level.",
    '{"b":1,"a":{"d":[{"z":1,"y":2}],"c":2}}',
    '{"a":{"c":2,"d":[{"y":2,"z":1}]},"b":1}',
  );
  ok(
    "keys-utf16-order",
    "Keys sort by UTF-16 code unit: U+1F600 (D83D DE00) sorts before U+FFFF.",
    '{"\\uffff":1,"\\ud83d\\ude00":2,"a":3}',
    '{"a":3,"\u{1F600}":2,"￿":1}',
  );
  ok(
    "string-escapes",
    "Only quote, backslash and C0 controls are escaped (lowercase hex); DEL, U+2028 and non-ASCII stay raw.",
    '"\\u0000\\u001f\\u007f\\u2028\\"\\\\/\\b\\f\\n\\r\\t\\u00e9"',
    '"\\u0000\\u001f\u007f \\"\\\\/\\b\\f\\n\\r\\té"',
  );
  ok(
    "literals",
    "true, false, null, an empty array and an empty object.",
    "[true,false,null,[],{}]",
    "[true,false,null,[],{}]",
  );
  special("refuse-nan", "NaN is refused (not null).", "NaN");
  special("refuse-infinity", "Infinity is refused.", "Infinity");
  special("refuse-negative-infinity", "-Infinity is refused.", "-Infinity");
  bad(
    "refuse-lone-high-surrogate",
    "A lone high surrogate in a string is refused.",
    '["\\ud800"]',
  );
  bad(
    "refuse-lone-low-surrogate",
    "A lone low surrogate in a string is refused.",
    '"a\\udc00b"',
  );
  bad(
    "refuse-lone-surrogate-key",
    "A lone surrogate in a key is refused.",
    '{"\\ud800":1}',
  );
  return rows;
}

export function buildSyncVectors(): unknown {
  return {
    syncVectorsVersion: 1,
    description:
      "Cloud Sync end-to-end encryption known answers (WIRE-CONTRACT-V5 section 13.10, section 13.8.1; plans/CC-01-cloud-sync.md section 2.4). A client table, inert to an SDK that has not implemented sync.e2e: a runner reads the named sections it implements. Every row is recomputed by the generator through an independent reference over node:crypto. hkdfCases: HKDF-SHA256 with the exact ikm, salt, info and length, anchored by RFC 5869 appendix A; the label field names the derivation and the info bytes are shown in hex because several labels end in a NUL. envelopeCases: pkey-sync-value/1; a runner opens envelopeHex under rootHex, collection, name and aliases and expects `expect`, and for rows with a `seal` member also seals value with that salt and expects the same bytes (canonical JSON with sorted keys, UTF-8, padded 0x80 then zeros to a multiple of 64, always at least one byte); the invalid reasons are shape, version, kid, auth, padding, json and name, in the order a reader checks them. blindCases: blind(kind, ctx, n). transferPlanCases: the upload mode, partBytes and part count from the stored size and the collection's files.delta. hpkeAnchor: the RFC 9180 vector for pkey-sync-wrap/1 (enc, shared_secret, key, base_nonce and ciphertext). wrapCases: pkey-sync-wrap/1; a runner unwraps wrap (kem as an integer, enc and ct in hex) for recipientPrivateHex under product, deviceId, ringId and epoch with kidHex as aad and expects expectRootHex (null is a refusal); a `seal` member also wraps rootHex to recipientPublicHex with the ephemeral private key and expects the same enc and ct, and infoHex is the exact HPKE info. recoveryCodeCases: kind code (codeHex encodes to text, text parses to codeHex), kind parse (input parses to expectCodeHex or null) and kind blob (recovery.ct under K_rec; the same open/seal rule, with seal giving rootHex and nonceHex). The text is 8 hyphenated groups of 4 Crockford base32 characters over the code and the first 4 bytes of its SHA-256. adoptCases: the adopt blob (0x01, nonce, AES-256-GCM under K_adopt of currentRootHex, aad = pkey-sync/1 adopt, fromRingId, u32be(epoch), kid); expectRootHex is the adopted root or null. cdcCases: fastcdc-2016-nc1 (xorshift32 gear table from seed 0x9e3779b9; the hash starts at 0 at offset min of each chunk): a runner builds the input (stream: SHA-256(UTF-8 of `pkey-sync vector cdc ` + label, u32be counter) blocks cut to length; byte: length copies of value), cuts it with avg (min = avg/4, max = avg*4) and expects the chunk lengths in lens. chunkCases: kind id (the E2E id is HMAC-SHA256(K_cid(collection), chunk) and the server id SHA-256(chunk), both lowercase hex) and kind object (pkey-sync-chunk/1 under the 32 raw id bytes, 0x01 codec nonce(12) then the sealed body, the nonce being HMAC-SHA256(K_chunk, 0x01 codec body)[0:12]: open and expect; a `seal` member also seals bodyHex with that codec and expects objectHex; the invalid reasons are shape, version, codec, auth, nonce, decode, size and id in the order a reader checks; the codec 1 frames here are raw-block zstd frames); kind pair (one id sealed with codec 0 and codec 1: both objects open to plainHex and their nonces, bytes 2 to 14, differ)). manifestCases: pkey-sync-chunks/1 parse (ok rows are also re-encoded to the same bytes); the invalid reasons are shape, magic, version, recordSize, flags, reserved, count, length, size, record, chunkLen and a final size for the sum, first violation wins. canonicalJsonCases: canonical JSON, the input of a blinded element name: a runner parses inputJson with every number an IEEE double (Python: parse_int=float), or builds the number named by special, canonicalises it and expects canonical, or a refusal (invalid) for a number that is not finite and a string or key with a lone surrogate. Numbers print per ECMAScript Number::toString. Append-only: a new row or section keeps syncVectorsVersion; a changed row or rule bumps it.",
    constants: {
      envelopeOverheadBytes: REF_E2E_OVERHEAD,
      envelopeFixedBytes: REF_ENVELOPE_FIXED,
      paddingBlockBytes: REF_PAD_BLOCK,
    },
    ringId: RING_ID,
    hkdfCases: buildHkdfCases(),
    envelopeCases: buildEnvelopeCases(),
    blindCases: buildBlindCases(),
    transferPlanCases: buildTransferPlanCases(),
    hpkeAnchor: buildHpkeAnchor(),
    wrapCases: buildWrapCases(),
    recoveryCodeCases: buildRecoveryCodeCases(),
    adoptCases: buildAdoptCases(),
    cdcCases: buildCdcCases(),
    chunkCases: buildChunkCases(),
    manifestCases: buildManifestCases(),
    canonicalJsonCases: buildCanonicalJsonCases(),
  };
}
