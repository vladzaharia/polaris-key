/**
 * P4-28: the reference check's parts (`packRefs.ts`). The shared fixtures in godotFixtures.test.ts
 * pin the whole lint against the device; these pin the UID codec and the list parser.
 */
import { describe, expect, it } from "vitest";
import {
  attachableEntryProblem,
  canonicalUid,
  parseAttachable,
  uidText,
} from "../src/packRefs.js";

describe("UIDs (ResourceUID's text form)", () => {
  it("round-trips ids, the engine's way", () => {
    for (const id of [0n, 1n, 33n, 34n, 4242n, 987654321n, 0x7fffffffffffffffn])
      expect(canonicalUid(uidText(id))).toBe(id);
    expect(uidText(0x7fffffffffffffffn)).toBe("uid://d4n4ub6itg400");
    expect(uidText(-1n)).toBe("uid://<invalid>");
  });
  it("refuses every non-canonical spelling", () => {
    for (const t of [
      "uid://",
      "uid://zz",
      "uid://9",
      "uid://ab",
      "uid://A",
      "uid://d4n4ub6itg401",
      "uid://aaaaaaaaaaaaaa",
      "uid://<invalid>",
      "res://x",
    ])
      expect(canonicalUid(t), t).toBeNull();
  });
});

describe("the attachable list", () => {
  it("takes res:// paths, res://…/ directories and canonical UIDs", () => {
    const a = parseAttachable([
      "res://scripts/die.gd",
      "res://scripts/dice/",
      uidText(4242n),
    ]);
    expect([...a.paths]).toEqual(["res://scripts/die.gd"]);
    expect(a.dirs).toEqual(["res://scripts/dice/"]);
    expect([...a.uids]).toEqual([4242n]);
  });
  it("throws on a malformed entry", () => {
    for (const s of [
      "scripts/die.gd",
      "res://",
      "res:///",
      "res://a/../b.gd",
      "res://a//b.gd",
      "uid://zz",
      "user://x.gd",
    ]) {
      expect(attachableEntryProblem(s), s).not.toBeNull();
      expect(() => parseAttachable([s]), s).toThrow(/attachable entry/);
    }
  });
});
