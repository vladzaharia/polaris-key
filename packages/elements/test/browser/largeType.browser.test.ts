// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall
//
// Large text in real Chromium (the React kit's "main action in the first viewport" rule): every
// component state of ui-matrix.json at 200 % text, a 24 px root and 200 % zoom, on phone and
// desktop windows, in dark and light. At rest (scrolled to the top) the primary and the h1 are
// fully inside the window, nothing scrolls sideways, and a docked bar never covers readable text.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/elements.<component>.<state>/lt-<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import type { ComponentName, UiInput } from "@polaris-key/ui-core";
import matrix from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };

import { axeViolations, fixtureTheme, isHolderScreen } from "./support.js";
import { TAGS, type PkElement } from "../../src/index.js";
import { LAYOUTS } from "../../src/contract.js";

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
  "holders",
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
      if (f === "holders" && !isHolderScreen(r)) continue;
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

/** Large-text rows: [label, width, height, root font px]. 200 % of 16 px is 32 px. */
const SIZES = [
  { label: "390-200pct", width: 390, height: 844, rootPx: 32 },
  { label: "320-font24", width: 320, height: 640, rootPx: 24 },
  { label: "390-font24", width: 390, height: 844, rootPx: 24 },
  { label: "844x390-font24", width: 844, height: 390, rootPx: 24 },
  { label: "1280x800-zoom200", width: 640, height: 400, rootPx: 16 },
  { label: "1440-200pct", width: 1440, height: 900, rootPx: 32 },
] as const;
const SCHEMES = ["dark", "light"] as const;

beforeAll(async () => {
  fixtureTheme(__PKEY_FONTS__);
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.fontSize = "";
  window.scrollTo(0, 0);
});

async function mount(
  row: Row,
  scheme: "dark" | "light",
  height: number,
): Promise<PkElement> {
  const tag = TAGS[row.expect.component as ComponentName];
  const el = document.createElement(tag) as PkElement;
  el.colorScheme = scheme;
  el.fill =
    (LAYOUTS as Record<string, { kind: string }>)[row.expect.component]
      ?.kind === "screen";
  el.input = { elapsedMs: 60_000, ...withDefaults(row.input), ...extras(row) };
  el.style.minBlockSize = `${height}px`;
  el.style.display = "grid";
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#060912" : "#f6f8ff";
  document.body.replaceChildren(el);
  await el.updateComplete;
  await document.fonts.ready;
  for (let i = 0; i < 3; i++)
    await new Promise((r) => requestAnimationFrame(r));
  await el.updateComplete;
  await Promise.all(
    el
      .shadowRoot!.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
  return el;
}

/** The part is whole inside the window at scroll 0 (null when it is, else what is wrong). */
function outside(node: Element | null, w: number, h: number): string | null {
  if (!node) return null;
  const r = node.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return r.top >= -1 && r.bottom <= h + 1 && r.left >= -1 && r.right <= w + 1
    ? null
    : `${node.tagName.toLowerCase()} ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)} in ${w}x${h}`;
}

describe("large text keeps the main action in the first viewport (DL1, DL3)", () => {
  for (const size of SIZES)
    for (const scheme of SCHEMES)
      it.each(
        SCENES.map(
          (r) => [`${r.expect.component}.${r.expect.state}`, r] as const,
        ),
      )(`%s at ${size.label} ${scheme}`, async (id, row) => {
        document.documentElement.style.fontSize = `${size.rootPx}px`;
        await page.viewport(size.width, size.height);
        const el = await mount(row, scheme, size.height);
        const sr = el.shadowRoot!;
        expect(sr.querySelector(".pk-root")).not.toBeNull();
        expect(
          document.documentElement.scrollWidth,
          "no sideways scroll",
        ).toBeLessThanOrEqual(size.width);
        const problems = [
          outside(sr.querySelector("h1"), size.width, size.height),
          outside(
            sr.querySelector('[data-part="primary"]'),
            size.width,
            size.height,
          ),
        ].filter(Boolean);
        if (__PKEY_KIT_SHOTS__)
          await commands.kitShot(
            `${__PKEY_KIT_SHOTS__}/elements.${id}/lt-${size.label}-${scheme}.png`,
          );
        expect(
          problems.join("; "),
          "title and primary in the first viewport",
        ).toBe("");
        // A docked bar never covers readable text once the window is scrolled to its end.
        const bar = sr.querySelector('[data-part="actions"]');
        if (bar && getComputedStyle(bar).position !== "static") {
          window.scrollTo(0, document.documentElement.scrollHeight);
          // A sheet is a dialog that scrolls inside itself.
          const sheet = sr.querySelector("dialog.sheet");
          if (sheet) sheet.scrollTop = sheet.scrollHeight;
          await new Promise((r) => requestAnimationFrame(r));
          const b = bar.getBoundingClientRect();
          for (const n of sr.querySelectorAll(
            'h1, [data-part="texts"] p, [data-part="device-list"], [data-part="links"]',
          )) {
            const r = n.getBoundingClientRect();
            expect(
              r.left < b.right &&
                r.right > b.left &&
                r.top < b.bottom &&
                r.bottom > b.top,
              `${n.tagName.toLowerCase()} ${Math.round(r.top)}..${Math.round(r.bottom)} under the bar ${Math.round(b.top)}..${Math.round(b.bottom)} at the end`,
            ).toBe(false);
          }
        }
        expect(await axeViolations(el)).toEqual([]);
      });
});
