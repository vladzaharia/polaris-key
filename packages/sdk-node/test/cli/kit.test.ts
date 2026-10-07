// @pkey-feature ui.cli
// The Node terminal kit's units (docs/design/UI-KITS.md §1.4 "Terminal", §3, §4.7, §5.1): what
// the terminal can draw, the copy formatter over the generated catalog, the accent resolver port,
// product identity through the presentation seam, the headless views and their copy keys, the
// `--json` envelope through both adapters, help and completion.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Command } from "commander";
import yargs from "yargs";
import {
  CLI_JSON_VERSION,
  CLI_VERBS,
  completionScript,
  createKitContext,
  deriveAccent,
  formatMessage,
  KitCopy,
  keyVerdict,
  registerPolarisCommands,
  registerYargsCommands,
  resolveAccent,
  resolveLocale,
  resolveProduct,
  statusView,
  activationOutcome,
  handoffView,
  updateView,
  devicesView,
} from "../../src/cli/index.js";
import {
  detectTerminal,
  schemeFromColorFgBg,
  schemeFromOsc11,
} from "../../src/cli/term/caps.js";
import {
  truncateMiddle,
  wrapText,
  cellWidth,
} from "../../src/cli/term/width.js";
import { KIT_COPY } from "../../src/kitCopy.generated.js";
import {
  frozenTicker,
  KEY,
  KEY_SECRET,
  NOW,
  render,
  stubClient,
  TIDEWATER,
  VARIANTS,
} from "./harness.js";
import { Screen } from "./screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(
  readFileSync(
    join(HERE, "../../../brand/fixtures/accent-vectors.json"),
    "utf8",
  ),
) as {
  derive: Array<{ name: string; pixels: number[][]; expect: string | null }>;
  resolve: Array<{
    name: string;
    input: string;
    scheme: "dark" | "light";
    expect: Record<string, string>;
  }>;
};
const COMPONENTS = JSON.parse(
  readFileSync(join(HERE, "../../../brand/kit-copy/components.json"), "utf8"),
) as {
  components: Record<string, { states: Record<string, { copy: string[] }> }>;
};

describe("what the terminal draws (caps)", () => {
  const tty = { isTTY: true, columns: 120, rows: 40, write: () => true };
  it("drops every escape under NO_COLOR, --no-color, TERM=dumb and off a TTY", () => {
    expect(detectTerminal({ env: { NO_COLOR: "1" }, stdout: tty }).color).toBe(
      "none",
    );
    expect(
      detectTerminal({ env: {}, stdout: tty, flags: { color: false } }).color,
    ).toBe("none");
    expect(detectTerminal({ env: { TERM: "dumb" }, stdout: tty }).color).toBe(
      "none",
    );
    expect(
      detectTerminal({ env: {}, stdout: { ...tty, isTTY: false } }).color,
    ).toBe("none");
    expect(
      detectTerminal({ env: {}, stdout: tty, flags: { json: true } }).color,
    ).toBe("none");
  });
  it("uses ANSI-16 by default and truecolor only when the terminal says so", () => {
    expect(detectTerminal({ env: {}, stdout: tty }).color).toBe("ansi16");
    expect(
      detectTerminal({ env: { COLORTERM: "truecolor" }, stdout: tty }).color,
    ).toBe("truecolor");
    expect(
      detectTerminal({ env: { COLORTERM: "24bit" }, stdout: tty }).color,
    ).toBe("truecolor");
    expect(
      detectTerminal({
        env: { FORCE_COLOR: "1" },
        stdout: { ...tty, isTTY: false },
      }).color,
    ).toBe("ansi16");
  });
  it("selects ASCII under TERM=dumb, TERM=linux and --ascii", () => {
    expect(detectTerminal({ env: { TERM: "dumb" }, stdout: tty }).unicode).toBe(
      false,
    );
    expect(
      detectTerminal({ env: { TERM: "linux" }, stdout: tty }).unicode,
    ).toBe(false);
    expect(
      detectTerminal({ env: {}, stdout: tty, flags: { ascii: true } }).unicode,
    ).toBe(false);
    expect(detectTerminal({ env: {}, stdout: tty }).unicode).toBe(true);
  });
  it("never animates or prompts under CI, off a TTY, or with reduced motion", () => {
    const stdin = { isTTY: true };
    expect(detectTerminal({ env: {}, stdout: tty, stdin }).animate).toBe(true);
    expect(detectTerminal({ env: {}, stdout: tty, stdin }).interactive).toBe(
      true,
    );
    expect(
      detectTerminal({ env: { CI: "true" }, stdout: tty, stdin }).animate,
    ).toBe(false);
    expect(
      detectTerminal({ env: { CI: "true" }, stdout: tty, stdin }).interactive,
    ).toBe(false);
    expect(
      detectTerminal({
        env: {},
        stdout: tty,
        stdin,
        theme: { motion: "reduced" },
      }).animate,
    ).toBe(false);
    expect(
      detectTerminal({ env: {}, stdout: { ...tty, isTTY: false }, stdin })
        .interactive,
    ).toBe(false);
  });
  it("lays out at 80 columns, degrading to the terminal's width", () => {
    expect(detectTerminal({ env: {}, stdout: tty }).columns).toBe(80);
    expect(
      detectTerminal({ env: {}, stdout: { ...tty, columns: 64 } }).columns,
    ).toBe(64);
  });
  it("reads the scheme from PKEY_THEME, COLORFGBG and an OSC 11 answer", () => {
    expect(
      detectTerminal({ env: { PKEY_THEME: "light" }, stdout: tty }).scheme,
    ).toBe("light");
    expect(schemeFromColorFgBg("0;15")).toBe("light");
    expect(schemeFromColorFgBg("15;0")).toBe("dark");
    expect(schemeFromColorFgBg("15;default;0")).toBe("dark");
    expect(schemeFromOsc11("\x1b]11;rgb:fbfb/fbfb/fcfc\x07")).toBe("light");
    expect(schemeFromOsc11("\x1b]11;rgb:1010/1111/1414\x1b\\")).toBe("dark");
  });
  it("knows a headless computer (SIGN-IN.md D-68)", () => {
    expect(
      detectTerminal({
        env: { SSH_TTY: "/dev/pts/1", DISPLAY: ":0" },
        stdout: tty,
        platform: "darwin",
      }).headless,
    ).toBe(true);
    expect(
      detectTerminal({ env: {}, stdout: tty, platform: "linux" }).headless,
    ).toBe(true);
    expect(
      detectTerminal({
        env: { WAYLAND_DISPLAY: "wayland-0" },
        stdout: tty,
        platform: "linux",
      }).headless,
    ).toBe(false);
    expect(
      detectTerminal({ env: {}, stdout: tty, platform: "darwin" }).headless,
    ).toBe(false);
  });
});

