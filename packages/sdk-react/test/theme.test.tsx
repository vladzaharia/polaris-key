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

/** A `matchMedia` for an OS that prefers light (`light`) or dark, with a live change event.
 *  Any other query answers false. */
function stubMatchMedia(light: boolean) {
  const listeners = new Set<() => void>();
  let current = light;
  const mql = (media: string) => ({
    get matches() {
      if (media.includes("prefers-color-scheme: light")) return current;
      if (media.includes("prefers-color-scheme: dark")) return !current;
      return false;
    },
    media,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: (fn: () => void) => listeners.add(fn),
    removeListener: (fn: () => void) => listeners.delete(fn),
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => mql(media)),
  );
  return {
    set(next: boolean) {
      current = next;
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
        [darkTokens, lightTokens].flatMap((brand) =>
          Object.entries(brand)
            // Ink (the primary's fill and its label) is neutral in both themes by design.
            .filter(
              ([k]) => !["accent", "accentHover", "accentText"].includes(k),
            )
            .map(([, v]) => v.toLowerCase()),
        ),
      );
      for (const k of ["accent", "ring", "background"] as const)
        expect(brandHexes.has(t[k].toLowerCase())).toBe(false);
    }
  });

  it("the neutral copy never names Polaris Key; the brand's copy names it only as a placeholder", () => {
    for (const text of Object.values(mergeTheme().copy))
      expect(text).not.toMatch(/Polaris Key/);
    // The sign-in button stays "Sign in" (welcome.signIn) under the brand too: the platform is
    // named in the Powered-by line and the hand-off's address, not on the product's button.
    expect(mergeTheme(polarisKeyTheme).copy.oidcButtonLabel).toBe("Sign in");
    const named = Object.entries(mergeTheme(polarisKeyTheme).copy).filter(
      ([, text]) => /Polaris Key/.test(text),
    );
    expect(named.map(([k]) => k)).toEqual(["productName"]);
    // An integrator's copy wins under either branding.
    expect(
      mergeTheme({ ...polarisKeyTheme, copy: { oidcButtonLabel: "Go" } }).copy
        .oidcButtonLabel,
    ).toBe("Go");
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
    const neutral = renderWith(<span />, { colorScheme: "dark" });
    let root = rootOf(neutral.container);
    expect(root.getAttribute("data-branding")).toBe("neutral");
    expect(root.style.getPropertyValue("--pk-accent")).toBe(
      neutralDarkTokens.accent,
    );
    expect(root.style.getPropertyValue("--pk-font-family")).toBe("inherit");
    cleanup();
    const brand = renderWith(<span />, {
      branding: "polaris-key",
      colorScheme: "dark",
    });
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
      // The primary is ink, not the brand's violet: a kit speaks in the product's accent or in
      // ink (B2, DL13).
      expect(tokens.accent).not.toBe(brand.accent.violet.solid);
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
    // The primary is ink (a neutral); the colour the brand adds is the focus ring.
    expect([darkTokens.accent, lightTokens.accent]).toEqual([
      "#f4f4f5",
      "#18181b",
    ]);
    const accents: [string, "dark" | "light"][] = [
      [darkTokens.ring, "dark"],
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
    // The accent runs through the resolver for each scheme, against that scheme's grounds.
    expect(light.tokens.accent).toBe("#123456");
    expect(dark.tokens.accent).not.toBe("#123456");
    expect(contrastRatio(dark.tokens.accent, "#010101")).toBeGreaterThanOrEqual(
      3,
    );
    expect(dark.tokens.background).toBe("#010101");
    expect(light.tokens.background).toBe("#fafafa");
    expect(light.tokens.text).toBe(neutralLightTokens.text);
    expect(mergeTheme(partial).scheme).toBe("dark");
  });
});

describe("a product accent through the resolver (UI-KITS.md §3.3, DL13; the UK-47 review's V7)", () => {
  // The accents the review measured unreadable: pink on dark (label 3.84:1), navy on dark
  // (label 1.71:1, fill 1.57:1), yellow on light (label 1.63:1).
  const CASES = [
    ["pink", "#ff4fa3", "dark"],
    ["navy", "#1b2a6b", "dark"],
    ["yellow", "#ffd400", "light"],
    ["pink", "#ff4fa3", "light"],
    ["navy", "#1b2a6b", "light"],
    ["yellow", "#ffd400", "dark"],
  ] as const;
  for (const branding of ["neutral", "polaris-key"] as const)
    for (const [name, accent, scheme] of CASES)
      it(`${name} under ${branding}, ${scheme}: a readable primary and ring`, () => {
        const t = mergeTheme({ branding, tokens: { accent } }, scheme).tokens;
        expect(contrastRatio(t.accentText, t.accent)).toBeGreaterThanOrEqual(
          4.5,
        );
        for (const ground of [t.background, t.surface, t.surfaceSunken]) {
          expect(contrastRatio(t.accent, ground)).toBeGreaterThanOrEqual(3);
          expect(contrastRatio(t.ring, ground)).toBeGreaterThanOrEqual(3);
        }
      });

  it("the focus ring follows the product accent, not the brand's violet", () => {
    for (const scheme of ["dark", "light"] as const) {
      const t = mergeTheme(
        { branding: "polaris-key", tokens: { accent: "#ff6a3d" } },
        scheme,
      ).tokens;
      expect(t.ring).not.toBe(THEME_TOKENS[scheme].focus);
      expect(t.ring.toLowerCase()).not.toBe("#9a5cff");
    }
  });

  it("keeps what the integrator set beside the accent, and a var() as given", () => {
    const owned = mergeTheme(
      { tokens: { accent: "#ff4fa3", accentText: "#000000", ring: "#00ff00" } },
      "dark",
    ).tokens;
    expect(owned).toMatchObject({
      accent: "#ff4fa3",
      accentText: "#000000",
      ring: "#00ff00",
    });
    const host = mergeTheme(
      { tokens: { accent: "var(--app-accent)" } },
      "dark",
    ).tokens;
    expect(host.accent).toBe("var(--app-accent)");
    expect(host.ring).toBe(neutralDarkTokens.ring);
  });
});

