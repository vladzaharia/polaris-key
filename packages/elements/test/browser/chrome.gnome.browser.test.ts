// @pkey-feature ui.kit ui.theme
//
// The elements' GNOME chrome baselines (UK-06.7): the same scenes as the React lane
// (sdk-react/test/chromeScenes.ts, test/browser/chrome.gnome.browser.test.tsx), drawn by the
// `<pk-*>` elements with `theme.platform: "linux"` (the variant id `gnome`), so `pnpm ui:report`
// can hold both renderers to the same pixels. The elements share the React kit's stylesheet and
// DOM, so the checks here are the chrome's own: the variant on the kit root, pill responses at
// 40 px, the footer pinned inside the window, 44 px under touch.
//
//   PKEY_KIT_BASELINES=test/visual/__screenshots__ pnpm test:browser   (or `pnpm test:visual`)
//
// writes <dir>/<Component>.<state>/gnome-<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { PolarisKey, TAGS, LAYOUTS, type PkElement } from "../../src/index.js";
import {
  HOST_APP_HTML,
  WINDOWS_SCENES as SCENES,
  sceneInput,
  type Scene,
} from "../../../sdk-react/test/chromeScenes.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
    emulateTouch: (on: boolean) => Promise<void>;
  }
}
declare const __PKEY_KIT_BASELINES__: string;
declare const __PKEY_FONTS__: string;

const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "480x640", width: 480, height: 640 },
  { label: "900x600", width: 900, height: 600 },
  { label: "1440", width: 1440, height: 900 },
] as const;
/** A GNOME machine: the platform every scene is drawn on. */
const GNOME_PLATFORM = { os: "linux", formFactor: "computer" };
const SCHEMES = ["dark", "light"] as const;
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
afterEach(async () => {
  document.body.replaceChildren();
  await commands.emulateTouch(false);
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
  el.input = sceneInput(scene, GNOME_PLATFORM);
  if (scene.sheet) {
    el.presentation = "sheet";
    el.open = true;
  }
  if (
    !scene.sheet &&
    !scene.dialog &&
    scene.component !== "PolarisKeyGate" &&
    LAYOUTS[scene.component as keyof typeof LAYOUTS].kind === "screen"
  )
    el.fill = true;
  const main = document.createElement("main");
  main.dataset.hostContent = "";
  main.innerHTML = "<p>The app</p>";
  el.append(main);
  document.body.replaceChildren(el);
  // The host window behind a dialog, so the smoke layer has something to dim.
  if (scene.sheet || scene.dialog)
    document.body.insertAdjacentHTML("afterbegin", HOST_APP_HTML);
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
          const fine = !matchMedia("(pointer: coarse)").matches;
          for (const b of kit.querySelectorAll<HTMLElement>(
            '.actions .btn:not([data-variant="link"])',
          )) {
            const r = b.getBoundingClientRect();
            if (r.height === 0 || !fine) continue;
            expect(
              r.height,
              "a response is a 40 px pill",
            ).toBeGreaterThanOrEqual(40);
            expect(
              parseFloat(getComputedStyle(b).borderTopLeftRadius),
            ).toBeGreaterThan(20);
          }
          const footer = kit.querySelector<HTMLElement>(
            "dialog[open] .card > .actions:not([data-group])",
          );
          if (footer)
            expect(
              footer.getBoundingClientRect().bottom,
              "the footer is inside the window",
            ).toBeLessThanOrEqual(innerHeight + 0.5);
          if (scene.sheet || scene.dialog)
            expect(kit.querySelector("dialog[open]")).not.toBeNull();
          if (__PKEY_KIT_BASELINES__)
            await commands.kitShot(
              `${__PKEY_KIT_BASELINES__}/${scene.id}/gnome-${size.label}-${scheme}.png`,
            );
        });
});

describe("the GNOME chrome under a coarse pointer, drawn by the elements", () => {
  it("takes 44 px controls (touch)", async () => {
    await page.viewport(900, 600);
    await commands.emulateTouch(true);
    const scene = SCENES.find((x) => x.id === "Activate.parsed")!;
    const el = await mount(scene, "light");
    expect(matchMedia("(pointer: coarse)").matches).toBe(true);
    const kit = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
    expect(
      kit
        .querySelector<HTMLElement>('.btn[data-variant="primary"]')!
        .getBoundingClientRect().height,
    ).toBe(44);
    expect(kit.querySelector("input")!.getBoundingClientRect().height).toBe(44);
  });
});
