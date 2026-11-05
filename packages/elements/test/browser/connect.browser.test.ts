// @pkey-feature ui.kit
//
// CC-19.L: LinkPairing and TransferOffer as elements in real Chromium, at the phone, the phone on
// its side, the laptop and 200 % text, in dark and light. The twin of sdk-react's
// connect.browser.test: no sideways scroll, the primary in the first viewport (the code step's
// actions flow after what is shared, so it is exempt), 24 px targets, axe finds nothing, the code
// fully visible, the categories before Codes match, and the shares never covered.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/elements.<Component>.<state>/<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";

import type { UiInput } from "@polaris-key/ui-core";
import matrixJson from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import { PolarisKey, TAGS, type PkElement } from "../../src/index.js";
import { axeViolations } from "./support.js";

declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_KIT_BASELINES__: string;
declare const __PKEY_FONTS__: string;

interface Row {
  name: string;
  input: UiInput;
  expect: { component: "LinkPairing" | "TransferOffer"; state: string };
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
  { label: "640x360", width: 640, height: 360, rootPx: 16 },
  { label: "1440x900", width: 1440, height: 900, rootPx: 16 },
  { label: "390x844@200", width: 390, height: 844, rootPx: 32 },
] as const;

const shoot = (file: string): Promise<void> =>
  (commands as unknown as Record<string, (f: string) => Promise<void>>)
    .kitShot!(file);
const nextFrame = () =>
  new Promise<void>((done) => requestAnimationFrame(() => done()));

// The product the React twin draws, so the two kits' renders compare pixel for pixel.
beforeAll(() => {
  PolarisKey.fonts(__PKEY_FONTS__);
  PolarisKey.theme({
    product: {
      name: "Tidewater",
      developer: "Lumen Games",
      accent: "#369186",
    },
  });
  document.body.style.margin = "0";
});
afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.fontSize = "";
});

async function mount(
  row: Row,
  scheme: "dark" | "light",
  rootPx: number,
): Promise<PkElement> {
  document.documentElement.style.fontSize = `${rootPx}px`;
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  const el = document.createElement(TAGS[row.expect.component]) as PkElement;
  el.colorScheme = scheme;
  el.fill = true;
  el.input = {
    elapsedMs: 60_000,
    ...m.vocabulary.defaults,
    ...row.input,
  } as UiInput;
  document.body.replaceChildren(el);
  await el.updateComplete;
  await document.fonts.ready;
  await nextFrame();
  await Promise.allSettled(
    [...document.getAnimations(), ...(el.shadowRoot?.getAnimations() ?? [])]
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished),
  );
  await nextFrame();
  return el;
}

const visible = (el: Element): DOMRect | null => {
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return box.width > 0 &&
    box.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none"
    ? box
    : null;
};

describe("the connect screens at the §7.1 rows", () => {
  for (const row of SCENES)
    for (const scheme of ["dark", "light"] as const)
      for (const size of SIZES) {
        const id = `${row.expect.component}.${row.expect.state}`;
        it(`${id} ${size.label} ${scheme}`, async () => {
          await page.viewport(size.width, size.height);
          const el = await mount(row, scheme, size.rootPx);
          const kit = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
          expect(el.view.state).toBe(row.expect.state);
          expect(
            document.documentElement.scrollWidth,
            "sideways scroll",
          ).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
          const primary = [
            ...kit.querySelectorAll<HTMLElement>(
              '.btn[data-variant="primary"]',
            ),
          ].find(visible);
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
          ].flatMap((n) => {
            const r = visible(n);
            return r && (r.width < 24 || r.height < 24)
              ? [`${n.tagName} ${(n.textContent ?? "").slice(0, 20)}`]
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
          }
          const cats = kit.querySelector(".pair-cats");
          const confirm = kit.querySelector('[data-key="linkPairing.confirm"]');
          if (cats && confirm)
            expect(
              cats.compareDocumentPosition(confirm) &
                Node.DOCUMENT_POSITION_FOLLOWING,
              "the categories come before Codes match",
            ).toBeTruthy();
          expect(await axeViolations(el)).toEqual([]);
          if (__PKEY_KIT_SHOTS__)
            await shoot(
              `${__PKEY_KIT_SHOTS__}/elements.${id}/${size.label}-${scheme}.png`,
            );
        });
      }
});

