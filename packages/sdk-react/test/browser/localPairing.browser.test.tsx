// @pkey-feature connect.local
//
// CC-29K: Pair with a Code and the paired devices in real Chromium. Every non-hidden row of
// ui-matrix.json `local` is drawn at the committed 390 and 1440 rows in dark and light; the first
// row of each state also at a phone on its side and at 200 % text. Assertions: no sideways scroll,
// the primary is in the first viewport (200 % text reflows and scrolls), every target is 24 px or
// more, axe finds nothing. The show screen's window rule (UI-KITS 4.3, LocalPairing): two panes
// from 600 px, one column under, no logo and no scroll in a short wide window, one scrolling column
// with the notice before the QR in a narrow short one. PKEY_KIT_SHOTS=<dir> writes each render to
// <dir>/react.local.<scene>/<size>-<scheme>.png.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { commands, page } from "vitest/browser";
import type { ReactNode } from "react";

import * as Kit from "@polaris-key/react/kit";
import type { UiInput } from "@polaris-key/ui-core";
import matrixJson from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import { axeFindings } from "./axe.js";

declare const __PKEY_KIT_SHOTS__: string;

interface Row {
  name: string;
  input: UiInput;
  expect: { component: string; state: string };
}
type Scheme = "dark" | "light";
const SCHEMES: readonly Scheme[] = ["dark", "light"];
const matrix = matrixJson as unknown as {
  vocabulary: { defaults: Record<string, unknown> };
  local: Row[];
};
const ROWS = matrix.local.filter((r) => r.expect.state !== "hidden");
const stateOf = (r: Row): string => `${r.expect.component}.${r.expect.state}`;
const FIRST = new Set(
  ROWS.filter((r, i) => ROWS.findIndex((o) => stateOf(o) === stateOf(r)) === i),
);
const SIZES = [
  { label: "390x844", width: 390, height: 844, rootPx: 16 },
  { label: "1440x900", width: 1440, height: 900, rootPx: 16 },
  { label: "844x390", width: 844, height: 390, rootPx: 16 },
  { label: "390x844@200", width: 390, height: 844, rootPx: 32 },
] as const;
const PRODUCT = { name: "DJDL", developer: "DJDL Audio", accent: "#e8553d" };
const NOW = Math.floor(Date.now() / 1000);
const STORED_AT = 1_700_000_000;

/** The one mounted screen of a test: drawn in a page of its own, taken down after. */
const stage: { root: Root | null; host: HTMLElement | null } = {
  root: null,
  host: null,
};
function takeDown(): void {
  stage.root?.unmount();
  stage.host?.remove();
  stage.root = stage.host = null;
  document.documentElement.style.fontSize = "";
}
afterAll(takeDown);
beforeAll(async () => {
  await Kit.preloadKitParts();
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = new URL("../../../brand/fonts/fonts.css", import.meta.url).href;
  await new Promise<void>((done) => {
    sheet.onload = sheet.onerror = () => done();
    document.head.append(sheet);
  });
});

const frame = (): Promise<void> =>
  new Promise((done) => requestAnimationFrame(() => done()));
const SCREENS = {
  LocalPairing: Kit.LocalPairing,
  PairedDevices: Kit.PairedDevices,
} as const;

/** A row's input with the defaults, and its stored times moved to now: the kit says how long ago. */
function inputOf(row: Row): UiInput {
  const input = { ...matrix.vocabulary.defaults, ...row.input } as UiInput;
  const list = input.pairedDevices;
  if (!list?.devices) return input;
  const devices = list.devices.map((d) => ({
    ...d,
    lastSeen: d.lastSeen === null ? null : NOW - (STORED_AT - d.lastSeen),
  }));
  return { ...input, pairedDevices: { ...list, devices } };
}

