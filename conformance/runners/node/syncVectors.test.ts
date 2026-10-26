// The Node conformance runner for `conformance/corpus/v2/sync-vectors.json` (WIRE-CONTRACT-V5
// §13.10). It covers React too, since both JS SDKs share `@polaris-key/client-core`.
//
// Runs the named sections it implements: `hkdfCases` (the port's HKDF and, for every label, the
// matching derivation helper), `envelopeCases` (open every row, seal every row that has a `seal`
// member and compare the bytes, and the reader's check order through the invalid reasons) and
// `blindCases`. Other sections are another slice's.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_FIXED_BYTES,
  ENVELOPE_OVERHEAD_BYTES,
  ENVELOPE_PAD_BLOCK,
  blind,
  deriveAdoptKey,
  deriveChunkIdKey,
  deriveChunkKey,
  deriveCollKey,
  deriveFileKey,
  deriveKid,
  deriveNamesKey,
  deriveRecoveryKey,
  deriveValueKey,
  openValue,
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