describe("cell widths", () => {
  it("counts CJK as two cells and escapes as none", () => {
    expect(cellWidth("ライセンス")).toBe(10);
    expect(cellWidth("\x1b[1mab\x1b[22m")).toBe(2);
  });
  it("cuts keys in the middle, never at the end", () => {
    const cut = truncateMiddle("pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA", 20);
    expect(cut.startsWith("pkey_")).toBe(true);
    expect(cut.endsWith("WPLDA")).toBe(true);
    expect(cellWidth(cut)).toBeLessThanOrEqual(20);
  });
  it("wraps CJK between characters and Latin at spaces", () => {
    expect(wrapText("一二三四五六", 6)).toEqual(["一二三", "四五六"]);
    expect(wrapText("one two three", 8)).toEqual(["one two", "three"]);
  });
});

describe("the copy (UI-KITS §4.7)", () => {
  it("formats plurals and the formFactor select in each launch locale", () => {
    expect(
      formatMessage("{count, plural, one {# device} other {# devices}}", {
        count: 1,
      }),
    ).toBe("1 device");
    expect(
      formatMessage("{count, plural, one {# device} other {# devices}}", {
        count: 3,
      }),
    ).toBe("3 devices");
    const de = new KitCopy({ locale: "de_DE.UTF-8" });
    expect(de.locale).toBe("de");
    expect(de.t("deviceLimit.heading", { used: 3, limit: 3 })).toBe(
      "Ihre Lizenz wird auf 3 von 3 Geräten verwendet",
    );
    expect(
      new KitCopy().t("part.thisDeviceTitle", { formFactor: "computer" }),
    ).toBe("This computer");
  });
  it("maps POSIX and BCP 47 tags onto the launch locales", () => {
    expect(resolveLocale("pt_BR.UTF-8")).toBe("pt-BR");
    expect(resolveLocale("zh_CN")).toBe("zh-Hans");
    expect(resolveLocale("zh-TW")).toBe("en");
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("C")).toBe("en");
    expect(resolveLocale("ar")).toBe("en");
  });
  it("falls back key by key: an override, then the locale, then English", () => {
    const c = new KitCopy({
      locale: "fr",
      overrides: { fr: { "common.cancel": "Annuler tout" } },
    });
    expect(c.t("common.cancel")).toBe("Annuler tout");
    expect(c.t("common.close")).toBe(KIT_COPY.fr["common.close"]);
  });
  it("has every cli.* key in every launch locale", () => {
    const keys = Object.keys(KIT_COPY.en).filter((k) => k.startsWith("cli."));
    expect(keys.length).toBeGreaterThan(70);
    for (const loc of Object.keys(KIT_COPY) as Array<keyof typeof KIT_COPY>)
      for (const k of keys)
        expect(KIT_COPY[loc][k], `${loc} ${k}`).toBeTruthy();
  });
  it("spells catalog symbols in ASCII when the terminal takes ASCII only", () => {
    expect(new KitCopy({ ascii: true }).t("activate.busy")).toBe(
      "Activating...",
    );
  });
});

