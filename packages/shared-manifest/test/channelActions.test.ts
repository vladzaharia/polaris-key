import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  actionClassOf,
  actionClassOfKind,
  channelOfKind,
  customerActionOfKind,
  labelOn,
  offerPlatforms,
  offersForPlatform,
  findChannel,
} from "../src/index.js";

const offer = (kind: string, platforms: string[], outletId = "o1") => ({
  kind,
  platforms,
  outletId,
});

describe("channel classes come from the catalogue", () => {
  it("every channel with a customer action has a class, and only the install channel is a file", () => {
    for (const c of CHANNELS)
      expect(actionClassOf(c) === "file").toBe(c.customerAction === "install");
  });

  it("sorts the offer kinds the page uses", () => {
    expect(actionClassOfKind("download")).toBe("file");
    for (const k of [
      "app-store",
      "play",
      "ms-store",
      "steam",
      "itch",
      "flathub",
      "snap",
      "winget",
    ])
      expect(actionClassOfKind(k), k).toBe("store");
    for (const k of [
      "homebrew",
      "scoop",
      "altstore",
      "sidestore",
      "altstore-pal",
      "obtainium",
      "fdroid",
    ])
      expect(actionClassOfKind(k), k).toBe("source");
    expect(actionClassOfKind("nope")).toBeNull();
  });

  it("maps another offer of a channel to the channel", () => {
    expect(channelOfKind("sidestore")?.id).toBe("altstore");
    expect(customerActionOfKind("sidestore")).toBe("add-source");
  });
});

describe("offer order", () => {
  it("puts a Mac's download, the Mac App Store link and Homebrew together, in that order", () => {
    const got = offersForPlatform(
      [
        offer("homebrew", ["macos"]),
        offer("app-store", ["ios", "macos"]),
        offer("download", ["macos"]),
        offer("play", ["android"]),
      ],
      "macos",
    ).map((o) => o.kind);
    expect(got).toEqual(["download", "app-store", "homebrew"]);
  });

  it("puts the download first on every desktop, then the store", () => {
    for (const platform of ["macos", "windows", "linux"]) {
      const kinds = offersForPlatform(
        [
          offer("ms-store", [platform]),
          offer("flathub", [platform]),
          offer("app-store", [platform]),
          offer("download", [platform]),
        ],
        platform,
      ).map((o) => o.kind);
      expect(kinds[0], platform).toBe("download");
    }
  });

  it("follows the catalogue per platform (store first on iPhone, file first on desktop)", () => {
    const kinds = (platform: string) =>
      offersForPlatform(
        [
          offer("download", [platform]),
          offer("altstore-pal", [platform]),
          offer("sidestore", [platform]),
          offer("altstore", [platform]),
          offer("app-store", [platform]),
        ],
        platform,
      ).map((o) => o.kind);
    expect(kinds("ios")).toEqual([
      "app-store",
      "altstore",
      "sidestore",
      "altstore-pal",
      "download",
    ]);
  });

  it("breaks a tie by outlet and puts an unranked kind last", () => {
    const got = offersForPlatform(
      [
        offer("nope", ["linux"], "a"),
        offer("snap", ["linux"], "b"),
        offer("snap", ["linux"], "a"),
      ],
      "linux",
    );
    expect(got.map((o) => `${o.kind}:${o.outletId}`)).toEqual([
      "snap:a",
      "snap:b",
      "nope:a",
    ]);
  });
});

describe("platforms a channel serves for a product", () => {
  const appStore = findChannel("app-store")!;
  const have = [
    { platform: "ios", arches: ["arm64"] },
    { platform: "macos", arches: ["universal", "x86_64"] },
  ];
  const named = (arch: string, format: string | null) => [
    { platform: "macos", arch, format },
  ];
  it("serves a Mac only for one named universal or arm64 pkg", () => {
    expect(offerPlatforms(appStore, have, named("arm64", "pkg"))).toEqual([
      "ios",
      "macos",
    ]);
    expect(offerPlatforms(appStore, have, named("universal", "pkg"))).toEqual([
      "ios",
      "macos",
    ]);
    expect(offerPlatforms(appStore, have, named("x86_64", "pkg"))).toEqual([
      "ios",
    ]);
  });

  it("gives a Mac dmg, or no named build, no Mac App Store", () => {
    expect(offerPlatforms(appStore, have, named("universal", "dmg"))).toEqual([
      "ios",
    ]);
    expect(offerPlatforms(appStore, have)).toEqual(["ios"]);
    expect(offerPlatforms(appStore, have, named("universal", null))).toEqual([
      "ios",
    ]);
  });

  it("serves only the platforms the product has", () => {
    expect(
      offerPlatforms(appStore, [{ platform: "windows", arches: ["x86_64"] }]),
    ).toEqual([]);
  });

  it("claims no arch-limited platform when nothing is known", () => {
    expect(offerPlatforms(appStore, [])).toEqual(["ios"]);
    expect(offerPlatforms(findChannel("steam")!, [])).toEqual([
      "windows",
      "macos",
      "linux",
    ]);
  });
});

describe("a channel's name on a platform", () => {
  it("is the Mac App Store on a Mac, the catalogue label elsewhere", () => {
    expect(labelOn("app-store", "macos")).toBe("Mac App Store");
    expect(labelOn("app-store", "ios")).toBe("App Store");
    expect(labelOn("winget", "windows")).toBe("WinGet");
  });
});