describe("PolarisKeyProvider — colorScheme (BRAND.md §3)", () => {
  afterEach(() => {
    document.body.style.backgroundColor = "";
    document.querySelector('meta[name="color-scheme"]')?.remove();
  });

  it('"system" on a page that paints nothing and opts in to no dark scheme is light, even when the OS is dark', () => {
    stubMatchMedia(false);
    const { container } = renderWith(<span />);
    const root = rootOf(container);
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.style.getPropertyValue("--pk-background")).toBe(
      neutralLightTokens.background,
    );
    expect(root.style.colorScheme).toBe("light");
  });

  it('"system" follows the host page\'s background, whatever the OS says', () => {
    stubMatchMedia(true);
    document.body.style.backgroundColor = "rgb(17, 17, 17)";
    const dark = renderWith(<span />);
    expect(rootOf(dark.container).getAttribute("data-theme")).toBe("dark");
    cleanup();
    stubMatchMedia(false);
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    const light = renderWith(<span />);
    expect(rootOf(light.container).getAttribute("data-theme")).toBe("light");
  });

  it('"system" on a page that opts in to dark follows prefers-color-scheme, live', () => {
    const meta = document.createElement("meta");
    meta.name = "color-scheme";
    meta.content = "light dark";
    document.head.append(meta);
    const media = stubMatchMedia(true);
    const { container } = renderWith(<span />);
    const root = rootOf(container);
    expect(root.getAttribute("data-theme")).toBe("light");
    act(() => media.set(false));
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.getPropertyValue("--pk-text")).toBe(
      neutralDarkTokens.text,
    );
  });

  it('"dark" and "light" pin the scheme whatever the page and the OS say', () => {
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

describe("the product identity on the SDK's screens (UI-KITS §1.2, §1.6)", () => {
  it("shows no Polaris Key mark under either branding", async () => {
    for (const branding of ["neutral", "polaris-key"] as const) {
      const { container } = renderWith(
        <LicenseGate>
          <div />
        </LicenseGate>,
        { state: expiredState(), branding },
      );
      await waitFor(() =>
        expect(
          container.querySelector('[data-polaris-gate="expired"]'),
        ).toBeTruthy(),
      );
      expect(container.querySelector("[data-polaris-mark]")).toBeNull();
      expect(container.querySelector("[data-polaris-identity]")).toBeNull();
      cleanup();
    }
  });

  it("shows the product's monogram once its name is known, once per screen", async () => {
    const { container } = renderWith(
      <LicenseGate>
        <div />
      </LicenseGate>,
      {
        state: expiredState(),
        theme: { copy: { productName: "Tidewater" } },
      },
    );
    const screen = await waitFor(() => {
      const el = container.querySelector('[data-polaris-gate="expired"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const tiles = screen.querySelectorAll('[data-polaris-identity="monogram"]');
    // One: the embedded sign-in methods do not repeat it.
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.textContent).toBe("T");
    expect(tiles[0]!.getAttribute("aria-hidden")).toBe("true");
  });

  it("picks the badge variant for the ground in use (dark means FOR dark)", () => {
    expect(groundOf(mergeTheme(polarisKeyTheme, "dark"))).toBe("dark");
    expect(groundOf(mergeTheme(polarisKeyTheme, "light"))).toBe("light");
    expect(
      groundOf(mergeTheme({ tokens: { background: "#fff" } }, "dark")),
    ).toBe("light");
    expect(
      groundOf(mergeTheme({ tokens: { background: "var(--host)" } }, "light")),
    ).toBe("light");
  });

  it("an integrator's logo replaces the monogram, and `logo: null` removes it", async () => {
    const custom = renderWith(<PolarisLogin />, {
      theme: {
        logo: <span data-testid="acme-logo">ACME</span>,
        copy: { productName: "Tidewater" },
      },
    });
    expect(within(custom.container).getByTestId("acme-logo")).toBeTruthy();
    expect(
      custom.container.querySelector("[data-polaris-identity]"),
    ).toBeNull();
    cleanup();
    const none = renderWith(<PolarisLogin />, {
      theme: { logo: null, copy: { productName: "Tidewater" } },
    });
    expect(none.container.querySelector("[data-polaris-identity]")).toBeNull();
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
    // Keyboard focus: a key was pressed since the last pointer press.
    fireEvent.keyDown(document, { key: "Tab" });
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

  it("does not paint the ring on focus a screen moves before any key press (a cold start)", () => {
    const { getByRole } = renderWith(<Button>Go</Button>);
    const button = getByRole("button", { name: "Go" });
    // :focus-visible matches a programmatic focus on a cold start; the ring still waits for a key.
    vi.spyOn(button, "matches").mockImplementation(
      (sel: string) => sel === ":focus-visible",
    );
    fireEvent.pointerDown(document);
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