describe("the accent resolver port (accent-vectors.json)", () => {
  it("reproduces every resolve vector", () => {
    for (const v of VECTORS.resolve)
      expect(resolveAccent(v.input, v.scheme), `${v.name} ${v.scheme}`).toEqual(
        v.expect,
      );
  });
  it("reproduces every derive vector", () => {
    for (const v of VECTORS.derive) {
      const rgba: number[] = [];
      for (const [r, g, b, a, n] of v.pixels)
        for (let i = 0; i < n!; i++) rgba.push(r!, g!, b!, a!);
      expect(deriveAccent(rgba), v.name).toBe(v.expect);
    }
  });
});

describe("product identity (UI-KITS §1.2) through the presentation seam", () => {
  it("takes the presentation's accent and accentDark with zero integrator code", async () => {
    const dark = resolveProduct({
      slug: "tidewater",
      scheme: "dark",
      presentation: { ...TIDEWATER, accentDark: "#ff6a3d" },
    });
    expect(dark).toMatchObject({
      name: "Tidewater Studio",
      developer: "Harbor Audio",
      accentSource: "product",
      accentHex: "#ff6a3d",
    });
    expect(dark.chip).toEqual({
      solid: resolveAccent("#ff6a3d", "dark").solid,
      on: resolveAccent("#ff6a3d", "dark").on,
    });
    const light = resolveProduct({
      slug: "tidewater",
      scheme: "light",
      presentation: { ...TIDEWATER, accentDark: "#ff6a3d" },
    });
    expect(light.accentHex).toBe("#369186");
  });
  it("derives the accent from a verified icon when the presentation has none", () => {
    const rgba: number[] = [];
    for (const [r, g, b, a, n] of VECTORS.derive.find(
      (v) => v.name === "tidewater",
    )!.pixels)
      for (let i = 0; i < n!; i++) rgba.push(r!, g!, b!, a!);
    const p = resolveProduct({
      slug: "tidewater",
      scheme: "dark",
      presentation: { name: "Tidewater Studio", iconPixels: rgba },
    });
    expect(p).toMatchObject({ accentSource: "icon", accentHex: "#369186" });
  });
  it("lets the integrator win, then falls through bundle → slug → ink; never violet unless asked", () => {
    expect(
      resolveProduct({
        slug: "tw",
        scheme: "dark",
        theme: { product: { name: "Mine", accent: "#123456" } },
        presentation: TIDEWATER,
      }),
    ).toMatchObject({
      name: "Mine",
      accentSource: "integrator",
      accentHex: "#123456",
    });
    expect(
      resolveProduct({
        slug: "drift-kart",
        scheme: "dark",
        bundle: { name: "Drift Kart" },
      }),
    ).toMatchObject({ name: "Drift Kart", accentSource: "ink", chip: null });
    expect(resolveProduct({ slug: "drift-kart", scheme: "dark" }).name).toBe(
      "Drift Kart",
    );
    expect(
      resolveProduct({
        slug: "tw",
        scheme: "light",
        theme: { accent: "core" },
      }),
    ).toMatchObject({ accentSource: "core", accentHex: "#7a2fff" });
    expect(
      resolveProduct({
        slug: "tw",
        scheme: "dark",
        presentation: TIDEWATER,
        theme: { preset: "native" },
      }).chip,
    ).toBeNull();
  });
  it("draws the chip in the presentation's accent, in truecolor, from the flow's own context", async () => {
    const r = await render({ variant: VARIANTS[0]! }, async (h) => {
      h.ctx.rows([
        {
          mark: "start",
          spans: [{ text: " Tidewater Studio ", style: ["chip"] }],
        },
      ]);
    });
    const { solid } = resolveAccent("#369186", "dark");
    const [R, G, B] = [1, 3, 5].map((i) => parseInt(solid.slice(i, i + 2), 16));
    expect(r.text).toContain(`\x1b[48;2;${R};${G};${B}m`);
  });
  it("reads the SDK's presentation accessor off the client (HA-13) when one exists", async () => {
    const screen = new Screen();
    const lines: string[] = [];
    const program = new Command();
    program.exitOverride();
    const client = Object.assign(stubClient(), {
      presentation: () => ({ name: "Lighthouse Mixer", accent: "#ff6a3d" }),
    });
    registerPolarisCommands(program, async () => client, {
      pinnedKeys: {},
      productSlug: "tidewater",
      io: {
        stdout: screen,
        stderr: screen,
        env: { COLORTERM: "truecolor" },
        ticker: frozenTicker,
        now: () => NOW,
      },
      setExitCode: () => undefined,
    });
    await program.parseAsync(["status"], { from: "user" });
    lines.push(screen.text());
    expect(lines.join("\n")).toContain("Lighthouse Mixer");
  });
});

