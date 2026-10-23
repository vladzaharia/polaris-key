// @pkey-feature ui.kit ui.theme
//
// The GNOME (libadwaita) chrome of the React kit in real Chromium (UK-06.7, UI-KITS §3.1
// `platform`): `theme.platform: "linux"` (the variant id `gnome`) sets `data-pk-platform="gnome"` on the kit root and the
// same web DOM draws as libadwaita: pill responses (40 px) with the suggested action at the end of
// a row and on top when they stack, 34 px controls at radius 8, cards at 12, the sheet an AdwDialog
// (radius 14 on the box, a soft shadow, a 7 % hairline in light and a light hairline in dark, never
// a dark outline), the update prompt an AdwAlertDialog, message screens an AdwStatusPage, opaque
// surfaces. Every render also passes axe (WCAG 2.2 AA), has no sideways scroll and no target under
// 24 px, in dark and light at 390 and 1440, and under `dir="rtl"`.
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
import { SCENES, sceneInput, type Scene } from "../chromeScenes.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
    emulateForced: (forced: "active" | null) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_KIT_BASELINES__: string;

const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "1440", width: 1440, height: 900 },
] as const;
const SCHEMES = ["dark", "light"] as const;
type Scheme = (typeof SCHEMES)[number];
/** The scenes' input on a GNOME host: the corpus rows default to a Mac, so the platform is Linux. */
const gnomeInput = (scene: Scene): UiInput => ({
  ...sceneInput(scene),
  platform: { os: "linux", formFactor: "computer" },
});
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
  o: { rtl?: boolean; platform?: string } = {},
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
  root.render(
    <Component
      input={gnomeInput(scene)}
      {...(scene.sheet ? { presentation: "sheet", open: true } : {})}
      fill={LAYOUTS[scene.component as keyof typeof LAYOUTS].kind === "screen"}
      theme={{
        product: PRODUCT,
        colorScheme: scheme,
        platform: (o.platform ?? "linux") as "linux",
      }}
    >
      <main data-host-content="">
        <p>The app</p>
      </main>
    </Component>,
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
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`),
  );
}

const rgba = (c: string): number[] =>
  (c.match(/[\d.]+/g) ?? []).map(Number).concat([1]).slice(0, 4);
const alpha = (c: string): number => {
  const m = c.match(/[\d.]+/g) ?? [];
  return m.length >= 4 ? Number(m[3]) : 1;
};

function chrome(
  kit: HTMLElement,
  scene: Scene,
  scheme: Scheme,
  width: number,
  rtl = false,
) {
  expect(kit.getAttribute("data-pk-platform")).toBe("gnome");
  const fine = !matchMedia("(pointer: coarse)").matches;
  // Responses are pills at 40 px; every other control is 34 px at radius 8.
  const actions = [
    ...kit.querySelectorAll<HTMLElement>(".actions .btn"),
  ].filter(visible);
  for (const b of actions) {
    const cs = getComputedStyle(b);
    expect(
      parseFloat(cs.borderTopLeftRadius),
      "response radius",
    ).toBeGreaterThan(20);
    if (fine) expect(visible(b)!.height).toBeGreaterThanOrEqual(40);
  }
  const plain = [
    ...kit.querySelectorAll<HTMLElement>(".btn:not(.actions .btn)"),
  ].filter((b) => visible(b) && b.dataset.variant !== "link");
  if (fine)
    for (const b of plain) {
      const cs = getComputedStyle(b);
      expect(parseFloat(cs.minHeight), "control height").toBe(34);
      expect(parseFloat(cs.borderTopLeftRadius), "control radius").toBe(8);
    }
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
    expect(box.width).toBeLessThanOrEqual(460 + 1);
    const buttons = [...dialog!.querySelectorAll<HTMLElement>(".actions .btn")]
      .filter(visible)
      .filter((b) => b.dataset.variant !== "link");
    if (wide) {
      // Centred; the rounded box on every corner.
      expect(box.bottom).toBeLessThan(innerHeight);
      expect(parseFloat(ds.borderBottomLeftRadius)).toBe(14);
      expect(Math.abs(box.left + box.width / 2 - innerWidth / 2)).toBeLessThan(
        2,
      );
      if (buttons.length === 2) {
        // Equal width always; side by side with the suggested action at the end, or (a label too
        // wide for half the row) stacked with it on top: never a wrapped label.
        const rects = buttons.map((b) => b.getBoundingClientRect());
        const widths = rects.map((r) => Math.round(r.width));
        expect(new Set(widths).size, `equal width ${widths}`).toBe(1);
        const p = buttons.findIndex((b) => b.dataset.variant === "primary");
        const oneRow = new Set(rects.map((r) => Math.round(r.top))).size === 1;
        if (oneRow) {
          const lefts = rects.map((r) => r.left);
          const end = rtl ? Math.min(...lefts) : Math.max(...lefts);
          expect(lefts[p], "suggested at the end").toBe(end);
        } else {
          expect(new Set(rects.map((r) => Math.round(r.left))).size).toBe(1);
          expect(rects[p]!.top, "suggested on top").toBe(
            Math.min(...rects.map((r) => r.top)),
          );
        }
        for (const b of buttons)
          expect(
            b.getBoundingClientRect().height,
            `label wrapped: ${b.textContent}`,
          ).toBeLessThan(56);
      }
    } else {
      // Narrow: a sheet docked to the bottom, rounded on top only, the responses stacked with the
      // suggested action on top.
      expect(Math.round(box.bottom)).toBe(innerHeight);
      expect(parseFloat(ds.borderBottomLeftRadius)).toBe(0);
      if (buttons.length >= 2) {
        const lefts = new Set(
          buttons.map((b) => Math.round(b.getBoundingClientRect().left)),
        );
        expect(lefts.size, "stacked").toBe(1);
        const tops = buttons.map((b) => b.getBoundingClientRect().top);
        const p = buttons.findIndex((b) => b.dataset.variant === "primary");
        expect(tops[p], "suggested on top").toBe(Math.min(...tops));
      }
    }
  }
  // AdwStatusPage: no card surface, the responses stacked, centred, the suggested one on top.
  if (scene.id.startsWith("StatusScreen.")) {
    const card = kit.querySelector<HTMLElement>(".stage .card")!;
    const cs = getComputedStyle(card);
    expect(alpha(cs.backgroundColor), "status page has no surface").toBe(0);
    expect(cs.boxShadow).toBe("none");
    expect(cs.textAlign).toBe("center");
    const bar = card.querySelector<HTMLElement>(":scope > .actions");
    const btns = bar
      ? [...bar.querySelectorAll<HTMLElement>(".btn")].filter(visible)
      : [];
    if (btns.length >= 2) {
      const tops = btns.map((b) => b.getBoundingClientRect().top);
      expect(
        new Set(btns.map((b) => Math.round(b.getBoundingClientRect().left)))
          .size,
      ).toBe(1);
      const p = btns.findIndex((b) => b.dataset.variant === "primary");
      expect(tops[p]).toBe(Math.min(...tops));
    }
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      expect(Math.abs(r.left + r.width / 2 - innerWidth / 2)).toBeLessThan(
        innerWidth / 2,
      );
    }
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
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    const btn = kit.querySelector<HTMLElement>('.btn[data-variant="primary"]')!;
    btn.focus();
    await frame();
    const dlg = getComputedStyle(kit.querySelector("dialog[open]")!);
    expect(dlg.boxShadow).toBe("none");
    expect(dlg.borderTopStyle).toBe("solid");
  });
});