/** Draw `node` in a page of its own and wait for the kit, its fonts and a frame. */
async function draw(
  node: ReactNode,
  scheme: Scheme,
  rootPx: number,
): Promise<HTMLElement> {
  takeDown();
  document.documentElement.style.fontSize = `${rootPx}px`;
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  stage.host = document.body.appendChild(document.createElement("div"));
  stage.root = createRoot(stage.host);
  stage.root.render(node);
  while (!stage.host.querySelector(".pk-root"))
    await new Promise((r) => setTimeout(r, 20));
  await document.fonts.ready;
  await frame();
  return stage.host.querySelector<HTMLElement>(".pk-root")!;
}

async function mount(
  row: Row,
  scheme: Scheme,
  rootPx: number,
  over: Partial<UiInput> = {},
): Promise<HTMLElement> {
  const Screen = SCREENS[row.expect.component as keyof typeof SCREENS];
  const kit = await draw(
    <Screen
      input={{ ...inputOf(row), ...over } as UiInput}
      categories={["crates", "cues"]}
      categoryLabels={{ crates: "Crates", cues: "Cue points" }}
      fill
      theme={{ product: PRODUCT, colorScheme: scheme }}
    />,
    scheme,
    rootPx,
  );
  const running = document
    .getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity);
  await Promise.allSettled(running.map((a) => a.finished));
  await frame();
  return kit;
}

/** The box of an element that is drawn, else null. */
function drawn(el: Element | null): DOMRect | null {
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const css = getComputedStyle(el);
  const hidden = css.visibility === "hidden" || css.display === "none";
  return box.width > 0 && box.height > 0 && !hidden ? box : null;
}
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
const sceneId = (row: Row): string =>
  `${stateOf(row)}.${slug(row.name.split(": ").slice(1).join(" "))}`;
const shoot = async (scene: string, file: string): Promise<void> => {
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(`${__PKEY_KIT_SHOTS__}/react.${scene}/${file}.png`);
};
const columns = (el: Element | null): number =>
  getComputedStyle(el!).gridTemplateColumns.split(" ").filter(Boolean).length;
const noSideways = (): void =>
  expect(
    document.documentElement.scrollWidth,
    "sideways scroll",
  ).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);

/** Every control a finger or a pointer may press is 24 px or more in both directions. */
function tooSmall(kit: HTMLElement): string[] {
  const targets = kit.querySelectorAll(
    ".btn, input, a[href], .pair-switch, .pair-more",
  );
  return [...targets].flatMap((el) => {
    const box = drawn(el);
    return box && Math.min(box.width, box.height) < 24
      ? [`${el.tagName} ${el.textContent?.slice(0, 20)}`]
      : [];
  });
}

describe("Pair with a Code at the committed rows", () => {
  for (const row of ROWS)
    for (const scheme of SCHEMES)
      for (const size of SIZES) {
        // The first row of each state is drawn at every size; its variants at the two big rows.
        const big = size.label === "390x844" || size.label === "1440x900";
        if (!big && !FIRST.has(row)) continue;
        it(`${sceneId(row)} ${size.label} ${scheme}`, async () => {
          await page.viewport(size.width, size.height);
          const kit = await mount(row, scheme, size.rootPx);
          expect(kit.dataset.state).toBe(row.expect.state);
          noSideways();
          // The primary is in the first viewport; a long list scrolls inside its own box.
          const primary = [
            ...kit.querySelectorAll('.btn[data-variant="primary"]'),
          ].find(drawn);
          if (primary && size.rootPx === 16 && size.label !== "844x390") {
            const box = primary.getBoundingClientRect();
            expect(box.top).toBeGreaterThanOrEqual(-0.5);
            expect(
              box.bottom,
              "the primary is below the first viewport",
            ).toBeLessThanOrEqual(innerHeight + 0.5);
          }
          expect(tooSmall(kit).join("\n")).toBe("");
          const code = kit.querySelector<HTMLElement>(".pair-code");
          if (code) {
            const box = code.getBoundingClientRect();
            expect(box.left, "the code is cut off").toBeGreaterThanOrEqual(0);
            expect(box.right, "the code is cut off").toBeLessThanOrEqual(
              innerWidth + 0.5,
            );
            const size1 = (el: Element) =>
              parseFloat(getComputedStyle(el).fontSize);
            expect(size1(code), "the code is the largest text").toBeGreaterThan(
              size1(kit.querySelector("h1")!),
            );
          }
          const shares = kit.querySelector(".pair-cats");
          const yes = kit.querySelector('[data-key="localPairing.pair"]');
          if (shares && yes)
            expect(
              shares.compareDocumentPosition(yes) &
                Node.DOCUMENT_POSITION_FOLLOWING,
              "the categories come before Pair",
            ).toBeTruthy();
          expect(await axeFindings(kit)).toEqual([]);
          await shoot(sceneId(row), `${size.label}-${scheme}`);
        });
      }
});

