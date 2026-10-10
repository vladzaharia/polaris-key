// @pkey-feature ui.kit ui.kit.manage
//
// The drop-in kit in real Chromium at every size it ships to: phones (320, 390), a phone on its
// side (568x320, 667x375, 844x390), small and large landscape windows (640x360, 800x600,
// 1280x720, 1920x1080), tablets (768, 1024), desktop (1440), a 2560 monitor, 200 % zoom on a
// laptop and a tablet, and a 24 px default font; each in dark and light. On every render:
//
//   * nothing scrolls sideways: no element past the window's edge, no sideways scroller;
//   * the screen's title (h2) and its main action are fully in the first viewport;
//   * every control is at least 24 x 24 px (WCAG 2.5.8);
//   * axe's color-contrast rule passes on the kit;
//   * the kit's text is set in the theme's font, or system-ui on a page that sets none;
//   * a gate screen on a phone is full-bleed (no top border, the window's full width);
//   * the buttons of a screen's action stack share one width;
//   * focus is where the screen puts it, with no ring at rest (no key was pressed).
//
// Per scene, every piece of the kit's text scales with the root font (24 px root = 1.5 x).
// A preset axis renders the main screens under the Polaris Key brand and under a host's own font
// and accent; a "system" scene checks the scheme on a light host with the OS dark; and the focus
// suite drives the update dialog and a rename by keyboard. `PKEY_KIT_SHOTS=<dir>` writes each
// render to <dir>/react.<scene>/<size>-<scheme>[-<preset>].png.

import { afterEach, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { relativeLuminance } from "@polaris-key/brand/color";
import { PolarisKeyProvider } from "../../src/react/Provider.js";
import { UpdatePrompt } from "../../src/components/UpdatePrompt.js";
import {
  ALL,
  PRESET_SCENE_IDS,
  SCENES as GATE_SCENES,
  SYSTEM_ON_LIGHT_HOST,
  adapterFor,
  presetFont,
  setPreset,
  type Preset,
  type Scene,
  type Scheme,
} from "./scenes.js";
import { DEVICE_SCENES } from "./scenes.devices.js";
import { okBridgeState } from "../fixtures.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
    emulateScheme: (scheme: "dark" | "light" | null) => Promise<void>;
    emulateForced: (forced: "active" | null) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;

const SCENES: Scene[] = [...GATE_SCENES, ...DEVICE_SCENES];

interface Size {
  label: string;
  width: number;
  height: number;
  rootPx?: number;
}

const SIZES: Size[] = [
  { label: "320", width: 320, height: 640 },
  { label: "390", width: 390, height: 844 },
  { label: "568x320", width: 568, height: 320 },
  { label: "640x360", width: 640, height: 360 },
  { label: "667x375", width: 667, height: 375 },
  { label: "768", width: 768, height: 1024 },
  { label: "800x600", width: 800, height: 600 },
  { label: "844x390", width: 844, height: 390 },
  { label: "1024", width: 1024, height: 768 },
  { label: "1280x720", width: 1280, height: 720 },
  { label: "1440", width: 1440, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560", width: 2560, height: 1440 },
  // 200 % zoom halves the CSS viewport: a 1280x800 laptop and a 768x1024 tablet.
  { label: "1280x800-zoom200", width: 640, height: 400 },
  { label: "768x1024-zoom200", width: 384, height: 512 },
  { label: "390-font24", width: 390, height: 844, rootPx: 24 },
  { label: "1440-font24", width: 1440, height: 900, rootPx: 24 },
];
const PRESET_SIZES = SIZES.filter((s) =>
  ["390", "1440", "844x390"].includes(s.label),
);
const SCHEMES: Scheme[] = ["dark", "light"];

/** The kit's own surfaces; host content around them is not under test. */
const KIT =
  "[data-polaris-gate], [data-polaris-login], [data-polaris-devices], [data-polaris-config], [data-polaris-update], [data-polaris-logout]";
const CONTROLS =
  "button, a[href], input, select, textarea, [role=button], [tabindex]:not([tabindex='-1'])";

let root: Root | null = null;
let host: HTMLElement | null = null;
let disposeAdapter: (() => void) | null = null;

function unmount(): void {
  root?.unmount();
  host?.remove();
  disposeAdapter?.();
  root = null;
  host = null;
  disposeAdapter = null;
}

afterEach(() => {
  unmount();
  document.documentElement.style.fontSize = "";
  setPreset("neutral");
});

async function until<T>(probe: () => T | null | undefined): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (performance.now() - start > 5_000)
      throw new Error("timed out waiting for the scene");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));

