// `sync-vectors.json`: Cloud Sync end-to-end encryption known answers (WIRE-CONTRACT-V5 §13.10,
// §13.8.1; plans/CC-01-cloud-sync.md §2.4). `syncVectorsVersion` 1.
//
// Slice U-34.6 adds `cdcEditCases` and `deltaCases`. Slice U-34.4 adds `fileStreamCases`. Slice U-34.3 adds `cdcCases`, `chunkCases` and `manifestCases`.
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
  refMemberName,
  refOpenRecord,
  refRecordName,
  type RefRecordWire,
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
  REF_FILE,
  refFilePlainSize,
  refOpenFile,
  refOpenFileRange,
  refSealFile,
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
  /**
   * Present on a record row (U-09): the blinded names the envelope arrived under. `name` stays
   * the `k` the reader expects, so a runner that opens by `name` still gets every verdict; a
   * runner for records opens without a name, splits `k`, recomputes the blinded forms and
   * compares them (`ok` rows pass, a swapped row is `invalid` with reason `name`).
   */
  record?: RefRecordWire;
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
  extra: { expectLen?: number; record?: RefRecordWire } = {},
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
    ...(extra.record === undefined ? {} : { record: extra.record }),
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
  over: Partial<
    Pick<EnvelopeCase, "name" | "aliases" | "collection" | "record">
  > = {},
): EnvelopeCase {
  const env = edit(new Uint8Array(fromHex(base.envelopeHex)));
  return {
    id,
    description,
    rootHex: base.rootHex,
    collection: over.collection ?? base.collection,
    name: over.name ?? base.name,
    aliases: over.aliases ?? [],
    ...(over.record === undefined ? {} : { record: over.record }),
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
  // A merge member's `k` is `setting ‖ U+0000 ‖ member`; an open key's `k` is the key (§13.10.4).
  const member = sealRow(
    "seal-member",
    "A merge member: k is the setting, U+0000, then the member name ('inventory' and 'gold').",
    "$settings",
    refMemberName("inventory", "gold"),
    3,
    "m",
  );
  rows.push(
    member,
    sealRow(
      "seal-open-key",
      "An open key: k is the key itself, as the host names it.",
      "$settings",
      "notes/draft",
      "hello",
      "o",
    ),
    mutate(
      member,
      "member-swapped",
      "Another member of the same setting: authentic, but k names 'gold' and the reader expects 'silver', so a server cannot swap members.",
      env,
      "name",
      { name: refMemberName("inventory", "silver") },
    ),
    mutate(
      member,
      "member-wrong-setting",
      "The same member under another merge setting: k names 'inventory' and the reader expects 'equipment', so a server cannot move a member between settings.",
      env,
      "name",
      { name: refMemberName("equipment", "gold") },
    ),
    mutate(
      member,
      "member-name-only",
      "A reader that binds the member name alone refuses: k carries the setting too.",
      env,
      "name",
      { name: "gold" },
    ),
  );
  rows.push(...buildRecordEnvelopeCases());
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
    const want = r.expect;
    // A record row is read both ways: by the name it expects, and by the recompute-and-compare
    // rule over its blinded wire names (§13.10.4). Both must give the row's verdict.
    const readings = [
      refOpenValue(
        fromHex(r.rootHex),
        r.collection,
        r.name,
        r.aliases,
        fromHex(r.envelopeHex),
      ),
      ...(r.record === undefined
        ? []
        : [
            refOpenRecord(
              fromHex(r.rootHex),
              r.collection,
              r.record,
              fromHex(r.envelopeHex),
            ),
          ]),
    ];
    for (const got of readings) {
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
  }
  return rows;
}

/**
 * The record names of G4 / D1 (§13.10.4, U-09): a value's `k` is the record id, a `merge` field's
 * is `id ‖ U+0000 ‖ field`, a `union` element's is `id ‖ U+0000 ‖ canonicalJson(e)`. All records
 * of a collection share `K_coll(c)`, so only `k` stops the server placing one record's envelope
 * under another's blinded id, field or element. Each swapped row is authentic: the envelope is a
 * real one for another name, so the only thing that refuses it is the recomputed blinded name.
 */
function buildRecordEnvelopeCases(): EnvelopeCase[] {
  const C = "saves";
  const kn = refKNames(ROOT);
  const bl = (kind: "record" | "field" | "element", n: string): string =>
    refBlind(kn, kind, C, n);
  const valueWire = (id: string): RefRecordWire => ({
    kind: "value",
    id: bl("record", id),
  });
  const fieldWire = (id: string, field: string): RefRecordWire => ({
    kind: "field",
    id: bl("record", id),
    name: bl("field", field),
  });
  const elementWire = (id: string, e: unknown): RefRecordWire => ({
    kind: "element",
    id: bl("record", id),
    name: bl("element", refCanonicalJson(e)),
  });
  const swap = (
    base: EnvelopeCase,
    id: string,
    description: string,
    expectName: string,
    record: RefRecordWire,
  ): EnvelopeCase =>
    mutate(base, id, description, (b) => b, "name", {
      name: expectName,
      record,
    });

  const value = sealRow(
    "seal-record-value",
    "A record's value: k is the record id ('slot-1').",
    C,
    "slot-1",
    { hp: 10, gold: 3 },
    "r1",
    { record: valueWire("slot-1") },
  );
  const field = sealRow(
    "seal-record-field",
    "A merge record's field: k is the record id, U+0000, then the field name ('slot-1' and 'hp').",
    C,
    refRecordName("slot-1", "hp"),
    10,
    "r2",
    { record: fieldWire("slot-1", "hp") },
  );
  // Written with unsorted keys on purpose: k holds the canonical JSON, whatever order e was built in.
  const e1 = { tag: "a", id: 7 };
  const e2 = "shield";
  const element = sealRow(
    "seal-record-element",
    'A union record\'s element: k is the record id, U+0000, then canonicalJson(e) (here {"id":7,"tag":"a"}); v is the element.',
    C,
    refRecordName("slot-1", refCanonicalJson(e1)),
    e1,
    "r3",
    { record: elementWire("slot-1", e1) },
  );
  const fieldSeven = sealRow(
    "seal-record-field-seven",
    "A merge record's field named '7' holding 7: k = 'slot-1' U+0000 '7', whose name part is also canonicalJson(v).",
    C,
    refRecordName("slot-1", "7"),
    7,
    "r4",
    { record: fieldWire("slot-1", "7") },
  );
  // Sealed here only to be refused: the envelopes below are authentic, and each is read under
  // wire names that agree with its k.
  const elementShield = sealRow(
    "seal-record-element-shield",
    "An element cell whose k names 'shield' and whose v is 'sword'.",
    C,
    refRecordName("slot-1", refCanonicalJson(e2)),
    "sword",
    "r5",
  );
  // An element sealed by a writer that did not canonicalise: the name part of k is the text as
  // the writer spelled it, keys unsorted.
  const looseName = '{"tag":"a","id":7}';
  const elementLoose = sealRow(
    "seal-record-element-noncanonical",
    "An element cell sealed under a k whose name part is not canonical JSON.",
    C,
    refRecordName("slot-1", looseName),
    e1,
    "r6",
  );
  return [
    value,
    swap(
      value,
      "record-value-swapped-id",
      "The envelope of record 'slot-1' served under the blinded id of 'slot-2': authentic, but the id recomputed from k is not the one on the wire, so a server cannot place a value under another record.",
      "slot-2",
      valueWire("slot-2"),
    ),
    swap(
      value,
      "record-value-served-as-field",
      "A record's value envelope (k = 'slot-1') served as the field 'hp' of that record: k holds no U+0000 to split, so it is refused.",
      refRecordName("slot-1", "hp"),
      fieldWire("slot-1", "hp"),
    ),
    field,
    swap(
      field,
      "record-field-swapped-id",
      "The field 'hp' of 'slot-1' served as the field 'hp' of 'slot-2': the field name is right, the record id is not.",
      refRecordName("slot-2", "hp"),
      fieldWire("slot-2", "hp"),
    ),
    swap(
      field,
      "record-field-swapped-field",
      "The field 'hp' of 'slot-1' served as the field 'mp' of the same record: the id is right, the field is not, so a server cannot swap fields within a record.",
      refRecordName("slot-1", "mp"),
      fieldWire("slot-1", "mp"),
    ),
    swap(
      field,
      "record-field-served-as-value",
      "A field envelope (k = 'slot-1' U+0000 'hp') served as the value of 'slot-1': the whole k is not the record id.",
      "slot-1",
      valueWire("slot-1"),
    ),
    element,
    swap(
      element,
      "record-element-swapped-id",
      "The element of 'slot-1' served under the blinded id of 'slot-2'.",
      refRecordName("slot-2", refCanonicalJson(e1)),
      elementWire("slot-2", e1),
    ),
    swap(
      element,
      "record-element-swapped-element",
      "The element {id:7,tag:'a'} of 'slot-1' served as the blinded element 'shield' of the same record: a server cannot swap elements within a record.",
      refRecordName("slot-1", refCanonicalJson(e2)),
      elementWire("slot-1", e2),
    ),
    // The container fixes the kind (U-09 security review). `name` on these rows is the k the host
    // expected at that wire position, so a reader that opens by name refuses them as well.
    fieldSeven,
    swap(
      fieldSeven,
      "record-field-served-as-element",
      "The field cell '7' of 'slot-1' (k = 'slot-1' U+0000 '7', v = 7) served in the elements of that record: its k even names canonicalJson(v), but the wire name is a blinded field, not the blinded element '7', so the container's kind refuses it. The host expected the element 'shield' there.",
      refRecordName("slot-1", refCanonicalJson(e2)),
      { kind: "element", id: bl("record", "slot-1"), name: bl("field", "7") },
    ),
    swap(
      element,
      "record-element-served-as-field",
      "The element cell of 'slot-1' served in the fields of that record: the wire name is a blinded element, not the blinded field with that text, so the container's kind refuses it. The host expected the field 'hp' there.",
      refRecordName("slot-1", "hp"),
      {
        kind: "field",
        id: bl("record", "slot-1"),
        name: bl("element", refCanonicalJson(e1)),
      },
    ),
    swap(
      elementShield,
      "record-element-value-not-name",
      "An element cell whose k names 'shield' but whose v is 'sword', with the blinded element 'shield' on the wire: the blinded names agree, but canonicalJson(v) is not the name part of k, so it is refused. The host expected the element 'sword'.",
      refRecordName("slot-1", refCanonicalJson("sword")),
      elementWire("slot-1", e2),
    ),
    swap(
      elementLoose,
      "record-element-noncanonical-name",
      'An element cell whose k carries the element as {"tag":"a","id":7}, not in canonical JSON, with the blinded form of that text on the wire: the blinded names agree, but canonicalJson(v) is not the name part of k, so it is refused. The host expected the canonical {"id":7,"tag":"a"}.',
      refRecordName("slot-1", refCanonicalJson(e1)),
      {
        kind: "element",
        id: bl("record", "slot-1"),
        name: bl("element", '{"tag":"a","id":7}'),
      },
    ),
  ];
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

// ── pkey-sync-file/1 (§13.10.4) ──────────────────────────────────────────────────────────────

const FILE_ROOT = mat("file root");
const FILE_COLL = "saves";
const FILE_SEG = REF_FILE.segmentBytes;
const FILE_STRIDE = FILE_SEG + REF_FILE.tag;

const sha256Hex = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

/** The plaintext of a seal row: SHA-256 blocks of the label and a counter, cut to length. */
const filePlain = (label: string, length: number): Uint8Array =>
  refStream(`pkey-sync vector file ${label}`, length);
const fileSalt = (label: string): Uint8Array => mat(`file salt ${label}`);

type FileOp =
  | { op: "truncate"; length: number }
  | { op: "dropSegment"; index: number }
  | { op: "swapSegments"; a: number; b: number }
  | { op: "appendSegment"; from: number }
  | { op: "xor"; offset: number; value: number }
  | { op: "setHex"; offset: number; hex: string }
  | { op: "appendHex"; hex: string };

/** Applies `ops` in order. Segment `i` is at 64 + i * (1 MiB + 16) and ends at the next one. */
function applyFileOps(stream: Uint8Array, ops: FileOp[]): Uint8Array {
  let b: Uint8Array = Uint8Array.from(stream);
  const seg = (s: Uint8Array, i: number): [number, number] => {
    const a = 64 + i * FILE_STRIDE;
    return [a, Math.min(s.length, a + FILE_STRIDE)];
  };
  for (const o of ops) {
    if (o.op === "truncate") b = b.slice(0, o.length);
    else if (o.op === "dropSegment") {
      const [x, y] = seg(b, o.index);
      b = cat(b.subarray(0, x), b.subarray(y));
    } else if (o.op === "swapSegments") {
      const [lo, hi] = o.a < o.b ? [o.a, o.b] : [o.b, o.a];
      const [x1, y1] = seg(b, lo);
      const [x2, y2] = seg(b, hi);
      b = cat(
        b.subarray(0, x1),
        b.subarray(x2, y2),
        b.subarray(y1, x2),
        b.subarray(x1, y1),
        b.subarray(y2),
      );
    } else if (o.op === "appendSegment") {
      const [x, y] = seg(b, o.from);
      b = cat(b, b.subarray(x, y));
    } else if (o.op === "xor") b[o.offset] = b[o.offset]! ^ o.value;
    else if (o.op === "setHex") b.set(fromHex(o.hex), o.offset);
    else b = cat(b, fromHex(o.hex));
  }
  return b;
}

function buildFileStreamCases(): unknown[] {
  const rows: unknown[] = [];
  const kid = refKid(FILE_ROOT);
  const base = { rootHex: toHex(FILE_ROOT), collection: FILE_COLL };
  const seals: Array<[string, string, string, number]> = [
    [
      "seal-empty",
      "empty",
      "An empty file is one empty last segment: the header and a 16-byte tag.",
      0,
    ],
    ["seal-one-byte", "one", "One byte: one last segment.", 1],
    [
      "seal-segment-minus-one",
      "segm1",
      "1 MiB - 1: one short last segment.",
      FILE_SEG - 1,
    ],
    [
      "seal-segment-exact",
      "seg",
      "Exactly 1 MiB: one full segment that is the last; no empty segment follows.",
      FILE_SEG,
    ],
    [
      "seal-segment-plus-one",
      "segp1",
      "1 MiB + 1: a full segment (flag 0, counter 0) and a one-byte last segment (flag 1, counter 1).",
      FILE_SEG + 1,
    ],
    [
      "seal-two-segments-exact",
      "two",
      "Exactly 2 MiB: two full segments, only the second last.",
      2 * FILE_SEG,
    ],
    [
      "seal-three-segments",
      "three",
      "2.5 MiB: two full segments and a half-size last.",
      2 * FILE_SEG + FILE_SEG / 2,
    ],
  ];
  const sealed = new Map<string, Uint8Array>();
  const plains = new Map<string, Uint8Array>();
  for (const [id, label, description, length] of seals) {
    const salt = fileSalt(label);
    const plain = filePlain(label, length);
    const stream = refSealFile(FILE_ROOT, FILE_COLL, salt, plain);
    const back = refOpenFile(FILE_ROOT, FILE_COLL, kid, stream);
    if (!back.ok || toHex(back.plain) !== toHex(plain))
      throw new Error(`syncVectors file ${id}: reference disagrees`);
    sealed.set(id, stream);
    plains.set(id, plain);
    rows.push({
      id,
      description,
      kind: "seal",
      ...base,
      saltHex: toHex(salt),
      plain: { label, length },
      expect: {
        sealedSize: stream.length,
        headerHex: toHex(stream.subarray(0, 64)),
        sealedSha256Hex: sha256Hex(stream),
        plainSha256Hex: sha256Hex(plain),
        ...(stream.length <= 256 ? { sealedHex: toHex(stream) } : {}),
      },
    });
  }

  rows.push({
    id: "sizes",
    description:
      "plainSize -> sealedSize = 64 + plainSize + 16 * max(1, ceil(plainSize / 1 MiB)); a sealed size no stream has maps to null.",
    kind: "sizes",
    plainToSealed: [
      0,
      1,
      FILE_SEG - 1,
      FILE_SEG,
      FILE_SEG + 1,
      2 * FILE_SEG,
      1024 * FILE_SEG,
    ].map((p) => [p, 64 + p + 16 * Math.max(1, Math.ceil(p / FILE_SEG))]),
    sealedToPlain: (
      [
        [64 + 16, 0],
        [64 + 17, 1],
        [64 + FILE_STRIDE, FILE_SEG],
        [64 + FILE_STRIDE + 17, FILE_SEG + 1],
        [0, null],
        [63, null],
        [64, null],
        [64 + 15, null],
        [64 + FILE_STRIDE + 16, null],
        [64 + FILE_STRIDE + 5, null],
      ] as Array<[number, number | null]>
    ).map(([sz, want]) => {
      if (refFilePlainSize(sz) !== want)
        throw new Error(`syncVectors file sizes ${sz}: reference disagrees`);
      return [sz, want];
    }),
  });

  const open = (
    id: string,
    description: string,
    baseId: string,
    mutate: FileOp[],
    reason: string | null,
    over: { collection?: string; expectKidHex?: string } = {},
  ) => {
    const stream = applyFileOps(sealed.get(baseId)!, mutate);
    const got = refOpenFile(
      FILE_ROOT,
      over.collection ?? FILE_COLL,
      over.expectKidHex === undefined ? kid : fromHex(over.expectKidHex),
      stream,
    );
    const ok = reason === null ? got.ok : !got.ok && got.reason === reason;
    if (!ok) throw new Error(`syncVectors file ${id}: reference disagrees`);
    rows.push({
      id,
      description,
      kind: "open",
      base: baseId,
      mutate,
      ...(over.collection === undefined
        ? {}
        : { openCollection: over.collection }),
      ...(over.expectKidHex === undefined
        ? {}
        : { expectKidHex: over.expectKidHex }),
      expect:
        reason === null
          ? { result: "ok", plainSha256Hex: sha256Hex(plains.get(baseId)!) }
          : { result: "invalid", reason },
    });
  };
  for (const [id] of seals)
    open(`open-${id.slice(5)}`, `Opens ${id}.`, id, [], null);

  const b3 = "seal-three-segments";
  const b2 = "seal-two-segments-exact";
  const b1 = "seal-segment-plus-one";
  open(
    "refuse-truncated-at-boundary",
    "The last segment dropped: the new final segment was sealed with last = 0, so its tag fails as the last.",
    b3,
    [{ op: "dropSegment", index: 2 }],
    "auth",
  );
  open(
    "refuse-truncated-mid-segment",
    "The stream cut inside the last segment.",
    b3,
    [{ op: "truncate", length: 64 + 2 * FILE_STRIDE + 100 }],
    "auth",
  );
  open(
    "refuse-truncated-to-header",
    "Only the header remains: no segment at all.",
    b3,
    [{ op: "truncate", length: 64 }],
    "shape",
  );
  open(
    "refuse-truncated-header",
    "Fewer than 64 bytes.",
    b3,
    [{ op: "truncate", length: 63 }],
    "shape",
  );
  open(
    "refuse-truncated-in-tag",
    "A tail shorter than a tag.",
    b1,
    [{ op: "truncate", length: 64 + FILE_STRIDE + 7 }],
    "shape",
  );
  open(
    "refuse-reordered",
    "The two full segments swapped: each was sealed under its own counter.",
    b2,
    [{ op: "swapSegments", a: 0, b: 1 }],
    "auth",
  );
  open(
    "refuse-reordered-with-last",
    "The first and the last segment swapped (the stream length changes too).",
    b3,
    [{ op: "swapSegments", a: 0, b: 2 }],
    "auth",
  );
  open(
    "refuse-duplicated-segment",
    "A full segment appended after the last: the old last now fails as a non-last.",
    b2,
    [{ op: "appendSegment", from: 0 }],
    "auth",
  );
  open(
    "refuse-dropped-first-segment",
    "The first segment removed: the rest are one counter short.",
    b3,
    [{ op: "dropSegment", index: 0 }],
    "auth",
  );
  open(
    "refuse-empty-trailing-segment",
    "An empty last segment after a full one is refused before any tag is tried: only the empty file has one.",
    b1,
    [
      { op: "truncate", length: 64 + FILE_STRIDE },
      { op: "appendHex", hex: "00".repeat(16) },
    ],
    "size",
  );
  open(
    "refuse-last-flag-missing",
    "The first segment of a two-segment file standing alone: it was sealed with last = 0, so it fails as a last segment.",
    b2,
    [{ op: "truncate", length: 64 + FILE_STRIDE }],
    "auth",
  );
  open(
    "refuse-tampered-ciphertext",
    "One bit flipped in the first segment.",
    b2,
    [{ op: "xor", offset: 64 + 100, value: 1 }],
    "auth",
  );
  open(
    "refuse-tampered-tag",
    "One bit flipped in the last tag.",
    b3,
    [{ op: "xor", offset: sealed.get(b3)!.length - 1, value: 1 }],
    "auth",
  );
  open(
    "refuse-tampered-header-salt",
    "A flipped salt byte changes K_file, so every segment fails.",
    b1,
    [{ op: "xor", offset: 40, value: 1 }],
    "auth",
  );
  open(
    "refuse-wrong-collection",
    "Opened under another collection's K_coll.",
    b1,
    [],
    "auth",
    { collection: "other" },
  );
  open(
    "refuse-bad-magic",
    "The magic is not PKSYNCF1.",
    b1,
    [{ op: "xor", offset: 0, value: 1 }],
    "magic",
  );
  open(
    "refuse-bad-version",
    "version u16 (little-endian) is 2.",
    b1,
    [{ op: "setHex", offset: 8, hex: "0200" }],
    "version",
  );
  open(
    "refuse-flags-set",
    "flags u16 is not 0: no flag is defined.",
    b1,
    [{ op: "setHex", offset: 10, hex: "0100" }],
    "flags",
  );
  open(
    "refuse-segment-size-smaller",
    "segmentBytes u32 (little-endian) is 64 KiB, not 1 MiB.",
    b1,
    [{ op: "setHex", offset: 12, hex: "00000100" }],
    "segmentSize",
  );
  open(
    "refuse-segment-size-big-endian",
    "segmentBytes written big-endian (00 10 00 00) reads as 4096 little-endian and is refused.",
    b1,
    [{ op: "setHex", offset: 12, hex: "00100000" }],
    "segmentSize",
  );
  open(
    "refuse-wrong-kid",
    "The header's kid is not the kid of the ring the reader holds.",
    b1,
    [],
    "kid",
    { expectKidHex: toHex(refKid(mat("another root"))) },
  );
  open(
    "refuse-header-kid-tampered",
    "A flipped kid byte in the header.",
    b1,
    [{ op: "xor", offset: 16, value: 1 }],
    "kid",
  );

  const range = (
    id: string,
    description: string,
    baseId: string,
    mutate: FileOp[],
    start: number,
    end: number,
  ) => {
    const stream = applyFileOps(sealed.get(baseId)!, mutate);
    const got = refOpenFileRange(FILE_ROOT, FILE_COLL, kid, stream, start, end);
    if (
      got.ok &&
      mutate.length === 0 &&
      toHex(got.plain) !== toHex(plains.get(baseId)!.subarray(start, end))
    )
      throw new Error(`syncVectors file ${id}: reference disagrees`);
    rows.push({
      id,
      description,
      kind: "range",
      base: baseId,
      mutate,
      start,
      end,
      expect: got.ok
        ? {
            result: "ok",
            length: end - start,
            sha256Hex: sha256Hex(got.plain),
            reads: got.reads,
          }
        : { result: "invalid", reason: got.reason },
    });
  };
  const all3 = 2 * FILE_SEG + FILE_SEG / 2;
  range(
    "range-first-bytes",
    "Bytes 0..100 read the header and segment 0 only.",
    b3,
    [],
    0,
    100,
  );
  range("range-empty", "start = end reads only the header.", b3, [], 5, 5);
  range(
    "range-inside-one-segment",
    "A range inside segment 1.",
    b3,
    [],
    FILE_SEG + 10,
    FILE_SEG + 4000,
  );
  range(
    "range-across-boundary",
    "A range across the segment 0 / 1 boundary reads two segments.",
    b3,
    [],
    FILE_SEG - 8,
    FILE_SEG + 8,
  );
  range(
    "range-ends-at-boundary",
    "end exactly at a boundary reads only segment 0.",
    b3,
    [],
    FILE_SEG - 100,
    FILE_SEG,
  );
  range(
    "range-starts-at-boundary",
    "start exactly at a boundary reads only segment 1.",
    b3,
    [],
    FILE_SEG,
    FILE_SEG + 100,
  );
  range(
    "range-last-segment",
    "The tail of a short last segment: its read length is its actual length.",
    b3,
    [],
    2 * FILE_SEG + 5,
    all3,
  );
  range(
    "range-whole-file",
    "The whole plaintext reads every segment.",
    b3,
    [],
    0,
    all3,
  );
  range(
    "range-exact-single-segment",
    "A file of exactly 1 MiB: segment 0 is the last.",
    "seal-segment-exact",
    [],
    10,
    FILE_SEG,
  );
  range(
    "range-empty-file",
    "The empty file has an empty range only.",
    "seal-empty",
    [],
    0,
    0,
  );
  range(
    "refuse-range-past-end",
    "end is past the plaintext size.",
    b3,
    [],
    0,
    all3 + 1,
  );
  range("refuse-range-inverted", "start is after end.", b3, [], 10, 5);
  range(
    "range-ignores-tampered-other-segment",
    "A flipped bit in segment 2 does not touch a range inside segment 0: only the segments read are authenticated.",
    b3,
    [{ op: "xor", offset: 64 + 2 * FILE_STRIDE + 3, value: 1 }],
    0,
    100,
  );
  range(
    "refuse-range-in-tampered-segment",
    "The same flip, with a range that reads segment 2.",
    b3,
    [{ op: "xor", offset: 64 + 2 * FILE_STRIDE + 3, value: 1 }],
    2 * FILE_SEG,
    2 * FILE_SEG + 10,
  );
  range(
    "refuse-range-truncated-stream",
    "A stream cut at a segment boundary has another size, so the size alone moves the last flag: a range in segment 1 now fails.",
    b3,
    [{ op: "dropSegment", index: 2 }],
    FILE_SEG,
    FILE_SEG + 10,
  );
  range(
    "refuse-range-impossible-size",
    "A stored size no stream has is refused before any read.",
    b1,
    [{ op: "truncate", length: 64 + FILE_STRIDE + 7 }],
    0,
    10,
  );
  return rows;
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

// ── Edit and delta cases (§13.8.3): what a new version of a file costs ───────────────────────

interface CdcEdit {
  op: "insert" | "delete" | "overwrite";
  at: number;
  length: number;
  /** The inserted or overwriting bytes: `refStream("pkey-sync vector cdc-edit " + label, length)`. */
  label: string;
}

function applyCdcEdit(base: Uint8Array, e: CdcEdit): Uint8Array {
  const fill = refStream(`pkey-sync vector cdc-edit ${e.label}`, e.length);
  const head = base.subarray(0, e.at);
  if (e.op === "insert") return cat(head, fill, base.subarray(e.at));
  if (e.op === "delete") return cat(head, base.subarray(e.at + e.length));
  return cat(head, fill, base.subarray(e.at + e.length));
}

interface CdcEditCase {
  id: string;
  description: string;
  avg: number;
  rootHex: string;
  collection: string;
  base: CdcInput;
  edit: CdcEdit;
  baseLens: number[];
  editedLens: number[];
  baseIdsHex: string[];
  editedIdsHex: string[];
  /** Indexes into the edited file whose id the base file already has. */
  keptIndexes: number[];
  /** Indexes into the edited file whose id the base file lacks. */
  changedIndexes: number[];
  baseManifestHex: string;
  editedManifestHex: string;
}

function chunkRecords(
  buf: Uint8Array,
  lens: number[],
): { id: Uint8Array; plainLen: number }[] {
  let at = 0;
  return lens.map((n) => {
    const id = refChunkId(CHUNK_ROOT, CHUNK_COLL, buf.subarray(at, at + n));
    at += n;
    return { id, plainLen: n };
  });
}

const manifestOf = (
  buf: Uint8Array,
  recs: { id: Uint8Array; plainLen: number }[],
): Uint8Array =>
  refEncodeManifest({
    plainSize: buf.length,
    plainSha256: new Uint8Array(createHash("sha256").update(buf).digest()),
    records: recs,
  });

function buildCdcEditCases(): CdcEditCase[] {
  const small = 2048;
  const baseSmall: CdcInput = {
    kind: "stream",
    label: "edit",
    length: 96 * 1024,
  };
  const realBase: CdcInput = {
    kind: "stream",
    label: "c",
    length: 6 * 1024 * 1024 + 12345,
  };
  const mk = (
    id: string,
    description: string,
    avg: number,
    base: CdcInput,
    edit: CdcEdit,
  ): CdcEditCase => {
    const a = cdcInput(base);
    const b = applyCdcEdit(a, edit);
    if (edit.op === "overwrite" && a.length !== b.length)
      throw new Error(`syncVectors ${id}: overwrite changed the length`);
    if (edit.op === "overwrite" && Buffer.compare(a, b) === 0)
      throw new Error(`syncVectors ${id}: the edit changed nothing`);
    const baseLens = refCdc(a, avg);
    const editedLens = refCdc(b, avg);
    const baseRecs = chunkRecords(a, baseLens);
    const editedRecs = chunkRecords(b, editedLens);
    const have = new Set(baseRecs.map((r) => toHex(r.id)));
    const keptIndexes: number[] = [];
    const changedIndexes: number[] = [];
    editedRecs.forEach((r, i) =>
      (have.has(toHex(r.id)) ? keptIndexes : changedIndexes).push(i),
    );
    if (changedIndexes.length === 0 && id !== "delete-end")
      throw new Error(`syncVectors ${id}: no chunk changed`);
    return {
      id,
      description,
      avg,
      rootHex: toHex(CHUNK_ROOT),
      collection: CHUNK_COLL,
      base,
      edit,
      baseLens,
      editedLens,
      baseIdsHex: baseRecs.map((r) => toHex(r.id)),
      editedIdsHex: editedRecs.map((r) => toHex(r.id)),
      keptIndexes,
      changedIndexes,
      baseManifestHex: toHex(manifestOf(a, baseRecs)),
      editedManifestHex: toHex(manifestOf(b, editedRecs)),
    };
  };
  const n = baseSmall.length;
  return [
    mk(
      "insert-start",
      "Insert 100 bytes at the start: the first chunk changes, the cut points resynchronise soon after and later chunks keep their ids.",
      small,
      baseSmall,
      { op: "insert", at: 0, length: 100, label: "i0" },
    ),
    mk("insert-middle", "Insert 100 bytes in the middle.", small, baseSmall, {
      op: "insert",
      at: n / 2,
      length: 100,
      label: "i1",
    }),
    mk(
      "insert-end",
      "Append 100 bytes: only the last chunk or two change.",
      small,
      baseSmall,
      { op: "insert", at: n, length: 100, label: "i2" },
    ),
    mk("delete-start", "Delete the first 100 bytes.", small, baseSmall, {
      op: "delete",
      at: 0,
      length: 100,
      label: "-",
    }),
    mk("delete-middle", "Delete 100 bytes from the middle.", small, baseSmall, {
      op: "delete",
      at: n / 2,
      length: 100,
      label: "-",
    }),
    mk("delete-end", "Truncate the last 100 bytes.", small, baseSmall, {
      op: "delete",
      at: n - 100,
      length: 100,
      label: "-",
    }),
    mk(
      "overwrite-start",
      "Overwrite 100 bytes at the start: the length is unchanged.",
      small,
      baseSmall,
      { op: "overwrite", at: 0, length: 100, label: "o0" },
    ),
    mk(
      "overwrite-middle",
      "Overwrite 100 bytes in the middle.",
      small,
      baseSmall,
      { op: "overwrite", at: n / 2, length: 100, label: "o1" },
    ),
    mk("overwrite-end", "Overwrite the last 100 bytes.", small, baseSmall, {
      op: "overwrite",
      at: n - 100,
      length: 100,
      label: "o2",
    }),
    mk("one-byte-middle", "One byte changes in the middle.", small, baseSmall, {
      op: "overwrite",
      at: n / 2 + 7,
      length: 1,
      label: "b1",
    }),
    mk(
      "append-5000",
      "Append 5000 bytes: every earlier chunk but the last keeps its id.",
      small,
      baseSmall,
      { op: "insert", at: n, length: 5000, label: "i3" },
    ),
    mk(
      "zeros-one-byte",
      "A file of identical max chunks (all zeros) shares one chunk id; changing one byte makes new ids for that chunk only.",
      1024,
      { kind: "byte", value: 0, length: 5 * 4096 },
      { op: "overwrite", at: 2 * 4096 + 9, length: 1, label: "z" },
    ),
    mk(
      "real-insert-middle",
      "Real parameters (avg 256 KiB): 100 bytes inserted in the middle of 6 MiB.",
      REF_CDC.avg,
      realBase,
      { op: "insert", at: 3 * 1024 * 1024, length: 100, label: "r1" },
    ),
    mk(
      "real-one-byte-end",
      "Real parameters: one byte changed near the end.",
      REF_CDC.avg,
      realBase,
      { op: "overwrite", at: 6 * 1024 * 1024, length: 1, label: "r2" },
    ),
  ];
}

type DeltaWant = { row: string; side: "base" | "edited" };
type DeltaSide = DeltaWant | { idsHex: string[] };

interface DeltaCase {
  id: string;
  description: string;
  have: DeltaSide;
  want: DeltaWant;
  /** The distinct chunk ids to move, in the order the wanted manifest first names them. */
  moveIdsHex: string[];
  moveBytes: number;
}

function buildDeltaCases(edits: CdcEditCase[]): DeltaCase[] {
  const byId = new Map(edits.map((e) => [e.id, e]));
  const recs = (w: DeltaWant) => {
    const e = byId.get(w.row)!;
    const lens = w.side === "base" ? e.baseLens : e.editedLens;
    const ids = w.side === "base" ? e.baseIdsHex : e.editedIdsHex;
    return ids.map((id, i) => ({ id, plainLen: lens[i]! }));
  };
  const rows: DeltaCase[] = [];
  const diff = (
    id: string,
    description: string,
    have: DeltaSide,
    want: DeltaWant,
  ) => {
    const haveIds = new Set(
      "idsHex" in have ? have.idsHex : recs(have).map((r) => r.id),
    );
    const move: string[] = [];
    let moveBytes = 0;
    for (const r of recs(want)) {
      if (haveIds.has(r.id) || move.includes(r.id)) continue;
      move.push(r.id);
      moveBytes += r.plainLen;
    }
    rows.push({ id, description, have, want, moveIdsHex: move, moveBytes });
  };
  for (const e of edits)
    diff(
      `upload-${e.id}`,
      "Upload of the edited version: the chunks the server holds from the base version are not sent.",
      { row: e.id, side: "base" },
      { row: e.id, side: "edited" },
    );
  diff(
    "download-rollback-insert-middle",
    "A device holding the edited version fetches only the base version's chunks it lacks.",
    { row: "insert-middle", side: "edited" },
    { row: "insert-middle", side: "base" },
  );
  diff(
    "upload-first-version",
    "No earlier version: every distinct chunk moves, once each.",
    { idsHex: [] },
    { row: "insert-middle", side: "base" },
  );
  diff(
    "upload-unchanged",
    "The same version again moves nothing.",
    { row: "insert-middle", side: "base" },
    { row: "insert-middle", side: "base" },
  );
  diff(
    "first-version-dedupes-within-file",
    "Identical chunks inside one file move once.",
    { idsHex: [] },
    { row: "zeros-one-byte", side: "base" },
  );
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
  const cdcEditCases = buildCdcEditCases();
  return {
    syncVectorsVersion: 1,
    description:
      "Cloud Sync end-to-end encryption known answers (WIRE-CONTRACT-V5 section 13.10, section 13.8.1; plans/CC-01-cloud-sync.md section 2.4). A client table, inert to an SDK that has not implemented sync.e2e: a runner reads the named sections it implements. Every row is recomputed by the generator through an independent reference over node:crypto. hkdfCases: HKDF-SHA256 with the exact ikm, salt, info and length, anchored by RFC 5869 appendix A; the label field names the derivation and the info bytes are shown in hex because several labels end in a NUL. envelopeCases: pkey-sync-value/1; a runner opens envelopeHex under rootHex, collection, name and aliases and expects `expect`, and for rows with a `seal` member also seals value with that salt and expects the same bytes (canonical JSON with sorted keys, UTF-8, padded 0x80 then zeros to a multiple of 64, always at least one byte); the invalid reasons are shape, version, kid, auth, padding, json and name, in the order a reader checks them. blindCases: blind(kind, ctx, n). transferPlanCases: the upload mode, partBytes and part count from the stored size and the collection's files.delta. hpkeAnchor: the RFC 9180 vector for pkey-sync-wrap/1 (enc, shared_secret, key, base_nonce and ciphertext). wrapCases: pkey-sync-wrap/1; a runner unwraps wrap (kem as an integer, enc and ct in hex) for recipientPrivateHex under product, deviceId, ringId and epoch with kidHex as aad and expects expectRootHex (null is a refusal); a `seal` member also wraps rootHex to recipientPublicHex with the ephemeral private key and expects the same enc and ct, and infoHex is the exact HPKE info. recoveryCodeCases: kind code (codeHex encodes to text, text parses to codeHex), kind parse (input parses to expectCodeHex or null) and kind blob (recovery.ct under K_rec; the same open/seal rule, with seal giving rootHex and nonceHex). The text is 8 hyphenated groups of 4 Crockford base32 characters over the code and the first 4 bytes of its SHA-256. adoptCases: the adopt blob (0x01, nonce, AES-256-GCM under K_adopt of currentRootHex, aad = pkey-sync/1 adopt, fromRingId, u32be(epoch), kid); expectRootHex is the adopted root or null. cdcEditCases: a base input (the cdcCases input forms), then edit applied to it (op insert | delete | overwrite at `at` for `length` bytes, the inserted or overwriting bytes being SHA-256(UTF-8 of `pkey-sync vector cdc-edit ` + label, u32be counter) blocks cut to length); a runner cuts both at avg and expects baseLens and editedLens, computes the E2E chunk ids under rootHex and collection (baseIdsHex, editedIdsHex), expects keptIndexes (edited chunks whose id the base has) and changedIndexes (the rest), and expects baseManifestHex and editedManifestHex to parse to those ids and lengths (plainSize and plainSha256 of the whole input; encoding the parsed manifest gives the same bytes). deltaCases: what a transfer moves: have is the set of ids the other side holds (a cdcEditCases side or an explicit list), want is the manifest to reach; moveIdsHex is the distinct ids of want absent from have, in first-appearance order, and moveBytes the sum of their plainLen. cdcCases: fastcdc-2016-nc1 (xorshift32 gear table from seed 0x9e3779b9; the hash starts at 0 at offset min of each chunk): a runner builds the input (stream: SHA-256(UTF-8 of `pkey-sync vector cdc ` + label, u32be counter) blocks cut to length; byte: length copies of value), cuts it with avg (min = avg/4, max = avg*4) and expects the chunk lengths in lens. chunkCases: kind id (the E2E id is HMAC-SHA256(K_cid(collection), chunk) and the server id SHA-256(chunk), both lowercase hex) and kind object (pkey-sync-chunk/1 under the 32 raw id bytes, 0x01 codec nonce(12) then the sealed body, the nonce being HMAC-SHA256(K_chunk, 0x01 codec body)[0:12]: open and expect; a `seal` member also seals bodyHex with that codec and expects objectHex; the invalid reasons are shape, version, codec, auth, nonce, decode, size and id in the order a reader checks; the codec 1 frames here are raw-block zstd frames); kind pair (one id sealed with codec 0 and codec 1: both objects open to plainHex and their nonces, bytes 2 to 14, differ)). fileStreamCases: pkey-sync-file/1 (header little-endian, nonce counter big-endian; the plaintext of a seal row is SHA-256(UTF-8 of `pkey-sync vector file ` + label, u32be counter) blocks cut to length; the salt is in the row). kind seal: seal that plaintext under rootHex and collection with saltHex and expect sealedSize, headerHex, sealedSha256Hex and plainSha256Hex (and sealedHex when present). kind sizes: plainToSealed pairs and sealedToPlain pairs (null: no stream has that size). kind open: take the sealed stream of the row named by base (a seal row), apply the mutate ops in order (truncate length; dropSegment index; swapSegments a b; appendSegment from; xor offset value; setHex offset hex; appendHex hex; segment i starts at 64 + i * (1 MiB + 16)), open it under openCollection (default collection) expecting the kid derived from the root unless expectKidHex is given, and expect ok with plainSha256Hex or a refusal; the reasons are shape, magic, version, flags, segmentSize, kid, size and auth in that order (auth covers truncation, reordering, a missing last flag and a tampered header). kind range: the same stored stream, open plaintext [start, end) through a reader that sees only offset and length; expect ok with length, sha256Hex and the exact reads (the header first, then one per segment overlapped, in order) or a refusal (range adds to the reasons). Only the segments read are authenticated; the stored size alone says which is last. manifestCases: pkey-sync-chunks/1 parse (ok rows are also re-encoded to the same bytes); the invalid reasons are shape, magic, version, recordSize, flags, reserved, count, length, size, record, chunkLen and a final size for the sum, first violation wins. canonicalJsonCases: canonical JSON, the input of a blinded element name: a runner parses inputJson with every number an IEEE double (Python: parse_int=float), or builds the number named by special, canonicalises it and expects canonical, or a refusal (invalid) for a number that is not finite and a string or key with a lone surrogate. Numbers print per ECMAScript Number::toString. A row with a `record` member (U-09) names the blinded wire names the envelope arrived under: kind value (id), field (id and name) or element (id and name), all from blind() under the row's collection; its `name` is still the k the reader expects (the record id, id U+0000 field, or id U+0000 canonicalJson(element)), so a runner that opens by name reads every verdict, and a runner for records opens without a name, splits k at the first U+0000, recomputes blind(record, c, id) and blind(field or element, c, rest) and compares them with the wire names: any difference is invalid with reason name. The container fixes the kind (a fields entry is read as a field, an elements entry as an element), and an element's canonicalJson(v) must equal the name part of k. A row whose only refusal is one of those rules carries a `name` that differs from k, so a runner that opens by name refuses it too. Append-only: a new row or section keeps syncVectorsVersion; a changed row or rule bumps it.",
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
    cdcEditCases,
    deltaCases: buildDeltaCases(cdcEditCases),
    chunkCases: buildChunkCases(),
    fileStreamCases: buildFileStreamCases(),
    manifestCases: buildManifestCases(),
    canonicalJsonCases: buildCanonicalJsonCases(),
  };
}
