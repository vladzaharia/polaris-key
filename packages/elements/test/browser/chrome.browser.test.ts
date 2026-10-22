// @pkey-feature ui.kit ui.theme
//
// The elements' desktop chrome baselines (UK-06.6 Windows, UK-06.8 macOS): the same scenes as the React lane
// (sdk-react/test/chromeScenes.ts), drawn by the `<pk-*>` elements with `theme.platform:
// "windows"`, so `pnpm ui:report` can hold both renderers to the same pixels. The elements share
// the React kit's stylesheet and DOM, so the checks here are the chrome's own: the variant on the
// kit root, 32 px controls at radius 4, the sheet a centred ContentDialog with equal-width
// buttons, the primary first.
//
//   PKEY_KIT_BASELINES=test/visual/__screenshots__ pnpm test:browser   (or `pnpm test:visual`)
//
// writes <dir>/<Component>.<state>/<windows|macos>-<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { PolarisKey, TAGS, LAYOUTS, type PkElement } from "../../src/index.js";
import {
  SCENES,
  sceneInput,
  type Scene,
} from "../../../sdk-react/test/chromeScenes.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_BASELINES__: string;
declare const __PKEY_FONTS__: string;

const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "1440", width: 1440, height: 900 },
] as const;
const SCHEMES = ["dark", "light"] as const;
const PLATFORMS = ["windows", "macos"] as const;
type Platform = (typeof PLATFORMS)[number];
const PRODUCT = {
  name: "Tidewater",
  developer: "Lumen Games",
  accent: "#369186",
};

beforeAll(() => {
  PolarisKey.fonts(__PKEY_FONTS__);
  PolarisKey.theme({ product: PRODUCT });
  document.body.style.margin = "0";
});
afterEach(() => {
  document.body.replaceChildren();
});

async function mount(
  scene: Scene,
  scheme: "dark" | "light",
  platform: Platform,
): Promise<PkElement> {
  document.documentElement.style.fontSize = "16px";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const el = document.createElement(
    TAGS[scene.component as keyof typeof TAGS],
  ) as PkElement & { presentation?: string; open?: boolean };
  el.colorScheme = scheme;
  el.theme = { platform };
  el.input = sceneInput(scene);
  if (scene.sheet) {
    el.presentation = "sheet";
    el.open = true;
  }
  if (
    scene.component !== "PolarisKeyGate" &&
    LAYOUTS[scene.component as keyof typeof LAYOUTS].kind === "screen"
  )
    el.fill = true;
  const main = document.createElement("main");
  main.dataset.hostContent = "";
  main.innerHTML = "<p>The app</p>";
  el.append(main);
  document.body.replaceChildren(el);
  await el.updateComplete;
  await document.fonts.ready;
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  await el.updateComplete;
  await Promise.all(
    [...document.getAnimations(), ...(el.shadowRoot?.getAnimations() ?? [])]
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  return el;
}

describe("the desktop chrome, drawn by the elements", () => {
  for (const platform of PLATFORMS)
    for (const scene of SCENES)
      for (const scheme of SCHEMES)
        for (const size of SIZES)
          it(`${platform} ${scene.id} ${size.label} ${scheme}`, async () => {
            await page.viewport(size.width, size.height);
            const el = await mount(scene, scheme, platform);
            const kit = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
            expect(kit.getAttribute("data-pk-platform")).toBe(platform);
            const primary = [
              ...kit.querySelectorAll<HTMLElement>(
                '.btn[data-variant="primary"]',
              ),
            ].find((b) => b.getBoundingClientRect().height > 0);
            if (primary && !matchMedia("(pointer: coarse)").matches) {
              const cs = getComputedStyle(primary);
              if (platform === "windows") {
                expect(parseFloat(cs.minHeight)).toBe(32);
                expect(parseFloat(cs.borderTopLeftRadius)).toBe(4);
              } else {
                expect(parseFloat(cs.minHeight)).toBe(
                  scene.component === "Welcome" ? 36 : 28,
                );
                expect(parseFloat(cs.borderTopLeftRadius)).toBeGreaterThan(100);
              }
            }
            if (scene.sheet || scene.dialog)
              expect(kit.querySelector("dialog[open]")).not.toBeNull();
            if (__PKEY_KIT_BASELINES__)
              await commands.kitShot(
                `${__PKEY_KIT_BASELINES__}/${scene.id}/${platform}-${size.label}-${scheme}.png`,
              );
          });
});
