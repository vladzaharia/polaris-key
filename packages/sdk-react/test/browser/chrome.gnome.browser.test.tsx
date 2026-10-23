// @pkey-feature ui.kit ui.theme
//
// The GNOME (libadwaita) chrome of the React kit in real Chromium (UK-06.7, UI-KITS §3.1
// `platform`): `theme.platform: "linux"` (the variant id `gnome`) sets `data-pk-platform="gnome"` on
// the kit root and the same web DOM draws as libadwaita: pill responses (40 px) with the suggested
// action last in a row of two and first in a stack (the DOM order, so Tab follows the eye), 34 px controls at radius 8, cards at 12, the sheet an AdwDialog (radius 14
// on the box, a soft shadow, a 7 % hairline in light and a light hairline in dark, never a dark
// outline) over the host window with a pinned footer, the update prompt an AdwAlertDialog, message
// screens an AdwStatusPage, opaque surfaces. Every render also passes axe (WCAG 2.2 AA), has no
// sideways scroll, no target under 24 px and a Tab order that is the visual order, in dark and
// light at four sizes, and under `dir="rtl"`.
//
// PKEY_KIT_BASELINES=<dir> records each scene as <dir>/<Component>.<state>/gnome-<size>-<scheme>.png
// beside the web and Windows baselines (the folder ui:report reads).
// PKEY_KIT_SHOTS=<dir> writes <dir>/react.gnome.<scene>/<size>-<scheme>.png for the UX review.

import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import type { UiInput } from "@polaris-key/ui-core";
import { LAYOUTS } from "@polaris-key/elements/contract";

import * as Kit from "@polaris-key/react/kit";
import {
  HOST_APP_HTML,
  WINDOWS_SCENES as SCENES,
  sceneInput,
  type Scene,
} from "../chromeScenes.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
    emulateForced: (forced: "active" | null) => Promise<void>;
    emulateTouch: (on: boolean) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_KIT_BASELINES__: string;

/** The phone row, the board's two window sizes (the default Windows window and the narrow one) and
 *  the desktop row. */
const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "480x640", width: 480, height: 640 },
  { label: "900x600", width: 900, height: 600 },
  { label: "1440", width: 1440, height: 900 },
] as const;
/** A GNOME machine: the platform every scene is drawn on. */
const GNOME_PLATFORM = { os: "linux", formFactor: "computer" };
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
  document.documentElement.removeAttribute("dir");
  await commands.emulateForced(null);
  await commands.emulateTouch(false);
});
const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));
const COMPONENTS = Kit as unknown as Record<
  string,
  (p: Kit.KitProps & { children?: ReactNode }) => ReactNode
>;

