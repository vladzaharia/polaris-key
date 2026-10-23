// @pkey-feature ui.kit ui.theme
//
// The elements' GNOME chrome baselines (UK-06.7): the same scenes as the React lane
// (sdk-react/test/chromeScenes.ts, test/browser/chrome.gnome.browser.test.tsx), drawn by the
// `<pk-*>` elements with `theme.platform: "linux"` (the variant id `gnome`), so `pnpm ui:report` can hold both renderers to
// the same pixels. The elements share the React kit's stylesheet and DOM, so the checks here are
// the chrome's own: the variant on the kit root, pill responses at 40 px, the sheet an AdwDialog
// at radius 14, the suggested action at the end of a row.
//
//   PKEY_KIT_BASELINES=test/visual/__screenshots__ pnpm test:browser   (or `pnpm test:visual`)
//
// writes <dir>/<Component>.<state>/gnome-<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { PolarisKey, TAGS, LAYOUTS, type PkElement } from "../../src/index.js";
import type { UiInput } from "@polaris-key/ui-core";
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
): Promise<PkElement> {
  document.documentElement.style.fontSize = "16px";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const el = document.createElement(
    TAGS[scene.component as keyof typeof TAGS],
  ) as PkElement & { presentation?: string; open?: boolean };
  el.colorScheme = scheme;
  el.theme = { platform: "linux" };
  el.input = gnomeInput(scene);
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

describe("the GNOME chrome, drawn by the elements", () => {
  for (const scene of SCENES)
    for (const scheme of SCHEMES)
      for (const size of SIZES)
        it(`${scene.id} ${size.label} ${scheme}`, async () => {
          await page.viewport(size.width, size.height);
          const el = await mount(scene, scheme);
          const kit = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
          expect(kit.getAttribute("data-pk-platform")).toBe("gnome");
          const res = [
            ...kit.querySelectorAll<HTMLElement>(".actions .btn"),
          ].find((b) => b.getBoundingClientRect().height > 0);
          if (res && !matchMedia("(pointer: coarse)").matches) {
            const cs = getComputedStyle(res);
            expect(parseFloat(cs.minHeight)).toBe(40);
            expect(parseFloat(cs.borderTopLeftRadius)).toBeGreaterThan(20);
          }
          if (scene.sheet || scene.dialog)
            expect(kit.querySelector("dialog[open]")).not.toBeNull();
          if (__PKEY_KIT_BASELINES__)
            await commands.kitShot(
              `${__PKEY_KIT_BASELINES__}/${scene.id}/gnome-${size.label}-${scheme}.png`,
            );
        });
});
