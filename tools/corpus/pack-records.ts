// The content set's object refs and the signed pack records (P4-04) that `packRecordCases`,
// `markerCases`, the content families and delegation pin, both built once per run.

import {
  CORPUS_CHUNK_PARAMS,
  contentHashBytes,
  contentRef,
  loadContentSet,
  type ContentSet,
} from "../gen-content-corpus.js";
import { AUD_V3, REL_KID, sha256Hex, signAs } from "./common.js";
import {
  r15Builds,
  RECORD_ISSUED,
  recordDoc,
  type RecordVector,
} from "./release-records.js";
import { REF_JSON } from "./reference/content.js";

// ── §4.3's records over the content set's object refs (P4-04) ─────────────────────────────────

/** The content set, decoded from the committed inputs in `conformance/corpus/v2/content/blobs/`
 *  (`tools/gen-content-corpus.ts`). P4-21 pinned a fixed table here; P4-04 re-signs every valid
 *  record, twin and marker over the real refs, so the two corpora join by hash. */
let CONTENT_SET: ContentSet | null = null;
export function contentSet(): ContentSet {
  CONTENT_SET ??= loadContentSet(REF_JSON);
  return CONTENT_SET;
}
/** The object refs every §4.6 record may pin: shipped blobs and `refs.json`'s four entries. */
export function packObjectHashes(): Set<string> {
  return new Set([...contentSet().objects.values()].map((r) => r.sha256));
}

/** An object ref `{sha256, bytes, size, codec}` of a content-set object. */
export function objRef(name: string): Record<string, unknown> {
  const r = contentRef(contentSet(), name);
  return { sha256: r.sha256, bytes: r.bytes, size: r.size, codec: r.codec };
}
/** A `{sha256, bytes}` member (a delta's `artifact` or `data`). */
export function hashBytes(name: string): Record<string, unknown> {
  return contentHashBytes(contentSet(), name);
}

/** The payloads: a container's `sha256` is its payload file's; a tree's is its `treeDigest`. */
export const PACK_PAYLOADS = {
  get v1() {
    return { ...contentSet().c1.payload };
  },
  get v2() {
    return { ...contentSet().c2.payload };
  },
  get treeV1() {
    return { ...contentSet().tree1.payload };
  },
  get treeV2() {
    return { ...contentSet().tree2.payload };
  },
  get t1() {
    return { ...contentSet().t1.payload };
  },
};

const LEVELS_HANDLER = {
  mountOrder: 2,
  prefixes: ["res://levels/"],
  activation: "restart",
};

export function packDoc(
  deliverable: string,
  version: string,
  seq: number,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aud: AUD_V3,
    deliverable,
    kind: "pack",
    version,
    seq,
    issuedAt: RECORD_ISSUED,
    tag: `${deliverable}-v${version}`,
    channel: "stable",
    ...body,
  };
}

/** `djdl.levels@1.1.0`'s `{texture: s3tc}` variant: one delta of each scope from v1. */
export function levelsV2Variant(): Record<string, unknown> {
  return {
    variant: { texture: "s3tc" },
    payload: { ...PACK_PAYLOADS.v2 },
    full: objRef("payload/v2.full.zst"),
    files: {
      format: "pkey-files/1",
      layout: "container",
      ...objRef("files/v2.files.zst"),
      gaps: objRef("files/v2.gaps.zst"),
    },
    deltas: [
      {
        method: "zstd-patch-from",
        scope: "payload",
        from: PACK_PAYLOADS.v1.sha256,
        memBytes: PACK_PAYLOADS.v1.size + PACK_PAYLOADS.v2.size,
        artifact: hashBytes("deltas/v1-v2.pf.zst"),
      },
      {
        method: "zstd-patch-from",
        scope: "files",
        from: PACK_PAYLOADS.v1.sha256,
        memBytes: contentSet().memBytes.setC,
        patch: objRef("patch/v1-v2.files.zst"),
        data: hashBytes("patch/v1-v2.files.data"),
      },
    ],
    requires: { engine: "godot-4.7" },
  };
}

/** plans/P4-10.md §2.2, §4.5: a variant's `chunks`, pinning `chunks/v2.pkc.zst` with the corpus
 *  parameters (§2.4's, with a 256 KiB bundle target). */
export function levelsChunks(): Record<string, unknown> {
  return {
    format: "pkey-chunks/1",
    ...objRef("chunks/v2.pkc.zst"),
    params: { ...CORPUS_CHUNK_PARAMS },
  };
}

