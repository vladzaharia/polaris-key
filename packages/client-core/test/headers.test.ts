// Unit tests for the §5.2 spelling lookups. The corpus rows (`headers.json`) run in
// conformance/runners/node/headers.test.ts; these pin the lookup's three rules directly.
import { describe, expect, it } from "vitest";
import { canonicalArch, canonicalPlatform } from "../src/headers.js";

describe("canonicalPlatform", () => {
  it("maps each runtime spelling to its canonical value", () => {
    expect(canonicalPlatform("darwin")).toBe("macos");
    expect(canonicalPlatform("win32")).toBe("windows");
    expect(canonicalPlatform("browser")).toBe("web");
    expect(canonicalPlatform("iPadOS")).toBe("ios");
  });

  it("maps the Apple OS tokens to their own canonical values (§5.2, SP-08)", () => {
    expect(canonicalPlatform("tvOS")).toBe("tvos");
    expect(canonicalPlatform("visionOS")).toBe("visionos");
    expect(canonicalPlatform("WATCHOS")).toBe("watchos");
  });

  it("folds ASCII A-Z only, never a locale lowercase", () => {
    expect(canonicalPlatform("LINUX")).toBe("linux");
    // U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE is not folded.
    expect(canonicalPlatform("LİNUX")).toBeNull();
  });

  it("does not trim, and an unknown spelling has no value", () => {
    expect(canonicalPlatform(" linux")).toBeNull();
    expect(canonicalPlatform("freebsd")).toBeNull();
    expect(canonicalPlatform("")).toBeNull();
  });

  it("reads the table's own entries only", () => {
    expect(canonicalPlatform("constructor")).toBeNull();
    expect(canonicalPlatform("__proto__")).toBeNull();
    expect(canonicalPlatform("toString")).toBeNull();
  });
});

describe("canonicalArch", () => {
  it("maps each runtime spelling to its canonical value", () => {
    expect(canonicalArch("x64")).toBe("x86_64");
    expect(canonicalArch("AMD64")).toBe("x86_64");
    expect(canonicalArch("aarch64")).toBe("arm64");
    expect(canonicalArch("arm")).toBe("armv7");
    expect(canonicalArch("wasm32")).toBe("wasm32");
  });

  it("omits what it cannot map", () => {
    expect(canonicalArch("ia32")).toBeNull();
    expect(canonicalArch("x86_64 ")).toBeNull();
    expect(canonicalArch("hasOwnProperty")).toBeNull();
  });
});
