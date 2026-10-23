import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_PATH, checkApi } from "./api-check.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const real = (): any => JSON.parse(readFileSync(join(root, API_PATH), "utf8"));
const run = (mutate: (api: any) => void): string[] => {
  const api = real();
  mutate(api);
  return checkApi(root, { api });
};
const concept = (api: any, id: string): any =>
  api.concepts.find((c: any) => c.id === id);

describe("api-check rule 4", () => {
  it("passes on the committed api.json", () => {
    expect(checkApi(root)).toEqual([]);
  });

  it("fails the schema", () => {
    const v = run((a) => {
      a.apiVersion = 2;
      concept(a, "config.get").kind = "verb";
    });
    expect(v.length).toBeGreaterThan(0);
    expect(
      v.every((l) => l.startsWith("[rule 8] conformance/parity/api.json")),
    ).toBe(true);
  });

  it("fails a planned package that is unknown", () => {
    const v = run((a) => {
      concept(a, "config.get").sdks.node.planned = "NOPE-1";
    });
    expect(v).toEqual([
      "[rule 8] config.get (node planned): NOPE-1 is not a work package",
    ]);
  });

  it("fails a planned package that is done", () => {
    const v = run((a) => {
      concept(a, "config.get").sdks.node.planned = "P0-42";
    });
    expect(v).toEqual([
      "[rule 8] config.get (node planned): P0-42 is done; drop the entry or row",
    ]);
  });

  it("fails an unknown feature and an unknown enum", () => {
    const v = run((a) => {
      concept(a, "config.get").feature = "config.nope";
      concept(a, "events").enum = "noSuchEnum";
    });
    expect(v).toContain('[rule 8] config.get: unknown feature "config.nope"');
    expect(v).toContain('[rule 8] events: unknown enum "noSuchEnum"');
  });

  it("fails a reserved package that is not a work package", () => {
    const v = run((a) => {
      concept(a, "client.doctor").reserved = "NOPE-2";
    });
    expect(v).toEqual([
      "[rule 8] client.doctor (reserved): NOPE-2 is not a work package",
    ]);
  });

  it("fails a common-word removal without a scan, and accepts one with a scan", () => {
    const row = {
      sdk: "python",
      from: "trust",
      to: "options.pinnedKeys",
      package: "SP-35",
    };
    expect(run((a) => a.removed.push(row))).toEqual([
      '[rule 8] removed trust: a common word needs its own "scan" (pattern or files)',
    ]);
    expect(
      run((a) => a.removed.push({ ...row, scan: { files: ["*.py"] } })),
    ).toEqual([]);
  });

  it("accepts a removal whose name is not a common word", () => {
    expect(
      run((a) =>
        a.removed.push({
          sdk: "node",
          from: "config.getConfig",
          to: "config.get",
          package: "SP-35",
        }),
      ),
    ).toEqual([]);
  });
});
