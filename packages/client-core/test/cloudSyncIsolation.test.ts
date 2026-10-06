// T5 (plans/U-01.md §2.6): the Cloud Sync journal never reaches a licence or config gate. No
// module reachable from `gate.ts`, `store.ts` or `verify.ts` may import `cloud-sync`, so a sync
// response cannot change licence state by construction.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CloudSyncMachine,
  applySettingOp,
  formatHlc,
  parseHlc,
  valueValid,
} from "../src/cloud-sync.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every module reachable from `entry` through relative imports (static and type-only). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(SRC, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g,
    )) {
      const spec = m[1]!.replace(/\.js$/, ".ts");
      stack.push(
        resolve(dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`),
      );
    }
  }
  return seen;
}

describe("cloud-sync isolation (T5)", () => {
  for (const entry of ["gate.ts", "store.ts", "verify.ts"])
    it(`${entry} cannot reach cloud-sync`, () => {
      const files = [...reachable(entry)].map((f) => f.slice(SRC.length + 1));
      expect(files).toContain(entry);
      expect(files.filter((f) => f.startsWith("cloud-sync"))).toEqual([]);
    });

  it("the barrel does not re-export it either", () => {
    expect(readFileSync(join(SRC, "index.ts"), "utf8")).not.toMatch(
      /cloud-sync/,
    );
  });
});

describe("cloud-sync primitives", () => {
  it("formats and parses the HLC", () => {
    expect(formatHlc(1_760_000_000_000, 3)).toBe("0199c82cc000:0003");
    expect(parseHlc("0199c82cc000:0003")).toEqual([1_760_000_000_000, 3]);
    expect(() => formatHlc(-1, 0)).toThrow(RangeError);
    expect(() => formatHlc(0, 0x10000)).toThrow(RangeError);
    expect(() => parseHlc("0199c82cc000-0003")).toThrow();
  });

  it("applies setting ops by policy", () => {
    expect(applySettingOp("max", 5, { op: "set", value: 3 })).toBe(5);
    expect(applySettingOp("min", 5, { op: "set", value: 3 })).toBe(3);
    expect(applySettingOp("lastWrite", 5, { op: "set", value: 3 })).toBe(3);
    expect(applySettingOp("lastWrite", 5, { op: "clear" })).toBeUndefined();
    expect(
      applySettingOp(
        "merge",
        { a: 1 },
        { op: "setMember", member: "b", value: 2 },
      ),
    ).toEqual({
      a: 1,
      b: 2,
    });
    expect(
      applySettingOp(
        "merge",
        { a: 1, b: 2 },
        { op: "removeMember", member: "a" },
      ),
    ).toEqual({
      b: 2,
    });
  });

  it("checks the schema subset", () => {
    expect(valueValid(0.5, { type: "number", minimum: 0, maximum: 1 })).toBe(
      true,
    );
    expect(valueValid(1.5, { type: "number", minimum: 0, maximum: 1 })).toBe(
      false,
    );
    expect(valueValid(1.5, { type: "integer" })).toBe(false);
    expect(valueValid("x", { type: "string", enum: ["a"] })).toBe(false);
    expect(valueValid({}, { type: "object" })).toBe(true);
    expect(valueValid(null, undefined)).toBe(true);
  });

  it("refuses a response with nothing in flight and a malformed clientId", () => {
    const m = new CloudSyncMachine({
      product: "demo",
      catalog: { settings: [] },
      document: { values: {} },
      now: 0,
      newClientId: () => "c_short",
      subject: null,
    });
    expect(() => m.receive({ status: 200, body: {} })).toThrow(/no request/);
    expect(() => m.signIn("sub_a")).toThrow(/bad clientId/);
  });
});
