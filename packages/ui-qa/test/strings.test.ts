import { describe, expect, it } from "vitest";
import { REPO_ROOT, STRINGS_ALLOW } from "../src/config.ts";
import {
  compile,
  globMatch,
  icuToPatterns,
  lintStrings,
  loadAllow,
  loadCatalog,
  matchString,
  stateOf,
  titleCase,
  type CatalogMessage,
} from "../src/strings.ts";
import { resolve } from "node:path";

const cat: CatalogMessage[] = [
  { key: "common.tryAgain", value: "Try again", role: "button", variants: {} },
  {
    key: "update.restartWhenReady",
    value: "Restart when ready",
    role: "button",
    variants: { macos: "Install and Relaunch" },
  },
  {
    key: "devices.count",
    value: "{used} of {limit, plural, one {# device} other {# devices}} in use",
    variants: {},
  },
  {
    key: "formFactor",
    value: "{formFactor, select, mac {this Mac} other {this device}}",
    variants: {},
  },
  { key: "store.key", value: "{store} key", variants: {} },
];
const m = compile(cat);

describe("the string lint's catalog matcher", () => {
  it("expands plural and select branches into glob patterns", () => {
    expect(
      icuToPatterns("{a} of {n, plural, one {# x} other {# xs}}").patterns,
    ).toEqual([
      [null, " of ", null, " x"],
      [null, " of ", null, " xs"],
    ]);
    expect(matchString(m, "3 of 3 devices in use", "web")?.key).toBe(
      "devices.count",
    );
    expect(matchString(m, "this Mac", "web")?.key).toBe("formFactor");
  });

  it("globs linearly and exactly", () => {
    expect(globMatch("ab", ["a", null])).toBe(true);
    expect(globMatch("a", ["a", null])).toBe(false);
    expect(globMatch("xay", [null, "a", null])).toBe(true);
    expect(globMatch("x".repeat(5000), [null, " ", null, " ", null, "z"])).toBe(
      false,
    );
  });

  it("allows a documented variant only on its platform, and macOS title case on buttons", () => {
    expect(matchString(m, "Install and Relaunch", "macos")).toEqual({
      key: "update.restartWhenReady",
      variant: "macos",
    });
    expect(matchString(m, "Install and Relaunch", "windows")).toBeNull();
    expect(matchString(m, "Try Again", "macos")?.variant).toBe("macos");
    expect(matchString(m, "Try Again", "web")).toBeNull();
    expect(titleCase("Use a license key")).toBe("Use a License Key");
  });

  it("does not let an all-argument message swallow copy", () => {
    expect(matchString(m, "Enter a license key", "web")).toBeNull();
    expect(matchString(m, "Steam key", "web")?.key).toBe("store.key");
  });

  it("fails on a seeded copy drift between two boards", () => {
    const { findings } = lintStrings(
      cat,
      [],
      [
        {
          board: "web",
          platform: "web",
          strings: [{ scope: "error", target: "button", text: "Try again" }],
        },
        {
          board: "godot",
          platform: "godot",
          strings: [{ scope: "error", target: "button", text: "Try Again" }],
        },
      ],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      board: "godot",
      state: "error",
      text: "Try Again",
    });
    expect(findings[0]!.detail).toMatch(/Try again/);
  });

  it("names states without their size suffix", () => {
    expect(stateOf("sign-in-390")).toBe("sign-in");
    expect(stateOf("gate-deck")).toBe("gate");
  });

  it("loads the real catalogs and an allow list where every entry has a reason", () => {
    const real = loadCatalog(REPO_ROOT);
    expect(real.length).toBeGreaterThan(400);
    expect(real.some((c) => c.key.startsWith("core.gate."))).toBe(true);
    for (const a of loadAllow(resolve(REPO_ROOT, STRINGS_ALLOW)))
      expect(a.reason.length).toBeGreaterThan(10);
  });
});
