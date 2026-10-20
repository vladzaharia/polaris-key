// @pkey-feature ui.theme ui.kit
//
// LK-16 in real Chromium: the Powered by Polaris Locker attribution in the settings pane. The line
// is the Locker micro mark at 16 px and the phrase in live text; `badge` draws the 320 x 104 Locker
// badge where the pane leaves 320 px and falls back to the line where it does not. No sideways
// scroll, and the badge is never cropped or shrunk.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/elements.powered-by.<mode>/<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import type { UiInput } from "@polaris-key/ui-core";
import matrix from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };

import { PolarisKey, TAGS, type PkElement } from "../../src/index.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_FONTS__: string;

type Row = { name: string; input: Record<string, unknown> };
const m = matrix as unknown as Record<string, Row[]> & {
  vocabulary: { defaults: Record<string, unknown> };
};

function input(mode: "line" | "badge"): UiInput {
  const row = m.settings!.find(
    (r) => r.name === "AccountAndLicense/signed-in: Powered by",
  )!;
  const base: Record<string, unknown> = { ...row.input };
  for (const [k, v] of Object.entries(m.vocabulary.defaults)) {
    if (k === "capabilities")
      base[k] = { ...(v as object), ...((base[k] as object) ?? {}) };
    else if (!(k in base)) base[k] = v;
  }
  base.integrator = {
    ...(base.integrator as object),
    poweredBy: mode,
  };
  return { elapsedMs: 60_000, ...base } as UiInput;
}

beforeAll(() => {
  PolarisKey.fonts(__PKEY_FONTS__);
  PolarisKey.theme({
    product: { name: "Tidewater Studio", accent: "#369186" },
  });
  document.body.style.margin = "0";
});

afterEach(() => document.body.replaceChildren());

const frames = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const q = <T extends Element = HTMLElement>(el: PkElement, s: string) =>
  el.shadowRoot!.querySelector<T>(s);

async function draw(
  mode: "line" | "badge",
  w: number,
  h: number,
  scheme: "dark" | "light",
): Promise<PkElement> {
  await page.viewport(w, h);
  document.body.style.background = scheme === "dark" ? "#060912" : "#f6f8ff";
  const el = document.createElement(TAGS.AccountAndLicense) as PkElement;
  el.colorScheme = scheme;
  el.input = input(mode);
  el.style.display = "grid";
  document.body.replaceChildren(el);
  await el.updateComplete;
  await document.fonts.ready;
  await frames();
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(
      `${__PKEY_KIT_SHOTS__}/elements.powered-by.${mode}/${w}-${scheme}.png`,
    );
  return el;
}

describe("Powered by Polaris Locker", () => {
  for (const scheme of ["dark", "light"] as const)
    for (const [w, h] of [
      [390, 844],
      [1440, 900],
    ] as const) {
      it(`line at ${w} ${scheme}: the 16 px mark and the phrase, no sideways scroll`, async () => {
        const el = await draw("line", w, h, scheme);
        const line = q(el, '[data-part="powered-by"]')!;
        const mark = line.querySelector("svg")!.getBoundingClientRect();
        expect(Math.round(mark.width)).toBe(16);
        expect(Math.round(mark.height)).toBe(16);
        expect(line.textContent!.trim()).toBe("Powered by Polaris Locker");
        expect(q(el, '[data-part="powered-by-badge"]')).toBeNull();
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(w);
      });

      it(`badge at ${w} ${scheme}: 320 x 104 where 320 px are free, else the line`, async () => {
        const el = await draw("badge", w, h, scheme);
        const wrap = q(el, ".powered-by")!;
        const badge = q(el, '[data-part="powered-by-badge"]')!;
        const line = q(el, '[data-part="powered-by"]')!;
        const free = wrap.getBoundingClientRect().width;
        if (free >= 320) {
          const r = badge.querySelector("svg")!.getBoundingClientRect();
          expect(r.width).toBeGreaterThanOrEqual(320);
          expect(Math.round((r.width * 104) / 320)).toBe(Math.round(r.height));
          expect(getComputedStyle(line).display).toBe("none");
        } else {
          expect(getComputedStyle(badge).display).toBe("none");
          expect(getComputedStyle(line).display).not.toBe("none");
        }
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(w);
      });
    }
});
