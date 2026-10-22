import { describe, expect, it } from "vitest";
import { CHANNELS } from "./channels.generated.js";
import {
  KNOWN_FORMATS,
  archFits,
  channelFit,
  channelFitById,
  formatOfFile,
} from "./formats.js";

describe("KNOWN_FORMATS", () => {
  it("holds every format the catalogue names", () => {
    for (const c of CHANNELS)
      for (const f of c.formats)
        expect(Object.keys(KNOWN_FORMATS), `${c.id} ${f}`).toContain(f);
  });

  it("has no orphan: every format is named by a channel", () => {
    const named = new Set(CHANNELS.flatMap((c) => c.formats));
    for (const f of Object.keys(KNOWN_FORMATS))
      expect(named.has(f), f).toBe(true);
  });

  it("each channel format is built for a platform the channel serves", () => {
    for (const c of CHANNELS)
      for (const f of c.formats) {
        const k = KNOWN_FORMATS[f as keyof typeof KNOWN_FORMATS];
        expect(
          k.platforms.some((p) => c.platforms.includes(p)),
          `${c.id} ${f}`,
        ).toBe(true);
      }
  });
});

describe("formatOfFile", () => {
  it.each([
    ["Locker-1.2.dmg", "dmg"],
    ["app.tar.gz", "tar.gz"],
    ["app.tgz", "tar.gz"],
    ["App.AppImage", "appimage"],
    ["app.msixbundle", "msixbundle"],
    ["app.msix", "msix"],
    ["a.b.zip", "zip"],
    ["app.gz", null],
    ["app.bin", null],
    [".dmg", null],
    ["dmg", null],
  ])("%s -> %s", (name, want) => {
    expect(formatOfFile(name)).toBe(want);
  });
});

describe("archFits", () => {
  it("matches exact arches", () => {
    expect(archFits("arm64", ["arm64"])).toBe(true);
    expect(archFits("x86_64", ["arm64"])).toBe(false);
    expect(archFits("x86_64", ["universal", "arm64"])).toBe(false);
  });
  it("universal and any fit everything", () => {
    for (const a of ["universal", "any"]) {
      expect(archFits(a, ["arm64"])).toBe(true);
      expect(archFits(a, ["x86_64"])).toBe(true);
    }
  });
  it("an empty accepted list takes only universal and any", () => {
    expect(archFits("arm64", [])).toBe(false);
    expect(archFits("universal", [])).toBe(true);
  });
});

describe("channelFit", () => {
  const mac = (arch: string, format: string | null = "pkg") => ({
    platform: "macos",
    arch,
    format,
  });

  it("a macOS x86_64-only build fails the App Store on arch", () => {
    expect(channelFitById("app-store", [mac("x86_64")])).toEqual([
      { platform: "macos", fits: false, reasons: ["arch"] },
    ]);
    expect(channelFitById("testflight", [mac("x86_64")])?.[0]?.fits).toBe(
      false,
    );
  });

  it("universal and arm64 pass the App Store", () => {
    for (const a of ["universal", "arm64"])
      expect(channelFitById("app-store", [mac(a)])).toEqual([
        { platform: "macos", fits: true, reasons: [] },
      ]);
  });

  it("any fitting build is enough", () => {
    expect(
      channelFitById("app-store", [mac("x86_64"), mac("arm64")])?.[0]?.fits,
    ).toBe(true);
  });

  it("a wrong format fails on format; wrong format and arch gives both", () => {
    expect(channelFitById("app-store", [mac("universal", "dmg")])).toEqual([
      { platform: "macos", fits: false, reasons: ["format"] },
    ]);
    expect(
      channelFitById("app-store", [mac("x86_64", "dmg")])?.[0]?.reasons.sort(),
    ).toEqual(["arch", "format"]);
  });

  it("a Windows arm64 zip fits scoop and winget", () => {
    const zip = [{ platform: "windows", arch: "arm64", format: "zip" }];
    expect(channelFitById("scoop", zip)?.[0]?.fits).toBe(true);
    expect(channelFitById("winget", zip)?.[0]?.fits).toBe(true);
  });

  it("a Windows arm64 exe fits scoop and winget", () => {
    const exe = [{ platform: "windows", arch: "arm64", format: "exe" }];
    expect(channelFitById("scoop", exe)?.[0]?.fits).toBe(true);
    expect(channelFitById("winget", exe)?.[0]?.fits).toBe(true);
  });

  it("apk and aab fit Google Play", () => {
    for (const format of ["apk", "aab"])
      expect(
        channelFitById("google-play", [
          { platform: "android", arch: "arm64", format },
        ]),
      ).toEqual([{ platform: "android", fits: true, reasons: [] }]);
  });

  it("an ipa fits the App Store on iOS", () => {
    expect(
      channelFitById("app-store", [
        { platform: "ios", arch: "arm64", format: "ipa" },
      ]),
    ).toEqual([{ platform: "ios", fits: true, reasons: [] }]);
  });

  it("an unknown or free-text format fits with a note", () => {
    for (const format of ["weird", null])
      expect(
        channelFitById("scoop", [
          { platform: "windows", arch: "x86_64", format },
        ]),
      ).toEqual([
        { platform: "windows", fits: true, reasons: ["unknown-format"] },
      ]);
  });

  it("an unknown format still fails the arch requirement", () => {
    expect(channelFitById("app-store", [mac("x86_64", "weird")])).toEqual([
      { platform: "macos", fits: false, reasons: ["arch", "unknown-format"] },
    ]);
  });

  it("finds the format from a file name when format is null", () => {
    expect(
      channelFitById("scoop", [
        { platform: "windows", arch: "x86_64", format: null, name: "a.zip" },
      ]),
    ).toEqual([{ platform: "windows", fits: true, reasons: [] }]);
  });

  it("skips platforms with no build, and platforms the channel does not serve", () => {
    expect(
      channelFitById("app-store", [
        { platform: "linux", arch: "x86_64", format: "deb" },
      ]),
    ).toEqual([]);
    expect(channelFitById("nope", [])).toBeNull();
    expect(channelFit({ platforms: ["web"], formats: ["html"] }, [])).toEqual(
      [],
    );
  });
});
