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
  const platforms = (facts: { platform: string; arches: string[] }[]) =>
    storeLink("app-store", identity, facts)!.platforms;

  it("adds the Mac for a universal or arm64 build, never for x64 alone", () => {
    const ios = { platform: "ios", arches: ["arm64"] };
    expect(platforms([ios, { platform: "macos", arches: ["arm64"] }])).toEqual([
      "ios",
      "macos",
    ]);
    expect(
      platforms([ios, { platform: "macos", arches: ["universal"] }]),
    ).toEqual(["ios", "macos"]);
    expect(platforms([ios, { platform: "macos", arches: ["x86_64"] }])).toEqual(
      ["ios"],
    );
  });

  it("keeps the unchecked platforms when the product names none", () => {
    expect(platforms([])).toEqual(["ios"]);
    expect(platforms([{ platform: "windows", arches: ["x86_64"] }])).toEqual([
      "ios",
    ]);
  });
});

describe("the page offers a platform's actions in the catalogue's order", () => {
  it("lists a Mac's download before the Mac App Store, and the iPhone's store first", async () => {
    const w = await setup();
    const m = await model(w);
    const kinds = (platform: string) => {
      const g = m.platforms.find((p) => p.platform === platform)!;
      return g.actions.map((id) => m.actions.find((a) => a.id === id)!.kind);
    };
    const mac = kinds("macos");
    expect(mac[0]).toBe("download");
    expect(mac).toContain("app-store");
    expect(mac.indexOf("download")).toBeLessThan(mac.indexOf("app-store"));
    expect(kinds("ios")[0]).toBe("app-store");
  });
});
