// `sync-vectors.json`: Cloud Sync end-to-end encryption known answers (WIRE-CONTRACT-V5 §13.10,
// §13.8.1; plans/CC-01-cloud-sync.md §2.4). `syncVectorsVersion` 1.
//
// Slice U-34.1 holds `hkdfCases`, `envelopeCases`, `blindCases` and `transferPlanCases`. The
// remaining sections (`wrapCases`, `recoveryCodeCases`, `adoptCases`, `cdcCases`, `chunkCases`,
// `fileStreamCases`, `manifestCases`) append in later U-34 slices without changing the version.
// Every row is recomputed through `reference/syncVectors.ts` (`node:crypto` only; nothing from
// client-core), and the HKDF rows are cross-checked against `crypto.hkdfSync`.

import { createCipheriv, createHash, hkdfSync } from "node:crypto";
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
  refKid,
  refOpenValue,
  refSealValue,
  refTransferPlan,
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

export function buildSyncVectors(): unknown {
  return {
    syncVectorsVersion: 1,
    description:
      "Cloud Sync end-to-end encryption known answers (WIRE-CONTRACT-V5 section 13.10, section 13.8.1; plans/CC-01-cloud-sync.md section 2.4). A client table, inert to an SDK that has not implemented sync.e2e: a runner reads the named sections it implements. Every row is recomputed by the generator through an independent reference over node:crypto. hkdfCases: HKDF-SHA256 with the exact ikm, salt, info and length, anchored by RFC 5869 appendix A; the label field names the derivation and the info bytes are shown in hex because several labels end in a NUL. envelopeCases: pkey-sync-value/1; a runner opens envelopeHex under rootHex, collection, name and aliases and expects `expect`, and for rows with a `seal` member also seals value with that salt and expects the same bytes (canonical JSON with sorted keys, UTF-8, padded 0x80 then zeros to a multiple of 64, always at least one byte); the invalid reasons are shape, version, kid, auth, padding, json and name, in the order a reader checks them. blindCases: blind(kind, ctx, n). transferPlanCases: the upload mode, partBytes and part count from the stored size and the collection's files.delta. Append-only: a new row or section keeps syncVectorsVersion; a changed row or rule bumps it.",
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
  };
}
