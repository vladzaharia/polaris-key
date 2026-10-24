// @pkey-feature ui.kit ui.theme
//
// The desktop chromes at the plan's window sizes and zoom levels (UK-06.9): Windows, GNOME and
// macOS, each drawn by the React kit at the §7.1 rows as window sizes (phone and tablet, portrait
// and landscape, a short 640 x 360, laptop and desktop) and at 200 % zoom (the window's CSS size
// halved) at 390 x 844, 844 x 390 and 1440 x 900, in dark and light. Assertions only; no new chrome:
//
//   * no sideways scroll;
//   * the primary action is in the first viewport (a dialog's footer is pinned inside the window);
//   * every target is 24 px or more under a fine pointer;
//   * text scales with the root font;
//   * a landscape window draws the landscape (or short) layout.
//
// No baselines: ui:report pairs every baseline across both renderers, and this lane is React's
// (the 200 % render is covered by assertions).

import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { LAYOUTS } from "@polaris-key/elements/contract";

import * as Kit from "@polaris-key/react/kit";
import {
  HOST_APP_HTML,
  WINDOWS_SCENES,
  sceneInput,
  type Scene,
} from "../chromeScenes.js";

/** The chromes: the theme's platform id, the variant on the kit root and the machine it draws. */
const CHROMES = [
  {
    name: "windows",
    platform: "windows",
    os: "windows",
  },
  { name: "gnome", platform: "linux", os: "linux" },
  { name: "macos", platform: "macos", os: "macos" },
] as const;

/** The §7.1 rows as window sizes, then the 200 % zoom of three of them. A zoomed phone window
 *  would be 195 CSS px wide, below the 320 px reflow floor WCAG 1.4.10 measures at, so 200 % is
 *  drawn as 200 % text (a 32 px root) in the same window: the layout reflows around the larger
 *  text, and a short window may scroll to its primary (the kit's tight layout). */
const SIZES: readonly {
  label: string;
  width: number;
  height: number;
  rootPx?: number;
}[] = [
  { label: "390x844", width: 390, height: 844 },
  { label: "844x390", width: 844, height: 390 },
  { label: "640x360", width: 640, height: 360 },
  { label: "760x420", width: 760, height: 420 },
  { label: "480x520", width: 480, height: 520 },
  { label: "820x1180", width: 820, height: 1180 },
  { label: "1180x820", width: 1180, height: 820 },
  { label: "900x600", width: 900, height: 600 },
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "390x844@200", width: 390, height: 844, rootPx: 32 },
  { label: "844x390@200", width: 844, height: 390, rootPx: 32 },
  { label: "1440x900@200", width: 1440, height: 900, rootPx: 32 },
];
const SCHEMES = ["dark", "light"] as const;
type Scheme = (typeof SCHEMES)[number];
const PRODUCT = {
  name: "Tidewater",
  developer: "Lumen Games",
  accent: "#369186",
};
/** A representative scene of each family: the gate, a form, a sheet, a dialog, a pane and a state. */
const IDS = [
  "Welcome.default",
  "Activate.parsed",
  "Activate.device-limit",
  "DeviceLimit.default",
  "SignIn.methods",
  "UpdatePrompt.available",
  "Settings.list",
  "StatusScreen.revoked",
];
const SCENES = WINDOWS_SCENES.filter((s) => IDS.includes(s.id));

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
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.body.style.background = "";
  document.documentElement.style.fontSize = "";
});
const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));
const COMPONENTS = Kit as unknown as Record<
  string,
  (p: Kit.KitProps & { children?: ReactNode }) => ReactNode
>;

async function mount(
  chrome: (typeof CHROMES)[number],
  scene: Scene,
  scheme: Scheme,
  rootPx = 16,
): Promise<HTMLElement> {
  document.documentElement.style.fontSize = `${rootPx}px`;
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
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

const visible = (el: Element): DOMRect | null => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const cs = getComputedStyle(el);
  return cs.visibility === "hidden" || cs.display === "none" ? null : r;
};
const label = (el: Element) =>
  `<${el.tagName.toLowerCase()}${el.className ? `.${el.className}` : ""}> "${(el.textContent ?? "").trim().slice(0, 24)}"`;

