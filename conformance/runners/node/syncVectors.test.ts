// @pkey-feature sync.e2e
// The Node conformance runner for `conformance/corpus/v2/sync-vectors.json` (WIRE-CONTRACT-V5
// §13.10). It covers React too, since both JS SDKs share `@polaris-key/client-core`.
//
// Runs the named sections it implements: `hkdfCases` (the port's HKDF and, for every label, the
// matching derivation helper), `envelopeCases` (open every row, seal every row that has a `seal`
// member and compare the bytes, and the reader's check order through the invalid reasons) and
// `blindCases`, `hpkeAnchor`, `wrapCases`, `recoveryCodeCases`, `adoptCases`, `cdcCases` (the
// streaming chunker, fed in uneven pieces), `chunkCases`, `manifestCases`, `cdcEditCases` and `deltaCases`. Other sections are
// another slice's.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { decode as zstdDecode } from "@polaris-key/zstd-wasm";
import {
  ENVELOPE_FIXED_BYTES,
  ENVELOPE_OVERHEAD_BYTES,
  ENVELOPE_PAD_BLOCK,
  CdcChunker,
  blind,
  FileStreamError,
  openFile,
  openFileRange,
  openFileStream,
  plainFileSize,
  planTransfer,
  sealFile,
  sealFileStream,
  sealedFileSize,
  chunkIdHex,
  cdcParams,
  encodeManifest,
  openChunk,
  parseManifest,
  sealChunk,
  HPKE_KEM_X25519,
  deriveAdoptKey,
  deriveChunkIdKey,
  deriveChunkKey,
  deriveCollKey,
  deriveFileKey,
  deriveKid,
  deriveNamesKey,
  deriveRecoveryKey,
  deriveValueKey,
  encodeRecoveryCode,
  hpkeEncap,
  hpkeKeySchedule,
  hpkeSeal,
  openAdopt,
  openValue,
  openValueAnyName,
  parseRecoveryCode,
  sealAdopt,
  unwrapRecovery,
  unwrapRoot,
  wrapInfo,
  wrapRecovery,
  wrapRoot,
  sealValue,
  webCryptoSyncPort as port,
  type BlindKind,
  type SyncCryptoPort,
  canonicalJson,
  type SyncJson,
} from "@polaris-key/client-core/sync";

interface HkdfCase {
  id: string;
  label: string;
  ikmHex: string;
  saltHex: string;
  infoHex: string;
  length: number;
  okmHex: string;
}
interface EnvelopeCase {
  id: string;
  rootHex: string;
  collection: string;
  name: string;
  aliases: string[];
  seal?: { saltHex: string; value: SyncJson };
  /** A record row (U-09): the blinded names the envelope arrived under (§13.10.4). */
  record?: { kind: "value" | "field" | "element"; id: string; name?: string };
  envelopeHex: string;
  expect:
    | { result: "ok"; name: string; value: SyncJson }
    | { result: "invalid"; reason: string };
}
interface BlindCase {
  id: string;
  rootHex: string;
  kind: BlindKind;
  ctx: string;
  n: string;
  blinded: string;
}
interface WrapCase {
  id: string;
  wrap: { kem: number; encHex: string; ctHex: string };
  expectRootHex: string | null;
  recipientPrivateHex: string;
  kidHex: string;
  epoch: number;
  ringId: string;
  deviceId: string;
  product: string;
  seal?: {
    rootHex: string;
    recipientPublicHex: string;
    ephemeralPrivateHex: string;
    infoHex: string;
  };
}
type RecoveryRow =
  | { kind: "code"; id: string; codeHex: string; text: string }
  | {
      kind: "parse";
      id: string;
      input: string;
      expectCodeHex: string | null;
    }
  | {
      kind: "blob";
      id: string;
      codeHex: string;
      ringId: string;
      epoch: number;
      kidHex: string;
      blobHex: string;
      expectRootHex: string | null;
      seal?: { rootHex: string; nonceHex: string };
    };
