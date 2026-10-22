import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyAllow } from "../src/report.ts";
import type { PairResult } from "../src/pixeldiff.ts";

function rootWith(states: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "allow-"));
  mkdirSync(join(root, "packages/ui-qa"), { recursive: true });
  writeFileSync(
    join(root, "packages/ui-qa/cross-renderer-allow.json"),
    JSON.stringify({ states }),
  );
  return root;
}
const mismatch = (name: string, ratio = 0.05): PairResult => ({
  name,
  status: "mismatch",
  ratio,
  detail: name,
});
const match = (name: string): PairResult => ({
  name,
  status: "match",
  ratio: 0,
  detail: name,
});

describe("the cross-renderer allow list", () => {
  it("turns an allowed state's mismatch into a recorded finding, and leaves others failing", () => {
    const r = applyAllow(
      [mismatch("A.x/390-dark.png"), mismatch("B.y/390-dark.png")],
      rootWith({ "A.x": { reason: "why" } }),
    )!;
    expect(r.map((p) => p.status)).toEqual(["allowed", "mismatch"]);
  });
  it("fails an entry whose state now matches in full", () => {
    const r = applyAllow(
      [match("A.x/390-dark.png")],
      rootWith({ "A.x": { reason: "why" } }),
    )!;
    expect(r.at(-1)?.status).toBe("stale-allow");
  });
  it("tolerates a looping animation within the entry's own ratio, never stale", () => {
    const root = rootWith({ "A.x": { reason: "w", maxRatio: 0.01 } });
    expect(applyAllow([mismatch("A.x/1.png", 0.005)], root)![0]!.status).toBe(
      "allowed",
    );
    expect(applyAllow([mismatch("A.x/1.png", 0.05)], root)![0]!.status).toBe(
      "mismatch",
    );
    expect(applyAllow([match("A.x/1.png")], root)).toHaveLength(1);
  });
});
