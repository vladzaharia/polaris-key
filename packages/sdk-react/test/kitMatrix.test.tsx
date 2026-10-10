// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall
//
// Every component row of conformance/corpus/v2/ui-matrix.json, drawn by its React kit component
// (plans/UK-02b.md §8), held to the same contract as the elements: the view is the row's (state,
// sorted copy keys, sorted actions, the Must not), a `hidden` row draws nothing, every key the view
// shows is on screen (as text, or as the accessible name it labels), every catalog `button` key is
// a control, every `title` key a heading, and the view's primary is the one filled control (DL4).

import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  Copy,
  viewOf,
  type ComponentName,
  type UiInput,
} from "@polaris-key/ui-core";
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";

import * as Kit from "../src/kit/index.js";

type Obj = Record<string, unknown>;
interface Row {
  name: string;
  input: Obj;
  expect: {
    component: string;
    state: string;
    copy: string[];
    actions?: string[];
  };
  mustNot?: { states?: string[] };
}

const REPO = join(import.meta.dirname, "..", "..", "..");
const matrix = JSON.parse(
  readFileSync(join(REPO, "conformance/corpus/v2/ui-matrix.json"), "utf8"),
) as Obj & { vocabulary: Obj & { defaults: Obj } };
const ROLE = Object.fromEntries(
  Object.entries(
    (
      JSON.parse(
        readFileSync(join(REPO, "packages/brand/kit-copy/en.json"), "utf8"),
      ) as { messages: Record<string, { role: string }> }
    ).messages,
  ).map(([k, v]) => [k, v.role]),
);
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
const en = new Copy({ tables: { en: KIT_COPY_EN } });

/** A member the input omits takes `vocabulary.defaults`; capabilities merge member by member. */
function withDefaults(input: Obj, defaults: Obj): UiInput {
  const out: Obj = { ...input };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((input[k] as Obj | undefined) ?? {}) };
    else if (!(k in input)) out[k] = v;
  }
  return out as UiInput;
}

/** The literal text of a message (its longest run outside `{…}`), to find it with any args. */
function literal(message: string): string {
  const runs = message
    .replace(/\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "\u0000")
    .split("\u0000");
  return runs.map((r) => r.trim()).sort((a, b) => b.length - a.length)[0] ?? "";
}

beforeAll(() => {
  // jsdom has no layout: an inert ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const COMPONENTS = Kit as unknown as Record<
  string,
  ((p: Kit.KitProps & { children?: ReactNode }) => ReactNode) | undefined
>;

for (const family of FAMILIES) {
  const rows = matrix[family] as Row[];
  describe(`react kit × ui-matrix.json ${family}`, () => {
    it.each(rows.map((r) => [r.name, r] as const))("%s", (_n, row) => {
      const component = row.expect.component as ComponentName;
      // A row without `elapsedMs` means the DL7 delay has passed.
      const input: UiInput = {
        elapsedMs: 60_000,
        ...withDefaults(row.input, matrix.vocabulary.defaults),
      };
      const view = viewOf(component, input);
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

      const Component = COMPONENTS[component]!;
      expect(Component, `${component} is exported`).toBeTypeOf("function");
      const { container } = render(
        <Component input={input}>
          <p data-app="">app</p>
        </Component>,
      );
      const root = container.querySelector<HTMLElement>(".pk-root");
      if (view.state === "hidden") {
        expect(root).toBeNull();
        return;
      }
      if (component === "PolarisKeyGate" && view.state === "licensed") {
        expect(root).toBeNull();
        expect(container.querySelector("[data-app]")).not.toBeNull();
        return;
      }
      expect(root, "a kit root").not.toBeNull();
      expect(root!.dataset.component).toBe(component);
      expect(root!.dataset.state).toBe(view.state);
      const shown = root!.textContent ?? "";
      const labels = [
        ...root!.querySelectorAll("[aria-label],[placeholder],[alt]"),
      ]
        .map((n) =>
          ["aria-label", "placeholder", "alt"]
            .map((a) => n.getAttribute(a) ?? "")
            .join(" "),
        )
        .join(" ");
      for (const key of view.copy) {
        const lit = literal(en.raw(key) ?? "");
        const keyed = root!.querySelector(`[data-key="${key}"]`);
        if (key.startsWith("a11y.")) {
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
            root!.querySelector(`button[data-key="${key}"]`),
            `${key} is a control`,
          ).not.toBeNull();
        if (role === "title" && keyed && component !== "GraceBanner")
          expect(
            keyed.closest("h1,h2,.callout-title,.label") !== null,
            `${key} is a heading`,
          ).toBe(true);
      }
      // DL4: at most one filled control, the primary of the view drawn (the gate draws Welcome,
      // StatusScreen or the grace banner for its state).
      const filled = [...root!.querySelectorAll('[data-variant="primary"]')];
      expect(filled.length).toBeLessThanOrEqual(1);
      const drawn =
        component === "PolarisKeyGate"
          ? (["Welcome", "StatusScreen", "GraceBanner"] as const).map(
              (c) => viewOf(c, input).decisions.primary,
            )
          : [];
      if (filled.length === 1)
        expect([view.decisions.primary, ...drawn]).toContain(
          filled[0]!.getAttribute("data-key"),
        );
      // The app renders under the grace banner, outside the kit root, so the kit's stylesheet
      // never reaches it.
      if (component === "PolarisKeyGate" && view.state === "grace")
        expect(root!.contains(container.querySelector("[data-app]"))).toBe(
          false,
        );
    });
  });
}