interface AdoptCase {
  id: string;
  currentRootHex: string;
  fromRingId: string;
  epoch: number;
  kidHex: string;
  blobHex: string;
  expectRootHex: string | null;
  seal?: { oldRootHex: string; nonceHex: string };
}
interface Vectors {
  syncVectorsVersion: number;
  constants: {
    envelopeOverheadBytes: number;
    envelopeFixedBytes: number;
    paddingBlockBytes: number;
  };
  hkdfCases: HkdfCase[];
  envelopeCases: EnvelopeCase[];
  blindCases: BlindCase[];
  hpkeAnchor: {
    vector: Record<string, string> & {
      encryption: { aad: string; ct: string; nonce: string; pt: string };
    };
  };
  wrapCases: WrapCase[];
  recoveryCodeCases: RecoveryRow[];
  adoptCases: AdoptCase[];
  cdcCases: CdcCase[];
  cdcEditCases: CdcEditCase[];
  deltaCases: DeltaCase[];
  chunkCases: ChunkRow[];
  manifestCases: ManifestCase[];
  transferPlanCases: TransferPlanCase[];
  fileStreamCases: FileRow[];
  canonicalJsonCases: CanonicalJsonCase[];
}
interface TransferPlanCase {
  id: string;
  size: number;
  delta: boolean;
  expect: { mode: string; partBytes: number | null; parts: number | null };
}
type FileOp =
  | { op: "truncate"; length: number }
  | { op: "dropSegment"; index: number }
  | { op: "swapSegments"; a: number; b: number }
  | { op: "appendSegment"; from: number }
  | { op: "xor"; offset: number; value: number }
  | { op: "setHex"; offset: number; hex: string }
  | { op: "appendHex"; hex: string };
type FileRow = { id: string; description: string } & (
  | {
      kind: "seal";
      rootHex: string;
      collection: string;
      saltHex: string;
      plain: { label: string; length: number };
      expect: {
        sealedSize: number;
        headerHex: string;
        sealedSha256Hex: string;
        plainSha256Hex: string;
        sealedHex?: string;
      };
    }
  | {
      kind: "sizes";
      plainToSealed: Array<[number, number]>;
      sealedToPlain: Array<[number, number | null]>;
    }
  | {
      kind: "open";
      base: string;
      mutate: FileOp[];
      openCollection?: string;
      expectKidHex?: string;
      expect:
        | { result: "ok"; plainSha256Hex: string }
        | { result: "invalid"; reason: string };
    }
  | {
      kind: "range";
      base: string;
      mutate: FileOp[];
      start: number;
      end: number;
      expect:
        | {
            result: "ok";
            length: number;
            sha256Hex: string;
            reads: Array<[number, number]>;
          }
        | { result: "invalid"; reason: string };
    }
);
type Verdict<T> =
  | ({ result: "ok" } & T)
  | { result: "invalid"; reason: string };
interface CdcEditCase {
  id: string;
  avg: number;
  rootHex: string;
  collection: string;
  base: CdcCase["input"];
  edit: {
    op: "insert" | "delete" | "overwrite";
    at: number;
    length: number;
    label: string;
  };
  baseLens: number[];
  editedLens: number[];
  baseIdsHex: string[];
  editedIdsHex: string[];
  keptIndexes: number[];
  changedIndexes: number[];
  baseManifestHex: string;
  editedManifestHex: string;
}
type DeltaWant = { row: string; side: "base" | "edited" };
interface DeltaCase {
  id: string;
  have: DeltaWant | { idsHex: string[] };
  want: DeltaWant;
  moveIdsHex: string[];
  moveBytes: number;
}
interface CdcCase {
  id: string;
  avg: number;
  min: number;
  max: number;
  input:
    | { kind: "stream"; label: string; length: number }
    | { kind: "byte"; value: number; length: number };
  lens: number[];
}
type ChunkRow =
  | {
      kind: "id";
      id: string;
      rootHex: string;
      collection: string;
      plainHex: string;
      e2eIdHex: string;
      serverIdHex: string;
    }
  | {
      kind: "object";
      id: string;
      rootHex: string;
      collection: string;
      idHex: string;
      objectHex: string;
      seal?: { codec: number; bodyHex: string };
      expect: Verdict<{ plainHex: string; codec: number }>;
    }
  | {
      kind: "pair";
      id: string;
      rootHex: string;
      collection: string;
      idHex: string;
      plainHex: string;
      rawObjectHex: string;
      zstdObjectHex: string;
      rawNonceHex: string;
      zstdNonceHex: string;
    };