describe("text scales with the root font", () => {
  it("LocalPairing.show", async () => {
    await page.viewport(1440, 900);
    const row = ROWS.find((r) => r.expect.state === "show")!;
    const textAt = async (px: number): Promise<number[]> => {
      const kit = await mount(row, "light", px);
      const sizeOf = (sel: string) =>
        parseFloat(getComputedStyle(kit.querySelector(sel)!).fontSize);
      return [sizeOf("h1"), sizeOf(".btn")];
    };
    const base = await textAt(16);
    const big = await textAt(32);
    base.forEach((px, i) => expect(big[i]! / px).toBeCloseTo(2, 1));
  });
});

// UI-KITS 4.3, LocalPairing: two panes from 600 px of window at any height, one column under and at
// 200 % text; a window under 480 tall drops the kit's logo and, wide, never scrolls; narrow and
// short, the column scrolls with the notice before the QR.
describe("the show screen's window rule", () => {
  const find = (part: string): Row => ROWS.find((r) => r.name.includes(part))!;
  const SHOW = "the code is the largest";
  const noLogo = (kit: HTMLElement): void =>
    expect(
      drawn(kit.querySelector('[data-part="header"]')),
      "the logo shows",
    ).toBeNull();
  const CASES = [
    { label: "1280x800", width: 1280, height: 800, rootPx: 16, panes: 2 },
    { label: "600x700", width: 600, height: 700, rootPx: 16, panes: 2 },
    { label: "599x700", width: 599, height: 700, rootPx: 16, panes: 1 },
    { label: "1100x800@200", width: 1100, height: 800, rootPx: 32, panes: 1 },
  ];
  for (const c of CASES)
    for (const scheme of SCHEMES)
      it(`${c.label} ${scheme}: ${c.panes} pane(s)`, async () => {
        await page.viewport(c.width, c.height);
        const kit = await mount(find(SHOW), scheme, c.rootPx);
        expect(columns(kit.querySelector(".pair-show"))).toBe(c.panes);
        const code = kit.querySelector(".pair-code")!.getBoundingClientRect();
        const qr = kit.querySelector(".qr")!.getBoundingClientRect();
        if (c.panes === 2) {
          expect(qr.left, "beside").toBeGreaterThanOrEqual(code.right - 0.5);
          const block = kit
            .querySelector(".pair-codeblock")!
            .getBoundingClientRect();
          const apart = qr.top + qr.height / 2 - (block.top + block.height / 2);
          expect(
            Math.abs(apart),
            "the QR is centred on the code",
          ).toBeLessThanOrEqual(2);
        } else
          expect(qr.top, "under").toBeGreaterThanOrEqual(code.bottom - 0.5);
        noSideways();
        // The reading order is the same in both layouts.
        const order = [
          "a11y.linkCode",
          "a11y.qrPairing",
          "localPairing.waitingDevice",
          "common.cancel",
          "localPairing.toEnter",
        ];
        const all = [...kit.querySelectorAll("*")];
        const at = order.map((k) =>
          all.findIndex((e) => e.getAttribute("data-key") === k),
        );
        expect(at).toEqual([...at].sort((x, y) => x - y));
        await shoot("window.show", `${c.label}-${scheme}`);
      });

  for (const scheme of SCHEMES)
    it(`720x420 ${scheme}: no logo, side by side, no scroll`, async () => {
      await page.viewport(720, 420);
      const kit = await mount(find(SHOW), scheme, 16);
      noLogo(kit);
      expect(columns(kit.querySelector(".pair-show"))).toBe(2);
      expect(
        document.documentElement.scrollHeight,
        "the window scrolls",
      ).toBeLessThanOrEqual(document.documentElement.clientHeight + 1);
      for (const k of [
        "common.cancel",
        "localPairing.toEnter",
        "localPairing.waitingDevice",
      ])
        expect(
          kit.querySelector(`[data-key="${k}"]`)!.getBoundingClientRect()
            .bottom,
          k,
        ).toBeLessThanOrEqual(innerHeight + 0.5);
      expect(await axeFindings(kit)).toEqual([]);
      await shoot("window.show", `720x420-${scheme}`);
    });

  for (const scheme of SCHEMES)
    it(`390x420 ${scheme}: one column that scrolls, the notice before the QR`, async () => {
      await page.viewport(390, 420);
      const kit = await mount(find("a wrong code changed it"), scheme, 16);
      noLogo(kit);
      expect(columns(kit.querySelector(".pair-show"))).toBe(1);
      const notice = kit.querySelector(".pair-notice")!.getBoundingClientRect();
      expect(notice.bottom, "the notice is above the QR").toBeLessThanOrEqual(
        kit.querySelector(".qr")!.getBoundingClientRect().top + 0.5,
      );
      // The wrong-code notice is told by a live region that is in the page before it, so it is
      // announced where it is out of view; the region holds the words, never the action.
      const said = kit.querySelector(
        '[role="status"] [data-key="a11y.newCode"]',
      );
      expect(said?.textContent).toContain("4 8 1 2");
      expect(
        kit
          .querySelector('[data-key="localPairing.showNew"]')
          ?.closest('[role="status"]'),
      ).toBeNull();
      noSideways();
      expect(await axeFindings(kit)).toEqual([]);
      await shoot("window.show", `390x420-${scheme}`);
    });

  it("a TV is always two panes", async () => {
    await page.viewport(900, 540);
    const kit = await mount(find(SHOW), "dark", 16, {
      platform: { os: "android", formFactor: "tv" },
    });
    expect(columns(kit.querySelector(".pair-show"))).toBe(2);
  });
});