async function mount(
  scene: Scene,
  scheme: Scheme,
  rootPx = 16,
): Promise<HTMLElement> {
  document.documentElement.style.fontSize = `${rootPx}px`;
  document.body.style.margin = "0";
  // A cold start: the last input was a pointer, so a screen's own focus paints no ring.
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  host = document.createElement("div");
  document.body.append(host);
  const { node, adapter } = scene.render(scheme);
  disposeAdapter = () => adapter.dispose();
  root = createRoot(host);
  root.render(node);
  if (scene.act) {
    await until(() => host!.querySelector(scene.before ?? scene.ready));
    await scene.act(host);
  }
  await until(() => host!.querySelector(scene.ready));
  // Let the full-window layout measure, and fonts and focus settle.
  await frame();
  await frame();
  return host;
}

function describeEl(el: Element): string {
  const data = [...el.attributes]
    .filter((a) => a.name.startsWith("data-") || a.name === "role")
    .map((a) => `[${a.name}${a.value ? `=${a.value}` : ""}]`)
    .join("");
  const text = (el.textContent ?? "").trim().slice(0, 30);
  return `<${el.tagName.toLowerCase()}${data}> "${text}"`;
}

function visible(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") return null;
  return r;
}

/** The part of `el` its clipping ancestors let through (the moving part of a progress bar
 *  inside its track), or null when they hide it all. */
function shown(el: Element): DOMRect | null {
  const r = visible(el);
  if (!r) return null;
  let { left, right } = r;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const o = getComputedStyle(a).overflowX;
    if (o === "visible") continue;
    const box = a.getBoundingClientRect();
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
    if (right <= left) return null;
  }
  return new DOMRect(left, r.top, right - left, r.height);
}

function sidewaysOverflow(): string[] {
  const vw = document.documentElement.clientWidth;
  const out: string[] = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > vw + 1)
    out.push(`the page scrolls sideways (${doc.scrollWidth} > ${vw})`);
  for (const el of document.body.querySelectorAll("*")) {
    const r = shown(el);
    if (!r) continue;
    // Visually hidden labels sit at 1 px, clipped: not content.
    if (r.width <= 1 && r.height <= 1) continue;
    if (r.left < -1 || r.right > vw + 1)
      out.push(
        `${describeEl(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`,
      );
    const cs = getComputedStyle(el);
    if (
      (cs.overflowX === "auto" || cs.overflowX === "scroll") &&
      el.scrollWidth > el.clientWidth + 1
    )
      out.push(
        `${describeEl(el)} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`,
      );
  }
  return out;
}

function smallTargets(): string[] {
  const out: string[] = [];
  for (const kit of document.querySelectorAll(KIT))
    for (const el of [kit, ...kit.querySelectorAll(CONTROLS)]) {
      if (!el.matches(CONTROLS)) continue;
      const r = visible(el);
      if (r && (r.width < 24 || r.height < 24))
        out.push(
          `${describeEl(el)} is ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    }
  return out;
}

/** Host content a kit surface wraps (the app behind the grace banner) is the host's. */
function isHostContent(el: Element): boolean {
  const content = el.closest("[data-host-content]");
  const kit = el.closest(KIT);
  return content !== null && kit !== null && kit.contains(content);
}

/** Every element of the kit that draws text of its own, once each. */
function kitText(): HTMLElement[] {
  const out = new Set<HTMLElement>();
  for (const kit of document.querySelectorAll(KIT))
    for (const el of [kit, ...kit.querySelectorAll("*")])
      if (
        !isHostContent(el) &&
        [...el.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
        ) &&
        visible(el)
      )
        out.add(el as HTMLElement);
  return [...out];
}

function inFirstViewport(el: Element | null, what: string): string | null {
  if (!el) return `no ${what}`;
  const r = el.getBoundingClientRect();
  const ok =
    r.top >= -1 &&
    r.left >= -1 &&
    r.bottom <= innerHeight + 1 &&
    r.right <= innerWidth + 1;
  return ok
    ? null
    : `${describeEl(el)} at ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}x${innerHeight}`;
}

/** The screen's title: the first kit h2 that is not the host's. */
function screenTitle(): Element | null {
  for (const kit of document.querySelectorAll(KIT)) {
    const h2 = kit.matches("h2") ? kit : kit.querySelector("h2");
    if (h2 && visible(h2) && !isHostContent(h2)) return h2;
  }
  return null;
}

async function contrastViolations(): Promise<string[]> {
  const kits = [...document.querySelectorAll(KIT)].filter(
    (el) => !el.parentElement?.closest(KIT),
  );
  if (kits.length === 0) return [];
  const result = await axe.run(
    { include: kits } as unknown as axe.ElementContext,
    { runOnly: { type: "rule", values: ["color-contrast"] } },
  );
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${n.target.join(" ")} ${n.failureSummary}`),
  );
}

