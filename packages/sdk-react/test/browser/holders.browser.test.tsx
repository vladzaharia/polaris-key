// @pkey-feature ui.kit.holders
//
// UK-42.9: the two holder screens in real Chromium, at the §7.1 rows that matter (a phone, a phone
// on its side, a laptop, and 200 % text), in dark and light, under both presets. Assertions: no
// sideways scroll, the primary is in the first viewport (200 % text reflows and scrolls), every
// target is 24 px or more, axe finds nothing, the text follows the root font. Motion: the reason
// lines and the check run on the Web Animations API, and a person who prefers reduced motion gets
// none. PKEY_KIT_SHOTS=<dir> writes each render to <dir>/react.<Component>.<state>/<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";

import type { UiInput } from "@polaris-key/ui-core";
import * as Kit from "@polaris-key/react/kit";
import matrixJson from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import { axeFindings } from "./axe.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
    emulateMotion: (motion: "reduce" | null) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;

interface Row {
  name: string;
  input: UiInput;
  expect: { component: string; state: string };
}
const m = matrixJson as unknown as {
  vocabulary: { defaults: Record<string, unknown> };
  holders: Row[];
};
const ROWS = m.holders.filter(
  (r) =>
    (r.expect.component === "ActivateDone" ||
      r.expect.component === "AddToAccount") &&
    r.expect.state !== "hidden",
);
// One row per state; the services-off variants stay with the jsdom suite.
const SCENES = ROWS.filter(
  (r, i) =>
    ROWS.findIndex(
      (o) =>
        o.expect.component === r.expect.component &&
        o.expect.state === r.expect.state,
    ) === i,
);
const SIZES = [
  { label: "390x844", width: 390, height: 844, rootPx: 16 },
  { label: "844x390", width: 844, height: 390, rootPx: 16 },
  { label: "1440x900", width: 1440, height: 900, rootPx: 16 },
  { label: "390x844@200", width: 390, height: 844, rootPx: 32 },
] as const;
const PRODUCT = {
  name: "Tidewater",
  developer: "Lumen Games",
  accent: "#369186",
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await commands.emulateMotion(null);
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.documentElement.style.fontSize = "";
});
beforeAll(async () => {
  await Kit.preloadKitParts();
});

const nextFrame = () =>
  new Promise<void>((done) => requestAnimationFrame(() => done()));
const SCREENS = {
  ActivateDone: Kit.ActivateDone,
  AddToAccount: Kit.AddToAccount,
} as const;
const inputOf = (row: Row): UiInput =>
  ({ elapsedMs: 60_000, ...m.vocabulary.defaults, ...row.input }) as UiInput;

async function mount(
  row: Row,
  scheme: "dark" | "light",
  rootPx: number,
  preset: "polaris-key" | "native" = "polaris-key",
  settle = true,
): Promise<HTMLElement> {
  document.documentElement.style.fontSize = `${rootPx}px`;
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  host = document.createElement("div");
  document.body.append(host);
  const Component = SCREENS[row.expect.component as keyof typeof SCREENS];
  root = createRoot(host);
  root.render(
    <Component
      input={inputOf(row)}
      fill
      theme={{ product: PRODUCT, colorScheme: scheme, preset }}
    />,
  );
  for (let i = 0; i < 150 && !host.querySelector(".pk-root"); i++)
    await new Promise((r) => setTimeout(r, 20));
  if (settle) {
    await document.fonts.ready;
    await nextFrame();
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished),
    );
    await nextFrame();
  }
  return host.querySelector<HTMLElement>(".pk-root")!;
}

/** The element's box when it is drawn, else null. */
const visible = (el: Element): DOMRect | null => {
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const drawn =
    box.width > 0 &&
    box.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none";
  return drawn ? box : null;
};

describe("the holder screens at the §7.1 rows", () => {
  for (const row of SCENES)
    for (const scheme of ["dark", "light"] as const)
      for (const preset of ["polaris-key", "native"] as const)
        for (const size of SIZES) {
          // The presets differ in look, not layout: the native one is drawn at the two big rows.
          if (
            preset === "native" &&
            size.label !== "390x844" &&
            size.label !== "1440x900"
          )
            continue;
          const id = `${row.expect.component}.${row.expect.state}`;
          it(`${id} ${size.label} ${scheme} ${preset}`, async () => {
            await page.viewport(size.width, size.height);
            const kit = await mount(row, scheme, size.rootPx, preset);
            expect(kit.dataset.state).toBe(row.expect.state);
            expect(
              document.documentElement.scrollWidth,
              "sideways scroll",
            ).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
            const primary = [
              ...kit.querySelectorAll<HTMLElement>(
                '.btn[data-variant="primary"]',
              ),
            ].find(visible);
            if (primary && size.rootPx === 16) {
              const r = primary.getBoundingClientRect();
              expect(r.top).toBeGreaterThanOrEqual(-0.5);
              expect(
                r.bottom,
                "the primary is below the first viewport",
              ).toBeLessThanOrEqual(innerHeight + 0.5);
            }
            const small = [
              ...kit.querySelectorAll(".btn, input, a[href]"),
            ].flatMap((el) => {
              const r = visible(el);
              return r && (r.width < 24 || r.height < 24)
                ? [`${el.tagName} ${(el.textContent ?? "").slice(0, 20)}`]
                : [];
            });
            expect(small.join("\n")).toBe("");
            expect(await axeFindings(kit)).toEqual([]);
            if (__PKEY_KIT_SHOTS__)
              await commands.kitShot(
                `${__PKEY_KIT_SHOTS__}/react.${id}/${size.label}-${scheme}${preset === "native" ? "-native" : ""}.png`,
              );
          });
        }
});

describe("text scales with the root font", () => {
  it("ActivateDone.ready", async () => {
    await page.viewport(1440, 900);
    const row = SCENES.find((s) => s.expect.state === "ready")!;
    const sizeAt = async (px: number) => {
      root?.unmount();
      host?.remove();
      const kit = await mount(row, "light", px);
      return [kit.querySelector("h1")!, kit.querySelector(".btn")!].map((e) =>
        parseFloat(getComputedStyle(e).fontSize),
      );
    };
    const base = await sizeAt(16);
    const big = await sizeAt(32);
    base.forEach((b, i) => expect(big[i]! / b).toBeCloseTo(2, 1));
  });
});

describe("motion", () => {
  const ready = () => SCENES.find((s) => s.expect.state === "ready")!;
  it("the reason lines enter one after another, three at most, and the check draws once", async () => {
    await page.viewport(1440, 900);
    const kit = await mount(ready(), "light", 16, "polaris-key", false);
    const lines = [...kit.querySelectorAll<HTMLElement>(".reasons li")];
    const running = lines.map((li) => li.getAnimations().length);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(
      running.every((n) => n === 1),
      `reason animations ${running}`,
    ).toBe(true);
    const delays = lines.map((li) =>
      Number(li.getAnimations()[0]!.effect!.getTiming().delay),
    );
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
    expect(new Set(delays).size).toBe(delays.length);
    expect(
      kit.querySelector(".success path")!.getAnimations().length,
      "one check draw",
    ).toBe(1);
  });
  it("reduced motion draws everything at once", async () => {
    await page.viewport(1440, 900);
    await commands.emulateMotion("reduce");
    const kit = await mount(ready(), "light", 16, "polaris-key", false);
    expect(kit.querySelectorAll(".reasons li").length).toBeGreaterThan(0);
    for (const el of kit.querySelectorAll(".reasons li, .success path, .card"))
      expect(el.getAnimations(), el.className.toString()).toEqual([]);
  });
});
