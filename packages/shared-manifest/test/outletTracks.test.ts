/**
 * P2-08 — the built-in channels and the default channel → lane maps of the store outlets.
 */
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_CHANNELS,
  DEFAULT_OUTLET_TRACKS,
  effectiveTrackMap,
} from "../src/index.js";

describe("built-in channels", () => {
  it("are stable, beta and dev", () => {
    expect(BUILT_IN_CHANNELS).toEqual(["stable", "beta", "dev"]);
  });
});

describe("effectiveTrackMap", () => {
  it("gives each outlet its default lanes when nothing is declared", () => {
    expect(effectiveTrackMap("play")).toEqual({
      stable: "production",
      beta: "beta",
      dev: "internal",
    });
    expect(effectiveTrackMap("play-testing", {})).toEqual(
      effectiveTrackMap("play"),
    );
    expect(effectiveTrackMap("testflight")).toEqual({
      beta: "external",
      dev: "internal",
    });
    expect(effectiveTrackMap("steam")).toEqual({
      stable: "default",
      beta: "beta",
      dev: "dev",
    });
    expect(effectiveTrackMap("ms-store")).toEqual({ beta: "beta" });
    expect(effectiveTrackMap("snap")).toEqual({
      stable: "stable",
      beta: "beta",
      dev: "edge",
    });
  });

  it("lets a declared entry win per channel and fills in the rest", () => {
    expect(effectiveTrackMap("play", { beta: "alpha" })).toEqual({
      stable: "production",
      beta: "alpha",
      dev: "internal",
    });
    expect(effectiveTrackMap("steam", { playtest: "playtest" })).toEqual({
      stable: "default",
      beta: "beta",
      dev: "dev",
      playtest: "playtest",
    });
  });

  it("never writes back into the table or the declaration", () => {
    const declared = { beta: "alpha" };
    effectiveTrackMap("play", declared);
    expect(declared).toEqual({ beta: "alpha" });
    expect(DEFAULT_OUTLET_TRACKS.play).toEqual({
      stable: "production",
      beta: "beta",
      dev: "internal",
    });
  });

  it("returns only the declaration for a kind with no defaults, and for a prototype key", () => {
    expect(effectiveTrackMap("itch", { stable: "x" })).toEqual({ stable: "x" });
    expect(effectiveTrackMap("constructor")).toEqual({});
  });
});