describe("the paired list's rows", () => {
  const find = (part: string): Row => ROWS.find((r) => r.name.includes(part))!;

  it("keeps name, switch and menu on one line down to 390 px, with a 44 x 24 switch", async () => {
    await page.viewport(390, 844);
    const kit = await mount(find("one is off"), "light", 16);
    for (const line of kit.querySelectorAll<HTMLElement>(".pair-row")) {
      const centre = (sel: string) => {
        const box = line.querySelector(sel)!.getBoundingClientRect();
        return box.top + box.height / 2;
      };
      expect(
        Math.abs(centre(".pair-name") - centre(".pair-more")),
        "on one line",
      ).toBeLessThanOrEqual(24);
      const sw = line.querySelector(".pair-switch")!.getBoundingClientRect();
      expect([Math.round(sw.width), Math.round(sw.height)]).toEqual([44, 24]);
    }
    // The Can connect column label goes under 480 px of window.
    expect(drawn(kit.querySelector(".pair-colhead"))).toBeNull();
  });

  it("shows the Can connect label from 480 px", async () => {
    await page.viewport(900, 700);
    const kit = await mount(find("one is off"), "light", 16);
    expect(drawn(kit.querySelector(".pair-colhead"))).not.toBeNull();
  });

  it("a long and a right-to-left name keep their ellipsis and isolation", async () => {
    await page.viewport(390, 844);
    const names = [
      "Riverside Club booth 2, Pioneer CDJ-3000 rig, back room",
      "جهاز مارا في غرفة الاستوديو الخلفية رقم ٢",
    ];
    const devices = names.map((label, i) => ({
      id: `n${i}`,
      label,
      lastSeen: NOW - (i + 1) * 86_400,
      reachable: true,
    }));
    const kit = await mount(find("five paired devices"), "light", 16, {
      pairedDevices: { step: "list", devices },
    } as unknown as Partial<UiInput>);
    const lines = [...kit.querySelectorAll<HTMLElement>(".pair-row")];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(
        innerWidth,
      );
      expect(getComputedStyle(line.querySelector("bdi")!).unicodeBidi).toBe(
        "isolate",
      );
    }
  });
});

