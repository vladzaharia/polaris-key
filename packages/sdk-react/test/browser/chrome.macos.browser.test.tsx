// @pkey-feature ui.kit ui.theme
//
// The macOS chrome of the React kit in real Chromium (UK-06.8): `theme.platform: "macos"` sets
// `data-pk-platform="macos"` and the same web DOM draws at Mac scale: 13 pt body, 28 pt capsule
// controls (36 pt on the Welcome hero), grouped sections at radius 10, the sheet a floating glass
// panel inset below the title-bar row (radius 24 on every side, 440 pt at most, the parent not
// dimmed), the default at the trailing edge, button wording through the catalog's `macos`
// variants, a 480 x 520 window laid out whole, and Increase Contrast putting hairlines at full
// contrast. Every render passes axe (WCAG 2.2 AA), has no sideways scroll and no target under 24
// px, in dark and light at 390 and 1440.
//
// PKEY_KIT_BASELINES=<dir> records <dir>/<Component>.<state>/macos-<size>-<scheme>.png.
// PKEY_KIT_SHOTS=<dir> writes <dir>/react.macos.<scene>/<size>-<scheme>.png for the UX review.

import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { LAYOUTS } from "@polaris-key/elements/contract";

import * as Kit from "@polaris-key/react/kit";
import {
  HOST_APP_HTML,
  WINDOWS_SCENES as SCENES,
  sceneInput,
  type Scene,
} from "../chromeScenes.js";

/** A Mac: the platform every scene is drawn on. */
const MAC_PLATFORM = { os: "macos", formFactor: "mac" };

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
    emulateContrast: (contrast: "more" | null) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_KIT_BASELINES__: string;

/** The phone row, the narrowest Mac window (480 x 520), the narrow and default windows, and the
 *  desktop row. */
const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "480x520", width: 480, height: 520 },
  { label: "480x640", width: 480, height: 640 },
  { label: "900x600", width: 900, height: 600 },
  { label: "1440", width: 1440, height: 900 },
] as const;
const SCHEMES = ["dark", "light"] as const;
type Scheme = (typeof SCHEMES)[number];
const PRODUCT = {
  name: "Tidewater",
  developer: "Lumen Games",
  accent: "#369186",
};

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
  await commands.emulateContrast(null);
});
const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));
const COMPONENTS = Kit as unknown as Record<
  string,
  (p: Kit.KitProps & { children?: ReactNode }) => ReactNode
>;

