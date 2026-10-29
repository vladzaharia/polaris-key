// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall
//
// The elements in real Chromium: one render of every component state of ui-matrix.json (the first
// row that reaches it), at the phone (390 × 844) and desktop (1440 × 900) rows in dark and light,
// with the fixture product (Tidewater Studio, teal, by Harbor Audio). Every render: axe (WCAG 2.x
// A and AA) finds nothing, no sideways scroll, the title and the primary inside the first
// viewport. Then the keyboard path (DL9) and forced colours.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/elements.<component>.<state>/<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import type { ComponentName, UiInput } from "@polaris-key/ui-core";
import matrix from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };

import { axeViolations, fixtureTheme, ICON } from "./support.js";
import {
  PolarisKey,
  TAGS,
  type PkElement,
  type PkSignIn,
} from "../../src/index.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
    emulateScheme: (scheme: "dark" | "light" | null) => Promise<void>;
    emulateForced: (forced: "active" | null) => Promise<void>;
    emulateMotion: (motion: "reduce" | null) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_FONTS__: string;

type Row = {
  name: string;
  input: Record<string, unknown>;
  expect: { component: string; state: string };
};

const FAMILIES = [
  "gate",
  "activate",
  "signIn",
  "deviceLimit",
  "devices",
  "update",
  "settings",
  "paywall",
  "cloudSync",
] as const;

const defaults = (
  matrix as unknown as { vocabulary: { defaults: Record<string, unknown> } }
).vocabulary.defaults;

function withDefaults(input: Record<string, unknown>): UiInput {
  const out: Record<string, unknown> = { ...input };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "capabilities")
      out[k] = {
        ...(v as object),
        ...((input[k] as object | undefined) ?? {}),
      };
    else if (!(k in input)) out[k] = v;
  }
  // The runner plays a host that can renew: the corpus lists Renew on the expired row, and a kit
  // draws it only for such a host (SwiftUI `renewURL`, Compose `onRenew`).
  if (!("renew" in out)) out["renew"] = { url: "https://example.com/renew" };
  return out as UiInput;
}

/** The first row of each component state, not hidden: the states the baselines cover. */
const SCENES: Row[] = (() => {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const f of FAMILIES)
    for (const r of (matrix as unknown as Record<string, Row[]>)[f]!) {
      const id = `${r.expect.component}.${r.expect.state}`;
      if (r.expect.state === "hidden" || seen.has(id)) continue;
      seen.add(id);
      out.push(r);
    }
  return out;
})();

/** Extras a render needs that a row's input leaves to the SDK (the served user code). */
function extras(row: Row): Partial<UiInput> {
  const dc = row.input.deviceCode as Record<string, unknown> | undefined;
  return dc
    ? {
        deviceCode: {
          ...(dc as object),
          userCode: "WDJB-MJHT",
        } as UiInput["deviceCode"],
      }
    : {};
}

const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "1440", width: 1440, height: 900 },
] as const;
const SCHEMES = ["dark", "light"] as const;

/** The recovery code the host hands RecoveryCode: a property, never in the input (U-42.2). */
const RECOVERY_CODE = "K7QF-2M9D-XR4T-8WHB-3JNC-6PEZ-V5GD-HT0S";

beforeAll(async () => {
  fixtureTheme(__PKEY_FONTS__);
});

afterEach(() => {
  document.body.replaceChildren();
});

async function mount(
  row: Row,
  scheme: "dark" | "light",
  height: number,
  fill = false,
): Promise<PkElement> {
  const tag = TAGS[row.expect.component as ComponentName];
  const el = document.createElement(tag) as PkElement;
  el.colorScheme = scheme;
  // A screen that owns the window (the React kit's `fill`) takes focus on a cold start (DL9).
  el.fill = fill;
  // The recovery code reaches RecoveryCode as a property, never in the input (U-42.2).
  if (row.expect.component === "RecoveryCode") el.code = RECOVERY_CODE;
  el.handles = "unlock review use-code";
  el.input = { elapsedMs: 60_000, ...withDefaults(row.input), ...extras(row) };
  el.style.minBlockSize = `${height}px`;
  el.style.display = "grid";
  document.body.style.background = scheme === "dark" ? "#060912" : "#f6f8ff";
  document.body.replaceChildren(el);
  await el.updateComplete;
  await document.fonts.ready;
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  await el.updateComplete;
  // The step's enter (§4.8) settles before anything is measured; the shimmer loops by design.
  await Promise.all(
    el
      .shadowRoot!.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
  return el;
}

describe("every component state, rendered", () => {
  for (const size of SIZES)
    for (const scheme of SCHEMES)
      it.each(
        SCENES.map(
          (r) => [`${r.expect.component}.${r.expect.state}`, r] as const,
        ),
      )(`%s at ${size.label} ${scheme}`, async (id, row) => {
        await page.viewport(size.width, size.height);
        const el = await mount(row, scheme, size.height);
        expect(el.shadowRoot!.querySelector(".pk-root")).not.toBeNull();
        // No sideways scroll (§7.1, DL15).
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          size.width,
        );
        // DL1: the title and the primary in the first viewport.
        for (const sel of ["h1", '[data-part="primary"]']) {
          const node = el.shadowRoot!.querySelector(sel);
          if (!node) continue;
          const r = node.getBoundingClientRect();
          expect(r.bottom, `${sel} in the first viewport`).toBeLessThanOrEqual(
            size.height,
          );
        }
        expect(await axeViolations(el)).toEqual([]);
        if (__PKEY_KIT_SHOTS__)
          await commands.kitShot(
            `${__PKEY_KIT_SHOTS__}/elements.${id}/${size.label}-${scheme}.png`,
          );
      });
});

