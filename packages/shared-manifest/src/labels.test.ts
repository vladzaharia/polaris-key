import { describe, expect, it } from "vitest";
import {
  archLabel,
  buildLabel,
  platformFromFileName,
  platformLabel,
  RELEASE_ARCHES,
  RELEASE_PLATFORMS,
} from "./index.js";

/** Every declared platform × every declared arch (plus x86 and an unknown arch). */
const EXPECTED: Record<string, Record<string, [string, string]>> = {
  macos: {
    arm64: ["macOS Apple silicon", "macOS · Apple silicon (arm64)"],
    x86_64: ["macOS Intel", "macOS · Intel (x86_64)"],
    universal: ["macOS Universal", "macOS · Universal"],
    armv7: ["macOS armv7", "macOS · armv7"],
    wasm32: ["macOS WebAssembly", "macOS · WebAssembly (wasm32)"],
    any: ["macOS Universal", "macOS · Universal"],
    x86: ["macOS x86", "macOS · x86"],
    riscv64: ["macOS riscv64", "macOS · riscv64"],
  },
  ios: {
    arm64: ["iOS / iPadOS", "iOS / iPadOS"],
    x86_64: ["iOS / iPadOS x86_64", "iOS / iPadOS · x86_64"],
    universal: ["iOS / iPadOS", "iOS / iPadOS"],
    armv7: ["iOS / iPadOS armv7", "iOS / iPadOS · armv7"],
    wasm32: ["iOS / iPadOS WebAssembly", "iOS / iPadOS · WebAssembly (wasm32)"],
    any: ["iOS / iPadOS", "iOS / iPadOS"],
    x86: ["iOS / iPadOS x86", "iOS / iPadOS · x86"],
    riscv64: ["iOS / iPadOS riscv64", "iOS / iPadOS · riscv64"],
  },
  android: {
    arm64: ["Android ARM64", "Android · ARM64"],
    x86_64: ["Android x86_64", "Android · x86_64"],
    universal: ["Android Universal", "Android · Universal"],
    armv7: ["Android armv7", "Android · armv7"],
    wasm32: ["Android WebAssembly", "Android · WebAssembly (wasm32)"],
    any: ["Android Universal", "Android · Universal"],
    x86: ["Android x86", "Android · x86"],
    riscv64: ["Android riscv64", "Android · riscv64"],
  },
  windows: {
    arm64: ["Windows Arm64", "Windows · Arm64"],
    x86_64: ["Windows x64", "Windows · x64 (x86_64)"],
    universal: ["Windows Universal", "Windows · Universal"],
    armv7: ["Windows armv7", "Windows · armv7"],
    wasm32: ["Windows WebAssembly", "Windows · WebAssembly (wasm32)"],
    any: ["Windows Universal", "Windows · Universal"],
    x86: ["Windows x86", "Windows · x86"],
    riscv64: ["Windows riscv64", "Windows · riscv64"],
  },
  linux: {
    arm64: ["Linux ARM64", "Linux · ARM64"],
    x86_64: ["Linux x86_64", "Linux · x86_64"],
    universal: ["Linux Universal", "Linux · Universal"],
    armv7: ["Linux armv7", "Linux · armv7"],
    wasm32: ["Linux WebAssembly", "Linux · WebAssembly (wasm32)"],
    any: ["Linux Universal", "Linux · Universal"],
    x86: ["Linux x86", "Linux · x86"],
    riscv64: ["Linux riscv64", "Linux · riscv64"],
  },
  web: {
    arm64: ["Web ARM64", "Web · ARM64"],
    x86_64: ["Web x86_64", "Web · x86_64"],
    universal: ["Web", "Web"],
    armv7: ["Web armv7", "Web · armv7"],
    wasm32: ["Web", "Web"],
    any: ["Web", "Web"],
    x86: ["Web x86", "Web · x86"],
    riscv64: ["Web riscv64", "Web · riscv64"],
  },
};