/** §4.3's six records, and plans/P4-10.md §4.5's `djdl.levels@1.2.0`. */
export function packRecordDocs(): Record<string, Record<string, unknown>> {
  const godot = {
    type: "godot.pck",
    formatVersion: 4,
    handler: LEVELS_HANDLER,
  };
  const tree = { type: "files.tree", formatVersion: 1 };
  const etc2 = levelsV2Variant();
  delete etc2.deltas;
  etc2.variant = { texture: "etc2" };
  return {
    "djdl.levels@1.0.0": packDoc("djdl.levels", "1.0.0", 1, {
      ...godot,
      variants: [
        {
          variant: { texture: "s3tc" },
          payload: { ...PACK_PAYLOADS.v1 },
          full: objRef("payload/v1.full.zst"),
          files: {
            format: "pkey-files/1",
            layout: "container",
            ...objRef("files/v1.files.zst"),
            gaps: objRef("files/v1.gaps.zst"),
          },
          requires: { engine: "godot-4.7" },
        },
      ],
    }),
    "djdl.levels@1.1.0": packDoc("djdl.levels", "1.1.0", 2, {
      ...godot,
      variants: [levelsV2Variant(), etc2],
    }),
    "djdl.assets@1.0.0": packDoc("djdl.assets", "1.0.0", 1, {
      ...tree,
      handler: { activation: "hot" },
      variants: [
        {
          variant: {},
          payload: { ...PACK_PAYLOADS.treeV1 },
          full: objRef("tree/v1.full.zst"),
          files: {
            format: "pkey-files/1",
            layout: "tree",
            ...objRef("tree/v1.files.zst"),
          },
        },
      ],
    }),
    "djdl.assets@1.1.0": packDoc("djdl.assets", "1.1.0", 2, {
      ...tree,
      handler: { activation: "hot" },
      variants: [
        {
          variant: {},
          payload: { ...PACK_PAYLOADS.treeV2 },
          full: objRef("tree/v2.full.zst"),
          files: {
            format: "pkey-files/1",
            layout: "tree",
            ...objRef("tree/v2.files.zst"),
          },
          deltas: [
            {
              method: "zstd-patch-from",
              scope: "files",
              from: PACK_PAYLOADS.treeV1.sha256,
              memBytes: contentSet().memBytes.setT,
              patch: objRef("patch/v1-v2.tree.zst"),
              data: hashBytes("patch/v1-v2.tree.data"),
            },
          ],
        },
      ],
    }),
    // plans/P4-10.md §4.5: v2's payload republished by a chunk-aware CI; both variants pin
    // `chunks/v2.pkc.zst`, which joins the two corpora by SHA-256.
    "djdl.levels@1.2.0": packDoc("djdl.levels", "1.2.0", 3, {
      ...godot,
      variants: [
        { ...levelsV2Variant(), chunks: levelsChunks() },
        { ...etc2, chunks: levelsChunks() },
      ],
    }),
    // The minimal record: no handler, no entitlement, no deltas, no requires.
    "djdl.docs@1.0.0": packDoc("djdl.docs", "1.0.0", 1, {
      ...tree,
      variants: [
        {
          variant: {},
          payload: { ...PACK_PAYLOADS.t1 },
          full: objRef("tree/t1.full.zst"),
          files: {
            format: "pkey-files/1",
            layout: "tree",
            ...objRef("tree/t1.files.zst"),
          },
        },
      ],
    }),
  };
}

/** The signed pack records (built once per run; the rewritten P3-02 cases sign the same). */
export let PACK_RECORDS: Map<string, RecordVector> | null = null;
export async function packRecords(): Promise<Map<string, RecordVector>> {
  if (PACK_RECORDS) return PACK_RECORDS;
  const out = new Map<string, RecordVector>();
  for (const [name, doc] of Object.entries(packRecordDocs())) {
    const jws = await signAs(doc, REL_KID, "pkey-release+jws");
    out.set(name, { name, doc, jws, sha256: sha256Hex(jws) });
  }
  PACK_RECORDS = out;
  return out;
}

/** The app twin of §4.6's app checks: R15's envelope with two builds, `content` pinning the
 *  two v1.1.0 pack records and the minimal one, and `embeds` on the desktop build. */
export function appTwin(
  packs: Map<string, RecordVector>,
): Record<string, unknown> {
  const pin = (name: string): Record<string, unknown> => {
    const r = packs.get(name)!;
    return {
      pack: r.doc.deliverable,
      release: { sha256: r.sha256, seq: r.doc.seq, version: r.doc.version },
    };
  };
  const builds = r15Builds("1.5.0", ["macos-dmg", "web"]);
  builds[0]!.embeds = ["djdl.levels"];
  builds[1]!.embeds = [];
  return recordDoc({
    content: {
      contentApi: 4,
      pins: [pin("djdl.levels@1.1.0"), pin("djdl.assets@1.1.0")],
      expects: [
        { pack: "djdl.levels", required: true, delivery: "essential" },
        { pack: "djdl.assets", required: false, delivery: "prefetch" },
      ],
    },
    builds,
  });
}
