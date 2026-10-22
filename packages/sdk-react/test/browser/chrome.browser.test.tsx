// @pkey-feature ui.kit ui.theme
//
// The desktop chrome of the React kit in real Chromium (UK-06.6, UI-KITS §3.1 `platform`): the
// Windows (Fluent 2) variant. `theme.platform: "windows"` sets `data-pk-platform="windows"` on the
// kit root, and the same web DOM draws as Fluent: 32 px controls at radius 4, overlays at radius
// 8, the sheet as a ContentDialog (centred, a smoke layer, a footer bar), the primary first at
// equal width, the two-tone focus ring, system colours under forced colours. Every render also
// passes axe (WCAG 2.2 AA), has no sideways scroll and no target under 24 px, in dark and light
// at 390 and 1440, and under `dir="rtl"`.
//
// The platform is also what `auto` resolves to when the host reports one (`input.platform`, from
// the desktop bridge's `host.os`); the web default never takes a desktop variant.
//
// PKEY_KIT_BASELINES=<dir> records each scene as <dir>/<Component>.<state>/windows-<size>-<scheme>.png
// beside the web baselines (the folder ui:report reads).
// PKEY_KIT_SHOTS=<dir> writes <dir>/react.windows.<scene>/<size>-<scheme>.png for the UX review.

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
      input={sceneInput(scene)}
      {...(scene.sheet ? { presentation: "sheet", open: true } : {})}
      fill={LAYOUTS[scene.component as keyof typeof LAYOUTS].kind === "screen"}
      theme={{
        product: PRODUCT,
        colorScheme: scheme,
        platform: (o.platform ?? "windows") as "windows",
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

function chrome(kit: HTMLElement, scene: Scene, width: number) {
  expect(kit.getAttribute("data-pk-platform")).toBe("windows");
  // Fine pointer: 32 px controls at radius 4 (a coarse one takes 44 px; not emulated here).
  const primary = [
    ...kit.querySelectorAll<HTMLElement>('.btn[data-variant="primary"]'),
  ].find(visible);
  if (primary && !matchMedia("(pointer: coarse)").matches) {
    const cs = getComputedStyle(primary);
    expect(parseFloat(cs.minHeight), "control height").toBe(32);
    expect(parseFloat(cs.borderTopLeftRadius), "control radius").toBe(4);
    expect(visible(primary)!.height).toBeGreaterThanOrEqual(32);
  }
  const dialog = kit.querySelector<HTMLDialogElement>("dialog[open]");
  if (scene.sheet || scene.dialog) {
    expect(dialog, "the sheet is a modal dialog").not.toBeNull();
    const back = getComputedStyle(dialog!, "::backdrop");
    // The smoke layer: Windows' 30 % black-ish scrim, not blurred.
    expect(back.backgroundColor).toMatch(/0\.3\)$/);
    const card = dialog!.querySelector<HTMLElement>(".card")!;
    expect(parseFloat(getComputedStyle(card).borderTopLeftRadius)).toBe(8);
    const box = dialog!.getBoundingClientRect();
    // A ContentDialog is centred, never docked to the bottom edge, 480 px at most.
    expect(box.width).toBeLessThanOrEqual(480 + 1);
    expect(box.bottom).toBeLessThan(innerHeight);
    const dir = getComputedStyle(kit).direction;
    const buttons = [...dialog!.querySelectorAll<HTMLElement>(".actions .btn")]
      .filter(visible)
      .filter((b) => b.dataset.variant !== "link");
    if (buttons.length >= 2) {
      const widths = buttons.map((b) =>
        Math.round(b.getBoundingClientRect().width),
      );
      expect(new Set(widths).size, `equal width ${widths}`).toBe(1);
      // The primary first: at the start edge.
      const lefts = buttons.map((b) => b.getBoundingClientRect().left);
      const p = buttons.findIndex((b) => b.dataset.variant === "primary");
      expect(p, "primary is in the footer").toBeGreaterThanOrEqual(0);
      const first = dir === "rtl" ? Math.max(...lefts) : Math.min(...lefts);
      expect(lefts[p]).toBe(first);
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
      `${__PKEY_KIT_SHOTS__}/react.windows.${scene.id}/${size.label}-${scheme}.png`,
    );
  if (__PKEY_KIT_BASELINES__)
    await commands.kitShot(
      `${__PKEY_KIT_BASELINES__}/${scene.id}/windows-${size.label}-${scheme}.png`,
    );
  chrome(kit, scene, size.width);
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

describe("the Windows chrome", () => {
  for (const scene of SCENES)
    describe(scene.id + (scene.sheet ? " (sheet)" : ""), () => {
      for (const scheme of SCHEMES)
        for (const size of SIZES)
          it(`${size.label} ${scheme}`, () => check(scene, scheme, size));
    });
});

describe("the Windows chrome, behaviour", () => {
  const sheet = SCENES.find((s) => s.sheet)!;

  it("the web default never takes a desktop variant, and auto takes the host's platform", async () => {
    await page.viewport(1440, 900);
    let kit = await mount(sheet, "dark", { platform: "web" });
    expect(kit.getAttribute("data-pk-platform")).toBe("web");
    root?.unmount();
    host?.remove();
    // `auto` with a reported platform: linux is the gnome variant (ui-core's one mapping).
    const withHost = {
      ...sheet,
      row: {
        ...sheet.row,
        input: {
          ...sheet.row.input,
          platform: { os: "linux", formFactor: "computer" },
        },
      },
    } as Scene;
    kit = await mount(withHost, "dark", { platform: "auto" });
    expect(kit.getAttribute("data-pk-platform")).toBe("gnome");
    root?.unmount();
    host?.remove();
    kit = await mount(sheet, "dark", { platform: "auto" });
    // The corpus default platform is macOS: auto takes the reported one.
    expect(kit.getAttribute("data-pk-platform")).toBe("macos");
  });

  it("draws the two-tone focus ring on the keyboard-focused primary", async () => {
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
    expect(cs.boxShadow).not.toBe("none");
  });

  it("mirrors in a right-to-left page: the primary first is at the right", async () => {
    await page.viewport(1440, 900);
    const kit = await mount(sheet, "dark", {});
    root?.unmount();
    host?.remove();
    const rtl = await mount(sheet, "dark", { rtl: true });
    expect(getComputedStyle(rtl).direction).toBe("rtl");
    chrome(rtl, sheet, 1440);
    expect(kit).not.toBe(rtl);
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
    const cs = getComputedStyle(btn);
    expect(cs.boxShadow).toBe("none");
    expect(getComputedStyle(kit.querySelector(".card")!).borderTopStyle).toBe(
      "solid",
    );
  });
});