interface CanonicalJsonCase {
  id: string;
  inputJson?: string;
  special?: "NaN" | "Infinity" | "-Infinity";
  expect: { result: "ok"; canonical: string } | { result: "invalid" };
}
interface ManifestCase {
  id: string;
  manifestHex: string;
  expect: Verdict<{
    plainSize: number;
    plainSha256Hex: string;
    records: Array<{ idHex: string; plainLen: number }>;
  }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(
    join(here, "..", "..", "corpus", "v2", "sync-vectors.json"),
    "utf8",
  ),
) as Vectors;

const unhex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type Derive = (
  p: SyncCryptoPort,
  ikm: Uint8Array,
  salt: Uint8Array,
  name: string,
) => Promise<Uint8Array>;

// The helper for each labelled derivation; `rfc5869` has none.
const HELPERS: Record<string, Derive> = {
  kid: (p, ikm) => deriveKid(p, ikm),
  coll: (p, ikm, _s, name) => deriveCollKey(p, ikm, name),
  names: (p, ikm) => deriveNamesKey(p, ikm),
  "chunk-id": (p, ikm, _s, name) => deriveChunkIdKey(p, ikm, name),
  value: (p, ikm, salt) => deriveValueKey(p, ikm, salt),
  file: (p, ikm, salt) => deriveFileKey(p, ikm, salt),
  chunk: (p, ikm, salt) => deriveChunkKey(p, ikm, salt),
  recovery: (p, ikm, salt) =>
    deriveRecoveryKey(p, ikm, new TextDecoder().decode(salt)),
  adopt: (p, ikm) => deriveAdoptKey(p, ikm),
};

describe("sync-vectors.json: table", () => {
  it("is version 1 and its constants match the client's", () => {
    expect(vectors.syncVectorsVersion).toBe(1);
    expect(vectors.constants).toEqual({
      envelopeOverheadBytes: ENVELOPE_OVERHEAD_BYTES,
      envelopeFixedBytes: ENVELOPE_FIXED_BYTES,
      paddingBlockBytes: ENVELOPE_PAD_BLOCK,
    });
  });
});

describe("sync-vectors.json: hkdfCases", () => {
  for (const c of vectors.hkdfCases) {
    it(c.id, async () => {
      const ikm = unhex(c.ikmHex);
      const salt = unhex(c.saltHex);
      const info = unhex(c.infoHex);
      expect(hex(await port.hkdf(ikm, salt, info, c.length))).toBe(c.okmHex);

      const helper = HELPERS[c.label];
      if (helper === undefined) return;
      // The info is the label, then (for a scoped label) a NUL and the name.
      const text = new TextDecoder().decode(info);
      const name = text.includes("\0")
        ? text.slice(text.indexOf("\0") + 1)
        : "";
      expect(hex(await helper(port, ikm, salt, name))).toBe(c.okmHex);
    });
  }
});

/**
 * Opens a sealed record value, field or element: the envelope first, then `k` split at its first
 * U+0000, the blinded forms recomputed and compared with the wire names; a difference is `name`.
 * The container fixes the kind (`wire.kind`), and an element's `canonicalJson(v)` must be the name
 * part of `k`.
 */
async function openRecord(
  root: Uint8Array,
  collection: string,
  wire: NonNullable<EnvelopeCase["record"]>,
  envelope: Uint8Array,
) {
  const r = await openValueAnyName(port, root, collection, envelope);
  if (!r.ok) return r;
  const refused = { ok: false, reason: "name" } as const;
  const cut = r.name.indexOf("\0");
  if (wire.kind !== "value" && cut < 0) return refused;
  const id = wire.kind === "value" ? r.name : r.name.slice(0, cut);
  if ((await blind(port, root, "record", collection, id)) !== wire.id)
    return refused;
  if (wire.kind === "value") return r;
  const rest = r.name.slice(cut + 1);
  if ((await blind(port, root, wire.kind, collection, rest)) !== wire.name)
    return refused;
  if (wire.kind === "element" && canonicalJson(r.value) !== rest)
    return refused;
  return r;
}

