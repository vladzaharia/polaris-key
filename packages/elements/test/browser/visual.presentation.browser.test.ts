// @pkey-feature ui.kit ui.update
//
// The product-presentation scenes of the elements' visual baselines (UI-KITS.md §1.2, §7.1): the
// same six scenes the React suite records (sdk-react/test/browser/presentation.browser.test.tsx),
// each from a `PresentationSource` the kit reads its name, accent and icon through.
//
//   Welcome.default-presentation-icon / -derived / -icon-failed / -rtl / -none
//   UpdatePrompt.available-presentation
//
// PKEY_KIT_BASELINES=<dir> records each at 390 and 1440, dark and light, under <dir>/<scene>/.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import type { UiInput } from "@polaris-key/ui-core";
import matrixJson from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import { PolarisKey, TAGS, type PkElement } from "../../src/index.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_BASELINES__: string;
declare const __PKEY_FONTS__: string;

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

function source(p: Obj | null, icon: Uint8Array | null) {
  return {
    current: () => p,
    icon: async () => icon,
    subscribe: () => () => {},
  } as unknown as NonNullable<
    NonNullable<Parameters<typeof PolarisKey.theme>[0]>["presentation"]
  >;
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

interface Scene {
  id: string;
  component: "Welcome" | "UpdatePrompt";
  input: UiInput;
  presentation: ReturnType<typeof source>;
}

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
    },
    {
      id: "Welcome.default-presentation-derived",
      component: "Welcome",
      input: inputOf(WELCOME, shown(MOSS, true)),
      presentation: source(MOSS, mossIcon),
    },
    {
      id: "Welcome.default-presentation-icon-failed",
      component: "Welcome",
      input: inputOf(WELCOME, shown(DRIFT, true)),
      presentation: source(DRIFT, new Uint8Array([1, 2, 3, 4])),
    },
    {
      id: "Welcome.default-presentation-rtl",
      component: "Welcome",
      input: inputOf(WELCOME, shown(RTL, false)),
      presentation: source(RTL, null),
    },
    {
      id: "Welcome.default-presentation-none",
      component: "Welcome",
      input: inputOf(WELCOME, { presentation: undefined, bundle: undefined }),
      presentation: source(null, null),
    },
    {
      id: "UpdatePrompt.available-presentation",
      component: "UpdatePrompt",
      input: inputOf("UpdatePrompt/available", shown(DRIFT, true)),
      presentation: source(DRIFT, driftIcon),
    },
  ];
}

const SIZES = [
  { label: "390", w: 390, h: 844 },
  { label: "1440", w: 1440, h: 900 },
] as const;

beforeAll(() => {
  PolarisKey.fonts(__PKEY_FONTS__);
  // The React suite sets no product here: the presentation source is the only identity.
  PolarisKey.theme({});
  document.body.style.margin = "0";
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("the product presentation in the elements", () => {
  for (const id of [
    "Welcome.default-presentation-icon",
    "Welcome.default-presentation-derived",
    "Welcome.default-presentation-icon-failed",
    "Welcome.default-presentation-rtl",
    "Welcome.default-presentation-none",
    "UpdatePrompt.available-presentation",
  ])
    for (const scheme of ["dark", "light"] as const)
      for (const size of SIZES)
        it(`${id} at ${size.label} ${scheme}`, async () => {
          scenes = scenes.length ? scenes : await build();
          const scene = scenes.find((s) => s.id === id)!;
          await page.viewport(size.w, size.h);
          document.documentElement.style.fontSize = "16px";
          document.body.style.background =
            scheme === "dark" ? "#101114" : "#ffffff";
          const el = document.createElement(TAGS[scene.component]) as PkElement;
          el.colorScheme = scheme;
          el.theme = { presentation: scene.presentation };
          el.input = scene.input;
          if (scene.component === "Welcome") el.fill = true;
          const main = document.createElement("main");
          main.innerHTML = "<p>The app</p>";
          el.append(main);
          document.body.replaceChildren(el);
          await el.updateComplete;
          await document.fonts.ready;
          // The icon is fetched through the source, then drawn from a blob: let it settle.
          await new Promise((r) => setTimeout(r, 300));
          await el.updateComplete;
          await Promise.all(
            [
              ...document.getAnimations(),
              ...(el.shadowRoot?.getAnimations() ?? []),
            ]
              .filter((a) => a.effect?.getTiming().iterations !== Infinity)
              .map((a) => a.finished.catch(() => undefined)),
          );
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
          expect(el.shadowRoot!.querySelector(".pk-root")).not.toBeNull();
          if (__PKEY_KIT_BASELINES__)
            await commands.kitShot(
              `${__PKEY_KIT_BASELINES__}/${id}/${size.label}-${scheme}.png`,
            );
        });
});
