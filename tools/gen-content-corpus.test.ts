// plans/P4-10.md decision 15: `--rebuild-content-blobs` may only ADD blobs and `refs.json`
// entries. The guard (`additionsOnly`) is pure and always tested; the full rebuild runs where the
// pinned zstd CLI (1.5.7) is on PATH, because only that build reproduces the committed frames.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTENT_BLOBS_DIR,
  additionsOnly,
  rebuildContentBlobs,
  type RefJson,
} from "./gen-content-corpus.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temporary copy of `content/blobs/`. */
function copyBlobs(): string {
  const d = mkdtempSync(join(tmpdir(), "pkey-blobs-"));
  dirs.push(d);
  cpSync(CONTENT_BLOBS_DIR, d, { recursive: true });
  return d;
}

/** Every file under `dir`, by relative name, with its bytes (hex). */
function snapshot(dir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    const name = prefix ? `${prefix}/${e}` : e;
    if (statSync(p).isDirectory())
      for (const [k, v] of snapshot(p, name)) out.set(k, v);
    else out.set(name, readFileSync(p).toString("hex"));
  }
  return out;
}

const bytesOf = (dir: string): Map<string, Uint8Array> => {
  const m = new Map<string, Uint8Array>();
  for (const [k, v] of snapshot(dir)) m.set(k, Buffer.from(v, "hex"));
  return m;
};

const flip = (dir: string, name: string): void => {
  const p = join(dir, ...name.split("/"));
  const b = readFileSync(p);
  const at = Math.floor(b.length / 2);
  b[at] = b[at]! ^ 1;
  writeFileSync(p, b);
};

describe("additionsOnly (plans/P4-10.md decision 15)", () => {
  it("accepts the committed set unchanged and writes nothing", () => {
    const d = copyBlobs();
    expect(additionsOnly(bytesOf(d), d)).toEqual([]);
  });

  it("lists a new blob to write", () => {
    const d = copyBlobs();
    const next = bytesOf(d);
    next.set("bundles/new", new Uint8Array([1, 2, 3]));
    expect(additionsOnly(next, d)).toEqual(["bundles/new"]);
  });

  it("throws when an existing blob would change, and writes nothing", () => {
    const d = copyBlobs();
    const next = bytesOf(d);
    flip(d, "tree/t1.full.zst");
    const before = snapshot(d);
    expect(() => additionsOnly(next, d)).toThrow(
      /tree\/t1\.full\.zst would change/,
    );
    expect(snapshot(d)).toEqual(before);
  });

  it("throws when an existing blob would disappear", () => {
    const d = copyBlobs();
    const next = bytesOf(d);
    next.delete("chunks/dup.pkc");
    expect(() => additionsOnly(next, d)).toThrow(
      /chunks\/dup\.pkc would be removed/,
    );
  });

  it("refs.json may gain entries, never change one", () => {
    const d = copyBlobs();
    const refs = JSON.parse(readFileSync(join(d, "refs.json"), "utf8")) as {
      zstd: string;
      refs: Record<string, Record<string, unknown>>;
    };
    const grown = bytesOf(d);
    grown.set(
      "refs.json",
      Buffer.from(
        JSON.stringify({
          ...refs,
          refs: {
            ...refs.refs,
            "x/new.zst": { sha256: "0".repeat(64), bytes: 1, size: 2 },
          },
        }),
      ),
    );
    expect(additionsOnly(grown, d)).toEqual(["refs.json"]);
    const changed = bytesOf(d);
    const first = Object.keys(refs.refs)[0]!;
    changed.set(
      "refs.json",
      Buffer.from(
        JSON.stringify({
          ...refs,
          refs: { ...refs.refs, [first]: { ...refs.refs[first], bytes: 1 } },
        }),
      ),
    );
    expect(() => additionsOnly(changed, d)).toThrow(/refs\.json entries/);
  });
});

function zstd157(): boolean {
  try {
    return /v1\.5\.7\b/.test(
      execFileSync("zstd", ["-V"], { encoding: "utf8" }),
    );
  } catch {
    return false;
  }
}

// Strict JSON is not needed by the rebuild (it reads payloads, never parses an index as JSON
// strictly); a plain parser stands in for sign-corpus.ts's reference.
const REF: RefJson = {
  parseStrict: (text) => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  },
  nonWire: () => [],
  stampContentClaims: () => true,
  stampHolds: () => [],
};

describe.skipIf(!zstd157())(
  "--rebuild-content-blobs over a temporary copy (zstd 1.5.7)",
  () => {
    it("reproduces every committed blob and adds nothing", () => {
      const d = copyBlobs();
      const before = snapshot(d);
      rebuildContentBlobs(REF, { blobsDir: d });
      expect(snapshot(d)).toEqual(before);
    }, 120_000);

    it("throws, writing nothing, when one existing blob was altered", () => {
      const d = copyBlobs();
      flip(d, "patch/v1-v2.tree.data");
      rmSync(join(d, "chunks", "dup.pkc"));
      const before = snapshot(d);
      expect(() => rebuildContentBlobs(REF, { blobsDir: d })).toThrow(
        /patch\/v1-v2\.tree\.data would change/,
      );
      // The missing chunks/dup.pkc is an addition the guard would allow, but nothing is written.
      expect(snapshot(d)).toEqual(before);
    }, 120_000);
  },
);