describe("a short window and large text (DL1, DL3)", () => {
  const ROWS = [
    ["Welcome", "default"],
    ["DeviceLimit", "default"],
    ["Activate", "empty"],
    ["StatusScreen", "revoked"],
  ] as const;
  const rect = (n: Element) => n.getBoundingClientRect();
  const overlaps = (a: DOMRect, b: DOMRect) =>
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top;
  /** The text a docked bar must never sit over once the window is scrolled to its end. */
  const readable = (el: PkElement) => [
    ...el.shadowRoot!.querySelectorAll(
      'h1, [data-part="texts"] p, [data-part="device-list"], [data-part="links"]',
    ),
  ];

  afterEach(() => {
    document.documentElement.style.fontSize = "";
    window.scrollTo(0, 0);
  });

  for (const [component, state] of ROWS) {
    const row = () =>
      SCENES.find(
        (r) => r.expect.component === component && r.expect.state === state,
      )!;

    it(`${component}.${state} at 844 x 390: two columns, the bar one row, nothing under it at the end`, async () => {
      await page.viewport(844, 390);
      const el = await mount(row(), "dark", 390);
      const root = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
      expect(root.dataset.shape).toBe("short");
      const bar = el.shadowRoot!.querySelector('[data-part="actions"]');
      if (bar) {
        // One row of buttons, not a column that takes the window.
        expect(rect(bar).height, "the bar's height").toBeLessThanOrEqual(
          390 * 0.4,
        );
        // The title is never under the bar, scrolled to the top.
        const h1 = el.shadowRoot!.querySelector("h1");
        if (h1) expect(overlaps(rect(h1), rect(bar))).toBe(false);
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((r) => requestAnimationFrame(r));
        for (const n of readable(el))
          expect(
            overlaps(rect(n), rect(bar)),
            `${n.tagName.toLowerCase()} under the bar at the end`,
          ).toBe(false);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(844);
      expect(await axeViolations(el)).toEqual([]);
      if (__PKEY_KIT_SHOTS__)
        await commands.kitShot(
          `${__PKEY_KIT_SHOTS__}/elements.${component}.${state}/844x390-dark.png`,
        );
    });

    for (const scheme of SCHEMES)
      it(`${component}.${state} at 390 with 200% text (${scheme}): the bar docks, and nothing is under it at the end`, async () => {
        document.documentElement.style.fontSize = "200%";
        await page.viewport(390, 844);
        const el = await mount(row(), scheme, 844);
        // The shape measure runs after the layout; give it a frame.
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        );
        await el.updateComplete;
        const root = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
        expect(root.hasAttribute("data-tight")).toBe(true);
        const bar = el.shadowRoot!.querySelector<HTMLElement>(
          '[data-part="actions"]',
        );
        if (bar) {
          expect(getComputedStyle(bar).position).toBe("sticky");
          window.scrollTo(0, document.documentElement.scrollHeight);
          await new Promise((r) => requestAnimationFrame(r));
          for (const n of readable(el))
            expect(
              overlaps(rect(n), rect(bar)),
              `${n.tagName.toLowerCase()} under the bar`,
            ).toBe(false);
        }
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
        expect(await axeViolations(el)).toEqual([]);
        if (__PKEY_KIT_SHOTS__)
          await commands.kitShot(
            `${__PKEY_KIT_SHOTS__}/elements.${component}.${state}/390-200pct-${scheme}.png`,
          );
      });
  }
});

