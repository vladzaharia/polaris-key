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
import { buildHooks } from "../../../src/core/hooks.js";
import { loadProductPublic } from "../../../src/core/products.js";
import { SERVICES } from "../../../src/mount.js";
import {
  SLUG,
  macBuild,
  model,
  setup,
  type World,
} from "../../downloadWorld.js";

/** The user-facing files `customerDownloads` lists for the newest stable release. */
async function customerFiles(w: World) {
  const product = await loadProductPublic(w.db, SLUG);
  const h = await buildHooks(SERVICES, product!.services, {
    env: w.env,
    db: w.db,
    product: product!,
    now: NOW,
  });
  const d = await h.delivery()!.customerDownloads!({
    channel: "stable",
    limit: 1,
  });
  return d!.releases[0]!.files;
}

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
  const ios = { platform: "ios", arches: ["arm64"] };
  const mac = { platform: "macos", arches: ["universal"] };
  const named = (arch: string, format: string | null) => [
    { platform: "macos", arch, format },
  ];
  const platforms = (
    facts: Parameters<typeof storeLink>[2],
    built: Parameters<typeof storeLink>[3] = [],
  ) => storeLink("app-store", identity, facts, built)?.platforms;

  it("adds the Mac only for a universal or arm64 pkg the outlet names", () => {
    expect(platforms([ios, mac], named("arm64", "pkg"))).toEqual([
      "ios",
      "macos",
    ]);
    expect(platforms([ios, mac], named("universal", "pkg"))).toEqual([
      "ios",
      "macos",
    ]);
  });

  it("gives an x64 pkg, a dmg or an unnamed build no Mac App Store", () => {
    expect(platforms([ios, mac], named("x86_64", "pkg"))).toEqual(["ios"]);
    expect(platforms([ios, mac], named("universal", "dmg"))).toEqual(["ios"]);
    expect(platforms([ios, mac], [])).toEqual(["ios"]);
  });

  it("names the Mac listing the Mac App Store", () => {
    const link = storeLink(
      "app-store",
      identity,
      [ios, mac],
      named("arm64", "pkg"),
    )!;
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
    expect(platforms([mac], named("x86_64", "pkg"))).toBeUndefined();
    expect(
      platforms([{ platform: "windows", arches: ["x86_64"] }]),
    ).toBeUndefined();
  });
});

describe("a Mac build the App Store outlet names (A-26b)", () => {
  const macActions = (m: Awaited<ReturnType<typeof model>>) => {
    const g = m.platforms.find((p) => p.platform === "macos")!;
    return g.actions.map((id) => m.actions.find((a) => a.id === id)!);
  };
  const names = (m: Awaited<ReturnType<typeof model>>) =>
    m.platforms.find((p) => p.platform === "macos")!.builds.map((b) => b.name);

  it("earns a Mac App Store row and is not listed as a download", async () => {
    const pkg = macBuild("mas", "universal", "pkg");
    const w = await setup({
      extraArtifacts: [pkg],
      appStore: { artifact: "mas" },
    });
    const m = await model(w);
    const store = macActions(m).find((a) => a.kind === "app-store")!;
    expect(store.label).toBe("Mac App Store");
    expect(names(m).some((n) => n.endsWith(".pkg"))).toBe(false);
    const d = await customerFiles(w);
    expect(d.some((f) => f.name.endsWith(".pkg"))).toBe(false);
    expect(d.some((f) => f.name.endsWith(".dmg"))).toBe(true);
  });

  it("leaves an unnamed pkg a download with no store row", async () => {
    const pkg = macBuild("direct", "universal", "pkg");
    const w = await setup({ extraArtifacts: [pkg] });
    const m = await model(w);
    expect(macActions(m).some((a) => a.kind === "app-store")).toBe(false);
    expect(names(m).some((n) => n.endsWith(".pkg"))).toBe(true);
    expect((await customerFiles(w)).some((f) => f.name.endsWith(".pkg"))).toBe(
      true,
    );
  });

  it("gives a universal dmg beside a named x64 pkg no store row", async () => {
    const pkg = macBuild("mas", "x86_64", "pkg");
    const w = await setup({
      extraArtifacts: [pkg],
      appStore: { artifact: "mas" },
    });
    expect(macActions(await model(w)).some((a) => a.kind === "app-store")).toBe(
      false,
    );
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
