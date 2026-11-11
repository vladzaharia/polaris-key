/**
 * A-26 — customer channel actions: the download page and the portal read one catalogue-derived
 * model. The typed kind lists agree with the catalogue's classes, the page orders a platform's
 * offers by the catalogue, and a store carries the platforms the product ships and the channel
 * takes (the Mac App Store beside the iPhone's, for a universal or arm64 Mac build only).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionClassOfKind } from "@polaris-key/manifest";
import {
  INSTALL_SOURCE_KINDS,
  STORE_KINDS,
  storeLink,
  storeVariants,
} from "../../../src/services/distribution/page/model.js";
import { NOW } from "../../seed.js";
import { model, setup } from "../../downloadWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the page's kind lists are the catalogue's classes", () => {
  it("stores are store channels and install sources are source channels", () => {
    for (const k of STORE_KINDS) expect(actionClassOfKind(k), k).toBe("store");
    for (const k of INSTALL_SOURCE_KINDS)
      expect(actionClassOfKind(k), k).toBe("source");
  });
});

describe("store platforms come from the catalogue and the product", () => {
  const identity = { appleId: "1234567890" };
  const ios = { platform: "ios", arches: ["arm64"], formats: ["ipa"] };
  const mac = (arches: string[], formats: string[]) => ({
    platform: "macos",
    arches,
    formats,
  });
  const platforms = (facts: Parameters<typeof storeLink>[2]) =>
    storeLink("app-store", identity, facts)?.platforms;

  it("adds the Mac for a universal or arm64 pkg", () => {
    expect(platforms([ios, mac(["arm64"], ["pkg"])])).toEqual(["ios", "macos"]);
    expect(platforms([ios, mac(["universal"], ["pkg"])])).toEqual([
      "ios",
      "macos",
    ]);
  });

  it("gives an x64-only Mac, or a Mac dmg, no Mac App Store", () => {
    expect(platforms([ios, mac(["x86_64"], ["pkg"])])).toEqual(["ios"]);
    expect(platforms([ios, mac(["universal"], ["dmg"])])).toEqual(["ios"]);
  });

  it("names the Mac listing the Mac App Store", () => {
    const link = storeLink("app-store", identity, [
      ios,
      mac(["arm64"], ["pkg"]),
    ])!;
    expect(
      storeVariants("app-store", link).map((v) => [v.label, v.platforms]),
    ).toEqual([
      ["App Store", ["ios"]],
      ["Mac App Store", ["macos"]],
    ]);
  });

  it("claims the unchecked platforms only when nothing is known", () => {
    expect(platforms([])).toEqual(["ios"]);
    // Known platforms that fit none: no link at all.
    expect(platforms([mac(["x86_64"], ["pkg"])])).toBeUndefined();
    expect(
      platforms([
        { platform: "windows", arches: ["x86_64"], formats: ["exe"] },
      ]),
    ).toBeUndefined();
  });
});

describe("the page offers a platform's actions in the catalogue's order", () => {
  it("lists the download first on a Mac, the store first on an iPhone, and no Mac App Store for a dmg", async () => {
    const w = await setup();
    const m = await model(w);
    const kinds = (platform: string) => {
      const g = m.platforms.find((p) => p.platform === platform)!;
      return g.actions.map((id) => m.actions.find((a) => a.id === id)!.kind);
    };
    const mac = kinds("macos");
    expect(mac[0]).toBe("download");
    expect(kinds("ios")[0]).toBe("app-store");
    // The fixture's Mac build is a dmg: no Mac App Store row beside its download.
    expect(mac).not.toContain("app-store");
    // Homebrew's app and command-line tool are told apart, the app first.
    const brew = m.actions
      .filter((a) => a.kind === "homebrew")
      .map((a) => a.label);
    expect(brew).toEqual(["Homebrew (app)", "Homebrew (command-line tool)"]);
  });
});