describe("sync-vectors.json: envelopeCases", () => {
  for (const c of vectors.envelopeCases) {
    it(c.id, async () => {
      const root = unhex(c.rootHex);
      const opened = await openValue(
        port,
        root,
        c.collection,
        c.name,
        unhex(c.envelopeHex),
        c.aliases,
      );
      if (c.expect.result === "ok") {
        expect(opened).toEqual({
          ok: true,
          name: c.expect.name,
          value: c.expect.value,
        });
      } else {
        expect(opened).toEqual({ ok: false, reason: c.expect.reason });
      }

      if (c.record !== undefined) {
        // The reader of a record (§13.10.4): open without a name, split k, recompute, compare.
        const got = await openRecord(
          root,
          c.collection,
          c.record,
          unhex(c.envelopeHex),
        );
        expect(got).toEqual(
          c.expect.result === "ok"
            ? { ok: true, name: c.expect.name, value: c.expect.value }
            : { ok: false, reason: c.expect.reason },
        );
      }

      if (c.seal !== undefined) {
        // Seal under the name the row expects back (an alias row seals under the old name).
        const sealedName = c.expect.result === "ok" ? c.expect.name : c.name;
        const sealed = await sealValue(
          port,
          root,
          c.collection,
          sealedName,
          c.seal.value,
          unhex(c.seal.saltHex),
        );
        expect(hex(sealed)).toBe(c.envelopeHex);
      }
    });
  }
});

describe("sync-vectors.json: blindCases", () => {
  for (const c of vectors.blindCases) {
    it(c.id, async () => {
      expect(await blind(port, unhex(c.rootHex), c.kind, c.ctx, c.n)).toBe(
        c.blinded,
      );
    });
  }
});

describe("sync-vectors.json: hpkeAnchor (RFC 9180)", () => {
  it("reproduces the encapsulation, key schedule and sequence-0 ciphertext", async () => {
    const v = vectors.hpkeAnchor.vector;
    const e = v.encryption;
    const encap = await hpkeEncap(port, unhex(v.pkRm!), unhex(v.skEm!));
    expect(hex(encap.enc)).toBe(v.enc);
    expect(hex(encap.sharedSecret)).toBe(v.shared_secret);
    const ks = await hpkeKeySchedule(port, encap.sharedSecret, unhex(v.info!));
    expect(hex(ks.key)).toBe(v.key);
    expect(hex(ks.nonce)).toBe(v.base_nonce);
    const sealed = await hpkeSeal(
      port,
      unhex(v.pkRm!),
      unhex(v.info!),
      unhex(e.aad),
      unhex(e.pt),
      unhex(v.skEm!),
    );
    expect(hex(sealed.ct)).toBe(e.ct);
  });
});

describe("sync-vectors.json: wrapCases", () => {
  for (const c of vectors.wrapCases) {
    it(c.id, async () => {
      const ctx = {
        product: c.product,
        deviceId: c.deviceId,
        ringId: c.ringId,
        epoch: c.epoch,
      };
      const root = await unwrapRoot(
        port,
        unhex(c.recipientPrivateHex),
        ctx,
        unhex(c.kidHex),
        {
          kem: c.wrap.kem,
          enc: unhex(c.wrap.encHex),
          ct: unhex(c.wrap.ctHex),
        },
      );
      expect(root === null ? null : hex(root)).toBe(c.expectRootHex);
      if (c.seal !== undefined) {
        expect(hex(wrapInfo(ctx))).toBe(c.seal.infoHex);
        const w = await wrapRoot(
          port,
          unhex(c.seal.recipientPublicHex),
          ctx,
          unhex(c.kidHex),
          unhex(c.seal.rootHex),
          unhex(c.seal.ephemeralPrivateHex),
        );
        expect(w.kem).toBe(HPKE_KEM_X25519);
        expect(hex(w.enc)).toBe(c.wrap.encHex);
        expect(hex(w.ct)).toBe(c.wrap.ctHex);
      }
    });
  }
});

describe("sync-vectors.json: recoveryCodeCases", () => {
  for (const c of vectors.recoveryCodeCases) {
    it(`${c.kind}: ${c.id}`, async () => {
      if (c.kind === "code") {
        expect(await encodeRecoveryCode(port, unhex(c.codeHex))).toBe(c.text);
        const parsed = await parseRecoveryCode(port, c.text);
        expect(parsed === null ? null : hex(parsed)).toBe(c.codeHex);
      } else if (c.kind === "parse") {
        const parsed = await parseRecoveryCode(port, c.input);
        expect(parsed === null ? null : hex(parsed)).toBe(c.expectCodeHex);
      } else {
        const root = await unwrapRecovery(
          port,
          unhex(c.codeHex),
          c.ringId,
          c.epoch,
          unhex(c.kidHex),
          unhex(c.blobHex),
        );
        expect(root === null ? null : hex(root)).toBe(c.expectRootHex);
        if (c.seal !== undefined) {
          const blob = await wrapRecovery(
            port,
            unhex(c.codeHex),
            c.ringId,
            c.epoch,
            unhex(c.kidHex),
            unhex(c.seal.rootHex),
            unhex(c.seal.nonceHex),
          );
          expect(hex(blob)).toBe(c.blobHex);
        }
      }
    });
  }
});

