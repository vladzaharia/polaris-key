// @pkey-feature ui.kit ui.update
//
// The product-presentation path of the React kit in real Chromium (HA-13, UI-KITS §1.2): a
// PresentationSource gives the kit its name, accent, accentDark and verified icon, with no
// integrator code. The scenes below are the reviewable renders of that path:
//
//   Welcome.default-presentation-icon       icon, accent and accentDark
//   Welcome.default-presentation-derived    no accent: derived from the icon
//   Welcome.default-presentation-icon-failed an icon that does not decode: the monogram, same accent
//   Welcome.default-presentation-rtl        an Arabic name and developer, bidi-isolated
//   Welcome.default-presentation-none       no name anywhere and no icon: no tile
//   UpdatePrompt.available-presentation     the update prompt, narrow card: a button keeps its height
//
// PKEY_KIT_BASELINES=<dir> records each at 390 and 1440, dark and light, under <dir>/<scene>/
// (the folder ui:report reads, and maps onto the registry's state by its prefix).

import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import matrixJson from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import type { UiInput } from "@polaris-key/ui-core";

import * as Kit from "@polaris-key/react/kit";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_BASELINES__: string;

type Obj = Record<string, unknown>;
type Row = { name: string; input: Obj };
const m = matrixJson as unknown as Record<string, Row[]> & {
  vocabulary: { defaults: Obj };
};
function inputOf(name: string, patch: Obj = {}): UiInput {
  let base: Obj | undefined;
  for (const k of Object.keys(m))
    if (Array.isArray(m[k]))
      base ??= (m[k] as Row[]).find((x) => x.name === name)?.input;
  if (!base) throw new Error(`no ui-matrix row ${name}`);
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(m.vocabulary.defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((out[k] as Obj) ?? {}) };
    else if (!(k in out)) out[k] = v;
  }
  return { elapsedMs: 60_000, ...out, ...patch } as UiInput;
}

/** A solid square PNG, made in the page: no binary fixture to commit. */
async function png(fill: string, size = 192): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  g.fillStyle = fill;
  g.fillRect(0, 0, size, size);
  g.fillStyle = "#ffffff";
  g.fillRect(size / 4, size / 4, size / 2, size / 2);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

function source(
  p: Obj | null,
  icon: Uint8Array | null,
): Kit.KitTheme["presentation"] {
  return {
    current: () => p,
    icon: async () => icon,
    subscribe: () => () => {},
  } as unknown as Kit.KitTheme["presentation"];
}

const DRIFT = {
  name: "Drift Kart",
  developerName: "Lanternworks",
  accent: "#ff6a3d",
  accentDark: "#ff8a5c",
};
const MOSS = { name: "Moss Garden", developerName: "Fernleaf" };
const RTL = {
  name: "سباق الانجراف",
  developerName: "استوديو الفانوس",
  accent: "#ff6a3d",
};
const WELCOME = "Welcome/default: sign-in and a key";

/** The input a product's presentation gives the screen (the corpus default names Tidewater). */
const shown = (p: Obj, icon: boolean): Obj => ({
  presentation: { name: p.name, developerName: p.developerName, icon },
});

type Scheme = "dark" | "light";
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.body.style.background = "";
});
const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));

