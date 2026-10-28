// The Node conformance runner for `conformance/corpus/v2/sync-vectors.json` (WIRE-CONTRACT-V5
// §13.10). It covers React too, since both JS SDKs share `@polaris-key/client-core`.
//
// Runs the named sections it implements: `hkdfCases` (the port's HKDF and, for every label, the
// matching derivation helper), `envelopeCases` (open every row, seal every row that has a `seal`
// member and compare the bytes, and the reader's check order through the invalid reasons) and
// `blindCases`, `hpkeAnchor`, `wrapCases`, `recoveryCodeCases`, `adoptCases`, `cdcCases` (the
// streaming chunker, fed in uneven pieces), `chunkCases` and `manifestCases`. Other sections are
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
  chunkCases: ChunkRow[];
  manifestCases: ManifestCase[];
}
type Verdict<T> =
  | ({ result: "ok" } & T)
  | { result: "invalid"; reason: string };
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
    };
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
