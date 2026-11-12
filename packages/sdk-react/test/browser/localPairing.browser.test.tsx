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
import { commands, page, userEvent } from "vitest/browser";
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
  notApplicable?: { sdks: string[] };
}
type Scheme = "dark" | "light";
const SCHEMES: readonly Scheme[] = ["dark", "light"];
const matrix = matrixJson as unknown as {
  vocabulary: { defaults: Record<string, unknown> };
  local: Row[];
};
const ROWS = matrix.local.filter(
  (r) =>
    r.expect.state !== "hidden" && !r.notApplicable?.sdks.includes("react"),
);
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
  while (!stage.host.querySelector(".pk-root")) await frame();
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

// UI-KITS 4.3, LocalPairing: one centred column at every size, the digits or the QR and never both;
// a window under 480 tall drops the kit's logo and the column scrolls, with the notice before the QR.
describe("the show screen's window rule", () => {
  const find = (part: string): Row => ROWS.find((r) => r.name.includes(part))!;
  const SHOW = "the code is the largest";
  const SHOW_QR = "the QR alone";
  const noLogo = (kit: HTMLElement): void =>
    expect(
      drawn(kit.querySelector('[data-part="header"]')),
      "the logo shows",
    ).toBeNull();
  const CASES = [
    { label: "1280x800", width: 1280, height: 800, rootPx: 16 },
    { label: "600x700", width: 600, height: 700, rootPx: 16 },
    { label: "599x700", width: 599, height: 700, rootPx: 16 },
    { label: "1100x800@200", width: 1100, height: 800, rootPx: 32 },
  ];
  for (const c of CASES)
    for (const scheme of SCHEMES)
      it(`${c.label} ${scheme}: one column, one method`, async () => {
        await page.viewport(c.width, c.height);
        const code = await mount(find(SHOW), scheme, c.rootPx);
        expect(columns(code.querySelector(".pair-show"))).toBe(1);
        expect(code.querySelector(".qr"), "no QR in the code view").toBeNull();
        expect(code.querySelector('[data-key="a11y.linkCode"]')).not.toBeNull();
        noSideways();
        // The reading order: the code, the waiting row, then Cancel and the one quiet link.
        const order = [
          "a11y.linkCode",
          "localPairing.waitingDevice",
          "common.cancel",
          "localPairing.toQr",
        ];
        const all = [...code.querySelectorAll("*")];
        const at = order.map((k) =>
          all.findIndex((e) => e.getAttribute("data-key") === k),
        );
        expect(at).toEqual([...at].sort((x, y) => x - y));
        expect(at.every((i) => i >= 0)).toBe(true);
        await shoot("window.show", `${c.label}-${scheme}`);

        const qr = await mount(find(SHOW_QR), scheme, c.rootPx);
        expect(columns(qr.querySelector(".pair-show"))).toBe(1);
        expect(
          qr.querySelector('[data-key="a11y.linkCode"]'),
          "no digits in the QR view",
        ).toBeNull();
        await until(() => qr.querySelector(".qr canvas, .qr svg"), "the QR");
        const box = qr.querySelector(".qr")!.getBoundingClientRect();
        const wait = qr
          .querySelector('[data-key="localPairing.waitingDevice"]')!
          .getBoundingClientRect();
        expect(
          wait.top,
          "the waiting row is under the QR",
        ).toBeGreaterThanOrEqual(box.bottom - 0.5);
        // Centred in its column.
        const col = qr.querySelector(".pair-show")!.getBoundingClientRect();
        expect(
          Math.abs(box.left + box.width / 2 - (col.left + col.width / 2)),
        ).toBeLessThanOrEqual(2);
        noSideways();
        await shoot("window.show-qr", `${c.label}-${scheme}`);
      });

  for (const scheme of SCHEMES)
    it(`720x420 ${scheme}: no logo, one column that scrolls`, async () => {
      await page.viewport(720, 420);
      const kit = await mount(find(SHOW), scheme, 16);
      noLogo(kit);
      expect(columns(kit.querySelector(".pair-show"))).toBe(1);
      noSideways();
      expect(await axeFindings(kit)).toEqual([]);
      await shoot("window.show", `720x420-${scheme}`);
    });

  for (const scheme of SCHEMES)
    it(`390x420 ${scheme}: one column that scrolls, the notice before the QR`, async () => {
      await page.viewport(390, 420);
      const kit = await mount(find("pairing is being blocked"), scheme, 16);
      noLogo(kit);
      expect(columns(kit.querySelector(".pair-show"))).toBe(1);
      const notice = kit.querySelector(".pair-notice")!.getBoundingClientRect();
      expect(notice.bottom, "the notice is above the QR").toBeLessThanOrEqual(
        kit.querySelector(".qr")!.getBoundingClientRect().top + 0.5,
      );
      noSideways();
      expect(await axeFindings(kit)).toEqual([]);
      await shoot("window.show-qr", `390x420-${scheme}`);
    });

  it("a wrong code is told by a live region that is in the page before it", async () => {
    await page.viewport(390, 844);
    const kit = await mount(find("a wrong code changed it"), "dark", 16);
    const said = kit.querySelector('[role="status"] [data-key="a11y.newCode"]');
    expect(said?.textContent).toContain("4 8 1 2");
    expect(
      kit
        .querySelector('[data-key="localPairing.showNew"]')
        ?.closest('[role="status"]'),
    ).toBeNull();
  });

  it("a TV is one column too", async () => {
    await page.viewport(900, 540);
    const kit = await mount(find(SHOW), "dark", 16, {
      platform: { os: "android", formFactor: "tv" },
    });
    expect(columns(kit.querySelector(".pair-show"))).toBe(1);
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
  /** How often the window was opened and renewed. */
  const calls = { pair: 0, renew: 0 };
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
      calls.pair++;
      return {
        open: true,
        stop: async () => undefined,
        renew: async () => (
          calls.renew++,
          {
            code: "5512 0000",
            qr: "PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y",
            reason: "opened",
            expiresAt: NOW + 300,
            failures: 0,
          }
        ),
        code: () => null,
      };
    },
    join: (o) => {
      seen.join = o;
      return next.join();
    },
  };
  return { driver, seen, next, calls };
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
const devicesNode = (
  d: Kit.LocalLinksLike,
  over: Partial<Kit.PairedDevicesProps> = {},
): ReactNode => (
  <Kit.PairedDevices
    driver={d}
    fill
    theme={{ product: PRODUCT, colorScheme: "dark" }}
    {...over}
  />
);

/** A 900 x 700 window with the list of devices `a`, `b` drawn and read. */
async function listed(over: Partial<Kit.PairedDevicesProps> = {}) {
  await page.viewport(900, 700);
  const driver = fakeDriver([link("a"), link("b")]).driver;
  const kit = await mountNode(devicesNode(driver, over));
  await until(() => kit.querySelector("[data-row]"), "the rows");
  return { kit, driver };
}

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

describe("the code and the QR are two views of one window", () => {
  const heading = (kit: HTMLElement) =>
    kit.querySelector<HTMLElement>('[data-part="title"]')!;
  const digits = (kit: HTMLElement) =>
    key(kit, "a11y.linkCode")?.getAttribute("aria-label") ?? null;

  it("shows the digits alone, then the QR alone, in the same window", async () => {
    const { f, kit } = await showing(1280, 800);
    expect(kit.querySelector(".qr"), "no QR with the digits").toBeNull();
    expect(key(kit, "localPairing.toEnter")).toBeNull();
    const before = digits(kit);
    const opened = f.seen.pair;
    press(key(kit, "localPairing.toQr"));
    await until(() => key(kit, "localPairing.toCode"), "the QR view");
    expect(digits(kit), "no digits with the QR").toBeNull();
    await until(() => kit.querySelector(".qr canvas, .qr svg"), "the QR");
    expect(key(kit, "localPairing.toQr")).toBeNull();
    expect(f.seen.pair, "the same window").toBe(opened);
    press(key(kit, "localPairing.toCode"));
    await until(() => key(kit, "a11y.linkCode"), "the code view");
    expect(digits(kit), "the same code").toBe(before);
    expect(kit.querySelector(".qr")).toBeNull();
    expect(f.calls).toEqual({ pair: 1, renew: 0 });
  });

  it("moves focus to the new view's heading and says the new view politely", async () => {
    const { kit } = await showing(1280, 800);
    press(key(kit, "localPairing.toQr"));
    await until(() => key(kit, "localPairing.toCode"), "the QR view");
    await until(
      () => document.activeElement === heading(kit),
      "focus on the QR view's heading",
    );
    expect(heading(kit).getAttribute("data-key")).toBe("localPairing.qrTitle");
    const note = [...kit.querySelectorAll('[role="status"]')].find((e) =>
      e.textContent?.includes("camera"),
    );
    await until(
      () =>
        [...kit.querySelectorAll('[role="status"]')].some((e) =>
          e.textContent?.includes("camera"),
        ),
      "the announcement",
    );
    void note;
    expect(
      document.activeElement?.getAttribute("data-key"),
      "the link is not the default action",
    ).not.toBe("localPairing.toCode");
    press(key(kit, "localPairing.toCode"));
    await until(() => key(kit, "a11y.linkCode"), "the code view");
    await until(
      () => document.activeElement === heading(kit),
      "focus on the code view's heading",
    );
    expect(heading(kit).getAttribute("data-key")).toBe("localPairing.title");
  });

  it("a renewal while the QR is open updates the QR view and keeps it", async () => {
    const { f, kit } = await showing(1280, 800);
    press(key(kit, "localPairing.toQr"));
    await until(() => key(kit, "localPairing.toCode"), "the QR view");
    f.seen.pair!.onCode(code("4873 0691", "wrong-code"));
    await frame();
    await frame();
    expect(key(kit, "localPairing.toCode"), "still the QR view").not.toBeNull();
    expect(digits(kit), "still no digits").toBeNull();
    press(key(kit, "localPairing.toCode"));
    await until(() => key(kit, "a11y.linkCode"), "the code view");
    expect(digits(kit)).toContain("4 8 7 3");
  });
});

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

describe("the rename field and a device's answer", () => {
  it("Enter saves a rename, closes it and leaves focus on the button with the menu closed", async () => {
    const { kit } = await listed();
    press(kit.querySelector('[data-row="a"] .pair-more'));
    press(key(kit, "devices.rename"));
    await until(() => kit.querySelector("input"), "the rename field");
    const field = kit.querySelector("input")!;
    await until(() => document.activeElement === field, "focus in the field");
    await userEvent.fill(field, "Studio Mac");
    // A real Enter: its keypress follows the keydown, and lands wherever focus has moved to.
    await userEvent.keyboard("{Enter}");
    await until(() => !kit.querySelector("input"), "the field to close");
    // The row was redrawn, so the button is a new element: look it up again.
    const button = (): HTMLElement =>
      kit.querySelector<HTMLElement>('[data-row="a"] .pair-more')!;
    await until(() => document.activeElement === button(), "focus on button");
    await frame();
    await frame();
    expect(document.activeElement).toBe(button());
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(
      kit.querySelector<HTMLElement>('[data-row="a"] .pair-menu')!.hidden,
    ).toBe(true);
  });

  it("Try again on a device's answer puts focus on that device's button", async () => {
    let retried = "";
    const { kit } = await listed({
      notice: { kind: "busy", id: "b", device: "Device b" },
      onRetry: (id) => {
        retried = id;
      },
    });
    press(key(kit, "common.tryAgain"));
    await until(
      () =>
        document.activeElement ===
        kit.querySelector('[data-row="b"] .pair-more'),
      "focus on the device's button",
    );
    expect(retried).toBe("b");
  });

  it("a host's answer is told by the status region that was already there", async () => {
    const { kit, driver } = await listed();
    const before = [...kit.querySelectorAll('[role="status"]')];
    stage.root!.render(
      devicesNode(driver, {
        notice: { kind: "busy", id: "a", device: "Device a" },
      }),
    );
    await until(
      () =>
        before.some(
          (n) => n.isConnected && /is busy/.test(n.textContent ?? ""),
        ),
      "the answer in a status region that was there before",
    );
  });
});

describe("the opening step and the announcements", () => {
  it("the opening step holds the show layout: the card does not jump when the code arrives", async () => {
    for (const [w, h] of [
      [1280, 800],
      [390, 844],
    ] as const) {
      await page.viewport(w, h);
      const f = fakeDriver();
      const kit = await mountNode(pairingNode(f.driver));
      press(key(kit, "localPairing.show"));
      await until(() => f.seen.pair, "the window");
      await frame();
      const card = (): number =>
        kit.querySelector<HTMLElement>(".card")!.getBoundingClientRect().height;
      const opening = card();
      const dump = (): string =>
        [...kit.querySelector(".pair-show")!.children]
          .map(
            (e) =>
              `${e.className}:${Math.round(e.getBoundingClientRect().height)}`,
          )
          .join(" ");
      const d0 = dump();
      f.seen.pair!.onCode(code("4812 3456"));
      await until(() => key(kit, "a11y.linkCode"), "the code");
      await frame();
      expect(
        Math.abs(card() - opening),
        `${w}x${h} ${d0} -> ${dump()}`,
      ).toBeLessThanOrEqual(1.5);
    }
  });

  it("a notice is announced as sentences, never a doubled full stop", async () => {
    const { f, kit } = await showing(1280, 800);
    f.seen.pair!.onCode(code("4873 0691", "wrong-code"));
    await until(() => key(kit, "localPairing.showNew"), "the notice");
    const said = [...kit.querySelectorAll('[role="status"]')]
      .map((n) => n.textContent ?? "")
      .find((t) => /New code/.test(t));
    expect(said).toBeDefined();
    expect(said).not.toMatch(/\.\./);
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

// A short window is one column that scrolls; the field screen still shows Pair whole.
describe("short windows", () => {
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
