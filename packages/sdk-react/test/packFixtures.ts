// Pack fixtures for the React pack tests (a copy of client-core's test/packFixtures.ts): `files.tree` pack records signed with the corpus's
// own release key (`djdl-release-test-2026`, never a production key), their objects stored raw
// (`codec: none`, so no compressor is needed), a fake byte server with Range/If-Range, and a
// `files` delta set whose one `delta` entry is the probe vector (a real `zstd --patch-from`
// frame over a 432-byte base).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signJws } from "@polaris-key/jws";
import type { ObjectResponse } from "@polaris-key/client-core";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "conformance", "corpus", "v2", "cases.json"),
    "utf8",
  ),
) as {
  keys: { kid: string; publicKeyRaw: string; privateKeyPkcs8Pem: string }[];
};
const key = (kid: string) => corpus.keys.find((k) => k.kid === kid)!;

export const PRODUCT = "djdl";
export const RELEASE_KID = "djdl-release-test-2026";
export const PRODUCT_KID = "pkey-test-prod-2026";
export const RELEASE_KEYS = { [RELEASE_KID]: key(RELEASE_KID).publicKeyRaw };
export const PRODUCT_TRUST = { [PRODUCT_KID]: key(PRODUCT_KID).publicKeyRaw };

export const sha = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const cmp = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The probe vector (zstd 1.5.7 `--patch-from`): base, frame and target. */
export const PROBE_BASE = enc(
  Array.from(
    { length: 6 },
    (_, i) =>
      `polaris key probe line ${String(i).padStart(3, "0")}: the quick brown fox jumps over the lazy dog\n`,
  ).join(""),
);
export const PROBE_FRAME = Uint8Array.from(
  Buffer.from(
    "28b52ffd64d500150200540230736c65657079206361740a313278797a357461696c20616464656420666f70726f62650a0a00db6bf840c481b4bbab0c04d021809e01ca9ab04cf0c8b204205fff9e32",
    "hex",
  ),
);
export const PROBE_TARGET = enc(
  Array.from(
    { length: 6 },
    (_, i) =>
      `polaris key probe line ${i === 3 ? "xyz" : String(i).padStart(3, "0")}: the quick brown fox jumps over the sleepy cat\n`,
  ).join("") + "tail added for the probe\n",
);

export interface TreePack {
  packId: string;
  version: string;
  seq: number;
  jws: string;
  recordSha256: string;
  treeDigest: string;
  size: number;
  /** Every stored object by its SHA-256. */
  objects: Map<string, Uint8Array>;
  files: Record<string, Uint8Array>;
  indexSha256: string;
  fullSha256: string;
}

/** A `files.tree` pack release over `files`, every object raw; optionally a `files` delta set
 *  from `from`, whose entries are `delta` (the probe frame, when the base file is the probe
 *  base) or raw `blob` entries. */
export async function treePack(o: {
  packId: string;
  version: string;
  seq: number;
  files: Record<string, Uint8Array | string>;
  from?: TreePack;
  activation?: string;
  entitlement?: string;
  type?: string;
  memBytes?: number;
}): Promise<TreePack> {
  const files: Record<string, Uint8Array> = {};
  for (const [p, b] of Object.entries(o.files))
    files[p] = typeof b === "string" ? enc(b) : b;
  const paths = Object.keys(files).sort(cmp);
  const entries = paths.map((path) => {
    const b = files[path]!;
    return {
      path,
      size: b.byteLength,
      sha256: sha(b),
      blob: { sha256: sha(b), bytes: b.byteLength, codec: "none" },
    };
  });
  const treeDigest = sha(
    entries.map((e) => `${e.sha256} ${e.size} ${e.path}\n`).join(""),
  );
  const size = entries.reduce((a, e) => a + e.size, 0);
  const index = enc(
    JSON.stringify({
      format: "pkey-files/1",
      layout: "tree",
      payload: { size, sha256: treeDigest },
      files: entries,
    }),
  );
  const full = Buffer.concat(paths.map((p) => files[p]!));
  const objects = new Map<string, Uint8Array>();
  objects.set(sha(index), index);
  objects.set(sha(full), new Uint8Array(full));
  for (const p of paths) objects.set(sha(files[p]!), files[p]!);

  const deltas: unknown[] = [];
  if (o.from) {
    const baseByPath = o.from.files;
    const baseHashes = new Set(Object.values(baseByPath).map((b) => sha(b)));
    const parts: Uint8Array[] = [];
    let offset = 0;
    let memBytes = 1;
    const pe: unknown[] = [];
    for (const e of entries) {
      if (baseHashes.has(e.sha256)) continue;
      const base = baseByPath[e.path];
      const b = files[e.path]!;
      if (
        base &&
        sha(base) === sha(PROBE_BASE) &&
        sha(b) === sha(PROBE_TARGET)
      ) {
        pe.push({
          path: e.path,
          op: "delta",
          from: sha(base),
          to: e.sha256,
          size: e.size,
          offset,
          length: PROBE_FRAME.byteLength,
        });
        parts.push(PROBE_FRAME);
        offset += PROBE_FRAME.byteLength;
        memBytes = Math.max(memBytes, base.byteLength + b.byteLength);
      } else {
        pe.push({
          path: e.path,
          op: "blob",
          to: e.sha256,
          size: e.size,
          codec: "none",
          offset,
          length: b.byteLength,
        });
        parts.push(b);
        offset += b.byteLength;
        memBytes = Math.max(memBytes, b.byteLength);
      }
    }
    const data = new Uint8Array(Buffer.concat(parts));
    const patch = enc(
      JSON.stringify({
        format: "pkey-patch/1",
        scope: "files",
        method: "zstd-patch-from",
        from: o.from.treeDigest,
        to: treeDigest,
        data: { sha256: sha(data), bytes: data.byteLength },
        entries: pe,
      }),
    );
    if (data.byteLength > 0) {
      objects.set(sha(patch), patch);
      objects.set(sha(data), data);
      deltas.push({
        method: "zstd-patch-from",
        scope: "files",
        from: o.from.treeDigest,
        memBytes: o.memBytes ?? memBytes,
        patch: {
          sha256: sha(patch),
          bytes: patch.byteLength,
          size: patch.byteLength,
          codec: "none",
        },
        data: { sha256: sha(data), bytes: data.byteLength },
      });
    }
  }

  const record = {
    schemaVersion: 1,
    aud: PRODUCT,
    deliverable: o.packId,
    kind: "pack",
    version: o.version,
    seq: o.seq,
    issuedAt: 1759300000 + o.seq,
    type: o.type ?? "files.tree",
    formatVersion: 1,
    handler: { activation: o.activation ?? "hot" },
    ...(o.entitlement ? { entitlement: o.entitlement } : {}),
    variants: [
      {
        variant: {},
        payload: { size, sha256: treeDigest },
        full: {
          sha256: sha(full),
          bytes: full.byteLength,
          size: full.byteLength,
          codec: "none",
        },
        files: {
          format: "pkey-files/1",
          layout: "tree",
          sha256: sha(index),
          bytes: index.byteLength,
          size: index.byteLength,
          codec: "none",
        },
        ...(deltas.length ? { deltas } : {}),
      },
    ],
  };
  const jws = await signJws(
    record,
    key(RELEASE_KID).privateKeyPkcs8Pem,
    RELEASE_KID,
    "pkey-release+jws",
  );
  return {
    packId: o.packId,
    version: o.version,
    seq: o.seq,
    jws,
    recordSha256: sha(jws),
    treeDigest,
    size,
    objects,
    files,
    indexSha256: sha(index),
    fullSha256: sha(full),
  };
}