async function mount(
  scene: Scene,
  scheme: Scheme,
  o: {
    rtl?: boolean;
    platform?: string;
    reported?: { os: string; formFactor: string };
  } = {},
): Promise<HTMLElement> {
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  if (o.rtl) document.documentElement.setAttribute("dir", "rtl");
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
        input={sceneInput(scene, o.reported ?? GNOME_PLATFORM)}
        {...(scene.sheet ? { presentation: "sheet", open: true } : {})}
        fill={
          !dialogScene &&
          LAYOUTS[scene.component as keyof typeof LAYOUTS].kind === "screen"
        }
        theme={{
          product: PRODUCT,
          colorScheme: scheme,
          platform: (o.platform ?? "linux") as "linux",
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

async function axeViolations(kit: HTMLElement): Promise<string[]> {
  const result = await axe.run(
    { include: [kit] } as unknown as axe.ElementContext,
    {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      },
      // The page-level rules are the host's, not the kit's.
      rules: {
        region: { enabled: false },
        "landmark-one-main": { enabled: false },
      },
    },
  );
  // A link the scrolled body leaves partly under the pinned footer is not a target on screen yet
  // (a focus scrolls it clear: `scroll-padding`), so axe's target-size does not count it.
  return result.violations.flatMap((v) =>
    v.nodes
      .filter((n) => {
        if (v.id !== "target-size") return true;
        const el = kit.querySelector(n.target.join(" "));
        return !(el && coveredByPinnedFooter(el));
      })
      .map((n) => `${v.id}: ${n.target.join(" ")}`),
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

/** True when the pinned footer sits over the element's centre (the body is scrolled under it; a
 *  focus scrolls it into view, `scroll-padding` keeps it clear of the footer). */
function coveredByPinnedFooter(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(
    r.left + r.width / 2,
    r.top + r.height / 2,
  );
  return top !== null && !el.contains(top) && !top.contains(el);
}

/** Tab order is the visual order (WCAG 2.4.3): each stop is at or below the one before it, and in
 *  the same row it is further along the reading direction. */
function tabOrderProblems(root: ParentNode): string[] {
  const stops = [
    ...root.querySelectorAll<HTMLElement>(
      "button, a[href], input, textarea, select, [tabindex='0']",
    ),
  ].filter(
    (el) =>
      visible(el) &&
      !scrolledAway(el) &&
      !coveredByPinnedFooter(el) &&
      !el.hasAttribute("disabled"),
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

const alpha = (c: string): number => {
  const m = c.match(/[\d.]+/g) ?? [];
  return m.length >= 4 ? Number(m[3]) : 1;
};
const rgba = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).map(Number);

function chrome(
  kit: HTMLElement,
  scene: Scene,
  scheme: Scheme,
  width: number,
  rtl = false,
) {
  expect(kit.getAttribute("data-pk-platform")).toBe("gnome");
  const fine = !matchMedia("(pointer: coarse)").matches;
  // Responses are pills, one line tall, 40 px at least; the other filled buttons are 34 px at radius 8.
  for (const b of kit.querySelectorAll<HTMLElement>(
    '.actions .btn:not([data-variant="link"])',
  )) {
    const r = visible(b);
    if (!r) continue;
    expect(
      parseFloat(getComputedStyle(b).borderTopLeftRadius),
      `${label(b)} radius`,
    ).toBeGreaterThan(20);
    if (fine) {
      expect(r.height, `${label(b)} height`).toBeGreaterThanOrEqual(40);
      expect(r.height, `${label(b)} is one line`).toBeLessThan(56);
    }
  }
  if (fine)
    for (const b of kit.querySelectorAll<HTMLElement>(
      '.btn:not(.actions .btn):is([data-variant="primary"], [data-variant="secondary"], [data-variant="danger"])',
    )) {
      if (!visible(b)) continue;
      expect(parseFloat(getComputedStyle(b).minHeight)).toBe(34);
      expect(parseFloat(getComputedStyle(b).borderTopLeftRadius)).toBe(8);
    }
  // Links sit at the column's edge, not indented by the button padding.
  for (const l of kit.querySelectorAll<HTMLElement>(
    '.btn[data-variant="link"]',
  ))
    if (visible(l))
      expect(
        parseFloat(getComputedStyle(l).paddingInlineStart),
      ).toBeLessThanOrEqual(12);
  const dialog = kit.querySelector<HTMLDialogElement>("dialog[open]");
  const wide = width >= 560;
  if (scene.sheet || scene.dialog) {
    expect(dialog, "the sheet is a modal dialog").not.toBeNull();
    const back = getComputedStyle(dialog!, "::backdrop");
    // The dim layer: 12 % in light, 35 % in dark, not blurred.
    expect(alpha(back.backgroundColor)).toBeCloseTo(
      scheme === "dark" ? 0.35 : 0.12,
      2,
    );
    expect(back.backdropFilter === "none" || back.backdropFilter === "").toBe(
      true,
    );
    const ds = getComputedStyle(dialog!);
    // Opaque, rounded at 14 on the box, a soft shadow with a hairline edge as its first layer.
    expect(alpha(ds.backgroundColor), "opaque dialog").toBe(1);
    expect(parseFloat(ds.borderTopLeftRadius)).toBe(14);
    const layers = ds.boxShadow.split(/,(?![^(]*\))/);
    expect(layers.length, ds.boxShadow).toBeGreaterThanOrEqual(3);
    const edge = rgba(layers[0]!);
    if (scheme === "light") {
      expect(edge.slice(0, 3)).not.toEqual([255, 255, 255]);
      expect(edge[3]).toBeCloseTo(0.07, 2);
    } else {
      // Never a dark outline in dark.
      expect(edge.slice(0, 3)).toEqual([255, 255, 255]);
    }
    const box = dialog!.getBoundingClientRect();
    if (wide) expect(box.width).toBeLessThanOrEqual(460 + 1);
    expect(box.top).toBeGreaterThanOrEqual(0);
    const footer = dialog!.querySelector<HTMLElement>(
      ".card > .actions:not([data-group])",
    );
    if (wide) {
      // Centred; the rounded box on every corner.
      expect(box.bottom).toBeLessThan(innerHeight);
      expect(parseFloat(ds.borderBottomLeftRadius)).toBe(14);
      expect(Math.abs(box.left + box.width / 2 - innerWidth / 2)).toBeLessThan(
        2,
      );
    } else {
      // Narrow: a sheet docked to the bottom, rounded on top only.
      expect(Math.round(box.bottom)).toBe(innerHeight);
      expect(parseFloat(ds.borderBottomLeftRadius)).toBe(0);
    }
    if (footer) {
      // The footer is pinned inside the window: the suggested action is never scrolled away.
      expect(
        footer.getBoundingClientRect().bottom,
        "footer bottom",
      ).toBeLessThanOrEqual(innerHeight + 0.5);
      const buttons = [...footer.querySelectorAll<HTMLElement>(".btn")].filter(
        visible,
      );
      const p = buttons.findIndex((b) => b.dataset.variant === "primary");
      if (buttons.length >= 2 && p >= 0) {
        // Equal width, never a wrapped label; the suggested action last at the end of a row and
        // first, on top, in a stack (the DOM order, so Tab follows the eye).
        const rects = buttons.map((b) => b.getBoundingClientRect());
        const widths = rects.map((r) => Math.round(r.width));
        expect(new Set(widths).size, `equal width ${widths}`).toBe(1);
        const oneRow = new Set(rects.map((r) => Math.round(r.top))).size === 1;
        if (oneRow) {
          const lefts = rects.map((r) => r.left);
          expect(lefts[p], "suggested at the end").toBe(
            rtl ? Math.min(...lefts) : Math.max(...lefts),
          );
        } else {
          expect(new Set(rects.map((r) => Math.round(r.left))).size).toBe(1);
          expect(rects[p]!.top, "suggested first, on top").toBe(
            Math.min(...rects.map((r) => r.top)),
          );
        }
      }
    }
    // Tab order is the visual order.
    expect(tabOrderProblems(dialog!).join("\n")).toBe("");
  } else {
    expect(tabOrderProblems(kit).join("\n")).toBe("");
  }
  // AdwStatusPage: no card surface, the responses stacked and centred, the suggested one first.
  if (scene.id.startsWith("StatusScreen.")) {
    const card = kit.querySelector<HTMLElement>(".stage .card")!;
    const cs = getComputedStyle(card);
    expect(alpha(cs.backgroundColor), "status page has no surface").toBe(0);
    expect(cs.boxShadow).toBe("none");
    const btns = [
      ...card.querySelectorAll<HTMLElement>(":scope > .actions .btn"),
    ].filter(visible);
    if (btns.length >= 2) {
      const tops = btns.map((b) => b.getBoundingClientRect().top);
      expect(
        new Set(btns.map((b) => Math.round(b.getBoundingClientRect().left)))
          .size,
      ).toBe(1);
      const p = btns.findIndex((b) => b.dataset.variant === "primary");
      expect(tops[p]).toBe(Math.min(...tops));
    }
  }
  expect(width).toBeGreaterThan(0);
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
      `${__PKEY_KIT_SHOTS__}/react.gnome.${scene.id}/${size.label}-${scheme}.png`,
    );
  if (__PKEY_KIT_BASELINES__)
    await commands.kitShot(
      `${__PKEY_KIT_BASELINES__}/${scene.id}/gnome-${size.label}-${scheme}.png`,
    );
  chrome(kit, scene, scheme, size.width);
  // No sideways scroll, no target under 24 px, and axe passes.
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

describe("the GNOME chrome", () => {
  for (const scene of SCENES)
    describe(scene.id + (scene.sheet ? " (sheet)" : ""), () => {
      for (const scheme of SCHEMES)
        for (const size of SIZES)
          it(`${size.label} ${scheme}`, () => check(scene, scheme, size));
    });
});

describe("the GNOME chrome, behaviour", () => {
  const sheet = SCENES.find((s) => s.sheet)!;

  it("draws the text-colour focus ring, 2 px, outside a response", async () => {
    await page.viewport(1440, 900);
    const kit = await mount(sheet, "light");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    const btn = kit.querySelector<HTMLElement>('.btn[data-variant="primary"]')!;
    btn.focus();
    await frame();
    const cs = getComputedStyle(btn);
    expect(parseFloat(cs.outlineWidth)).toBe(2);
    expect(cs.outlineStyle).toBe("solid");
    expect(parseFloat(cs.outlineOffset)).toBe(2);
  });

  it("mirrors in a right-to-left page: the suggested action is at the left", async () => {
    await page.viewport(1440, 900);
    const rtl = await mount(sheet, "dark", { rtl: true });
    expect(getComputedStyle(rtl).direction).toBe("rtl");
    chrome(rtl, sheet, "dark", 1440, true);
  });

  it("uses system colours under forced colours", async () => {
    await page.viewport(1440, 900);
    await commands.emulateForced("active");
    const kit = await mount(sheet, "dark");
    const dlg = getComputedStyle(kit.querySelector("dialog[open]")!);
    expect(dlg.boxShadow).toBe("none");
    expect(dlg.borderTopStyle).toBe("solid");
  });

  it("takes 44 px controls under a coarse pointer (touch)", async () => {
    await page.viewport(900, 600);
    await commands.emulateTouch(true);
    const scene = SCENES.find((x) => x.id === "Activate.parsed")!;
    const kit = await mount(scene, "light");
    expect(matchMedia("(pointer: coarse)").matches, "touch emulation").toBe(
      true,
    );
    const primary = kit.querySelector<HTMLElement>(
      '.btn[data-variant="primary"]',
    )!;
    expect(primary.getBoundingClientRect().height).toBe(44);
    expect(kit.querySelector("input")!.getBoundingClientRect().height).toBe(44);
  });
});