// UI-KITS "LinkPairing and TransferOffer": two panes in a window at least 600 px wide and under
// 480 tall at 1x text, and on a TV; one column at 200 % text and in portrait. The decisions sit in
// the first viewport, and the reading order is still start pane, then end pane.
describe("two panes in a short landscape window and on a TV", () => {
  const TV = {
    os: "android",
    formFactor: "tv",
  } as unknown as UiInput["platform"];
  const SPLIT = SCENES.filter(
    (r) =>
      (r.expect.component === "LinkPairing" &&
        (r.expect.state === "code" || r.expect.state === "confirm")) ||
      (r.expect.component === "TransferOffer" && r.expect.state === "ask"),
  );
  const CASES = [
    {
      label: "844x390",
      width: 844,
      height: 390,
      rootPx: 16,
      tv: false,
      two: true,
    },
    {
      label: "640x360",
      width: 640,
      height: 360,
      rootPx: 16,
      tv: false,
      two: true,
    },
    {
      label: "960x540 TV",
      width: 960,
      height: 540,
      rootPx: 16,
      tv: true,
      two: true,
    },
    {
      label: "1024x600 not short",
      width: 1024,
      height: 600,
      rootPx: 16,
      tv: false,
      two: false,
    },
    {
      label: "390x844 portrait",
      width: 390,
      height: 844,
      rootPx: 16,
      tv: false,
      two: false,
    },
    {
      label: "844x390@200",
      width: 844,
      height: 390,
      rootPx: 32,
      tv: false,
      two: false,
    },
    {
      label: "960x540 TV@200",
      width: 960,
      height: 540,
      rootPx: 32,
      tv: true,
      two: true,
    },
  ];
  for (const row of SPLIT)
    for (const c of CASES)
      for (const scheme of ["dark", "light"] as const)
        it(`${row.expect.component}.${row.expect.state} ${c.label} ${scheme}`, async () => {
          await page.viewport(c.width, c.height);
          const r = c.tv
            ? ({ ...row, input: { ...row.input, platform: TV } } as Row)
            : row;
          const el = await mount(r, scheme, c.rootPx);
          const kit = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
          const box = (sel: string) =>
            kit.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
          const start = box(
            row.expect.component === "LinkPairing"
              ? ".pair-code"
              : ".pair-offer",
          );
          const end = box(".btn");
          if (c.two) {
            expect(end.left, "the actions are in the end pane").toBeGreaterThan(
              start.right - 1,
            );
            const first = kit.querySelector<HTMLElement>(
              ".card > :not(.split):not(.shimmer)",
            )!;
            const endFirst = kit.querySelector<HTMLElement>(
              row.expect.component === "LinkPairing"
                ? ".pair-reported"
                : ".actions",
            )!;
            expect(
              Math.abs(
                endFirst.getBoundingClientRect().top -
                  first.getBoundingClientRect().top,
              ),
              "both panes start at the top",
            ).toBeLessThan(2);
          } else expect(end.left, "one column").toBeLessThan(start.right);
          if (c.two) {
            const actions = [
              ...kit.querySelectorAll<HTMLElement>(".btn"),
            ].filter(visible);
            expect(actions.length).toBeGreaterThan(0);
            const pane = kit.querySelector<HTMLElement>(
              ".pair-end, .card > .actions",
            )!;
            const fit = c.rootPx === 16;
            for (const b of actions) {
              const br = b.getBoundingClientRect();
              expect(br.width, "a decision is as wide as its pane").toBeCloseTo(
                pane.getBoundingClientRect().width,
                0,
              );
              if (!fit) continue;
              expect(
                br.top,
                "an action is above the first viewport",
              ).toBeGreaterThanOrEqual(-0.5);
              expect(
                br.bottom,
                "an action is below the first viewport",
              ).toBeLessThanOrEqual(innerHeight + 0.5);
            }
            // Stacked, the primary first in the DOM and on top.
            const tops = actions.map((b) => b.getBoundingClientRect().top);
            expect(tops, "stacked, in DOM order").toEqual(
              [...tops].sort((a, b) => a - b),
            );
            if (actions.some((b) => b.dataset["variant"] === "primary"))
              expect(
                actions[0]!.dataset["variant"],
                "the primary is first",
              ).toBe("primary");
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
            expect(
              document.documentElement.scrollWidth,
              "sideways scroll",
            ).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
            if (fit)
              expect(kit.getBoundingClientRect().height).toBeLessThanOrEqual(
                innerHeight + 1,
              );
          }
          // The cross-renderer baselines (ui:report diffs them against React's).
          const baseline = { "844x390": "844", "960x540 TV": "960tv" }[c.label];
          if (__PKEY_KIT_BASELINES__ && baseline)
            await shoot(
              `${__PKEY_KIT_BASELINES__}/${row.expect.component}.${row.expect.state}/${baseline}-${scheme}.png`,
            );
          if (__PKEY_KIT_SHOTS__)
            await shoot(
              `${__PKEY_KIT_SHOTS__}/elements.panes.${row.expect.component}.${row.expect.state}/${c.label.replace(/ /g, "_")}-${scheme}.png`,
            );
        });
});

