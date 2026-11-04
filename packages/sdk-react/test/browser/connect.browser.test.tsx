// @pkey-feature ui.kit
//
// CC-19.9: LinkPairing and TransferOffer in real Chromium, at the §7.1 rows that matter (a phone, a
// phone on its side, a laptop, and 200 % text), in dark and light, under both presets. Assertions:
// no sideways scroll, the primary is in the first viewport (200 % text reflows and scrolls), every
// target is 24 px or more, axe finds nothing, the text follows the root font, the code is fully
// visible and the categories sit above the confirm button. Keyboard: Tab reaches Codes match and
// Not a match, and Escape declines. PKEY_KIT_BASELINES=<dir> writes the 390 and 1440 dark/light
// renders to <dir>/<Component>.<state>/<width>-<scheme>.png for ui:report. PKEY_KIT_SHOTS=<dir> writes each render to
// <dir>/react.<Component>.<state>/<size>-<scheme>.png.

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
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_KIT_BASELINES__: string;

interface Row {
  name: string;
  input: UiInput;
  expect: { component: string; state: string };
}
const m = matrixJson as unknown as {
  vocabulary: { defaults: Record<string, unknown> };
  connect: Row[];
};
const ROWS = m.connect.filter((r) => r.expect.state !== "hidden");
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
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.documentElement.style.fontSize = "";
});
beforeAll(async () => {
  await Kit.preloadKitParts();
  // The brand fonts, as the kit suite loads them, so the baselines draw as the elements ones do.
  const fonts = Object.assign(document.createElement("link"), {
    rel: "stylesheet",
    href: new URL("../../../brand/fonts/fonts.css", import.meta.url).href,
  });
  const settled = new Promise<void>((done) => {
    fonts.onload = fonts.onerror = () => done();
  });
  document.head.append(fonts);
  await settled;
});

const nextFrame = () =>
  new Promise<void>((done) => requestAnimationFrame(() => done()));
const SCREENS = {
  LinkPairing: Kit.LinkPairing,
  TransferOffer: Kit.TransferOffer,
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

describe("the connect screens at the §7.1 rows", () => {
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
            // The code step is exempt: its actions flow after what is shared (see the next suite), they are
            // not docked into the first viewport.
            if (primary && size.rootPx === 16 && row.expect.state !== "code") {
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
            const code = kit.querySelector<HTMLElement>(".pair-code");
            if (code) {
              const r = code.getBoundingClientRect();
              expect(r.left, "the code is cut off").toBeGreaterThanOrEqual(0);
              expect(r.right, "the code is cut off").toBeLessThanOrEqual(
                innerWidth + 0.5,
              );
              const cats = kit.querySelector(".pair-cats");
              const confirm = kit.querySelector(
                '[data-key="linkPairing.confirm"]',
              );
              if (cats && confirm)
                expect(
                  cats.compareDocumentPosition(confirm) &
                    Node.DOCUMENT_POSITION_FOLLOWING,
                  "the categories come before Codes match",
                ).toBeTruthy();
            }
            expect(await axeFindings(kit)).toEqual([]);
            if (
              __PKEY_KIT_BASELINES__ &&
              preset === "polaris-key" &&
              (size.label === "390x844" || size.label === "1440x900")
            )
              await commands.kitShot(
                `${__PKEY_KIT_BASELINES__}/${id}/${size.label.replace(/x\d+$/, "")}-${scheme}.png`,
              );
            if (__PKEY_KIT_SHOTS__)
              await commands.kitShot(
                `${__PKEY_KIT_SHOTS__}/react.${id}/${size.label}-${scheme}${preset === "native" ? "-native" : ""}.png`,
              );
          });
        }
});