async function mount(scene: Scene, scheme: Scheme): Promise<HTMLElement> {
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  host = document.createElement("div");
  document.body.append(host);
  const Component = COMPONENTS[scene.component];
  if (!Component) throw new Error(`no React kit component ${scene.component}`);
  root = createRoot(host);
  const dialogScene = scene.sheet === true || scene.dialog === true;
  root.render(
    <>
      {dialogScene ? (
        <div dangerouslySetInnerHTML={{ __html: HOST_APP_HTML }} />
      ) : null}
      <Component
        input={sceneInput(scene, MAC_PLATFORM)}
        {...(scene.sheet ? { presentation: "sheet", open: true } : {})}
        fill={
          !dialogScene &&
          LAYOUTS[scene.component as keyof typeof LAYOUTS].kind === "screen"
        }
        theme={{ product: PRODUCT, colorScheme: scheme, platform: "macos" }}
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

async function axeViolations(kit: HTMLElement): Promise<string[]> {
  const result = await axe.run(
    { include: [kit] } as unknown as axe.ElementContext,
    {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      },
      rules: {
        region: { enabled: false },
        "landmark-one-main": { enabled: false },
      },
    },
  );
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`),
  );
}

/** True when a scrolling ancestor (the card's body, a long list) hides the element from view. */
function scrolledAway(el: Element): boolean {
  const r = el.getBoundingClientRect();
  for (
    let a = el.parentElement;
    a && a !== document.body;
    a = a.parentElement
  ) {
    if (getComputedStyle(a).overflowY === "visible") continue;
    const box = a.getBoundingClientRect();
    if (r.bottom <= box.top + 1 || r.top >= box.bottom - 1) return true;
  }
  return false;
}

/** Tab order is the visual order (WCAG 2.4.3): each stop is at or below the one before it, and in
 *  the same row it is further along the reading direction. */
function tabOrderProblems(root: ParentNode): string[] {
  const stops = [
    ...root.querySelectorAll<HTMLElement>(
      "button, a[href], input, textarea, select, [tabindex='0']",
    ),
  ].filter(
    (el) => visible(el) && !scrolledAway(el) && !el.hasAttribute("disabled"),
  );
  const rtl = getComputedStyle(stops[0] ?? document.body).direction === "rtl";
  const out: string[] = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!.getBoundingClientRect();
    const b = stops[i]!.getBoundingClientRect();
    const sameRow = Math.abs(b.top - a.top) <= 2;
    if (b.top < a.top - 2)
      out.push(`${label(stops[i]!)} is above ${label(stops[i - 1]!)}`);
    else if (sameRow && (rtl ? b.left > a.left + 2 : b.left < a.left - 2))
      out.push(
        `${label(stops[i]!)} is before ${label(stops[i - 1]!)} in its row`,
      );
  }
  return out;
}

function chrome(kit: HTMLElement, scene: Scene) {
  expect(kit.getAttribute("data-pk-platform")).toBe("macos");
  // Mac scale: a 13 pt body.
  expect(parseFloat(getComputedStyle(kit).fontSize), "body size").toBe(13);
  const fine = !matchMedia("(pointer: coarse)").matches;
  for (const b of kit.querySelectorAll<HTMLElement>(
    '.btn:is([data-variant="primary"], [data-variant="secondary"])',
  )) {
    const r = visible(b);
    if (!r || !fine) continue;
    // 28 pt capsule controls; Welcome's two are the 36 pt hero size.
    expect(r.height, `${label(b)} height`).toBe(
      scene.component === "Welcome" ? 36 : 28,
    );
    expect(parseFloat(getComputedStyle(b).borderTopLeftRadius)).toBeGreaterThan(
      100,
    );
  }
  for (const list of kit.querySelectorAll<HTMLElement>(".list"))
    if (visible(list))
      expect(parseFloat(getComputedStyle(list).borderTopLeftRadius)).toBe(10);
  for (const l of kit.querySelectorAll<HTMLElement>(
    '.links .btn[data-variant="link"]',
  ))
    if (visible(l))
      expect(
        parseFloat(getComputedStyle(l).paddingInlineStart),
      ).toBeLessThanOrEqual(4);
  const paste = kit.querySelector<HTMLElement>(".field-paste .paste");
  if (paste && visible(paste)) {
    const field = kit
      .querySelector<HTMLElement>(".field-paste")!
      .getBoundingClientRect();
    const r = paste.getBoundingClientRect();
    expect(r.bottom).toBeLessThanOrEqual(field.bottom + 0.5);
    expect(r.top).toBeGreaterThanOrEqual(field.top - 0.5);
    expect(r.width).toBeLessThanOrEqual(field.height + 0.5);
  }
  const dialog = kit.querySelector<HTMLDialogElement>("dialog[open]");
  if (scene.sheet || scene.dialog) {
    expect(dialog, "the sheet is a modal dialog").not.toBeNull();
    // The parent is not dimmed.
    expect(getComputedStyle(dialog!, "::backdrop").backgroundColor).toMatch(
      /^rgba\(0, 0, 0, 0\)|transparent/,
    );
    // The dialog itself is the rounded, shadowed panel.
    const dcs = getComputedStyle(dialog!);
    for (const c of [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomLeftRadius",
      "borderBottomRightRadius",
    ] as const)
      expect(parseFloat(dcs[c]), c).toBe(24);
    expect(dcs.boxShadow).not.toBe("none");
    expect(dcs.overflow).toBe("visible");
    const box = dialog!.getBoundingClientRect();
    // Floats inset below the title-bar row, 440 pt at most, never docked to the bottom.
    expect(box.top).toBeGreaterThanOrEqual(51);
    expect(box.width).toBeLessThanOrEqual(440 + 1);
    expect(box.bottom).toBeLessThan(innerHeight);
    const footer = dialog!.querySelector<HTMLElement>(
      ".card > .actions:not([data-group])",
    );
    if (footer) {
      // Pinned: the default is always in view, whatever the window height.
      expect(
        footer.getBoundingClientRect().bottom,
        "footer bottom",
      ).toBeLessThanOrEqual(innerHeight + 0.5);
      const buttons = [...footer.querySelectorAll<HTMLElement>(".btn")].filter(
        visible,
      );
      if (fine)
        for (const b of buttons)
          expect(
            b.getBoundingClientRect().height,
            `${label(b)} is one line`,
          ).toBe(28);
      const p = buttons.find((b) => b.dataset.variant === "primary");
      const tops = buttons.map((b) => b.getBoundingClientRect().top);
      if (
        p &&
        buttons.length >= 2 &&
        Math.max(...tops) - Math.min(...tops) <= 2
      ) {
        // In a row the default is the trailing control, and the last in the DOM.
        const rights = buttons.map((b) => b.getBoundingClientRect().right);
        expect(p.getBoundingClientRect().right).toBe(Math.max(...rights));
        expect(buttons[buttons.length - 1]).toBe(p);
      }
    }
    expect(tabOrderProblems(dialog!).join("\n")).toBe("");
  } else {
    expect(tabOrderProblems(kit).join("\n")).toBe("");
  }
}

async function check(
  scene: Scene,
  scheme: Scheme,
  size: (typeof SIZES)[number],
) {
  await page.viewport(size.width, size.height);
  const kit = await mount(scene, scheme);
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(
      `${__PKEY_KIT_SHOTS__}/react.macos.${scene.id}/${size.label}-${scheme}.png`,
    );
  if (__PKEY_KIT_BASELINES__)
    await commands.kitShot(
      `${__PKEY_KIT_BASELINES__}/${scene.id}/macos-${size.label}-${scheme}.png`,
    );
  chrome(kit, scene);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth + 1,
  );
  const small = [
    ...kit.querySelectorAll(".btn, input, [role=radio], a[href]"),
  ].flatMap((el) => {
    const r = visible(el);
    return r && (r.width < 24 || r.height < 24) ? [label(el)] : [];
  });
  expect(small.join("\n")).toBe("");
  expect((await axeViolations(kit)).join("\n")).toBe("");
}

describe("the macOS chrome", () => {
  for (const scene of SCENES)
    describe(scene.id + (scene.sheet ? " (sheet)" : ""), () => {
      for (const scheme of SCHEMES)
        for (const size of SIZES)
          it(`${size.label} ${scheme}`, () => check(scene, scheme, size));
    });
});

describe("the macOS chrome, behaviour", () => {
  const byId = (id: string) => SCENES.find((s) => s.id === id)!;

  it("words buttons through the catalog's macos variants", async () => {
    await page.viewport(1440, 900);
    let kit = await mount(byId("UpdatePrompt.available"), "dark");
    expect(kit.textContent).toContain("Remind Me Later");
    root?.unmount();
    host?.remove();
    root?.unmount();
    host?.remove();
    kit = await mount(byId("AccountAndLicense.signed-in"), "dark");
    expect(kit.textContent).toContain("Check for Updates…");
  });

  it("lays the gate out whole at the 480 x 520 floor", async () => {
    await page.viewport(480, 520);
    const kit = await mount(byId("Welcome.default"), "dark");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(481);
    for (const el of [
      kit.querySelector("h1"),
      kit.querySelector('.btn[data-variant="primary"]'),
    ]) {
      const r = el!.getBoundingClientRect();
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.bottom).toBeLessThanOrEqual(520);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(480);
    }
  });

  it("puts hairlines at full contrast under Increase Contrast", async () => {
    await page.viewport(1440, 900);
    const scene = byId("Settings.list");
    let kit = await mount(scene, "light");
    const normal = getComputedStyle(kit).getPropertyValue("--pk-border-subtle");
    root?.unmount();
    host?.remove();
    await commands.emulateContrast("more");
    kit = await mount(scene, "light");
    const more = getComputedStyle(kit).getPropertyValue("--pk-border-subtle");
    const strong = getComputedStyle(kit).getPropertyValue("--pk-text-strong");
    expect(more.trim()).toBe(strong.trim());
    expect(more).not.toBe(normal);
  });

  it("draws the system focus ring on a keyboard-focused control", async () => {
    await page.viewport(1440, 900);
    const kit = await mount(byId("Welcome.default"), "light");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    const btn = kit.querySelector<HTMLElement>('.btn[data-variant="primary"]')!;
    btn.focus();
    await frame();
    const cs = getComputedStyle(btn);
    expect(parseFloat(cs.outlineWidth)).toBe(3);
    expect(cs.outlineStyle).toBe("solid");
  });
});
