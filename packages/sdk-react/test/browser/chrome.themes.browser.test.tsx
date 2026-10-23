// @pkey-feature ui.kit ui.theme
//
// Themes, presets, identity and contrast per desktop chrome (UK-06.10), in real Chromium:
//
//   * `preset: "native"` per chrome draws the platform's own face (Segoe UI Variable, Adwaita Sans
//     or Cantarell, San Francisco) on a page that sets none;
//   * the custom light accent #ff6a3d and a dark accent keep their contrast on the render: text
//     4.5:1 (the primary's label, accent text, the title), UI 3:1 (the primary's fill and the
//     focus ring against the page), under both presets and in both schemes;
//   * forced colours (both schemes) draw system colours: the primary is Highlight, text CanvasText,
//     the product ambient is gone;
//   * Increase Contrast (`prefers-contrast: more`) lifts muted text to the default and, on macOS,
//     every hairline to full contrast;
//   * the host's reduced transparency (`data-transparency`) makes the macOS glass sheet opaque.
//
// PKEY_KIT_BASELINES=<dir> records <dir>/<Component>.<state>/<chrome>-native-1440-<scheme>.png and
// <chrome>-forced-colors-1440-<scheme>.png (React's own set: nothing in the elements lane pairs
// with it, so it lives outside test/visual/__screenshots__, which ui:report compares).

import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { contrastRatio } from "@polaris-key/brand/color";
import { LAYOUTS } from "@polaris-key/elements/contract";

import * as Kit from "@polaris-key/react/kit";
import {
  HOST_APP_HTML,
  WINDOWS_SCENES,
  sceneInput,
  type Scene,
} from "../chromeScenes.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
    emulateContrast: (contrast: "more" | null) => Promise<void>;
    emulateForced: (forced: "active" | null) => Promise<void>;
    emulateScheme: (scheme: "dark" | "light" | null) => Promise<void>;
  }
}
declare const __PKEY_KIT_BASELINES__: string;

const CHROMES = [
  { name: "windows", platform: "windows", os: "windows" },
  { name: "gnome", platform: "linux", os: "linux" },
  { name: "macos", platform: "macos", os: "macos" },
] as const;
type Chrome = (typeof CHROMES)[number];
const SCHEMES = ["dark", "light"] as const;
type Scheme = (typeof SCHEMES)[number];
const PRODUCT = { name: "Tidewater", developer: "Lumen Games" };
const IDS = ["Welcome.default", "UpdatePrompt.available", "Settings.list"];
const SCENES = WINDOWS_SCENES.filter((s) => IDS.includes(s.id));
const sceneById = (id: string) => SCENES.find((s) => s.id === id)!;

beforeAll(async () => {
  await Kit.preloadKitParts();
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../../../brand/fonts/fonts.css", import.meta.url).href;
  document.head.append(link);
  await new Promise<void>((resolve) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.body.style.background = "";
  document.body.style.colorScheme = "";
  await commands.emulateContrast(null);
  await commands.emulateForced(null);
  await commands.emulateScheme(null);
});
const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));
const COMPONENTS = Kit as unknown as Record<
  string,
  (p: Kit.KitProps & { children?: ReactNode }) => ReactNode
>;