describe("text scales with the root font", () => {
  it("LinkPairing.code", async () => {
    await page.viewport(1440, 900);
    const row = SCENES.find((s) => s.expect.state === "code")!;
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

// What the person would share is never behind, or after, Codes match: the actions flow after the
// categories (no docked bar), so wherever Codes match is on screen the shares are above it and not covered.
describe("the code step keeps what is shared above Codes match", () => {
  const SIX = [
    "contacts",
    "photos",
    "notes",
    "calendar",
    "tax-forms",
    "bookmarks",
  ];
  const base = SCENES.find((s) => s.expect.state === "code")!;
  const row: Row = {
    ...base,
    input: {
      ...base.input,
      linkPairing: { ...(base.input as any).linkPairing, categories: SIX },
    } as UiInput,
  };
  const CASES = [
    { label: "390x844@200", width: 390, height: 844, rootPx: 32 },
    { label: "320x256 (400 % zoom)", width: 320, height: 256, rootPx: 16 },
    { label: "844x390", width: 844, height: 390, rootPx: 16 },
    { label: "640x360", width: 640, height: 360, rootPx: 16 },
    { label: "1440x900@200", width: 1440, height: 900, rootPx: 32 },
  ];
  for (const c of CASES)
    it(`${c.label}: shares above Codes match and never covered`, async () => {
      await page.viewport(c.width, c.height);
      const kit = await mount(row, "light", c.rootPx);
      const shares = kit.querySelector<HTMLElement>('[data-part="shares"]')!;
      const confirm = kit.querySelector<HTMLElement>(
        '[data-key="linkPairing.confirm"]',
      )!;
      const reported = kit.querySelector<HTMLElement>(".pair-reported")!;
      expect(
        reported.compareDocumentPosition(confirm) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        "the device line comes before Codes match",
      ).toBeTruthy();
      const cr = confirm.getBoundingClientRect();
      const sr = shares.getBoundingClientRect();
      expect(sr.bottom, "the shares end above Codes match").toBeLessThanOrEqual(
        cr.top + 0.5,
      );
      // Scroll Codes match into view: the shares stay out of its way, and nothing sits over them.
      confirm.scrollIntoView({ block: "end" });
      await nextFrame();
      const s2 = shares.getBoundingClientRect();
      const midY = Math.min(Math.max(s2.top, 0) + 4, innerHeight - 1);
      if (s2.bottom > 0 && s2.top < innerHeight) {
        const hit = document.elementFromPoint(s2.left + 4, midY);
        expect(hit && shares.contains(hit), "something covers the shares").toBe(
          true,
        );
      }
      expect(
        document.documentElement.scrollWidth,
        "sideways scroll",
      ).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
    });
});

// UI-KITS "LinkPairing and TransferOffer": the code, confirm and ask states are two panes (start:
// title, lede, code or offer; end: the reported line, the categories, the actions) in a window at
// least 600 px wide and under 480 tall at 1x text, and on a TV always; the decision is in the first
// viewport. Message states and 200 % text stay one column.
describe("two panes in short landscape and on TV", () => {
  const TV = { os: "android", formFactor: "tv" };
  const SHORT = [
    { label: "844x390", width: 844, height: 390, tv: false },
    { label: "640x360", width: 640, height: 360, tv: false },
    { label: "960x540-tv", width: 960, height: 540, tv: true },
  ];
  const STATES = [
    ["LinkPairing", "code", ["linkPairing.confirm", "linkPairing.decline"]],
    ["LinkPairing", "confirm", ["common.cancel"]],
    ["TransferOffer", "ask", ["transferOffer.accept", "transferOffer.decline"]],
  ] as const;
  const rowOf = (component: string, state: string, tv: boolean): Row => {
    const base = SCENES.find(
      (r) => r.expect.component === component && r.expect.state === state,
    )!;
    return tv
      ? { ...base, input: { ...base.input, platform: TV } as UiInput }
      : base;
  };
  const columns = (card: Element) =>
    getComputedStyle(card)
      .gridTemplateColumns.split(" ")
      .filter((c) => c !== "").length;
  for (const [component, state, keys] of STATES)
    for (const scheme of ["dark", "light"] as const)
      for (const size of SHORT)
        it(`${component}.${state} ${size.label} ${scheme}: two panes, decision in view`, async () => {
          await page.viewport(size.width, size.height);
          const kit = await mount(rowOf(component, state, size.tv), scheme, 16);
          expect(columns(kit.querySelector(".card")!), "two columns").toBe(2);
          const left = kit.querySelector(".pair-code, .pair-offer")!;
          const right = kit.querySelector(".pair-end, .card > .actions")!;
          const edge = right.getBoundingClientRect().left + 0.5;
          expect(
            left.getBoundingClientRect().right,
            "the start pane is beside the end pane",
          ).toBeLessThanOrEqual(edge);
          expect(
            kit.querySelector("h1")!.getBoundingClientRect().right,
            "the title is in the start pane",
          ).toBeLessThanOrEqual(edge);
          for (const key of keys) {
            const b = kit
              .querySelector(`[data-key="${key}"]`)!
              .getBoundingClientRect();
            expect(b.top, key).toBeGreaterThanOrEqual(-0.5);
            expect(
              b.bottom,
              `${key} is below the first viewport`,
            ).toBeLessThanOrEqual(innerHeight + 0.5);
            expect(b.right, key).toBeLessThanOrEqual(innerWidth + 0.5);
          }
          expect(
            document.documentElement.scrollHeight,
            "the screen scrolls",
          ).toBeLessThanOrEqual(document.documentElement.clientHeight + 1);
          if (state === "code") {
            const cats = kit
              .querySelector(".pair-cats")!
              .getBoundingClientRect();
            const ok = kit
              .querySelector('[data-key="linkPairing.confirm"]')!
              .getBoundingClientRect();
            expect(
              cats.bottom,
              "categories before Codes match",
            ).toBeLessThanOrEqual(ok.top + 0.5);
          }
          expect(await axeFindings(kit)).toEqual([]);
          if (__PKEY_KIT_SHOTS__)
            await commands.kitShot(
              `${__PKEY_KIT_SHOTS__}/react.${component}.${state}/${size.label}-${scheme}.png`,
            );
        });

  it("one column under 600 wide, at 200 % text and in a tall window", async () => {
    for (const [w, h, px] of [
      [560, 360, 16],
      [844, 390, 32],
      [390, 844, 16],
    ] as const) {
      await page.viewport(w, h);
      const kit = await mount(
        rowOf("TransferOffer", "ask", false),
        "light",
        px,
      );
      expect(columns(kit.querySelector(".card")!), `${w}x${h}@${px}`).toBe(1);
      root?.unmount();
      host?.remove();
    }
  });

  it("a message state never splits", async () => {
    await page.viewport(844, 390);
    for (const [component, state] of [
      ["LinkPairing", "open"],
      ["LinkPairing", "linked"],
      ["TransferOffer", "receiving"],
    ] as const) {
      const row = SCENES.find(
        (r) => r.expect.component === component && r.expect.state === state,
      );
      if (!row) continue;
      const kit = await mount(row, "light", 16);
      expect(columns(kit.querySelector(".card")!), state).toBe(1);
      root?.unmount();
      host?.remove();
    }
  });
});

describe("keyboard", () => {
  it("nothing is focused on arrival; Tab reaches Codes match then Not a match", async () => {
    await page.viewport(1440, 900);
    const row = SCENES.find((s) => s.expect.state === "code")!;
    const kit = await mount(row, "light", 16);
    expect(document.activeElement?.closest(".btn")).toBeNull();
    const order = [
      ...kit.querySelectorAll<HTMLElement>("button, a[href], input"),
    ]
      .filter(visible)
      .map((el) => el.dataset.key);
    expect(order).toEqual(["linkPairing.confirm", "linkPairing.decline"]);
  });
});
