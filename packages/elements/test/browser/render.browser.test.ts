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
import axe from "axe-core";
import type { ComponentName, UiInput } from "@polaris-key/ui-core";
import matrix from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };

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

/** The fixture product's icon (the waves of Tidewater Studio), as an image the page can load. */
const ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#0f3b45"/><circle cx="66" cy="28" r="9" fill="#f7c873"/><path d="M8 58q10-10 20 0t20 0 20 0 20 0" stroke="#5be0c8" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M8 74q10-10 20 0t20 0 20 0 20 0" stroke="#7fb8b0" stroke-width="7" fill="none" stroke-linecap="round"/></svg>`,
)}`;

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

beforeAll(async () => {
  PolarisKey.fonts(__PKEY_FONTS__);
  PolarisKey.theme({
    product: {
      name: "Tidewater Studio",
      developer: "Harbor Audio",
      accent: "#369186",
    },
    iconSrc: ICON,
  });
  document.body.style.margin = "0";
});

afterEach(() => {
  document.body.replaceChildren();
});

async function mount(
  row: Row,
  scheme: "dark" | "light",
  height: number,
): Promise<PkElement> {
  const tag = TAGS[row.expect.component as ComponentName];
  const el = document.createElement(tag) as PkElement;
  el.colorScheme = scheme;
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

async function axeViolations(
  el: Element,
  skip: string[] = [],
): Promise<string[]> {
  const result = await axe.run(el as unknown as axe.ElementContext, {
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
    },
    rules: Object.fromEntries(skip.map((r) => [r, { enabled: false }])),
  });
  return result.violations.flatMap((v) =>
    v.nodes.map(
      (n) => `${v.id}: ${n.target.join(" ")} ${n.failureSummary ?? ""}`,
    ),
  );
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

describe("keyboard (DL9)", () => {
  it("Welcome focuses its primary on appear; a key press shows the ring, Tab moves on", async () => {
    await page.viewport(1440, 900);
    const welcome = SCENES.find((r) => r.expect.component === "Welcome")!;
    const el = await mount(welcome, "dark", 900);
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
    const el = await mount(welcome, "dark", 900);
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