// ── Driven screens in a real browser: focus, live regions, the menu, store failures, short windows ──

type PairArgs = Parameters<Kit.LocalLinksLike["pair"]>[0];
type JoinArgs = Parameters<Kit.LocalLinksLike["join"]>[0];

const link = (id: string, reachable = true) => ({
  id,
  label: `Device ${id}`,
  lastSeen: NOW - 86_400,
  reachable,
});

/** A driver over `rows` that records what the screen asked and lets the test answer. */
function fakeDriver(rows: ReturnType<typeof link>[] = []) {
  const seen: { pair: PairArgs | null; join: JoinArgs | null } = {
    pair: null,
    join: null,
  };
  const next: {
    join: () => Promise<never>;
    rename: () => Promise<boolean>;
    remove: () => Promise<boolean>;
  } = {
    join: () => new Promise(() => undefined),
    rename: async () => true,
    remove: async () => true,
  };
  const driver: Kit.LocalLinksLike = {
    localPairing: () => true,
    list: async () => rows,
    rename: () => next.rename(),
    remove: () => next.remove(),
    setReachable: async () => true,
    onChange: () => () => undefined,
    dialsLeft: () => null,
    pair: async (o) => {
      seen.pair = o;
      return {
        open: true,
        stop: async () => undefined,
        renew: async () => ({
          code: "5512 0000",
          qr: "PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y",
          reason: "opened",
          expiresAt: NOW + 300,
          failures: 0,
        }),
        code: () => null,
      };
    },
    join: (o) => {
      seen.join = o;
      return next.join();
    },
  };
  return { driver, seen, next };
}

const mountNode = (
  node: ReactNode,
  scheme: Scheme = "dark",
  rootPx = 16,
): Promise<HTMLElement> => draw(node, scheme, rootPx);

/** Wait until `test` holds, drawing frames meanwhile. */
async function until(test: () => unknown, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (test()) return;
    await frame();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const key = (kit: HTMLElement, k: string): HTMLElement | null =>
  kit.querySelector<HTMLElement>(`[data-key="${k}"]`);
const press = (el: HTMLElement | null): void => {
  if (!el) throw new Error("nothing to press");
  el.focus();
  el.click();
};
const keydown = (el: Element, k: string): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
};
const code = (c: string, reason = "opened") => ({
  code: c,
  qr: "PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y",
  reason,
  expiresAt: NOW + 300,
  failures: 0,
});
const pairingNode = (d: Kit.LocalLinksLike): ReactNode => (
  <Kit.LocalPairing
    driver={d}
    categories={["crates", "cues"]}
    categoryLabels={{ crates: "Crates", cues: "Cue points" }}
    fill
    theme={{ product: PRODUCT, colorScheme: "dark" }}
  />
);
const devicesNode = (d: Kit.LocalLinksLike): ReactNode => (
  <Kit.PairedDevices
    driver={d}
    fill
    theme={{ product: PRODUCT, colorScheme: "dark" }}
  />
);

