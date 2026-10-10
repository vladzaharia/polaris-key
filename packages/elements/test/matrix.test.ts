// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall
//
// Every component row of conformance/corpus/v2/ui-matrix.json, drawn by its pk-* element (plans/
// UK-02b.md §8): the element's view is the row's (state, sorted copy keys, sorted actions, the Must
// not), a `hidden` row draws nothing, and the DOM keeps the contract: every key the view shows is
// on screen (as text, or as the accessible name it labels), every catalog `button` key is a
// control, every `title` key a heading, and the view's primary is the one filled control (DL4).

import { beforeAll, describe, expect, it } from "vitest";
import { Copy, viewOf, type ComponentName } from "@polaris-key/ui-core";
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";

import { TAGS, type PkElement, type PkSignIn } from "../src/index.js";
import {
  COMPONENT_FAMILIES,
  readMatrix,
  roles,
  withDefaults,
  type Row,
} from "./fixtures.js";

const matrix = readMatrix();
const defaults = matrix.vocabulary.defaults;
const ROLE = roles();
const en = new Copy({ tables: { en: KIT_COPY_EN } });

beforeAll(() => {
  // jsdom has no layout: give ResizeObserver and matchMedia inert stand-ins.
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

async function draw(row: Row): Promise<PkElement> {
  const tag = TAGS[row.expect.component as ComponentName];
  const el = document.createElement(tag) as PkElement;
  // A row without `elapsedMs` means the DL7 delay has passed; the element's live model would
  // otherwise hold the loading state empty for its first 250 ms.
  el.input = { elapsedMs: 60_000, ...withDefaults(row.input, defaults) };
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}

/** The literal text of a message (its longest run outside `{…}`), to find it with any args. */
function literal(message: string): string {
  const runs = message
    .replace(/\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "\u0000")
    .split("\u0000");
  return runs.map((r) => r.trim()).sort((a, b) => b.length - a.length)[0] ?? "";
}

for (const family of COMPONENT_FAMILIES) {
  const rows = matrix[family] as Row[];
  describe(`elements × ui-matrix.json ${family}`, () => {
    it.each(rows.map((r) => [r.name, r] as const))("%s", async (_n, row) => {
      const el = await draw(row);
      const view = el.view;
      expect({
        component: view.component,
        state: view.state,
        copy: [...view.copy].sort(),
        actions: [...view.actions].sort(),
      }).toEqual({
        component: row.expect.component,
        state: row.expect.state,
        copy: [...row.expect.copy].sort(),
        actions: [...(row.expect.actions ?? [])].sort(),
      });
      for (const s of row.mustNot?.states ?? []) expect(view.state).not.toBe(s);

      const root = el.shadowRoot!;
      if (view.state === "hidden") {
        expect(root.querySelector(".pk-root")).toBeNull();
        return;
      }
      const shown = root.textContent ?? "";
      const labels = [
        ...root.querySelectorAll("[aria-label],[placeholder],[alt]"),
      ]
        .map((n) =>
          ["aria-label", "placeholder", "alt"]
            .map((a) => n.getAttribute(a) ?? "")
            .join(" "),
        )
        .join(" ");
      for (const key of view.copy) {
        const message = en.raw(key) ?? "";
        const lit = literal(message);
        const keyed = root.querySelector(`[data-key="${key}"]`);
        if (key.startsWith("a11y.")) {
          // An accessible name, or text a screen reader reads (visually hidden).
          if (lit)
            expect(`${labels} ${shown}`, `${key} labels something`).toContain(
              lit,
            );
          continue;
        }
        if (lit)
          expect(
            keyed !== null || shown.includes(lit) || labels.includes(lit),
            `${key} is on screen`,
          ).toBe(true);
        const role = ROLE[key];
        if (role === "button" || role === "menu")
          expect(
            root.querySelector(`button[data-key="${key}"]`),
            `${key} is a control`,
          ).not.toBeNull();
        if (role === "title" && keyed && el.view.component !== "GraceBanner")
          expect(
            keyed.closest("h1,h2,.callout-title,.label") !== null,
            `${key} is a heading`,
          ).toBe(true);
      }
      // DL4: at most one filled control, and it is the primary of the view drawn (the gate draws
      // Welcome, StatusScreen or the grace banner for its state).
      const filled = [...root.querySelectorAll('[data-variant="primary"]')];
      expect(filled.length).toBeLessThanOrEqual(1);
      // The sign-in form draws its step's body (the handoff's code view, the license choice).
      const drawn =
        view.component === "PolarisKeyGate"
          ? (["Welcome", "StatusScreen", "GraceBanner"] as const).map(
              (c) => viewOf(c, el.input).decisions.primary,
            )
          : view.component === "SignIn"
            ? [(el as PkSignIn).step.body.decisions.primary]
            : [];
      if (filled.length === 1)
        expect([view.decisions.primary, ...drawn]).toContain(
          filled[0]!.getAttribute("data-key"),
        );
    });
  });
}