async function mount(
  chrome: Chrome,
  scene: Scene,
  scheme: Scheme,
  theme: Kit.KitTheme = {},
): Promise<HTMLElement> {
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  document.body.style.colorScheme = scheme;
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  host = document.createElement("div");
  document.body.append(host);
  const Component = COMPONENTS[scene.component]!;
  root = createRoot(host);
  const dialogScene = scene.sheet === true || scene.dialog === true;
  root.render(
    <>
      {dialogScene ? (
        <div dangerouslySetInnerHTML={{ __html: HOST_APP_HTML }} />
      ) : null}
      <Component
        input={sceneInput(scene, { os: chrome.os, formFactor: "computer" })}
        {...(scene.sheet ? { presentation: "sheet", open: true } : {})}
        fill={
          !dialogScene &&
          LAYOUTS[scene.component as keyof typeof LAYOUTS].kind === "screen"
        }
        theme={{
          product: PRODUCT,
          colorScheme: scheme,
          platform: chrome.platform,
          ...theme,
        }}
      >
        <main data-host-content="">
          <p>The app</p>
        </main>
      </Component>
    </>,
  );
  for (let i = 0; i < 100 && !host.querySelector(".pk-root"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await document.fonts.ready;
  await frame();
  await Promise.all(
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
  await frame();
  await frame();
  return host.querySelector<HTMLElement>(".pk-root")!;
}

/** Any CSS colour (a var, a color-mix, a system colour) as the `#rrggbb` it paints. */
const swatch = document.createElement("canvas").getContext("2d", {
  willReadFrequently: true,
})!;
function hex(css: string): string {
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = "#000";
  swatch.fillStyle = css;
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b] = swatch.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, "0")).join("")}`;
}
/** A colour property resolved on `el`, through a probe so vars and mixes compute. */
function paint(el: Element, prop: "color" | "backgroundColor"): string {
  return hex(getComputedStyle(el)[prop]);
}
const varColor = (el: Element, name: string): string =>
  hex(
    (() => {
      const probe = document.createElement("i");
      probe.style.color = `var(${name})`;
      el.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    })(),
  );

const MEASURED: string[] = [];
afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`CONTRAST (min per case)\n${MEASURED.join("\n")}`);
});

describe("the native preset, per chrome", () => {
  const FACES = {
    windows: /Segoe UI Variable/,
    gnome: /Adwaita Sans/,
    macos: /-apple-system/,
  } as const;
  for (const chrome of CHROMES)
    it(`${chrome.name} draws its platform face on a page that sets none`, async () => {
      await page.viewport(1440, 900);
      const kit = await mount(chrome, sceneById("Welcome.default"), "light", {
        preset: "native",
      });
      expect(kit.dataset.preset).toBe("native");
      const family = getComputedStyle(kit).fontFamily;
      expect(family).toMatch(FACES[chrome.name]);
      const title = kit.querySelector("h1, h2")!;
      expect(getComputedStyle(title).fontFamily).toMatch(FACES[chrome.name]);
    });
});

describe("contrast on the render", () => {
  const ACCENTS = [
    { name: "light accent #ff6a3d", accent: "#ff6a3d" },
    { name: "dark accent #3b2aa0", accent: "#3b2aa0" },
  ];
  for (const chrome of CHROMES)
    for (const preset of ["polaris-key", "native"] as const)
      for (const scheme of SCHEMES)
        for (const a of ACCENTS)
          it(`${chrome.name} ${preset} ${scheme} ${a.name}`, async () => {
            await page.viewport(1440, 900);
            const kit = await mount(
              chrome,
              sceneById("Welcome.default"),
              scheme,
              { preset, accent: a.accent },
            );
            const stage = kit.querySelector(".stage") ?? kit;
            const ground = paint(stage, "backgroundColor");
            const primary = kit.querySelector<HTMLElement>(
              '.btn[data-variant="primary"]',
            )!;
            const link = kit.querySelector<HTMLElement>(
              '.btn[data-variant="link"], a[href]',
            );
            const title = kit.querySelector("h1, h2")!;
            const rows: [string, number, number][] = [
              [
                "primary label on its fill",
                contrastRatio(
                  paint(primary, "color"),
                  paint(primary, "backgroundColor"),
                ),
                4.5,
              ],
              [
                "primary fill on the page",
                contrastRatio(paint(primary, "backgroundColor"), ground),
                3,
              ],
              [
                "focus ring on the page",
                contrastRatio(varColor(kit, "--pk-ring"), ground),
                3,
              ],
              [
                "title on the page",
                contrastRatio(paint(title, "color"), ground),
                4.5,
              ],
              ...(link
                ? ([
                    [
                      "link on the page",
                      contrastRatio(paint(link, "color"), ground),
                      4.5,
                    ],
                  ] as [string, number, number][])
                : []),
            ];
            for (const [what, ratio, min] of rows)
              expect(ratio, `${what} (${ground})`).toBeGreaterThanOrEqual(min);
            MEASURED.push(
              `${chrome.name} ${preset} ${scheme} ${a.accent}: ` +
                rows.map(([w, r]) => `${w} ${r.toFixed(2)}`).join("; "),
            );
          });
});

describe("forced colours, in both schemes", () => {
  for (const chrome of CHROMES)
    for (const scheme of SCHEMES)
      it(`${chrome.name} ${scheme} draws system colours`, async () => {
        await page.viewport(1440, 900);
        await commands.emulateScheme(scheme);
        await commands.emulateForced("active");
        const kit = await mount(chrome, sceneById("Welcome.default"), scheme, {
          accent: "#ff6a3d",
        });
        const primary = kit.querySelector<HTMLElement>(
          '.btn[data-variant="primary"]',
        )!;
        const system = (prop: "color" | "backgroundColor", css: string) => {
          const p = document.createElement("i");
          p.style[prop] = css;
          kit.append(p);
          const out = hex(getComputedStyle(p)[prop]);
          p.remove();
          return out;
        };
        expect(paint(primary, "backgroundColor")).toBe(
          system("backgroundColor", "Highlight"),
        );
        expect(paint(primary, "color")).toBe(system("color", "HighlightText"));
        expect(paint(kit.querySelector("h1, h2")!, "color")).toBe(
          system("color", "CanvasText"),
        );
        for (const a of kit.querySelectorAll(".ambient, .passport-ambient"))
          expect(getComputedStyle(a).display).toBe("none");
        if (__PKEY_KIT_BASELINES__)
          for (const scene of SCENES) {
            root?.unmount();
            host?.remove();
            await mount(chrome, scene, scheme, { accent: "#ff6a3d" });
            await commands.kitShot(
              `${__PKEY_KIT_BASELINES__}/${scene.id}/${chrome.name}-forced-colors-1440-${scheme}.png`,
            );
          }
      });
});

describe("native baselines", () => {
  for (const chrome of CHROMES)
    for (const scheme of SCHEMES)
      it(`${chrome.name} native 1440 ${scheme}`, async () => {
        if (!__PKEY_KIT_BASELINES__) return;
        await page.viewport(1440, 900);
        for (const scene of SCENES) {
          root?.unmount();
          host?.remove();
          await mount(chrome, scene, scheme, { preset: "native" });
          await commands.kitShot(
            `${__PKEY_KIT_BASELINES__}/${scene.id}/${chrome.name}-native-1440-${scheme}.png`,
          );
        }
      });
});

describe("Increase Contrast and reduced transparency", () => {
  for (const chrome of CHROMES)
    it(`${chrome.name} lifts muted text under prefers-contrast: more`, async () => {
      await page.viewport(1440, 900);
      await commands.emulateContrast("more");
      const kit = await mount(chrome, sceneById("Welcome.default"), "light");
      expect(varColor(kit, "--pk-text-muted")).toBe(
        varColor(kit, "--pk-text-default"),
      );
      if (chrome.name === "macos")
        expect(varColor(kit, "--pk-border-subtle")).toBe(
          varColor(kit, "--pk-text-strong"),
        );
    });

  it("the host's Increase Contrast draws the same on macOS", async () => {
    await page.viewport(1440, 900);
    const kit = await mount(CHROMES[2], sceneById("Welcome.default"), "light");
    kit.setAttribute("data-contrast", "more");
    expect(varColor(kit, "--pk-border-subtle")).toBe(
      varColor(kit, "--pk-text-strong"),
    );
    expect(varColor(kit, "--pk-text-muted")).toBe(
      varColor(kit, "--pk-text-default"),
    );
  });

  it("the host's reduced transparency makes the macOS sheet opaque", async () => {
    await page.viewport(1440, 900);
    const scene = WINDOWS_SCENES.find((s) => s.sheet)!;
    const kit = await mount(CHROMES[2], scene, "dark");
    const sheet = () => kit.querySelector<HTMLElement>("dialog.sheet")!;
    expect(getComputedStyle(sheet()).backdropFilter).not.toBe("none");
    kit.setAttribute("data-transparency", "reduce");
    expect(getComputedStyle(sheet()).backdropFilter).toBe("none");
    expect(getComputedStyle(sheet()).backgroundColor).toMatch(
      /^rgb\(|^color\(srgb [\d. ]+\)$/,
    );
  });
});
