import { describe, expect, it } from "vitest";
import { diffSummary, lineDiff, structuredDiff } from "../../src/lib/diff.js";

const before = [
  { key: "a", label: "A" },
  { key: "b", label: "B" },
  { key: "c", label: "C", schema: { type: "string" } },
];
const after = [
  { key: "a", label: "A" },
  { key: "c", label: "C2", schema: { type: "integer" } },
  { key: "d", label: "D" },
];

describe("structuredDiff", () => {
  it("finds added, removed and changed entries with field changes", () => {
    const d = structuredDiff(before, after, "key");
    expect(d.added.map((c) => c.key)).toEqual(["d"]);
    expect(d.removed.map((c) => c.key)).toEqual(["b"]);
    expect(d.changed.map((c) => c.key)).toEqual(["c"]);
    expect(d.changed[0]!.fields).toEqual([
      { field: "label", before: "C", after: "C2" },
      {
        field: "schema",
        before: { type: "string" },
        after: { type: "integer" },
      },
    ]);
    expect(d.all).toHaveLength(3);
  });
  it("accepts a key function", () => {
    const d = structuredDiff(before, after, (e) => e.key.toUpperCase());
    expect(d.added[0]!.key).toBe("D");
  });
  it("summarises", () => {
    expect(diffSummary(structuredDiff(before, after, "key"))).toBe(
      "+1 key · −1 key · 1 changed",
    );
    expect(
      diffSummary({ added: [1, 2], removed: [], changed: [1, 2, 3] }),
    ).toBe("+2 keys · 3 changed");
    expect(diffSummary({ added: [], removed: [], changed: [] })).toBe(
      "No changes",
    );
  });
});

describe("lineDiff", () => {
  it("numbers context, removed and added lines", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\n")).toEqual([
      { kind: "context", text: "a", oldLine: 1, newLine: 1 },
      { kind: "removed", text: "b", oldLine: 2 },
      { kind: "added", text: "B", newLine: 2 },
      { kind: "context", text: "c", oldLine: 3, newLine: 3 },
    ]);
  });
});