/** The shower's screen with its first code up, at a window size. */
async function showing(width: number, height: number) {
  await page.viewport(width, height);
  const f = fakeDriver();
  const kit = await mountNode(pairingNode(f.driver));
  press(key(kit, "localPairing.show"));
  await until(() => f.seen.pair, "the window");
  f.seen.pair!.onCode(code("4812 3456"));
  await until(() => key(kit, "a11y.linkCode"), "the code");
  return { f, kit };
}

describe("focus and what is announced", () => {
  it("after Show a new code removes the notice, focus lands on the code", async () => {
    const { f, kit } = await showing(1280, 800);
    f.seen.pair!.onCode(code("4873 0691", "wrong-code"));
    await until(() => key(kit, "localPairing.showNew"), "the notice");
    press(key(kit, "localPairing.showNew"));
    await until(() => !key(kit, "localPairing.showNew"), "the notice to go");
    await until(
      () => document.activeElement === key(kit, "a11y.linkCode"),
      "focus on the code",
    );
    expect(document.activeElement?.getAttribute("aria-label")).toContain(
      "5 5 1 2",
    );
  });

  it("the joiner's late answers are told by a status region that was already there", async () => {
    await page.viewport(1280, 800);
    const f = fakeDriver();
    const kit = await mountNode(pairingNode(f.driver));
    press(key(kit, "localPairing.enter"));
    await until(() => kit.querySelector("input"), "the field");
    const regions = kit.querySelectorAll('[role="status"]').length;
    expect(regions).toBeGreaterThan(0);
    const input = kit.querySelector("input")!;
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    set.call(input, "48123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    f.next.join = async () => {
      throw Object.assign(new Error("x"), { code: "pairing-not-found" });
    };
    await until(
      () =>
        key(kit, "localPairing.pair")?.getAttribute("aria-disabled") !== "true",
      "Pair",
    );
    press(key(kit, "localPairing.pair"));
    await until(
      () =>
        [...kit.querySelectorAll('[role="status"]')].some((n) =>
          /find the other device/.test(n.textContent ?? ""),
        ),
      "the answer in a status region",
    );
  });
});

