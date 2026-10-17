/**
 * Vocabularies as data (P0-35): platform, ecosystem and licence words live in `lib/vocab/*`, and
 * nothing else spells them out. The grep half fails when a second label map appears.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ecosystemLabel,
  ECOSYSTEM_LABELS,
  TOKEN_ENV,
} from "../src/lib/vocab/ecosystems.js";
import { devicesText, expiresInText } from "../src/lib/vocab/license.js";
import {
  APPLE_PLATFORM_LABELS,
  platformConsumerName,
  platformInSentence,
  platformName,
} from "../src/lib/vocab/platforms.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("vocab/platforms", () => {
  it("names a platform from the catalog, then the manifest, then as sent", () => {
    expect(platformName("macos")).toBe("macOS");
    expect(platformName("ios")).toBe("iOS");
    expect(platformName("xbox")).toBe("Xbox");
    expect(platformName("Windows 11")).toBe("Windows 11");
    expect(platformName(null)).toBe("None");
  });
  it("words a platform for a customer and for a sentence", () => {
    expect(platformConsumerName("ios")).toBe("iPhone and iPad");
    expect(platformConsumerName("web")).toBe("Web");
    expect(platformInSentence("web")).toBe("the web");
    expect(platformInSentence("ios")).toBe("iPhone and iPad");
    expect(platformInSentence("ios", { phone: true })).toBe("iPhone");
    expect(platformInSentence("linux")).toBe("Linux");
  });
  it("names App Store Connect's platforms", () => {
    expect(APPLE_PLATFORM_LABELS.MAC_OS).toBe("macOS");
    expect(APPLE_PLATFORM_LABELS.VISION_OS).toBe("visionOS");
  });
});

describe("vocab/ecosystems", () => {
  it("names every ecosystem once", () => {
    expect(ecosystemLabel("pypi")).toBe("PyPI");
    expect(ecosystemLabel("go")).toBe("Go");
    expect(ecosystemLabel("nuget")).toBe("nuget");
    expect(Object.keys(ECOSYSTEM_LABELS)).toHaveLength(8);
    expect(TOKEN_ENV).toBe("PKEY_REGISTRY_TOKEN");
  });
});

describe("vocab/license", () => {
  it("words expiry and devices", () => {
    expect(expiresInText(1)).toBe("Expires in 1 day");
    expect(expiresInText(1, { tomorrow: true })).toBe("Expires tomorrow");
    expect(expiresInText(9, { tomorrow: true })).toBe("Expires in 9 days");
    expect(devicesText(2, 3)).toBe("2 of 3 devices");
    expect(devicesText(1)).toBe("1 device");
  });
});

describe("no second vocabulary", () => {
  // A quoted platform or ecosystem name outside lib/vocab is a label map in the making. The kit
  // story's sample data is fixture text, not a vocabulary.
  const NAMES =
    /["'`](macOS|iOS|iPadOS|tvOS|visionOS|watchOS|Windows|Linux|Android|PyPI|Docker \/ OCI|Maven \/ Gradle|iPhone and iPad)["'`]/;
  const ALLOWED = new Set(["kit/stories/charts.tsx"]);
  it("keeps platform and ecosystem names in lib/vocab", () => {
    const hits = sources(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.startsWith("lib/vocab/") && !ALLOWED.has(f))
      .filter((f) => NAMES.test(readFileSync(join(SRC, f), "utf8")));
    expect(hits).toEqual([]);
  });
  it("keeps the registry-token variable and the system slug in one place", () => {
    const hits = sources(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.startsWith("lib/vocab/"))
      .filter((f) =>
        /["']PKEY_REGISTRY_TOKEN["']|SYSTEM_PRODUCT_SLUG = /.test(
          readFileSync(join(SRC, f), "utf8"),
        ),
      );
    expect(hits).toEqual([]);
  });
});