function fontOf(el: Element): string {
  return getComputedStyle(el).fontFamily.replace(/["']/g, "").trim();
}

async function checkRender(
  scene: Scene,
  scheme: Scheme,
  size: Size,
  preset: Preset,
): Promise<void> {
  await page.viewport(size.width, size.height);
  setPreset(preset);
  await mount(scene, scheme, size.rootPx);
  expect(innerWidth).toBe(size.width);

  expect(sidewaysOverflow()).toEqual([]);
  // After an interaction in a host page (a rename opened, a row's error), the browser scrolls the
  // host's page to it; the title check is for the screen as it opens.
  const title = screenTitle();
  if (title && !scene.act) expect(inFirstViewport(title, "title")).toBeNull();
  if (scene.primary)
    expect(
      inFirstViewport(document.querySelector(scene.primary), scene.primary),
    ).toBeNull();
  expect(smallTargets()).toEqual([]);

  // Values (a setting's value, a key) are set in the kit mono, by design.
  const font = presetFont(preset);
  const offFont = kitText()
    .filter(
      (el) =>
        !fontOf(el).startsWith(font) &&
        !fontOf(el).startsWith("JetBrains Mono"),
    )
    .map((el) => `${describeEl(el)}: ${fontOf(el)}`);
  expect(offFont).toEqual([]);

  if (scene.gate && size.width <= 390 && !size.label.includes("zoom")) {
    const card = document.querySelector("[data-polaris-card]");
    expect(card, "the gate's card").toBeTruthy();
    expect(getComputedStyle(card!).borderTopWidth).toBe("0px");
    expect(Math.round(card!.getBoundingClientRect().width)).toBe(innerWidth);
  }

  for (const stack of document.querySelectorAll("[data-polaris-actions]")) {
    const widths = [...stack.querySelectorAll("button")].map((b) =>
      Math.round(b.getBoundingClientRect().width),
    );
    expect(new Set(widths).size, `${describeEl(stack)} ${widths}`).toBe(1);
  }

  if (scene.focus) {
    await until(() => document.activeElement?.matches(scene.focus!));
    expect(getComputedStyle(document.activeElement!).outlineStyle).toBe("none");
  }

  expect(await contrastViolations()).toEqual([]);

  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(
      `${__PKEY_KIT_SHOTS__}/react.${scene.id}/${size.label}-${scheme}${preset === "neutral" ? "" : `-${preset}`}.png`,
    );
}

describe.each(SCENES)("$id", (scene) => {
  describe.each(SCHEMES)("%s", (scheme) => {
    it.each(SIZES)("$label", (size) =>
      checkRender(scene, scheme, size, "neutral"),
    );
  });

  it("scales every piece of its text with the root font", async () => {
    await page.viewport(1440, 900);
    await mount(scene, "dark", 16);
    const at16 = kitText().map((el) => [
      describeEl(el),
      parseFloat(getComputedStyle(el).fontSize),
    ]);
    unmount();
    await mount(scene, "dark", 24);
    const at24 = kitText().map((el) => [
      describeEl(el),
      parseFloat(getComputedStyle(el).fontSize),
    ]);
    expect(at16.length).toBeGreaterThan(0);
    expect(at24.map(([d]) => d)).toEqual(at16.map(([d]) => d));
    const unscaled = at24.filter(
      ([, px], i) =>
        Math.abs((px as number) - (at16[i]![1] as number) * 1.5) > 0.5,
    );
    expect(unscaled).toEqual([]);
  });
});

describe.each(["polaris-key", "host"] as const)("preset %s", (preset) => {
  const scenes = SCENES.filter((s) => PRESET_SCENE_IDS.includes(s.id));
  describe.each(scenes)("$id", (scene) => {
    describe.each(SCHEMES)("%s", (scheme) => {
      it.each(PRESET_SIZES)("$label", (size) =>
        checkRender(scene, scheme, size, preset),
      );
    });
  });
});

function luminanceOf(css: string): number {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(css)!;
  const hex = (n: string) =>
    Math.round(Number(n)).toString(16).padStart(2, "0");
  return relativeLuminance(`#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`);
}

describe('colorScheme "system" on a light host with the OS dark', () => {
  afterEach(async () => {
    await commands.emulateScheme(null);
  });

  it.each(PRESET_SIZES)("$label", async (size) => {
    await commands.emulateScheme("dark");
    await page.viewport(size.width, size.height);
    await mount(SYSTEM_ON_LIGHT_HOST, "dark");
    expect(matchMedia("(prefers-color-scheme: dark)").matches).toBe(true);
    // The white canvas decides: the kit is light.
    const kitRoot = document.querySelector("[data-polaris-key-root]")!;
    expect(kitRoot.getAttribute("data-theme")).toBe("light");
    const logout = document.querySelector("[data-polaris-logout]")!;
    const cs = getComputedStyle(logout);
    const [a, b] = [
      luminanceOf(cs.color),
      luminanceOf(cs.backgroundColor),
    ].sort((x, y) => y - x);
    expect((a! + 0.05) / (b! + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(sidewaysOverflow()).toEqual([]);
    expect(await contrastViolations()).toEqual([]);
    if (__PKEY_KIT_SHOTS__)
      await commands.kitShot(
        `${__PKEY_KIT_SHOTS__}/react.${SYSTEM_ON_LIGHT_HOST.id}/${size.label}-os-dark.png`,
      );
  });
});

/** The sRGB channels of a computed `rgb()` / `rgba()` colour. */
function channels(css: string): [number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(css);
  if (!m) throw new Error(`not an rgb colour: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

describe("forced colours", () => {
  afterEach(async () => {
    await commands.emulateForced(null);
  });

  // In forced-colors mode a browser replaces an author's colours and paints a Canvas backplate
  // behind text unless `forced-color-adjust: none` keeps the pair, which left the primary's label
  // black on black. The label must be readable: the kit's pair, at 4.5:1, and not adjusted away.
  it.each(["dark", "light"] as const)(
    "the primary's label is readable and its pair is kept (%s)",
    async (scheme) => {
      await commands.emulateForced("active");
      await page.viewport(390, 844);
      const scene = SCENES.find((s) => s.id === "signin-handoff")!;
      const rootEl = await mount(scene, scheme);
      const primary = rootEl.querySelector(scene.primary!) as HTMLElement;
      const cs = getComputedStyle(primary);
      expect(cs.forcedColorAdjust).toBe("none");
      const label = luminance(channels(cs.color));
      const fill = luminance(channels(cs.backgroundColor));
      const contrast =
        (Math.max(label, fill) + 0.05) / (Math.min(label, fill) + 0.05);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      // And the primary is not drawn like the other buttons (a distinct fill).
      const other = rootEl.querySelector(
        "[data-polaris-handoff-cancel]",
      ) as HTMLElement;
      expect(getComputedStyle(other).backgroundColor).not.toBe(
        cs.backgroundColor,
      );
      if (__PKEY_KIT_SHOTS__)
        await commands.kitShot(
          `${__PKEY_KIT_SHOTS__}/react.forced-primary/${scheme}.png`,
        );
    },
  );
});

describe("focus by keyboard", () => {
  it("after rename Save, focus returns to the row's Rename", async () => {
    await page.viewport(1024, 768);
    const scene = SCENES.find((s) => s.id === "device-manager")!;
    const mounted = await mount(scene, "light");
    const rename = mounted.querySelector<HTMLButtonElement>(
      "[data-polaris-device-rename]",
    )!;
    const id = rename.getAttribute("data-polaris-device-rename");
    rename.focus();
    await userEvent.keyboard("{Enter}");
    const field = await until(() =>
      mounted.querySelector<HTMLInputElement>("[data-polaris-device-input]"),
    );
    await until(() => document.activeElement === field);
    field.select();
    await userEvent.keyboard("Studio{Enter}");
    await until(() =>
      document.activeElement?.matches(`[data-polaris-device-rename="${id}"]`),
    );
    // Keyboard focus draws the ring.
    expect(getComputedStyle(document.activeElement!).outlineStyle).toBe(
      "solid",
    );
  });

  it("the update dialog keeps Tab inside, dismisses on Escape, and gives focus back", async () => {
    await page.viewport(1024, 768);
    let release: () => void = () => undefined;
    const ready = new Promise<void>((r) => {
      release = r;
    });
    const adapter = adapterFor(okBridgeState({ capabilities: ALL }));
    disposeAdapter = () => adapter.dispose();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(
      <PolarisKeyProvider
        productSlug="tidewater"
        adapter={adapter}
        colorScheme="dark"
        theme={{ copy: { productName: "Tidewater Studio" } }}
      >
        <main data-host-content="">
          <button data-host-button="">Host action</button>
        </main>
        <UpdatePrompt
          variant="dialog"
          fetcher={async () => {
            await ready;
            return {
              version: "2.5.0",
              tag: "v2.5.0",
              url: "https://dl.example/2.5.0",
              updateAvailable: true,
            };
          }}
        />
      </PolarisKeyProvider>,
    );
    const hostButton = await until(() =>
      host!.querySelector<HTMLButtonElement>("[data-host-button]"),
    );
    hostButton.focus();
    release();
    const dialog = await until(() =>
      host!.querySelector<HTMLElement>('[data-polaris-update="dialog"]'),
    );
    // The app is visible behind a scrim, and inert while the dialog is up.
    expect(hostButton.closest("[inert]")).toBeTruthy();
    await until(() => dialog.contains(document.activeElement));
    for (let i = 0; i < 4; i++) {
      await userEvent.keyboard("{Tab}");
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await until(() => !host!.querySelector('[data-polaris-update="dialog"]'));
    expect(hostButton.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(hostButton);
  });
});