describe("sync-vectors.json: adoptCases", () => {
  for (const c of vectors.adoptCases) {
    it(c.id, async () => {
      const from = {
        fromRingId: c.fromRingId,
        epoch: c.epoch,
        kid: unhex(c.kidHex),
      };
      const root = await openAdopt(
        port,
        unhex(c.currentRootHex),
        from,
        unhex(c.blobHex),
      );
      expect(root === null ? null : hex(root)).toBe(c.expectRootHex);
      if (c.seal !== undefined) {
        const blob = await sealAdopt(
          port,
          unhex(c.currentRootHex),
          from,
          unhex(c.seal.oldRootHex),
          unhex(c.seal.nonceHex),
        );
        expect(hex(blob)).toBe(c.blobHex);
      }
    });
  }
});

/** The deterministic input of a `cdcCases` row (SHA-256 counter blocks, or one repeated byte). */
function cdcInput(i: CdcCase["input"]): Uint8Array {
  if (i.kind === "byte") return new Uint8Array(i.length).fill(i.value);
  const out = new Uint8Array(i.length);
  for (let at = 0, n = 0; at < i.length; n++, at += 32) {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, n);
    const block = createHash("sha256")
      .update(`pkey-sync vector cdc ${i.label}`)
      .update(ctr)
      .digest();
    out.set(block.subarray(0, Math.min(32, i.length - at)), at);
  }
  return out;
}

describe("sync-vectors.json: cdcCases", () => {
  for (const c of vectors.cdcCases) {
    it(c.id, () => {
      expect(cdcParams(c.avg)).toEqual({ avg: c.avg, min: c.min, max: c.max });
      const input = cdcInput(c.input);
      // Whole, then in awkward pieces: the cuts do not depend on how the input arrives.
      for (const piece of [input.length || 1, 1000, 65537]) {
        const chunker = new CdcChunker(cdcParams(c.avg));
        const lens: number[] = [];
        for (let at = 0; at < input.length; at += piece)
          for (const ch of chunker.push(input.subarray(at, at + piece)))
            lens.push(ch.length);
        for (const ch of chunker.finish()) lens.push(ch.length);
        expect(lens).toEqual(c.lens);
      }
    });
  }
});

describe("sync-vectors.json: chunkCases", () => {
  for (const c of vectors.chunkCases) {
    it(c.id, async () => {
      const root = unhex(c.rootHex);
      if (c.kind === "id") {
        const plain = unhex(c.plainHex);
        expect(await chunkIdHex(port, root, c.collection, plain)).toBe(
          c.e2eIdHex,
        );
        expect(await chunkIdHex(port, null, c.collection, plain)).toBe(
          c.serverIdHex,
        );
        return;
      }
      if (c.kind === "pair") {
        expect(c.rawNonceHex).not.toBe(c.zstdNonceHex);
        for (const [objHex, nonceHex, codec] of [
          [c.rawObjectHex, c.rawNonceHex, 0],
          [c.zstdObjectHex, c.zstdNonceHex, 1],
        ] as const) {
          const object = unhex(objHex);
          expect(hex(object.subarray(2, 14))).toBe(nonceHex);
          const o = await openChunk(
            port,
            root,
            c.collection,
            unhex(c.idHex),
            object,
            zstdDecode,
          );
          expect(o.ok).toBe(true);
          if (o.ok) {
            expect(hex(o.plain)).toBe(c.plainHex);
            expect(o.codec).toBe(codec);
          }
        }
        return;
      }
      const opened = await openChunk(
        port,
        root,
        c.collection,
        unhex(c.idHex),
        unhex(c.objectHex),
        zstdDecode,
      );
      if (c.expect.result === "ok") {
        expect(opened.ok).toBe(true);
        if (opened.ok) {
          expect(hex(opened.plain)).toBe(c.expect.plainHex);
          expect(opened.codec).toBe(c.expect.codec);
        }
      } else {
        expect(opened).toEqual({ ok: false, reason: c.expect.reason });
      }
      if (c.seal !== undefined) {
        const object = await sealChunk(
          port,
          root,
          c.collection,
          unhex(c.idHex),
          c.seal.codec,
          unhex(c.seal.bodyHex),
        );
        expect(hex(object)).toBe(c.objectHex);
      }
    });
  }
});