describe("keyboard (DL9)", () => {
  it("Welcome focuses its primary on appear; a key press shows the ring, Tab moves on", async () => {
    await page.viewport(1440, 900);
    const welcome = SCENES.find((r) => r.expect.component === "Welcome")!;
    const el = await mount(welcome, "dark", 900, true);
    const primary = el.shadowRoot!.querySelector<HTMLElement>(
      '[data-part="primary"]',
    )!;
    expect(el.shadowRoot!.activeElement).toBe(primary);
    // No ring at rest on a cold start; the first key since load shows it.
    expect(getComputedStyle(primary).outlineStyle).toBe("none");
    await userEvent.keyboard("{Shift}");
    await el.updateComplete;
    expect(getComputedStyle(primary).outlineStyle).toBe("solid");
    await userEvent.keyboard("{Tab}");
    expect(el.shadowRoot!.activeElement).not.toBe(primary);
    expect(el.shadowRoot!.activeElement?.getAttribute("data-key")).toBe(
      "welcome.useKey",
    );
  });

  it("no ring at rest on a cold start (pointer first)", async () => {
    await page.viewport(1440, 900);
    const welcome = SCENES.find((r) => r.expect.component === "Welcome")!;
    const el = await mount(welcome, "dark", 900, true);
    const primary = el.shadowRoot!.querySelector<HTMLElement>(
      '[data-part="primary"]',
    )!;
    await userEvent.click(primary);
    expect(getComputedStyle(primary).outlineStyle).toBe("none");
  });
});

describe("forced colours", () => {
  afterEach(async () => {
    await commands.emulateForced(null);
  });
  it("keeps every control and the card's edge visible", async () => {
    await commands.emulateForced("active");
    await page.viewport(1440, 900);
    const status = SCENES.find((r) => r.expect.component === "StatusScreen")!;
    const el = await mount(status, "dark", 900);
    const card = el.shadowRoot!.querySelector<HTMLElement>(".card")!;
    expect(getComputedStyle(card).borderTopStyle).toBe("solid");
    // The blurred icon is decoration: it goes under forced colours.
    const art = [
      ...el.shadowRoot!.querySelectorAll(".ambient, .passport-ambient"),
    ];
    expect(art.length).toBeGreaterThan(0);
    for (const n of art) expect(getComputedStyle(n).display).toBe("none");
    // Under forced colours the OS's system colours set contrast; axe reads the author colours.
    expect(await axeViolations(el, ["color-contrast"])).toEqual([]);
    if (__PKEY_KIT_SHOTS__)
      await commands.kitShot(
        `${__PKEY_KIT_SHOTS__}/elements.forced-colors/1440-dark.png`,
      );
  });
});

describe("the sign-in form (SIGN-IN.md §3.17, §3.18)", () => {
  const signInRow = (name: string) =>
    (matrix as unknown as Record<string, Row[]>).signIn!.find(
      (r) => r.name === name,
    )!;
  const methods = () => ({
    elapsedMs: 60_000,
    ...withDefaults(signInRow("SignIn/methods: web").input),
  });
  const handoff = () => ({
    elapsedMs: 60_000,
    ...withDefaults(signInRow("SignIn/handoff: waiting for the browser").input),
  });

  afterEach(async () => {
    await commands.emulateMotion(null);
  });

  for (const size of SIZES)
    it(`sheet at ${size.label}: a modal dialog over an inert host; Escape closes it and focus returns to the opener`, async () => {
      await page.viewport(size.width, size.height);
      document.body.style.background = "#060912";
      const opener = document.createElement("button");
      opener.textContent = "Open";
      const el = document.createElement("pk-sign-in") as PkSignIn;
      el.presentation = "sheet";
      el.colorScheme = "dark";
      el.input = methods();
      document.body.replaceChildren(opener, el);
      opener.focus();
      el.open = true;
      await el.updateComplete;
      await document.fonts.ready;
      const dialog = el.shadowRoot!.querySelector("dialog")!;
      expect(dialog.open).toBe(true);
      expect(dialog.matches(":modal")).toBe(true);
      await Promise.all(
        el
          .shadowRoot!.getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      );
      // The sheet's title and primary are inside the viewport; a phone docks it to the bottom.
      const card = dialog.querySelector(".card")!.getBoundingClientRect();
      expect(card.bottom).toBeLessThanOrEqual(size.height + 1);
      if (size.width < 560) expect(Math.round(card.bottom)).toBe(size.height);
      expect(await axeViolations(el)).toEqual([]);
      if (__PKEY_KIT_SHOTS__)
        await commands.kitShot(
          `${__PKEY_KIT_SHOTS__}/elements.sign-in-sheet/${size.label}-dark.png`,
        );
      await userEvent.keyboard("{Escape}");
      await el.updateComplete;
      expect(dialog.open).toBe(false);
      expect(el.open).toBe(false);
      expect(document.activeElement).toBe(opener);
    });

  async function stepChange(): Promise<PkSignIn> {
    await page.viewport(1440, 900);
    const el = document.createElement("pk-sign-in") as PkSignIn;
    el.colorScheme = "dark";
    el.input = methods();
    document.body.replaceChildren(el);
    await el.updateComplete;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    el.input = handoff();
    await el.updateComplete;
    return el;
  }

  it("morphs between steps under full motion", async () => {
    const el = await stepChange();
    expect(el.view.state).toBe("handoff");
    const running = el
      .shadowRoot!.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity);
    expect(running.length).toBeGreaterThan(0);
  });

  it("swaps instantly under reduced motion (DL16)", async () => {
    await commands.emulateMotion("reduce");
    const el = await stepChange();
    expect(el.view.state).toBe("handoff");
    expect(el.shadowRoot!.getAnimations()).toEqual([]);
  });
});