/** A content stamp's body pinning these releases (all required, essential). */
export function stampFor(...packs: TreePack[]) {
  return {
    contentApi: 1,
    pins: packs.map((p) => ({
      pack: p.packId,
      release: { sha256: p.recordSha256, seq: p.seq, version: p.version },
    })),
    expects: packs.map((p) => ({
      pack: p.packId,
      required: true,
      delivery: "essential",
    })),
  };
}

/** A marker (`pkey-marker/1`) for an embedded copy of `pack`. */
export function markerFor(pack: TreePack): string {
  return JSON.stringify({
    format: "pkey-marker/1",
    packId: pack.packId,
    version: pack.version,
    release: pack.jws,
  });
}

/** A fake byte server over every pack's records and objects. `cut` makes the next GET of an
 *  object stop after that many bytes (an interrupted download). */
export function byteServer(...packs: TreePack[]) {
  const records = new Map(packs.map((p) => [p.recordSha256, p.jws]));
  const objects = new Map<string, Uint8Array>();
  for (const p of packs) for (const [h, b] of p.objects) objects.set(h, b);
  const calls: { sha256: string; offset: number; ifRange: string | null }[] =
    [];
  const server = {
    calls,
    cut: null as number | null,
    fetchRecord: async (h: string) => {
      const body = records.get(h);
      return body === undefined
        ? ({ ok: false, code: "not_found" } as const)
        : ({ ok: true, body } as const);
    },
    fetchObject: async (req: {
      sha256: string;
      offset: number;
      ifRange: string | null;
    }): Promise<ObjectResponse> => {
      calls.push(req);
      const b = objects.get(req.sha256);
      if (!b)
        return {
          status: 404,
          contentRange: null,
          chunks: (async function* () {})(),
        };
      const ranged = req.offset > 0 && req.ifRange === `"${req.sha256}"`;
      const body = ranged ? b.subarray(req.offset) : b;
      const cut = server.cut;
      server.cut = null;
      return {
        status: ranged ? 206 : 200,
        contentRange: ranged
          ? `bytes ${req.offset}-${b.byteLength - 1}/${b.byteLength}`
          : null,
        chunks: (async function* () {
          if (cut !== null) {
            yield body.subarray(0, cut);
            throw new Error("connection reset");
          }
          for (let at = 0; at < body.byteLength; at += 7)
            yield body.subarray(at, at + 7);
        })(),
      };
    },
  };
  return server;
}
/** A `kind: revocation` record (plans/P4-13.md §2.3) revoking `target`, signed with the release
 *  key (or `kid`'s key), and its feed entry. */
export async function revocationFor(
  target: TreePack,
  o: {
    replacement?: TreePack;
    issuedAt?: number;
    reason?: string;
    kid?: string;
  } = {},
): Promise<{
  jws: string;
  record: string;
  entry: {
    record: string;
    pack: string;
    target: string;
    version: string;
    seq: number;
  };
}> {
  const kid = o.kid ?? RELEASE_KID;
  const jws = await signJws(
    {
      schemaVersion: 1,
      aud: PRODUCT,
      deliverable: target.packId,
      kind: "revocation",
      version: target.version,
      seq: target.seq,
      issuedAt: o.issuedAt ?? 1759350000,
      revokes: target.recordSha256,
      ...(o.replacement
        ? {
            replacement: {
              sha256: o.replacement.recordSha256,
              seq: o.replacement.seq,
              version: o.replacement.version,
            },
          }
        : {}),
      reason: o.reason ?? "Withdrawn in a test.",
    },
    key(kid).privateKeyPkcs8Pem,
    kid,
    "pkey-release+jws",
  );
  const record = sha(jws);
  return {
    jws,
    record,
    entry: {
      record,
      pack: target.packId,
      target: target.recordSha256,
      version: target.version,
      seq: target.seq,
    },
  };
}
