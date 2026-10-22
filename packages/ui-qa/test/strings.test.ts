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
  refusalPatterns,
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

  // R2-M2: "Add your license" matched account.tier ("{tier} license", a label) with "Add your" as
  // the tier, so a title no catalog key holds passed the lint.
  it("matches a title only against title-role messages and a button only against button-role ones", () => {
    const roles: CatalogMessage[] = [
      {
        key: "account.tier",
        value: "{tier} license",
        role: "label",
        variants: {},
      },
      {
        key: "activate.title",
        value: "Enter your license key",
        role: "title",
        variants: {},
      },
      {
        key: "activate.submit",
        value: "Activate license",
        role: "button",
        variants: {},
      },
      {
        key: "account.manage",
        value: "Manage {tier} license",
        role: "body",
        variants: {},
      },
    ];
    const r = compile(roles);
    // The wildcard still reads a label, and a string of no known kind, as before.
    expect(matchString(r, "Pro license", "web", undefined)?.key).toBe(
      "account.tier",
    );
    // A heading or a button cannot borrow a label's argument.
    expect(matchString(r, "Add your license", "web", "title")).toBeNull();
    expect(matchString(r, "Add your license", "ios", "button")).toBeNull();
    expect(matchString(r, "Manage Pro license", "web", "title")).toBeNull();
    // The real titles and buttons still match their own roles.
    expect(matchString(r, "Enter your license key", "web", "title")?.key).toBe(
      "activate.title",
    );
    expect(matchString(r, "Activate license", "web", "button")?.key).toBe(
      "activate.submit",
    );
    expect(matchString(r, "Activate license", "web", "title")).toBeNull();
  });

  it("reports the wildcard title through the whole lint", () => {
    const roles: CatalogMessage[] = [
      {
        key: "account.tier",
        value: "{tier} license",
        role: "label",
        variants: {},
      },
    ];
    const strings = (kind?: "title") => [
      { scope: "activate", target: "h1", text: "Add your license", kind },
    ];
    const run = (kind?: "title") =>
      lintStrings(
        roles,
        [],
        [{ board: "web", platform: "web", strings: strings(kind) }],
      ).findings;
    expect(run("title")).toHaveLength(1);
    expect(run(undefined)).toHaveLength(0);
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

  it("reads a terminal row without its status mark or the QR beside it, and still catches drift", () => {
    const strings = [
      { scope: "a", target: "row", text: "\u2713 Try again" },
      {
        scope: "a",
        target: "row",
        text: "\u2807 Try again \u2588\u2580 \u2584\u2588",
      },
      { scope: "a", target: "row", text: "\u2588\u2580\u2580 \u2584\u2584" },
      { scope: "a", target: "row", text: "\u2717 Try Again" },
    ];
    const { findings } = lintStrings(
      cat,
      [],
      [{ board: "terminal", platform: "terminal", strings }],
    );
    expect(findings.map((f) => f.text)).toEqual(["\u2717 Try Again"]);
    const web = lintStrings(
      cat,
      [],
      [{ board: "web", platform: "web", strings: [strings[0]!] }],
    );
    expect(web.findings).toHaveLength(1);
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

describe("the brand-name rule", () => {
  it("finds no Polaris Key in kit or core copy", async () => {
    const { lintBrandName } = await import("../src/strings.ts");
    expect(lintBrandName(REPO_ROOT)).toEqual([]);
  });
  it("reports a string that names Polaris Key and ignores notes", async () => {
    const { lintBrandName } = await import("../src/strings.ts");
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(resolve(tmpdir(), "brand-"));
    mkdirSync(resolve(dir, "c"));
    writeFileSync(
      resolve(dir, "c/en.json"),
      JSON.stringify({
        $comment: "Polaris Key",
        messages: {
          a: { value: "Open Polaris Key", note: "Polaris Key" },
          b: { value: "Open Polaris Locker" },
        },
      }),
    );
    const found = lintBrandName(dir, ["c"]);
    expect(found).toHaveLength(1);
    expect(found[0]!.state).toContain("messages.a.value");
  });
});

describe("refusalPatterns (DL6)", () => {
  const patterns = refusalPatterns(loadCatalog(REPO_ROOT)).map(
    (p) => new RegExp(p),
  );
  const refused = (t: string) => patterns.some((r) => r.test(t));

  it("finds the device-limit and gate refusal copy by key, arguments as wildcards", () => {
    expect(
      refused("Sign out of Tidewater on another device, then try again."),
    ).toBe(true);
    expect(refused("Your license is on 3 of 3 devices")).toBe(true);
    expect(
      refused(
        "This device was signed out. Sign in or activate again to continue.",
      ),
    ).toBe(true);
    expect(
      refused("Connect to the internet or renew your license to continue."),
    ).toBe(true);
  });

  it("leaves bad-input, success and button copy alone", () => {
    expect(refused("That key is not valid.")).toBe(false);
    expect(refused("Try again")).toBe(false);
    expect(refused("Your license is active.")).toBe(false);
  });
});
