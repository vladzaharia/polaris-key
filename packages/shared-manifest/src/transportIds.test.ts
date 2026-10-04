import { describe, expect, it } from "vitest";
import {
  assetPackId,
  parseAssetPackId,
  resolveAssetPackIds,
  resolvePadPackNames,
  TransportIdError,
} from "./index.js";

function problems(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TransportIdError);
    return (e as TransportIdError).problems.map((p) => [p.code, p.packId]);
  }
  throw new Error("expected a TransportIdError");
}

describe("asset-pack ids (P5-08, notes/S-01 §Recommendation)", () => {
  it("maps <pack>-c<contentApi>, rewriting only dots", () => {
    expect(assetPackId("foes", 3)).toBe("foes-c3");
    expect(assetPackId("diceroll.foes", 3)).toBe("diceroll-foes-c3");
    expect(parseAssetPackId("diceroll-foes-c12")).toEqual({
      base: "diceroll-foes",
      level: 12,
    });
    expect(parseAssetPackId("foes")).toBeNull();
    expect([...resolveAssetPackIds(["diceroll.foes", "audio"], 4)]).toEqual([
      ["audio", "audio-c4"],
      ["diceroll.foes", "diceroll-foes-c4"],
    ]);
  });

  it("refuses collisions, double hyphens and overlong ids, all at once", () => {
    expect(
      problems(() => resolveAssetPackIds(["x.foes", "x-foes"], 3)),
    ).toEqual([["asset-pack-id-collision", "x.foes"]]);
    expect(problems(() => resolveAssetPackIds(["x-.foes"], 3))).toEqual([
      ["asset-pack-id-invalid", "x-.foes"],
    ]);
    const long = `a${"b".repeat(61)}`;
    expect(long).toHaveLength(62);
    expect(problems(() => resolveAssetPackIds([long], 3))).toEqual([
      ["asset-pack-id-too-long", long],
    ]);
    expect(
      problems(() => resolveAssetPackIds(["Foes_1", "x.-foes", "ok"], 1)),
    ).toEqual([
      ["asset-pack-id-invalid", "Foes_1"],
      ["asset-pack-id-invalid", "x.-foes"],
    ]);
  });
});

describe("Play asset-pack names (P5-08)", () => {
  it("maps dots and hyphens to underscores and refuses collisions", () => {
    expect([...resolvePadPackNames(["diceroll.foes", "big-audio"])]).toEqual([
      ["big-audio", "big_audio"],
      ["diceroll.foes", "diceroll_foes"],
    ]);
    expect(problems(() => resolvePadPackNames(["a.b", "a-b"]))).toEqual([
      ["pad-pack-name-collision", "a.b"],
    ]);
  });
});