describe("sync-vectors.json: manifestCases", () => {
  for (const c of vectors.manifestCases) {
    it(c.id, () => {
      const parsed = parseManifest(unhex(c.manifestHex));
      if (c.expect.result === "invalid") {
        expect(parsed).toEqual({ ok: false, reason: c.expect.reason });
        return;
      }
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.manifest.plainSize).toBe(c.expect.plainSize);
      expect(hex(parsed.manifest.plainSha256)).toBe(c.expect.plainSha256Hex);
      expect(
        parsed.manifest.records.map((r) => ({
          idHex: hex(r.id),
          plainLen: r.plainLen,
        })),
      ).toEqual(c.expect.records);
      expect(hex(encodeManifest(parsed.manifest))).toBe(c.manifestHex);
    });
  }
});

describe("sync-vectors.json: transferPlanCases", () => {
  for (const c of vectors.transferPlanCases) {
    it(c.id, () => {
      expect(planTransfer(c.size, c.delta)).toEqual(c.expect);
    });
  }
});

const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

/** The plaintext of a seal row (SHA-256 counter blocks of the label). */
function filePlain(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0, n = 0; at < length; n++, at += 32) {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, n);
    const block = createHash("sha256")
      .update(`pkey-sync vector file ${label}`)
      .update(ctr)
      .digest();
    out.set(block.subarray(0, Math.min(32, length - at)), at);
  }
  return out;
}

const FSEG = 1_048_576;
const FSTRIDE = FSEG + 16;

function applyOps(stream: Uint8Array, ops: FileOp[]): Uint8Array {
  let b: Uint8Array = Uint8Array.from(stream);
  const seg = (s: Uint8Array, i: number): [number, number] => {
    const a = 64 + i * FSTRIDE;
    return [a, Math.min(s.length, a + FSTRIDE)];
  };
  const cat = (...p: Uint8Array[]): Uint8Array =>
    new Uint8Array(Buffer.concat(p));
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
    else if (o.op === "setHex") b.set(unhex(o.hex), o.offset);
    else b = cat(b, unhex(o.hex));
  }
  return b;
}