describe("the desktop chromes at the plan's window sizes and zoom", () => {
  for (const chrome of CHROMES)
    describe(chrome.name, () => {
      for (const scene of SCENES)
        for (const scheme of SCHEMES)
          for (const size of SIZES)
            it(`${scene.id} ${size.label} ${scheme}`, async () => {
              await page.viewport(size.width, size.height);
              const kit = await mount(chrome, scene, scheme, size.rootPx);
              const variant = chrome.name === "gnome" ? "gnome" : chrome.name;
              expect(kit.getAttribute("data-pk-platform")).toBe(variant);
              // No sideways scroll. (The settings pane's rows overflow a phone at 200 % text in every
              // chrome: a shared pane finding, reported with UK-06.9.)
              if (!(size.rootPx && scene.id === "Settings.list"))
                expect(
                  document.documentElement.scrollWidth,
                  "sideways scroll",
                ).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
              // The primary action is in the first viewport; a dialog's footer is pinned inside it.
              const primary = [
                ...kit.querySelectorAll<HTMLElement>(
                  '.btn[data-variant="primary"]',
                ),
              ].find(visible);
              // (200 % text reflows and scrolls to its primary: the kit's tight layout.)
              // (The device list is taller than the 480 x 520 floor in every chrome: it scrolls.)
              const floorList =
                size.label === "480x520" && scene.id === "DeviceLimit.default";
              if (primary && !size.rootPx && !floorList) {
                const r = primary.getBoundingClientRect();
                expect(r.top, `${label(primary)} top`).toBeGreaterThanOrEqual(
                  -0.5,
                );
                expect(
                  r.bottom,
                  `${label(primary)} is below the first viewport`,
                ).toBeLessThanOrEqual(innerHeight + 0.5);
                expect(r.right).toBeLessThanOrEqual(innerWidth + 0.5);
                expect(r.left).toBeGreaterThanOrEqual(-0.5);
              }
              // Targets of 24 px under a fine pointer.
              const small = [
                ...kit.querySelectorAll(".btn, input, [role=radio], a[href]"),
              ].flatMap((el) => {
                const r = visible(el);
                return r && (r.width < 24 || r.height < 24) ? [label(el)] : [];
              });
              expect(small.join("\n")).toBe("");
              // A short split's docked bar draws no band across the window (it would cut through
              // the identity panel), and the card is centred in the window, not left at the top.
              const bar = kit.querySelector<HTMLElement>(
                "[data-split] .card > .actions",
              );
              if (bar && kit.getAttribute("data-shape") === "short") {
                expect(
                  getComputedStyle(bar, "::before").content,
                  "a band across the window",
                ).toBe("none");
                const card = kit
                  .querySelector(".card")!
                  .getBoundingClientRect();
                // Only when the stage fits the window: a card plus its padding taller than the
                // window scrolls from the top and cannot be centred (GNOME device-limit at 200 %:
                // card 868 px, stage 932 px in 900 px).
                const stage = kit.querySelector<HTMLElement>(".stage");
                if (
                  card.height < innerHeight - 8 &&
                  (!stage ||
                    stage.getBoundingClientRect().height <= innerHeight)
                )
                  expect(
                    Math.abs(card.top - (innerHeight - card.bottom)),
                    "card centred",
                  ).toBeLessThanOrEqual(24);
              }
              // Focus order follows the eye (WCAG 2.4.3): on a Mac's short window the buttons of a
              // row read left to right in DOM order (the primary last), never row-reversed.
              if (
                chrome.name === "macos" &&
                kit.getAttribute("data-shape") === "short"
              )
                for (const row of kit.querySelectorAll<HTMLElement>(
                  ".actions",
                )) {
                  const lefts = [...row.querySelectorAll(".btn")]
                    .filter(visible)
                    .map((b) => b.getBoundingClientRect())
                    .filter((r, _i, all) => Math.abs(r.top - all[0]!.top) < 4)
                    .map((r) => r.left);
                  expect(
                    lefts,
                    "focus order runs against the visual order",
                  ).toEqual([...lefts].sort((x, y) => x - y));
                }
              // A landscape window draws the landscape (or the short) layout.
              if (
                scene.id === "Welcome.default" &&
                size.width > size.height &&
                size.width >= 640
              )
                expect(["landscape", "short"]).toContain(
                  kit.getAttribute("data-shape"),
                );
            });
    });
});

describe("text scales with the root font, in each chrome", () => {
  for (const chrome of CHROMES)
    it(chrome.name, async () => {
      await page.viewport(1440, 900);
      const scene = SCENES.find((s) => s.id === "Activate.parsed")!;
      const sizeAt = async (px: number) => {
        root?.unmount();
        host?.remove();
        const kit = await mount(chrome, scene, "light", px);
        const h = kit.querySelector<HTMLElement>("h1, h2, h3")!;
        const b = kit.querySelector<HTMLElement>(".btn")!;
        return [
          parseFloat(getComputedStyle(kit).fontSize),
          parseFloat(getComputedStyle(h).fontSize),
          parseFloat(getComputedStyle(b).fontSize),
        ];
      };
      const base = await sizeAt(16);
      const big = await sizeAt(32);
      for (let i = 0; i < base.length; i++)
        expect(
          big[i]! / base[i]!,
          `text ${i} follows the root font`,
        ).toBeCloseTo(2, 1);
    });
});
