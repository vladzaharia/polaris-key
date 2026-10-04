// @pkey-feature ui.kit
//
// The brand rollout of the SDK's UI (docs/design/BRAND.md, owner decisions of 2026-10-04): the
// default theme is NEUTRAL (host font, greyscale, no Polaris Key mark or badge); one option,
// `branding: "polaris-key"`, switches to the Polaris Key design system (read from
// `@polaris-key/brand`, dark and light); the pairings the components use clear WCAG AA in every
// branding and scheme, the Provider follows the system scheme with a pinned
// override, the screens carry the mark §7.1 assigns them, the "Powered by" badge appears only
// when the integrator opts in, the focus ring is the brand's, and nothing rendered needs an
// inline-style or inline-script CSP exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { THEME_TOKENS, colorViolations } from "@polaris-key/brand";
import { contrastRatio } from "@polaris-key/brand/color";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import { UpdatePrompt } from "../src/components/UpdatePrompt.js";
import { PolarisLogin } from "../src/components/PolarisLogin.js";
import { PoweredByPolarisKey, groundOf } from "../src/components/brand.js";
import { Button } from "../src/components/primitives/buttons.js";
import {
  defaultTheme,
  highContrastTheme,
  lightTheme,
  mergeTheme,
  neutralDarkTokens,
  neutralLightTokens,
  polarisKeyDarkTokens as darkTokens,
  polarisKeyLightTokens as lightTokens,
  polarisKeyTheme,
  type PartialTheme,
  type PolarisColorScheme,
  type PolarisThemeTokens,
} from "../src/components/theme.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeState } from "../src/desktop/bridge.js";
import {
  emptyBridgeState,
  makeDoc,
  makeFakeBridge,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const RETIRED_INDIGO = ["#5b7cfa", "#7d97ff", "#93a8ff"];

function renderWith(
  ui: JSX.Element,
  opts: {
    state?: BridgeState;
    theme?: PartialTheme;
    colorScheme?: PolarisColorScheme;
    branding?: "neutral" | "polaris-key";
    caps?: ReturnType<typeof services>;
  } = {},
) {
  const adapter = desktopAdapter({
    bridge: makeFakeBridge(opts.state ?? emptyBridgeState()),
    now: () => NOW_SEC,
    expectServices: opts.caps ?? services(),
  });
  return render(
    <PolarisKeyProvider
      productSlug="acme"
      adapter={adapter}
      theme={opts.theme}
      colorScheme={opts.colorScheme}
      branding={opts.branding}
    >
      {ui}
    </PolarisKeyProvider>,
  );
}

function expiredState(): BridgeState {
  return okBridgeState({
    doc: makeDoc({ issuedAt: 100, expiresAt: 200, graceUntil: 300 }),
  });
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[data-polaris-key-root]") as HTMLElement;
}

/** A `matchMedia` whose light query answers `light`, with a live change event. */
function stubMatchMedia(light: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: light,
    media: "(prefers-color-scheme: light)",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: (fn: () => void) => listeners.add(fn),
    removeListener: (fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  return {
    set(next: boolean) {
      mql.matches = next;
      for (const fn of listeners) fn();
    },
  };
}

describe("theme — neutral by default, Polaris Key on one option", () => {
  it("defaults to the neutral theme: the host's font, no Polaris Key colours", () => {
    expect(defaultTheme.branding).toBe("neutral");
    expect(defaultTheme.tokens).toBe(neutralDarkTokens);
    expect(lightTheme.tokens).toBe(neutralLightTokens);
    expect(mergeTheme().tokens).toBe(neutralDarkTokens);
    expect(mergeTheme({}, "light").tokens).toEqual(neutralLightTokens);
    for (const t of [neutralDarkTokens, neutralLightTokens]) {
      expect(t.fontFamily).toBe("inherit");
      const brandHexes = new Set(
        [...Object.values(darkTokens), ...Object.values(lightTokens)].map((v) =>
          v.toLowerCase(),
        ),
      );
      for (const k of ["accent", "ring", "background"] as const)
        expect(brandHexes.has(t[k].toLowerCase())).toBe(false);
    }
  });

  it('`branding: "polaris-key"` (or the preset) switches to the brand tokens', () => {
    expect(mergeTheme(polarisKeyTheme).tokens).toEqual(darkTokens);
    expect(mergeTheme(polarisKeyTheme, "light").tokens).toEqual(lightTokens);
    expect(mergeTheme({ branding: "polaris-key" }).branding).toBe(
      "polaris-key",
    );
    // An integrator's tokens still win over the brand.
    expect(
      mergeTheme({ branding: "polaris-key", tokens: { accent: "#ff5c00" } })
        .tokens.accent,
    ).toBe("#ff5c00");
  });

  it("the Provider's `branding` prop switches the published variables and the marker", () => {
    const neutral = renderWith(<span />);
    let root = rootOf(neutral.container);
    expect(root.getAttribute("data-branding")).toBe("neutral");
    expect(root.style.getPropertyValue("--pk-accent")).toBe(
      neutralDarkTokens.accent,
    );
    expect(root.style.getPropertyValue("--pk-font-family")).toBe("inherit");
    cleanup();
    const brand = renderWith(<span />, { branding: "polaris-key" });
    root = rootOf(brand.container);
    expect(root.getAttribute("data-branding")).toBe("polaris-key");
    expect(root.style.getPropertyValue("--pk-accent")).toBe(darkTokens.accent);
    expect(root.style.getPropertyValue("--pk-font-family")).toMatch(/Rubik/);
  });

  it("the Polaris Key branding reads every colour from the brand's generated tokens, dark and light", () => {
    for (const [tokens, brand] of [
      [darkTokens, THEME_TOKENS.dark],
      [lightTokens, THEME_TOKENS.light],
    ] as const) {
      expect(tokens.accent).toBe(brand.accent.violet.solid);
      expect(tokens.accentText).toBe(brand.accent.violet.on);
      expect(tokens.ring).toBe(brand.focus);
      expect(tokens.background).toBe(brand.surface.page);
      expect(tokens.surface).toBe(brand.surface.raised);
      expect(tokens.surfaceSunken).toBe(brand.surface.sunken);
      expect(tokens.text).toBe(brand.text.default);
      expect(tokens.textStrong).toBe(brand.text.strong);
      expect(tokens.textMuted).toBe(brand.text.muted);
      expect(tokens.border).toBe(brand.border.subtle);
      expect(tokens.borderStrong).toBe(brand.border.strong);
      expect(tokens.danger).toBe(brand.status.danger.fg);
      expect(tokens.warning).toBe(brand.status.warning.fg);
    }
    expect(darkTokens.fontFamily).toMatch(/^"Rubik"/);
  });

  it("carries no blue or indigo accent (BRAND.md §5.1), including the high-contrast variant", () => {
    const accents: [string, "dark" | "light"][] = [
      [darkTokens.accent, "dark"],
      [darkTokens.ring, "dark"],
      [lightTokens.accent, "light"],
      [lightTokens.ring, "light"],
      [highContrastTheme.tokens!.accent!, "dark"],
    ];
    for (const [hex, theme] of accents) {
      expect(RETIRED_INDIGO).not.toContain(hex.toLowerCase());
      expect(
        colorViolations(hex, theme, { gold: false }).filter((v) =>
          /blue|indigo/i.test(v.rule),
        ),
      ).toEqual([]);
    }
  });

  const schemes: [string, PolarisThemeTokens, number][] = [
    ["neutral dark", neutralDarkTokens, 4.5],
    ["neutral light", neutralLightTokens, 4.5],
    ["polaris-key dark", darkTokens, 4.5],
    ["polaris-key light", lightTokens, 4.5],
    ["high contrast", mergeTheme(highContrastTheme).tokens, 7],
  ];

  it.each(schemes)(
    "%s: every text pairing the components use clears its floor (WCAG 1.4.3 / 1.4.6)",
    (_name, t, floor) => {
      const grounds = [t.background, t.surface, t.surfaceSunken];
      for (const ground of grounds) {
        for (const ink of [t.textStrong, t.text, t.textMuted, t.danger]) {
          expect(contrastRatio(ink, ground)).toBeGreaterThanOrEqual(floor);
        }
      }
      expect(contrastRatio(t.text, t.warningSubtle)).toBeGreaterThanOrEqual(
        floor,
      );
      expect(contrastRatio(t.accentText, t.accent)).toBeGreaterThanOrEqual(
        Math.min(floor, 4.5),
      );
    },
  );

  it.each(schemes)(
    "%s: the focus ring and control borders clear 3:1 (WCAG 1.4.11)",
    (_name, t) => {
      for (const ground of [t.background, t.surface, t.surfaceSunken]) {
        expect(contrastRatio(t.ring, ground)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(t.borderStrong, ground)).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("merges an integrator's tokens over the resolved scheme, with per-scheme overrides", () => {
    expect(
      mergeTheme({ tokens: { accent: "#123456" } }, "light").tokens.text,
    ).toBe(neutralLightTokens.text);
    const partial: PartialTheme = {
      tokens: { accent: "#123456" },
      lightTokens: { background: "#fafafa" },
      darkTokens: { background: "#010101" },
    };
    const dark = mergeTheme(partial, "dark");
    const light = mergeTheme(partial, "light");
    expect(dark.tokens.accent).toBe("#123456");
    expect(light.tokens.accent).toBe("#123456");
    expect(dark.tokens.background).toBe("#010101");
    expect(light.tokens.background).toBe("#fafafa");
    expect(light.tokens.text).toBe(neutralLightTokens.text);
    expect(mergeTheme(partial).scheme).toBe("dark");
  });
});

describe("PolarisKeyProvider — colorScheme (BRAND.md §3)", () => {
  it("is dark when the OS states no preference (no matchMedia)", () => {
    const { container } = renderWith(<span />);
    const root = rootOf(container);
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.getPropertyValue("--pk-background")).toBe(
      neutralDarkTokens.background,
    );
    expect(root.style.colorScheme).toBe("dark");
  });

  it('"system" follows prefers-color-scheme, live', () => {
    const media = stubMatchMedia(true);
    const { container } = renderWith(<span />);
    const root = rootOf(container);
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.style.getPropertyValue("--pk-background")).toBe(
      neutralLightTokens.background,
    );
    act(() => media.set(false));
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.getPropertyValue("--pk-text")).toBe(
      neutralDarkTokens.text,
    );
  });

  it('"dark" and "light" pin the scheme whatever the OS says', () => {
    stubMatchMedia(true);
    const dark = renderWith(<span />, { colorScheme: "dark" });
    expect(rootOf(dark.container).getAttribute("data-theme")).toBe("dark");
    cleanup();
    stubMatchMedia(false);
    const light = renderWith(<span />, { colorScheme: "light" });
    expect(rootOf(light.container).getAttribute("data-theme")).toBe("light");
    expect(
      document.documentElement.style.getPropertyValue("--pk-surface"),
    ).toBe(neutralLightTokens.surface);
  });
});

describe("marks on the SDK's screens (BRAND.md §7.1, §6)", () => {
  it("the neutral theme shows no Polaris Key mark anywhere", async () => {
    const { container } = renderWith(
      <LicenseGate>
        <div />
      </LicenseGate>,
      { state: expiredState() },
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="expired"]'),
      ).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-mark]")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("under the Polaris Key branding the gate shows the Pinned K, named, with no terminal bit and no gold", async () => {
    const { container } = renderWith(
      <LicenseGate>
        <div />
      </LicenseGate>,
      { state: expiredState(), branding: "polaris-key" },
    );
    const screen = await waitFor(() => {
      const el = container.querySelector('[data-polaris-gate="expired"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const marks = screen.querySelectorAll('[data-polaris-mark="key"]');
    // One mark: the embedded sign-in card does not repeat it.
    expect(marks).toHaveLength(1);
    const mark = marks[0]!;
    expect(mark.getAttribute("role")).toBe("img");
    expect(mark.getAttribute("aria-label")).toBe("Polaris Key");
    const fills = [...mark.querySelectorAll("path")].map((p) =>
      (p.getAttribute("fill") ?? "").toLowerCase(),
    );
    expect(fills).not.toContain("#ffc24d");
    expect(fills).not.toContain("#d07a00");
    // Body (violet) and star (white) only: the bit's path is left out of the markup entirely.
    expect(new Set(fills)).toEqual(new Set(["#9a5cff", "#ffffff"]));
  });

  it("picks the mark variant for the ground in use (dark means FOR dark)", () => {
    expect(groundOf(mergeTheme(polarisKeyTheme, "dark"))).toBe("dark");
    expect(groundOf(mergeTheme(polarisKeyTheme, "light"))).toBe("light");
    expect(
      groundOf(mergeTheme({ tokens: { background: "#fff" } }, "dark")),
    ).toBe("light");
    expect(
      groundOf(mergeTheme({ tokens: { background: "var(--host)" } }, "light")),
    ).toBe("light");
  });

  it("an integrator's logo replaces the mark, and `logo: null` removes it", async () => {
    const custom = renderWith(<PolarisLogin />, {
      theme: { logo: <span data-testid="acme-logo">ACME</span> },
      branding: "polaris-key",
    });
    expect(within(custom.container).getByTestId("acme-logo")).toBeTruthy();
    expect(custom.container.querySelector("[data-polaris-mark]")).toBeNull();
    cleanup();
    const none = renderWith(<PolarisLogin />, {
      theme: { logo: null },
      branding: "polaris-key",
    });
    expect(none.container.querySelector("[data-polaris-mark]")).toBeNull();
  });

  it("an update dialog carries the Star Cut as Polaris Key Delivery", async () => {
    const fetcher = vi.fn(async () => ({
      version: "2.0.0",
      tag: "v2.0.0",
      url: "https://example.test/2.0.0",
      updateAvailable: true,
    }));
    const { container } = renderWith(
      <UpdatePrompt variant="dialog" fetcher={fetcher} />,
      {
        state: okBridgeState(),
        caps: services("license", "config", "update"),
        branding: "polaris-key",
      },
    );
    const mark = await waitFor(() => {
      const el = container.querySelector('[data-polaris-mark="delivery"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(mark.getAttribute("aria-label")).toBe("Polaris Key Delivery");
    expect(container.querySelector('[data-polaris-mark="key"]')).toBeNull();
  });
});

describe('"Powered by Polaris Key" (BRAND.md §1.5, §7.2)', () => {
  it("is off by default on the sign-in card, under both brandings", () => {
    const { container } = renderWith(<PolarisLogin />);
    expect(container.querySelector("[data-polaris-powered-by]")).toBeNull();
    cleanup();
    const brand = renderWith(<PolarisLogin />, { branding: "polaris-key" });
    expect(
      brand.container.querySelector("[data-polaris-powered-by]"),
    ).toBeNull();
  });

  it("appears, compact and never below its minimum, when the integrator opts in", () => {
    const { container } = renderWith(<PolarisLogin />, {
      theme: { poweredBy: true },
    });
    const wrap = container.querySelector(
      '[data-polaris-powered-by="compact"]',
    ) as HTMLElement;
    expect(wrap).toBeTruthy();
    const svg = wrap.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("Powered by Polaris Key");
    expect(Number(svg.getAttribute("width"))).toBeGreaterThanOrEqual(232);
    expect(Number(svg.getAttribute("height"))).toBeGreaterThanOrEqual(88);
  });

  it("the standalone badge raises a too-small width to the layout minimum", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container } = renderWith(
      <PoweredByPolarisKey layout="horizontal" width={100} />,
    );
    const svg = container.querySelector(
      '[data-polaris-powered-by="horizontal"] svg',
    )!;
    expect(Number(svg.getAttribute("width"))).toBe(376);
    expect(Number(svg.getAttribute("height"))).toBe(144);
  });
});

describe("focus ring (BRAND.md §7.4)", () => {
  it("paints 2px solid --pk-ring on keyboard focus and clears it on blur", () => {
    const { getByRole } = renderWith(<Button>Go</Button>);
    const button = getByRole("button", { name: "Go" });
    vi.spyOn(button, "matches").mockImplementation(
      (sel: string) => sel === ":focus-visible",
    );
    fireEvent.focus(button);
    expect(button.style.outline).toBe("2px solid var(--pk-ring)");
    expect(button.style.outlineOffset).toBe("2px");
    fireEvent.blur(button);
    expect(button.style.outline).toBe("none");
  });

  it("does not paint the ring on a pointer focus", () => {
    const { getByRole } = renderWith(<Button>Go</Button>);
    const button = getByRole("button", { name: "Go" });
    vi.spyOn(button, "matches").mockImplementation(() => false);
    fireEvent.focus(button);
    expect(button.style.outline).toBe("none");
  });
});

describe("CSP safety", () => {
  it("renders no <style> or <script> element and no style attribute inside the artwork", async () => {
    const { container } = renderWith(
      <>
        <LicenseGate>
          <div />
        </LicenseGate>
        <PoweredByPolarisKey />
      </>,
      {
        state: expiredState(),
        theme: { poweredBy: true },
        branding: "polaris-key",
      },
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-gate="expired"]'),
      ).toBeTruthy(),
    );
    expect(container.querySelectorAll("style, script")).toHaveLength(0);
    expect(container.querySelectorAll("svg [style], svg[style]")).toHaveLength(
      0,
    );
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(1);
  });

  it("no SDK source injects markup or a stylesheet itself", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(src);
    const hits = files.filter((f) =>
      /dangerouslySetInnerHTML|createElement\(["']style|insertRule\(|\.innerHTML\s*=/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(hits).toEqual([]);
  });
});