describe("sync-vectors.json: fileStreamCases", () => {
  const rows = vectors.fileStreamCases;
  const sealRows = rows.filter(
    (r): r is Extract<FileRow, { kind: "seal" }> => r.kind === "seal",
  );
  const streams = new Map<string, Uint8Array>();

  for (const r of sealRows) {
    it(`${r.id}: seals to the pinned bytes, whole and streamed`, async () => {
      const root = unhex(r.rootHex);
      const collKey = await deriveCollKey(port, root, r.collection);
      const kid = await deriveKid(port, root);
      const salt = unhex(r.saltHex);
      const plain = filePlain(r.plain.label, r.plain.length);
      expect(sha(plain)).toBe(r.expect.plainSha256Hex);
      const sealed = await sealFile(port, collKey, kid, plain, salt);
      expect(sealed.length).toBe(r.expect.sealedSize);
      expect(sealedFileSize(plain.length)).toBe(r.expect.sealedSize);
      expect(plainFileSize(sealed.length)).toBe(plain.length);
      expect(hex(sealed.subarray(0, 64))).toBe(r.expect.headerHex);
      expect(sha(sealed)).toBe(r.expect.sealedSha256Hex);
      if (r.expect.sealedHex !== undefined)
        expect(hex(sealed)).toBe(r.expect.sealedHex);
      // The same bytes from a source that arrives in awkward pieces.
      const pieces: Uint8Array[] = [];
      const source = (async function* () {
        for (let at = 0; at < plain.length; at += 100_003)
          yield plain.subarray(at, at + 100_003);
      })();
      for await (const p of sealFileStream(port, collKey, kid, source, salt))
        pieces.push(p);
      expect(sha(new Uint8Array(Buffer.concat(pieces)))).toBe(
        r.expect.sealedSha256Hex,
      );
      streams.set(r.id, sealed);
    });
  }

  const byId = (id: string): Extract<FileRow, { kind: "seal" }> =>
    sealRows.find((s) => s.id === id)!;
  const stored = async (
    base: string,
    mutate: FileOp[],
  ): Promise<{ bytes: Uint8Array; root: Uint8Array; coll: string }> => {
    const row = byId(base);
    const root = unhex(row.rootHex);
    if (!streams.has(base)) {
      const salt = unhex(row.saltHex);
      streams.set(
        base,
        await sealFile(
          port,
          await deriveCollKey(port, root, row.collection),
          await deriveKid(port, root),

          filePlain(row.plain.label, row.plain.length),
          salt,
        ),
      );
    }
    return {
      bytes: applyOps(streams.get(base)!, mutate),
      root,
      coll: row.collection,
    };
  };

  for (const r of rows) {
    if (r.kind === "sizes") {
      it(`${r.id}: the size maps`, () => {
        for (const [p, s] of r.plainToSealed) expect(sealedFileSize(p)).toBe(s);
        for (const [s, p] of r.sealedToPlain) expect(plainFileSize(s)).toBe(p);
      });
    } else if (r.kind === "open") {
      it(r.id, async () => {
        const { bytes, root, coll } = await stored(r.base, r.mutate);
        const collKey = await deriveCollKey(
          port,
          root,
          r.openCollection ?? coll,
        );
        const kid =
          r.expectKidHex === undefined
            ? await deriveKid(port, root)
            : unhex(r.expectKidHex);
        // Whole, then streamed in awkward pieces: the verdict does not depend on how it arrives.
        const whole = await openFile(port, collKey, kid, bytes);
        const piecewise = await (async () => {
          const out: Uint8Array[] = [];
          try {
            const src = (async function* () {
              for (let at = 0; at < bytes.length; at += 300_007)
                yield bytes.subarray(at, at + 300_007);
            })();
            for await (const p of openFileStream(port, collKey, kid, src))
              out.push(p);
          } catch (e) {
            if (e instanceof FileStreamError) return e.reason;
            throw e;
          }
          return sha(new Uint8Array(Buffer.concat(out)));
        })();
        if (r.expect.result === "ok") {
          expect(whole.ok && sha(whole.plain)).toBe(r.expect.plainSha256Hex);
          expect(piecewise).toBe(r.expect.plainSha256Hex);
        } else {
          expect(whole).toEqual({ ok: false, reason: r.expect.reason });
          expect(piecewise).toBe(r.expect.reason);
        }
      });
    } else if (r.kind === "range") {
      it(r.id, async () => {
        const { bytes, root, coll } = await stored(r.base, r.mutate);
        const collKey = await deriveCollKey(port, root, coll);
        const kid = await deriveKid(port, root);
        const reads: Array<[number, number]> = [];
        const read = async (offset: number, length: number) => {
          reads.push([offset, length]);
          return bytes.slice(offset, offset + length);
        };
        let got: { reason: string } | { plain: Uint8Array };
        try {
          got = {
            plain: await openFileRange(
              port,
              collKey,
              kid,
              read,
              bytes.length,
              r.start,
              r.end,
            ),
          };
        } catch (e) {
          if (!(e instanceof FileStreamError)) throw e;
          got = { reason: e.reason };
        }
        if (r.expect.result === "ok") {
          expect("plain" in got && got.plain.length).toBe(r.expect.length);
          expect("plain" in got && sha(got.plain)).toBe(r.expect.sha256Hex);
          expect(reads).toEqual(r.expect.reads);
        } else {
          expect(got).toEqual({ reason: r.expect.reason });
        }
      });
    }
  }
});

describe("sync-vectors.json: canonicalJsonCases", () => {
  for (const c of vectors.canonicalJsonCases) {
    it(c.id, () => {
      const input = (
        c.special !== undefined ? Number(c.special) : JSON.parse(c.inputJson!)
      ) as SyncJson;
      if (c.expect.result === "ok") {
        expect(canonicalJson(input)).toBe(c.expect.canonical);
      } else {
        expect(() => canonicalJson(input)).toThrow(RangeError);
      }
    });
  }
});