describe("the recovery code (U-42.2)", () => {
  afterEach(() => {
    document.documentElement.style.fontSize = "";
  });
  const row = () =>
    SCENES.find(
      (r) => r.expect.component === "RecoveryCode" && r.expect.state === "show",
    )!;
  /** The code's groups, the number of rows they fall in, and whether any wraps inside itself. */
  const layoutOf = (el: PkElement) => {
    const g = [
      ...el.shadowRoot!.querySelectorAll<HTMLElement>(".recovery-groups .g"),
    ];
    const rects = g.map((n) => n.getBoundingClientRect());
    return {
      count: g.length,
      rows: new Set(rects.map((r) => Math.round(r.top))).size,
      wrapped: g.some(
        (n, i) =>
          rects[i]!.height > parseFloat(getComputedStyle(n).lineHeight) * 1.5,
      ),
    };
  };

  it("is eight groups of four, four to a row on a phone, and never breaks inside a group", async () => {
    await page.viewport(390, 844);
    const el = await mount(row(), "dark", 844);
    expect(layoutOf(el)).toEqual({ count: 8, rows: 2, wrapped: false });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  it("goes two to a row at large text, with no group broken and no sideways scroll", async () => {
    await page.viewport(390, 844);
    document.documentElement.style.fontSize = "200%";
    const el = await mount(row(), "light", 844);
    expect(layoutOf(el)).toEqual({ count: 8, rows: 4, wrapped: false });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  it("is an image with the code spelled out in Chromium's accessibility tree", async () => {
    await page.viewport(390, 844);
    await mount(row(), "dark", 844);
    const image = page.getByRole("img", { name: /Recovery code/ });
    await expect.element(image).toBeVisible();
    const label = (await image.element().getAttribute("aria-label")) ?? "";
    expect(label).toContain("K 7 Q F, 2 M 9 D, X R 4 T, 8 W H B");
  });

  it("every control on the three screens is at least 24 px", async () => {
    await page.viewport(390, 844);
    for (const [component, state] of [
      ["UnlockSync", "code"],
      ["UnlockSync", "no-code"],
      ["UnlockSync", "start-over"],
      ["RingChange", "failed"],
      ["RecoveryCode", "saved"],
      ["RingChange", "confirm"],
    ] as const) {
      const r = SCENES.find(
        (x) => x.expect.component === component && x.expect.state === state,
      )!;
      const el = await mount(r, "dark", 844);
      for (const c of el.shadowRoot!.querySelectorAll<HTMLElement>(
        "button, input, label.check-row",
      )) {
        const b = c.getBoundingClientRect();
        expect(
          b.width,
          `${component}.${state} ${c.tagName} width`,
        ).toBeGreaterThanOrEqual(24);
        expect(
          b.height,
          `${component}.${state} ${c.tagName} height`,
        ).toBeGreaterThanOrEqual(24);
      }
    }
  });

  it("UnlockSync focuses its field, the Start over warning focuses Cancel, RecoveryCode the heading", async () => {
    await page.viewport(1440, 900);
    const focused = async (c: string, s: string) => {
      const r = SCENES.find(
        (x) => x.expect.component === c && x.expect.state === s,
      )!;
      const el = await mount(r, "dark", 900, true);
      await new Promise((res) => setTimeout(res, 50));
      return el.shadowRoot!.activeElement as HTMLElement | null;
    };
    expect((await focused("UnlockSync", "code"))?.dataset.key).toBe(
      "unlockSync.field",
    );
    expect((await focused("UnlockSync", "start-over"))?.dataset.key).toBe(
      "common.cancel",
    );
    expect((await focused("RecoveryCode", "show"))?.tagName).toBe("H1");
  });
});
