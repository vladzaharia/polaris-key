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

describe("api-check rule 1 (surface scanners)", () => {
  const TS = "tools/fixtures/api/surface.ts";
  const PY = "tools/fixtures/api/surface.py";
  const withSurface = (
    sdk: string,
    file: string,
    type: string | undefined,
    mutate: (api: any) => void = () => {},
  ): string[] =>
    run((a) => {
      a.surfaces = { [sdk]: [{ ns: "config", type, file }] };
      a.concepts = a.concepts.filter(
        (c: any) => !c.id.startsWith("config.") || c.id === "config.get",
      );
      mutate(a);
    });

  it("scans nothing while surfaces is empty", () => {
    expect(real().surfaces).toEqual({});
  });

  it("fails an unknown TypeScript verb; skips private, protected and _names", () => {
    const v = withSurface("node", TS, "FixtureClient");
    expect(v.sort()).toEqual(
      ["helper", "extra", "status"]
        .sort()
        .map(
          (n) =>
            `[rule 8] ${TS}: config.${n} is not a registry row, an sdks entry or an ignore entry`,
        ),
    );
  });

  it("accepts a row spelling, an ignore entry and an sdkOnly entry (TypeScript)", () => {
    const v = withSurface("node", TS, "FixtureClient", (a) => {
      a.ignore.push({ sdk: "node", path: "FixtureClient.helper", reason: "x" });
      a.concepts.push({
        id: "config.extra",
        kind: "method",
        sdks: { node: { sdkOnly: true, reason: "x" } },
      });
      a.concepts.push({
        id: "config.status",
        kind: "property",
        sdks: { node: {} },
      });
    });
    expect(v).toEqual([]);
  });

  it("an ignore entry for another SDK does not cover", () => {
    const v = withSurface("node", TS, "FixtureClient", (a) => {
      a.ignore.push({ sdk: "python", path: "config.helper", reason: "x" });
    });
    expect(v.some((l) => l.includes("config.helper"))).toBe(true);
  });

  it("scans a file's exported functions and consts when no type is given (React)", () => {
    const v = withSurface("react", TS, undefined);
    expect(v.sort()).toEqual(
      ["useOther", "useThing"].map(
        (n) =>
          `[rule 8] ${TS}: config.${n} is not a registry row, an sdks entry or an ignore entry`,
      ),
    );
    const ok = withSurface("react", TS, undefined, (a) => {
      a.concepts.push({
        id: "config.thing",
        kind: "hook",
        sdks: { react: { spelling: "useThing", shape: "hook" } },
      });
      a.ignore.push({ sdk: "react", path: "useOther", reason: "x" });
    });
    expect(ok).toEqual([]);
  });

  it("fails an unknown Python verb at class depth; skips _names, nested defs and other classes", () => {
    const v = withSurface("python", PY, "FixtureClient");
    expect(v.sort()).toEqual(
      ["get_value", "helper", "status", "sync_now"]
        .sort()
        .map(
          (n) =>
            `[rule 8] ${PY}: config.${n} is not a registry row, an sdks entry or an ignore entry`,
        ),
    );
  });

  it("accepts snake-cased rows, ignore and sdkOnly entries (Python)", () => {
    const v = withSurface("python", PY, "FixtureClient", (a) => {
      a.concepts.push({
        id: "config.getValue",
        kind: "method",
        sdks: { python: {} },
      });
      a.ignore.push({ path: "config.get_value", reason: "x" });
      a.ignore.push({ path: "FixtureClient.helper", reason: "x" });
      a.concepts.push({
        id: "config.syncNow",
        kind: "method",
        sdks: { python: { sdkOnly: true, reason: "x" } },
      });
      a.concepts.push({
        id: "config.status",
        kind: "property",
        sdks: { python: {} },
      });
    });
    expect(v).toEqual([]);
  });

  it("fails a surface file that does not exist", () => {
    expect(withSurface("node", "tools/fixtures/api/nope.ts", "X")).toEqual([
      "[rule 8] tools/fixtures/api/nope.ts: surface file not found",
    ]);
  });
});