describe("a tall card and a TV at large text", () => {
  const TV = {
    os: "android",
    formFactor: "tv",
  } as unknown as UiInput["platform"];
  it("a card taller than the window starts at the top edge and the window scrolls", async () => {
    const base = SCENES.find(
      (s) => s.expect.component === "TransferOffer" && s.expect.state === "ask",
    )!;
    const row: Row = {
      ...base,
      input: {
        ...base.input,
        transferOffer: {
          ...base.input.transferOffer!,
          device:
            "Maya's very long named travelling laptop in the spare room upstairs",
        },
      } as UiInput,
    };
    for (const scheme of ["dark", "light"] as const)
      for (const [w, h] of [
        [640, 360],
        [844, 390],
      ] as const) {
        await page.viewport(w, h);
        const el = await mount(row, scheme, 16);
        const kit = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
        const card = kit.querySelector(".card")!.getBoundingClientRect();
        const accept = kit
          .querySelector('[data-key="transferOffer.accept"]')!
          .getBoundingClientRect();
        // Document coordinates: focus on the heading may have scrolled the window.
        expect(card.top + scrollY, `${w}x${h} card top`).toBeGreaterThanOrEqual(
          -0.5,
        );
        expect(
          accept.top + scrollY,
          `${w}x${h} Accept top`,
        ).toBeGreaterThanOrEqual(-0.5);
        expect(
          accept.bottom + scrollY,
          `${w}x${h} Accept is reachable by scrolling`,
        ).toBeLessThanOrEqual(document.documentElement.scrollHeight + 0.5);
      }
  });

  for (const [component, state] of [
    ["LinkPairing", "code"],
    ["LinkPairing", "confirm"],
    ["TransferOffer", "ask"],
  ] as const)
    it(`${component}.${state} on a TV at 200 % text: two panes inside the title-safe area`, async () => {
      await page.viewport(960, 540);
      const base = SCENES.find(
        (s) => s.expect.component === component && s.expect.state === state,
      )!;
      const el = await mount(
        { ...base, input: { ...base.input, platform: TV } } as Row,
        "dark",
        32,
      );
      const kit = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
      const cols = getComputedStyle(kit.querySelector(".card")!)
        .gridTemplateColumns.split(" ")
        .filter(Boolean);
      expect(cols.length, "two columns").toBe(2);
      const sh = document.documentElement.scrollHeight;
      for (const t of [
        kit.querySelector(".pair-code, .pair-offer")!,
        kit.querySelector(".btn")!,
      ]) {
        const b = t.getBoundingClientRect();
        expect(b.top + scrollY, "above the top edge").toBeGreaterThanOrEqual(
          0.5,
        );
        expect(b.bottom + scrollY, "unreachable").toBeLessThanOrEqual(sh + 0.5);
        expect(b.left, "in overscan").toBeGreaterThanOrEqual(960 * 0.05 - 0.5);
        expect(b.right, "in overscan").toBeLessThanOrEqual(960 * 0.95 + 0.5);
      }
    });
});

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
      linkPairing: { ...base.input.linkPairing!, categories: SIX },
    } as UiInput,
  };
  const CASES = [
    { label: "390x844@200", width: 390, height: 844, rootPx: 32 },
    { label: "320x256 (400 % zoom)", width: 320, height: 256, rootPx: 16 },
    { label: "844x390", width: 844, height: 390, rootPx: 16 },
    { label: "640x360", width: 640, height: 360, rootPx: 16 },
  ];
  for (const c of CASES)
    it(`${c.label}: shares above Codes match and never covered`, async () => {
      await page.viewport(c.width, c.height);
      const el = await mount(row, "light", c.rootPx);
      const root = el.shadowRoot!;
      const shares = root.querySelector<HTMLElement>('[data-part="shares"]')!;
      const confirm = root.querySelector<HTMLElement>(
        '[data-key="linkPairing.confirm"]',
      )!;
      const sr = shares.getBoundingClientRect();
      expect(sr.bottom, "the shares end above Codes match").toBeLessThanOrEqual(
        confirm.getBoundingClientRect().top + 0.5,
      );
      confirm.scrollIntoView({ block: "end" });
      await nextFrame();
      const s2 = shares.getBoundingClientRect();
      if (s2.bottom > 0 && s2.top < innerHeight) {
        const hit = root.elementFromPoint(
          s2.left + 4,
          Math.min(Math.max(s2.top, 0) + 4, innerHeight - 1),
        );
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

describe("text and keyboard", () => {
  it("LinkPairing.code scales with the root font", async () => {
    await page.viewport(1440, 900);
    const row = SCENES.find((s) => s.expect.state === "code")!;
    const sizeAt = async (px: number) => {
      const el = await mount(row, "light", px);
      return [
        el.shadowRoot!.querySelector("h1")!,
        el.shadowRoot!.querySelector(".btn")!,
      ].map((e) => parseFloat(getComputedStyle(e).fontSize));
    };
    const base = await sizeAt(16);
    const big = await sizeAt(32);
    base.forEach((b, i) => expect(big[i]! / b).toBeCloseTo(2, 1));
  });

  it("nothing is focused on arrival; Tab reaches Codes match then Not a match", async () => {
    await page.viewport(1440, 900);
    const el = await mount(
      SCENES.find((s) => s.expect.state === "code")!,
      "light",
      16,
    );
    expect(el.shadowRoot!.activeElement?.closest(".btn") ?? null).toBeNull();
    const order = [
      ...el.shadowRoot!.querySelectorAll<HTMLElement>("button, a[href], input"),
    ]
      .filter(visible)
      .map((n) => n.dataset["key"]);
    expect(order).toEqual(["linkPairing.confirm", "linkPairing.decline"]);
  });
});

describe("bound to the SDK's offers", () => {
  it("a host that removes the element on pk-close never loses a queued offer", async () => {
    await page.viewport(1440, 900);
    let handler:
      | ((o: {
          id: string;
          name?: string;
          from: { label: string | null };
        }) => Promise<unknown>)
      | null = null;
    const el = document.createElement("pk-transfer-offer") as PkElement &
      Record<string, unknown>;
    el.colorScheme = "light";
    el.fill = true;
    el.input = { elapsedMs: 60_000, ...m.vocabulary.defaults } as UiInput;
    el.transfer = {
      onOffer: (h: typeof handler) => {
        handler = h;
        return () => void (handler = null);
      },
    };
    el.receive = () => undefined;
    const answers: unknown[] = [];
    el.addEventListener("pk-close", () => el.remove());
    document.body.replaceChildren(el);
    await el.updateComplete;
    // Idle: nothing is drawn.
    expect(el.shadowRoot!.querySelector(".pk-root")).toBeNull();
    for (const [id, name] of [
      ["p1", "one.jpg"],
      ["p2", "two.jpg"],
    ] as const)
      void handler!({ id, name, from: { label: "Maya" } }).then((a) =>
        answers.push(a),
      );
    await el.updateComplete;
    const press = async (key: string) => {
      el.shadowRoot!.querySelector<HTMLElement>(`[data-key="${key}"]`)!.click();
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
    };
    expect(el.shadowRoot!.querySelector(".pair-file")!.textContent).toContain(
      "one.jpg",
    );
    await press("transferOffer.decline");
    expect(el.isConnected, "the host was told to close too early").toBe(true);
    expect(el.shadowRoot!.querySelector(".pair-file")!.textContent).toContain(
      "two.jpg",
    );
    expect(answers).toEqual(["decline"]);
    await press("transferOffer.decline");
    expect(answers).toEqual(["decline", "decline"]);
    expect(el.isConnected).toBe(false);
  });
});