async function draw(
  node: ReactNode,
  w: number,
  h: number,
  scheme: Scheme,
): Promise<HTMLElement> {
  await page.viewport(w, h);
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(node);
  for (let i = 0; i < 100 && !host.querySelector(".pk-root"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await document.fonts.ready;
  // The icon is fetched through the source, then drawn from a blob: wait for it to settle.
  await new Promise((r) => setTimeout(r, 300));
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

const SIZES = [
  { label: "390", w: 390, h: 844 },
  { label: "1440", w: 1440, h: 900 },
] as const;

async function record(id: string, size: string, scheme: Scheme) {
  if (__PKEY_KIT_BASELINES__)
    await commands.kitShot(
      `${__PKEY_KIT_BASELINES__}/${id}/${size}-${scheme}.png`,
    );
}

interface Scene {
  id: string;
  component: "Welcome" | "UpdatePrompt";
  input: UiInput;
  presentation: Kit.KitTheme["presentation"];
  theme?: Kit.KitTheme;
  check: (kit: HTMLElement, scheme: Scheme) => void;
}

const colour = (kit: HTMLElement, name: string) =>
  getComputedStyle(kit).getPropertyValue(name).trim();

let scenes: Scene[] = [];
async function build(): Promise<Scene[]> {
  const driftIcon = await png("#ff6a3d");
  const mossIcon = await png("#2c8739");
  return [
    {
      id: "Welcome.default-presentation-icon",
      component: "Welcome",
      input: inputOf(WELCOME, shown(DRIFT, true)),
      presentation: source(DRIFT, driftIcon),
      check(kit, scheme) {
        expect(kit.textContent).toContain("Drift Kart");
        const icon = kit.querySelector<HTMLImageElement>(
          'img[data-part="icon"]',
        );
        expect(icon?.src).toMatch(/^blob:/);
        expect(Math.round(icon!.getBoundingClientRect().width)).toBe(
          // UI-KITS §1.2: the hero icon is 120 on the web at the desktop width, 96 below it.
          innerWidth >= 1024 ? 120 : 96,
        );
        // accentDark is the dark scheme's accent.
        expect(colour(kit, "--pk-accent")).toBe(
          scheme === "dark" ? "#ff8a5c" : "#ec592a",
        );
      },
    },
    {
      id: "Welcome.default-presentation-derived",
      component: "Welcome",
      input: inputOf(WELCOME, shown(MOSS, true)),
      presentation: source(MOSS, mossIcon),
      check(kit) {
        // No accent served: it comes from the icon (green), never the ink or Polaris violet.
        const accent = colour(kit, "--pk-accent");
        expect(kit.querySelector('img[data-part="icon"]')).not.toBeNull();
        expect(accent).not.toBe("");
        expect(accent.toLowerCase()).not.toBe("#7c5cff");
        const [r, g, b] = [1, 3, 5].map((i) =>
          parseInt(accent.slice(i, i + 2), 16),
        );
        expect(g, `accent ${accent} is green`).toBeGreaterThan(r!);
        expect(g, `accent ${accent} is green`).toBeGreaterThan(b!);
      },
    },
    {
      id: "Welcome.default-presentation-icon-failed",
      component: "Welcome",
      input: inputOf(WELCOME, shown(DRIFT, true)),
      // Bytes that do not decode: the monogram, with the served accent kept.
      presentation: source(DRIFT, new Uint8Array([1, 2, 3, 4])),
      check(kit) {
        expect(kit.querySelector('[data-part="monogram"]')?.textContent).toBe(
          "D",
        );
        expect(kit.querySelector('img[data-part="icon"]')).toBeNull();
        expect(colour(kit, "--pk-accent")).not.toBe("");
      },
    },
    {
      id: "Welcome.default-presentation-rtl",
      component: "Welcome",
      input: inputOf(WELCOME, shown(RTL, false)),
      presentation: source(RTL, null),
      check(kit) {
        const isolated = [...kit.querySelectorAll("bdi")].map(
          (e) => e.textContent,
        );
        expect(isolated).toContain("سباق الانجراف");
        expect(kit.querySelector('[data-part="monogram"]')).not.toBeNull();
      },
    },
    {
      id: "Welcome.default-presentation-none",
      component: "Welcome",
      input: inputOf(WELCOME, { presentation: undefined, bundle: undefined }),
      presentation: source(null, null),
      check(kit) {
        // No name anywhere and no icon: no tile, empty or otherwise (UI-KITS §1.2).
        expect(kit.querySelector('[data-part="monogram"]')).toBeNull();
        for (const tile of kit.querySelectorAll(".icon"))
          expect(tile.textContent?.trim() || tile.tagName).not.toBe("");
        // ... and the title is the neutral one, not "Welcome to" with nothing after it.
        const title = kit.querySelector('[data-part="title"]');
        expect(title?.textContent?.trim()).toBe("Welcome");
      },
    },
    {
      id: "UpdatePrompt.available-presentation",
      component: "UpdatePrompt",
      input: inputOf("UpdatePrompt/available", shown(DRIFT, true)),
      presentation: source(DRIFT, driftIcon),
      check(kit) {
        // Whatever the card's width, a button keeps its own height (about the control's).
        for (const b of kit.querySelectorAll<HTMLElement>(".actions .btn")) {
          const h = b.getBoundingClientRect().height;
          expect(h, `${b.textContent} is ${h} px tall`).toBeLessThanOrEqual(72);
        }
        expect(kit.textContent).not.toMatch(/[{}]/);
      },
    },
  ];
}

describe("the product presentation in the React kit", () => {
  const ids = [
    "Welcome.default-presentation-icon",
    "Welcome.default-presentation-derived",
    "Welcome.default-presentation-icon-failed",
    "Welcome.default-presentation-rtl",
    "Welcome.default-presentation-none",
    "UpdatePrompt.available-presentation",
  ];
  for (const id of ids)
    for (const scheme of ["dark", "light"] as const)
      for (const size of SIZES)
        it(`${id} at ${size.label} ${scheme}`, async () => {
          scenes = scenes.length ? scenes : await build();
          const scene = scenes.find((s) => s.id === id)!;
          const Component = (
            Kit as unknown as Record<
              string,
              (p: Kit.KitProps & { children?: ReactNode }) => ReactNode
            >
          )[scene.component]!;
          const kit = await draw(
            <Component
              input={scene.input}
              fill={scene.component === "Welcome"}
              theme={{
                presentation: scene.presentation,
                colorScheme: scheme,
                ...(scene.theme ?? {}),
              }}
            >
              <main>
                <p>The app</p>
              </main>
            </Component>,
            size.w,
            size.h,
            scheme,
          );
          scene.check(kit, scheme);
          await record(id, size.label, scheme);
        });
});