describe("the headless views (layer c) name components.json states and catalog keys", () => {
  const check = (v: { component: string; state: string; copy: string[] }) => {
    expect(COMPONENTS.components[v.component], v.component).toBeDefined();
    expect(
      Object.keys(COMPONENTS.components[v.component]!.states),
      `${v.component}.${v.state}`,
    ).toContain(v.state);
    for (const k of v.copy)
      expect(KIT_COPY.en[k], `${v.component}.${v.state}: ${k}`).toBeDefined();
  };
  it("covers the key field, activation outcomes and the device limit", () => {
    for (const input of [
      "",
      "pkey",
      "pkey_tidewater_7Q2M",
      KEY,
      "nope",
      `${KEY}xx`,
    ])
      check(keyVerdict(input));
    for (const input of ["", KEY.slice(0, 30)]) check(keyVerdict(input, true));
    expect(keyVerdict(KEY)).toMatchObject({
      state: "parsed",
      slug: "tidewater",
      prefix: "pkey_tidewater_",
    });
    expect(keyVerdict(KEY.slice(0, 30), true)).toMatchObject({
      state: "cut-short",
      used: 15,
      limit: 22,
    });
    expect(keyVerdict("tidewater", true)).toMatchObject({
      state: "rejected",
      reason: "malformed",
    });
    const dl = activationOutcome({
      kind: "device-limit",
      code: "device_limit",
      limit: 3,
      deviceCount: 3,
      manageUrl: "https://k/p",
    });
    check(dl);
    if (dl.state === "device-limit") check(dl.deviceLimit);
    check(activationOutcome({ kind: "ok", token: "t", schemaVersion: 1 }));
    check(
      activationOutcome({
        kind: "refused",
        code: "key_entry_limit",
        status: 403,
        message: "",
      }),
    );
    check(activationOutcome({ kind: "unauthorized", code: "unauthorized" }));
    check(activationOutcome({ kind: "error", code: "network", message: "" }));
  });
  it("covers the hand-off, status, update and devices views", () => {
    for (const s of [
      "starting",
      "waiting",
      "no-browser",
      "code",
      "link-copied",
      "finishing",
      "denied",
      "expired",
      "cancelled",
    ] as const)
      check(handoffView(s));
    for (const status of [
      "ok",
      "grace",
      "needs-activation",
      "not-applicable",
      "revoked",
      "expired",
      "version-too-old",
      "version-too-new",
      "channel-not-entitled",
    ])
      check(statusView({ status, info: null, now: 0, graceUntil: 3 * 86_400 }));
    check(
      updateView({
        action: "none",
        reason: "up-to-date",
        behind: false,
        discardStaged: false,
      } as never),
    );
    check(
      updateView({
        action: "blocked",
        reason: "app-floor",
        discardStaged: false,
      } as never),
    );
    check(devicesView([]));
    check(devicesView([{ id: "d", current: true }]));
  });
});