describe("the paired list's menu", () => {
  it("is a menu: focus goes in, the arrows move, Escape returns to the button", async () => {
    await page.viewport(900, 700);
    const kit = await mountNode(
      devicesNode(fakeDriver([link("a"), link("b")]).driver),
    );
    await until(() => kit.querySelector("[data-row]"), "the rows");
    const more = kit.querySelector<HTMLElement>('[data-row="a"] .pair-more')!;
    press(more);
    const rename = key(kit, "devices.rename")!;
    await until(() => document.activeElement === rename, "focus in the menu");
    keydown(rename, "ArrowDown");
    expect(document.activeElement).toBe(
      kit.querySelector('[data-row="a"] [data-key="pairedDevices.forget"]'),
    );
    keydown(document.activeElement!, "Escape");
    expect(document.activeElement).toBe(more);
    await frame();
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("is never clipped at the bottom of a scrolling list: it opens upward there", async () => {
    await page.viewport(1440, 900);
    const rows = Array.from({ length: 32 }, (_, i) => link(`${i + 1}`, i < 8));
    const kit = await mountNode(devicesNode(fakeDriver(rows).driver));
    await until(() => kit.querySelector('[data-row="32"]'), "the rows");
    const list = kit.querySelector<HTMLElement>("[data-scroll]")!;
    list.scrollTop = list.scrollHeight;
    await frame();
    press(kit.querySelector('[data-row="32"] .pair-more'));
    await until(
      () =>
        !kit.querySelector<HTMLElement>('[data-row="32"] .pair-menu')!.hidden,
      "the menu",
    );
    await frame();
    const menu = kit
      .querySelector('[data-row="32"] .pair-menu')!
      .getBoundingClientRect();
    const box = list.getBoundingClientRect();
    expect(menu.top, "above the list's top").toBeGreaterThanOrEqual(
      box.top - 0.5,
    );
    expect(menu.bottom, "below the list's bottom").toBeLessThanOrEqual(
      box.bottom + 0.5,
    );
    expect(menu.bottom).toBeLessThanOrEqual(innerHeight);
  });

  it("the first row's menu opens downward", async () => {
    await page.viewport(1440, 900);
    const rows = Array.from({ length: 32 }, (_, i) => link(`${i + 1}`, i < 8));
    const kit = await mountNode(devicesNode(fakeDriver(rows).driver));
    await until(() => kit.querySelector('[data-row="1"]'), "the rows");
    press(kit.querySelector('[data-row="1"] .pair-more'));
    await until(
      () =>
        !kit.querySelector<HTMLElement>('[data-row="1"] .pair-menu')!.hidden,
      "the menu",
    );
    expect(
      kit.querySelector('[data-row="1"] .pair-menu')!.hasAttribute("data-up"),
    ).toBe(false);
  });

  it("a store that refuses a rename or a forget says so in the row", async () => {
    await page.viewport(900, 700);
    const f = fakeDriver([link("a"), link("b")]);
    f.next.rename = async () => {
      throw new Error("store");
    };
    f.next.remove = async () => {
      throw new Error("store");
    };
    const kit = await mountNode(devicesNode(f.driver));
    await until(() => kit.querySelector("[data-row]"), "the rows");
    press(kit.querySelector('[data-row="a"] .pair-more'));
    press(key(kit, "devices.rename"));
    await until(() => kit.querySelector("input"), "the rename field");
    press(key(kit, "common.save"));
    await until(() => key(kit, "devices.renameFailed"), "the failure line");
    expect(key(kit, "pairedDevices.renameEmpty")).toBeNull();
    // The text stays, and so does the person's place: the editor is still the row's.
    expect(kit.querySelector("input")!.value).toBe("Device a");
    expect(
      document.activeElement?.closest('[data-editing="rename"]'),
    ).not.toBeNull();
    press(key(kit, "common.cancel"));
    await until(
      () =>
        document.activeElement ===
        kit.querySelector('[data-row="a"] .pair-more'),
      "focus back on the row's button",
    );
    press(kit.querySelector('[data-row="b"] .pair-more'));
    press(
      kit.querySelector('[data-row="b"] [data-key="pairedDevices.forget"]'),
    );
    await until(() => key(kit, "pairedDevices.forgetConfirm"), "the question");
    press(
      kit.querySelector(
        '[data-editing="forget"] [data-key="pairedDevices.forget"]',
      ),
    );
    await until(
      () => key(kit, "pairedDevices.forgetFailed"),
      "the failure line",
    );
  });
});

// A short window keeps the way out of a notice in the first view: Cancel and the link share a row
// and, side by side, sit under the code, so a wrong-code notice does not push them below the fold.
describe("short windows after a notice", () => {
  for (const [width, height] of [
    [720, 420],
    [1280, 420],
  ] as const)
    it(`${width}x${height}: Cancel and Enter a code instead stay in view with the notice up`, async () => {
      const { f, kit } = await showing(width, height);
      f.seen.pair!.onCode(code("4873 0691", "wrong-code"));
      await until(() => key(kit, "localPairing.showNew"), "the notice");
      await frame();
      for (const k of [
        "common.cancel",
        "localPairing.toEnter",
        "localPairing.showNew",
      ])
        expect(
          key(kit, k)!.getBoundingClientRect().bottom,
          `${k} below the fold`,
        ).toBeLessThanOrEqual(innerHeight + 0.5);
    });

  it("1280x420: the field screen shows Pair whole", async () => {
    await page.viewport(1280, 420);
    const f = fakeDriver();
    const kit = await mountNode(pairingNode(f.driver));
    press(key(kit, "localPairing.enter"));
    await until(() => kit.querySelector("input"), "the field");
    await frame();
    const pair = key(kit, "localPairing.pair")!.getBoundingClientRect();
    expect(pair.bottom, "Pair is cut off").toBeLessThanOrEqual(
      innerHeight + 0.5,
    );
  });
});
