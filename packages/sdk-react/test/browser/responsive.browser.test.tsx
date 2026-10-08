// @pkey-feature ui.kit ui.kit.manage
//
// The drop-in kit in real Chromium at every size it ships to: phone (320, 390), tablet (768,
// 1024), desktop (1440), a 2560 monitor, a phone on its side (844x390), 200 % zoom on a laptop
// and on a tablet, and a 24 px default font; each in dark and light. On every one:
//
//   * nothing scrolls sideways: no element past the window's edge, no sideways scroller;
//   * the screen's main action is in the first viewport, without scrolling;
//   * every control is at least 24 x 24 px (WCAG 2.5.8);
//   * the kit never draws in the browser's default serif on a page that sets no font;
//
// and, once per scene, every piece of the kit's text scales with the root font (24 px root =
// 1.5 x every size). `PKEY_KIT_SHOTS=<dir>` also writes each render to
// <dir>/react.<scene>/<size>-<scheme>.png.

import { afterEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { SCENES, type Scene, type Scheme } from "./scenes.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;

interface Size {
  label: string;
  width: number;
  height: number;
  rootPx?: number;
}

const SIZES: Size[] = [
  { label: "320", width: 320, height: 640 },
  { label: "390", width: 390, height: 844 },
  { label: "768", width: 768, height: 1024 },
  { label: "1024", width: 1024, height: 768 },
  { label: "1440", width: 1440, height: 900 },
  { label: "2560", width: 2560, height: 1440 },
  { label: "844x390", width: 844, height: 390 },
  // 200 % zoom halves the CSS viewport: a 1280x800 laptop and a 768x1024 tablet.
  { label: "1280x800-zoom200", width: 640, height: 400 },
  { label: "768x1024-zoom200", width: 384, height: 512 },
  { label: "390-font24", width: 390, height: 844, rootPx: 24 },
  { label: "1440-font24", width: 1440, height: 900, rootPx: 24 },
];
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

function sidewaysOverflow(): string[] {
  const vw = document.documentElement.clientWidth;
  const out: string[] = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > vw + 1)
    out.push(`the page scrolls sideways (${doc.scrollWidth} > ${vw})`);
  for (const el of document.body.querySelectorAll("*")) {
    const r = visible(el);
    if (!r) continue;
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

/** Every element of the kit that draws text of its own. */
function kitText(): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const kit of document.querySelectorAll(KIT))
    for (const el of [kit, ...kit.querySelectorAll("*")])
      if (
        !isHostContent(el) &&
        [...el.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
        ) &&
        visible(el)
      )
        out.push(el as HTMLElement);
  return out;
}

function inFirstViewport(selector: string): string | null {
  const el = document.querySelector(selector);
  if (!el) return `no ${selector}`;
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

describe.each(SCENES)("$id", (scene) => {
  describe.each(SCHEMES)("%s", (scheme) => {
    it.each(SIZES)("$label", async (size) => {
      await page.viewport(size.width, size.height);
      await mount(scene, scheme, size.rootPx);
      expect(innerWidth).toBe(size.width);

      expect(sidewaysOverflow()).toEqual([]);
      if (scene.primary) expect(inFirstViewport(scene.primary)).toBeNull();
      expect(smallTargets()).toEqual([]);
      const serif = kitText().filter((el) =>
        /^\s*("?times new roman"?|"?times"?|serif)\s*$/i.test(
          getComputedStyle(el).fontFamily,
        ),
      );
      expect(serif.map(describeEl)).toEqual([]);

      if (__PKEY_KIT_SHOTS__)
        await commands.kitShot(
          `${__PKEY_KIT_SHOTS__}/react.${scene.id}/${size.label}-${scheme}.png`,
        );
    });
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