describe("--json on every verb (both adapters)", () => {
  const flowsThatRun = CLI_VERBS.filter(
    (v) => !["login", "update", "packs"].includes(v.path[0]!),
  );
  it("prints exactly one versioned JSON object, never a prompt or an escape (commander)", async () => {
    for (const verb of flowsThatRun) {
      const screen = new Screen();
      const program = new Command();
      program.exitOverride();
      registerPolarisCommands(program, async () => stubClient(), {
        pinnedKeys: {},
        productSlug: "tidewater",
        io: {
          stdout: screen,
          stderr: new Screen(),
          stdin: Object.assign(
            new (await import("node:stream")).PassThrough(),
            { isTTY: false },
          ) as never,
          env: { COLORTERM: "truecolor" },
          ticker: frozenTicker,
          now: () => NOW,
        },
        setExitCode: () => undefined,
      });
      const args: string[] = verb.args
        .filter((a) => a.startsWith("<"))
        .map((a) =>
          a.includes("shell")
            ? "bash"
            : a.includes("file")
              ? "/nonexistent"
              : "x",
        );
      if (verb.path[0] === "activate") args.push(KEY);
      await program.parseAsync([...verb.path, ...args, "--json"], {
        from: "user",
      });
      const out = screen.raw.trim();
      expect(out, verb.path.join(" ")).not.toMatch(/\x1b/);
      expect(out.split("\n"), verb.path.join(" ")).toHaveLength(1);
      const j = JSON.parse(out) as {
        version: number;
        command: string;
        ok: boolean;
        exitCode: number;
      };
      expect(j).toMatchObject({
        version: CLI_JSON_VERSION,
        command: verb.path.join(" "),
      });
      expect(typeof j.exitCode).toBe("number");
      expect(out).not.toContain(KEY_SECRET);
      expect(out).not.toContain("pkeyt_");
    }
  });
  it("streams login as NDJSON: pending first, then the final state, never the poll credential", async () => {
    const r = await render({ variant: VARIANTS[0]!, json: true }, async (h) => {
      const { loginFlow } = await import("../../src/cli/flows.js");
      await loginFlow(h.ctx, stubClient());
    });
    const lines = r.raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { state: string; userCode?: string });
    expect(lines.map((l) => l.state)).toEqual(["pending", "signedIn"]);
    expect(lines[0]!.userCode).toBe("WDJB-MJHT");
    expect(r.raw).not.toContain("dc_secret");
  });
  it("yargs prints the same envelope", async () => {
    const screen = new Screen();
    const y = yargs([]).exitProcess(false);
    registerYargsCommands(y, async () => stubClient(), {
      pinnedKeys: {},
      productSlug: "tidewater",
      io: {
        stdout: screen,
        stderr: new Screen(),
        env: {},
        ticker: frozenTicker,
        now: () => NOW,
      },
      setExitCode: () => undefined,
    });
    await y.parseAsync(["polaris-key", "status", "--json"]);
    expect(JSON.parse(screen.raw)).toMatchObject({
      version: 1,
      command: "status",
      ok: true,
      exitCode: 0,
      state: "signed-in",
    });
  });
  it("keeps the old names working: sign-in, sign-out and a positional key", async () => {
    const program = new Command();
    program.exitOverride();
    const screen = new Screen();
    const err = new Screen();
    registerPolarisCommands(program, async () => stubClient(), {
      pinnedKeys: {},
      productSlug: "tidewater",
      io: {
        stdout: screen,
        stderr: err,
        env: {},
        ticker: frozenTicker,
        now: () => NOW,
      },
      setExitCode: () => undefined,
    });
    await program.parseAsync(["activate", KEY], { from: "user" });
    expect(err.text()).toContain("saved in your shell history");
    expect(screen.raw + err.raw).not.toContain(KEY_SECRET);
    await program.parseAsync(["sign-out", "--yes"], { from: "user" });
    // No presentation and no bundle name here: the product is named after its slug.
    expect(screen.text()).toContain("Signed out of Tidewater on this device.");
  });
});

describe("help and completion", () => {
  it("groups the commander program's help and gives each verb its own", async () => {
    const program = new Command("tidewater");
    let out = "";
    program.exitOverride().configureOutput({ writeOut: (s) => (out += s) });
    registerPolarisCommands(program, async () => stubClient(), {
      pinnedKeys: {},
      productSlug: "tidewater",
      io: { env: {}, stdout: new Screen({ tty: false }) },
    });
    await program
      .parseAsync(["--help"], { from: "user" })
      .catch(() => undefined);
    for (const heading of [
      "License",
      "Account",
      "Devices",
      "Settings",
      "Updates",
      "Content",
      "Support",
      "Options",
    ])
      expect(out).toContain(`\n${heading}\n`);
    out = "";
    await program
      .parseAsync(["activate", "--help"], { from: "user" })
      .catch(() => undefined);
    expect(out).toContain("tidewater activate [key] [options]");
  });
  it("generates bash, zsh and fish completion from the verb table", async () => {
    const ctx = await createKitContext({
      slug: "tidewater",
      io: { env: {}, stdout: new Screen({ tty: false }) },
    });
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const s = completionScript(ctx, shell, CLI_VERBS);
      for (const word of [
        "activate",
        "login",
        "sign-in",
        "devices",
        "completion",
        "json",
      ])
        expect(s, `${shell}: ${word}`).toContain(word);
    }
    expect(completionScript(ctx, "bash", CLI_VERBS)).toContain(
      'devices) [ "$COMP_CWORD" -eq 2 ] && words="list rename deauthorize"',
    );
  });
});