/** Cut `buf` into plaintext chunks with the streaming chunker, fed in uneven pieces. */
function cutChunks(buf: Uint8Array, avg: number): Uint8Array[] {
  const chunker = new CdcChunker(cdcParams(avg));
  const out: Uint8Array[] = [];
  for (let at = 0; at < buf.length; at += 65537)
    for (const ch of chunker.push(buf.subarray(at, at + 65537)))
      out.push(Uint8Array.from(ch));
  for (const ch of chunker.finish()) out.push(Uint8Array.from(ch));
  return out;
}

/** The edited bytes of a `cdcEditCases` row (the recipe in the file's description). */
function applyEdit(base: Uint8Array, e: CdcEditCase["edit"]): Uint8Array {
  const piece = new Uint8Array(e.length);
  for (let at = 0, n = 0; at < e.length; n++, at += 32) {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, n);
    const block = createHash("sha256")
      .update(`pkey-sync vector cdc-edit ${e.label}`)
      .update(ctr)
      .digest();
    piece.set(block.subarray(0, Math.min(32, e.length - at)), at);
  }
  const tail = base.subarray(e.op === "insert" ? e.at : e.at + e.length);
  const head = base.subarray(0, e.at);
  const mid = e.op === "delete" ? new Uint8Array(0) : piece;
  return new Uint8Array(Buffer.concat([head, mid, tail]));
}

describe("sync-vectors.json: cdcEditCases", () => {
  for (const c of vectors.cdcEditCases) {
    it(c.id, async () => {
      const root = unhex(c.rootHex);
      const base = cdcInput(c.base);
      const edited = applyEdit(base, c.edit);
      const sides = [
        ["base", base, c.baseLens, c.baseIdsHex, c.baseManifestHex],
        ["edited", edited, c.editedLens, c.editedIdsHex, c.editedManifestHex],
      ] as const;
      for (const [, buf, lens, ids, manifestHex] of sides) {
        const chunks = cutChunks(buf, c.avg);
        expect(chunks.map((ch) => ch.length)).toEqual(lens);
        const got: string[] = [];
        for (const ch of chunks)
          got.push(await chunkIdHex(port, root, c.collection, ch));
        expect(got).toEqual(ids);
        const parsed = parseManifest(unhex(manifestHex));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.manifest.plainSize).toBe(buf.length);
        expect(hex(parsed.manifest.plainSha256)).toBe(
          createHash("sha256").update(buf).digest("hex"),
        );
        expect(parsed.manifest.records.map((r) => hex(r.id))).toEqual(ids);
        expect(parsed.manifest.records.map((r) => r.plainLen)).toEqual(lens);
        expect(hex(encodeManifest(parsed.manifest))).toBe(manifestHex);
      }
      const have = new Set(c.baseIdsHex);
      const kept: number[] = [];
      const changed: number[] = [];
      c.editedIdsHex.forEach((id, i) =>
        (have.has(id) ? kept : changed).push(i),
      );
      expect(kept).toEqual(c.keptIndexes);
      expect(changed).toEqual(c.changedIndexes);
    });
  }
});

describe("sync-vectors.json: deltaCases", () => {
  for (const c of vectors.deltaCases) {
    it(c.id, () => {
      const manifestOf = (w: DeltaWant) => {
        const row = vectors.cdcEditCases.find((e) => e.id === w.row)!;
        const parsed = parseManifest(
          unhex(
            w.side === "base" ? row.baseManifestHex : row.editedManifestHex,
          ),
        );
        if (!parsed.ok) throw new Error(`delta ${c.id}: manifest refused`);
        return parsed.manifest.records.map((r) => ({
          id: hex(r.id),
          plainLen: r.plainLen,
        }));
      };
      const have = new Set(
        "idsHex" in c.have
          ? c.have.idsHex
          : manifestOf(c.have).map((r) => r.id),
      );
      const move = new Map<string, number>();
      for (const r of manifestOf(c.want))
        if (!have.has(r.id) && !move.has(r.id)) move.set(r.id, r.plainLen);
      expect([...move.keys()]).toEqual(c.moveIdsHex);
      expect([...move.values()].reduce((a, b) => a + b, 0)).toBe(c.moveBytes);
    });
  }
});
