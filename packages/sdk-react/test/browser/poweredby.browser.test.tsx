// @pkey-feature ui.theme ui.kit
//
// LK-16 in the React kit, in real Chromium: the Powered by Polaris Locker attribution, set through
// the theme (`poweredBy`). The line is the Locker micro mark at 16 px and the phrase in live text, at
// the pane foot and outside the status live region; the badge is About's, 320 x 104 where 320 px are
// free, else the line. Twin of packages/elements/test/browser/poweredby.browser.test.ts.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/react.powered-by.<mode>/<size>-<scheme>.png.

import { type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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
declare const __PKEY_KIT_SHOTS__: string;

type Obj = Record<string, unknown>;
const m = matrixJson as unknown as Record<
  string,
  { name: string; input: Obj }[]
> & {
  vocabulary: { defaults: Obj };
};

function input(): UiInput {
  const row = m.settings!.find(
    (r) => r.name === "AccountAndLicense/signed-in: Powered by",
  )!;
  const base: Obj = { ...row.input };
  for (const [k, v] of Object.entries(m.vocabulary.defaults)) {
    if (k === "capabilities")
      base[k] = { ...(v as Obj), ...((base[k] as Obj) ?? {}) };
    else if (!(k in base)) base[k] = v;
  }
  delete base.integrator; // the theme carries it
  return { elapsedMs: 60_000, ...base } as UiInput;
}

beforeAll(async () => {
  // The QR encoder and the settings, device and account rows load on demand.
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
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));

async function draw(
  node: ReactNode,
  mode: string,
  w: number,
  h: number,
  scheme: "dark" | "light",
): Promise<HTMLElement> {
  await page.viewport(w, h);
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#060912" : "#f6f8ff";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(node);
  for (let i = 0; i < 100 && !host.querySelector(".pk-root"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await document.fonts.ready;
  for (let i = 0; i < 4; i++) await frame();
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(
      `${__PKEY_KIT_SHOTS__}/react.powered-by.${mode}/${w}-${scheme}.png`,
    );
  return host;
}

const theme = (
  poweredBy: true | "line" | "badge",
  scheme: "dark" | "light",
) => ({
  product: { name: "Tidewater Studio", accent: "#369186" },
  colorScheme: scheme,
  poweredBy,
});
const q = <T extends Element = HTMLElement>(el: Element, s: string) =>
  el.querySelector<T>(s);

describe("Powered by Polaris Locker (React)", () => {
  for (const scheme of ["dark", "light"] as const)
    for (const [w, h] of [
      [390, 844],
      [1440, 900],
    ] as const) {
      it(`line at ${w} ${scheme}: the 16 px mark and the phrase at the pane foot, outside the status region`, async () => {
        const el = await draw(
          <Kit.AccountAndLicense input={input()} theme={theme(true, scheme)} />,
          "line",
          w,
          h,
          scheme,
        );
        const line = q(el, '[data-part="powered-by"]')!;
        const mark = line.querySelector("svg")!.getBoundingClientRect();
        expect(Math.round(mark.width)).toBe(16);
        expect(line.textContent!.trim()).toBe("Powered by Polaris Locker");
        expect(line.closest('[role="status"]')).toBeNull();
        expect(q(el, '[data-part="status"]')?.textContent ?? "").not.toContain(
          "Powered by",
        );
        expect(q(el, '[data-part="powered-by-badge"]')).toBeNull();
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(w);
      });

      it(`About badge at ${w} ${scheme}: 320 x 104 where 320 px are free, else the line`, async () => {
        const el = await draw(
          <Kit.About input={input()} theme={theme("badge", scheme)} />,
          "badge",
          w,
          h,
          scheme,
        );
        const badge = q(el, '[data-part="powered-by-badge"]')!;
        const line = q(el, '[data-part="powered-by"]')!;
        const free = q(el, ".powered-by")!.getBoundingClientRect().width;
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
