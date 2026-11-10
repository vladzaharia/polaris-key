// The archive `exportToSink` produces is a standard zip (WIRE-CONTRACT-V5 §13.12, "Container"):
// `unzip -t` accepts it and Python's `zipfile` reads it back to the same entries. Both skip
// cleanly where the tool is missing. The writer's zip32 refusal and a cancel are checked here too.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cp from "node:child_process";
import { fileURLToPath } from "node:url";
import { PolarisError } from "@polaris-key/client-core";
import { ZipStoreWriter } from "@polaris-key/client-core/sync";
import {
  readStoredZip,
  runExportCase,
  type ExportCase,
} from "./syncExportSuite.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rows = (
  JSON.parse(
    fs.readFileSync(
      path.join(here, "..", "..", "corpus", "v2", "sync-vectors.json"),
      "utf8",
    ),
  ) as { exportCases: ExportCase[] }
).exportCases;
// A server archive, an end-to-end one with a partial multi-segment file, and a chunked one.
const PICK = ["server-basic", "e2e-file-truncated", "chunks-e2e-basic"];

const has = (cmd: string, args: string[]): boolean => {
  const r = cp.spawnSync(cmd, args, { stdio: "ignore" });
  return r.error === undefined;
};
const haveUnzip = has("unzip", ["-v"]);
const havePython = has("python3", ["--version"]);

/** Runs a row, writes its archive to a throwaway directory and hands the file to `check`. */
async function withArchive(
  row: ExportCase,
  check: (file: string) => void,
): Promise<void> {
  const { run, error } = await runExportCase(row);
  if (error !== undefined) throw error;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkey-export-"));
  try {
    const file = path.join(dir, "export.zip");
    fs.writeFileSync(file, run.zip);
    check(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LIST_ENTRIES =
  "import sys, zipfile, hashlib, json\n" +
  "z = zipfile.ZipFile(sys.argv[1])\n" +
  "assert z.testzip() is None\n" +
  "print(json.dumps([[i.filename, hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()]))\n";

describe("exportCases: the archive is a standard zip", () => {
  for (const id of PICK) {
    const row = rows.find((r) => r.id === id)!;
    it.skipIf(!haveUnzip)(`${id}: unzip -t accepts it`, () =>
      withArchive(row, (file) => {
        const r = cp.spawnSync("unzip", ["-t", file], { encoding: "utf8" });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain("No errors detected");
      }),
    );
    it.skipIf(!havePython)(`${id}: zipfile reads the same entries`, () =>
      withArchive(row, (file) => {
        const r = cp.spawnSync("python3", ["-I", "-c", LIST_ENTRIES, file], {
          encoding: "utf8",
        });
        expect(r.status, r.stderr).toBe(0);
        const entries = "entries" in row.expect ? row.expect.entries : [];
        expect(JSON.parse(r.stdout)).toEqual(
          entries.map((e) => [e.name, e.sha256Hex]),
        );
      }),
    );
  }
});

describe("ZipStoreWriter", () => {
  const collect = (): {
    parts: Uint8Array[];
    sink: { write(c: Uint8Array): void };
  } => {
    const parts: Uint8Array[] = [];
    return {
      parts,
      sink: { write: (c) => void parts.push(Uint8Array.from(c)) },
    };
  };
  const join2 = (parts: Uint8Array[]): Uint8Array =>
    new Uint8Array(Buffer.concat(parts));

  it("lists the central directory in the order named, and reads back", async () => {
    const { parts, sink } = collect();
    const z = new ZipStoreWriter(sink);
    await z.addBytes("b.txt", new TextEncoder().encode("second"));
    await z.addBytes("a.txt", new TextEncoder().encode("first"));
    await z.finish(["a.txt", "b.txt"]);
    const got = readStoredZip(join2(parts));
    expect(got.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
    expect(new TextDecoder().decode(got[0]!.data)).toBe("first");
  });

  it("refuses with sync-export-too-large before it writes past the limit", async () => {
    const { parts, sink } = collect();
    const z = new ZipStoreWriter(sink, 400);
    await z.begin("x");
    let error: unknown;
    try {
      for (let i = 0; i < 10; i++) await z.write(new Uint8Array(100));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PolarisError);
    expect((error as PolarisError).code).toBe("sync-export-too-large");
    // Whatever was written fits the limit with the records the archive still owes.
    expect(join2(parts).length).toBeLessThanOrEqual(400);
  });

  it("refuses an entry whose header would not fit", async () => {
    const { sink } = collect();
    const z = new ZipStoreWriter(sink, 100);
    await expect(z.begin("x".repeat(40))).rejects.toMatchObject({
      code: "sync-export-too-large",
    });
  });
});

describe("exportToSink: cancel", () => {
  it("ends with cancelled once the signal aborts, and writes nothing more", async () => {
    const row = rows.find((r) => r.id === "server-basic")!;
    const ctl = new AbortController();
    ctl.abort();
    const { exportToSink, webCryptoSyncPort } =
      await import("@polaris-key/client-core/sync");
    const writes: number[] = [];
    let error: unknown;
    try {
      await exportToSink(
        {
          product: row.product,
          exportedAt: row.exportedAt,
          unsynced: 0,
          includeRevisions: false,
          changes: row.changes,
          port: webCryptoSyncPort,
          root: null,
          signal: ctl.signal,
          files: {
            pointers: async () => [],
            stored: () => (async function* () {})(),
            chunk: async () => null,
          },
        },
        { write: (c) => void writes.push(c.length) },
      );
    } catch (e) {
      error = e;
    }
    expect((error as PolarisError).code).toBe("cancelled");
    expect(writes).toEqual([]);
  });
});