describe("buildLabel", () => {
  it("covers every declared platform and arch", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...RELEASE_PLATFORMS].sort());
    for (const p of RELEASE_PLATFORMS) {
      for (const a of RELEASE_ARCHES) expect(EXPECTED[p]![a]).toBeDefined();
    }
  });

  for (const [platform, arches] of Object.entries(EXPECTED)) {
    for (const [arch, [short, long]] of Object.entries(arches)) {
      it(`${platform} × ${arch}`, () => {
        const label = buildLabel({ platform, arch });
        expect(label.short).toBe(short);
        expect(label.long).toBe(long);
        expect(label.long.startsWith(label.platform)).toBe(true);
      });
    }
  }

  it("reads a platform-independent build as All platforms", () => {
    for (const platform of [null, undefined, "", "any"]) {
      for (const arch of [null, "any", "universal"]) {
        expect(buildLabel({ platform, arch })).toEqual({
          platform: "All platforms",
          arch: null,
          short: "All platforms",
          long: "All platforms",
        });
      }
    }
  });

  it("never shows a concrete arch without a platform", () => {
    expect(buildLabel({ platform: null, arch: "arm64" })).toEqual({
      platform: "Unknown platform",
      arch: "ARM64",
      short: "Unknown platform ARM64",
      long: "Unknown platform · ARM64",
    });
    expect(buildLabel({ arch: "riscv64" }).long).toBe(
      "Unknown platform · riscv64",
    );
  });

  it("passes unknown platforms through verbatim", () => {
    expect(buildLabel({ platform: "beos", arch: "arm64" })).toMatchObject({
      short: "beos ARM64",
      long: "beos · ARM64",
    });
    expect(buildLabel({ platform: "tvos", arch: "arm64" }).long).toBe(
      "tvOS · ARM64",
    );
    expect(buildLabel({ platform: "beos" }).long).toBe("beos");
  });

  it("appends the format to the long form only", () => {
    const label = buildLabel({
      platform: "macos",
      arch: "arm64",
      format: "zip",
    });
    expect(label.short).toBe("macOS Apple silicon");
    expect(label.long).toBe("macOS · Apple silicon (arm64) · zip");
  });

  it("uses the download page's wording for consumers", () => {
    expect(
      buildLabel({ platform: "ios", arch: "arm64" }, { audience: "consumer" })
        .short,
    ).toBe("iPhone and iPad");
    expect(platformLabel("macos", { audience: "consumer" })).toBe("macOS");
  });
});

describe("platformLabel and archLabel", () => {
  it("names the console platforms", () => {
    expect(platformLabel("visionos")).toBe("visionOS");
    expect(platformLabel("switch")).toBe("Nintendo Switch");
    expect(platformLabel(null)).toBe("All platforms");
  });
  it("is null when the platform implies the arch", () => {
    expect(archLabel("arm64", "ios")).toBeNull();
    expect(archLabel(null, "macos")).toBeNull();
    expect(archLabel("any", null)).toBeNull();
    expect(archLabel("arm64", "macos")).toBe("Apple silicon");
  });
});

describe("platformFromFileName", () => {
  const cases: [string, string | null][] = [
    ["djdl-arm64.app.zip", "macos"],
    ["djdl-macos-arm64.app.zip", "macos"],
    ["Dice-1.2.0.dmg", "macos"],
    ["Dice.pkg", "macos"],
    ["tool_darwin_amd64.tar.gz", "macos"],
    ["dice-mac-universal.zip", "macos"],
    ["Dice Setup 1.0.exe", "windows"],
    ["dice-x64.msi", "windows"],
    ["dice-win64.zip", "windows"],
    ["dice-windows-arm64.zip", "windows"],
    ["Dice-x86_64.AppImage", "linux"],
    ["dice_1.0_amd64.deb", "linux"],
    ["dice-linux-arm64.tar.gz", "linux"],
    ["dice.apk", "android"],
    ["dice-android-armv7.zip", "android"],
    ["Dice.ipa", "ios"],
    ["dice-web.zip", "web"],
    ["dice-arm64.zip", null],
    ["dice-macos-linux.zip", null],
    ["darwinia.zip", null],
    ["README", null],
  ];
  for (const [name, platform] of cases) {
    it(`${name} → ${platform}`, () => {
      expect(platformFromFileName(name)).toBe(platform);
    });
  }
});
