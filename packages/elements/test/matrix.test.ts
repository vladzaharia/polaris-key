// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall
//
// Every component row of conformance/corpus/v2/ui-matrix.json, drawn by its pk-* element (plans/
// UK-02b.md §8): the element's view is the row's (state, sorted copy keys, sorted actions, the Must
// not), a `hidden` row draws nothing, and the DOM keeps the contract: every key the view shows is
// on screen (as text, or as the accessible name it labels), every catalog `button` key is a
// control, every `title` key a heading, and the view's primary is the one filled control (DL4).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Copy,
  viewOf,
  type ComponentName,
  type UiInput,
} from "@polaris-key/ui-core";
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";

import { LAYOUTS, TAGS, type PkElement, type PkSignIn } from "../src/index.js";
import { resetMissingWarnings } from "../src/render.js";
import {
  COMPONENT_FAMILIES,
  familyRows,
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

// Keys the kit leaves out on purpose (the review's terse-copy fixes): the lede that repeats the
// title, the product line under the header, a heading with nothing under it.
const LEFT_OUT = new Set([
  // No "or" divider over the sign-in methods (DL4) and no "Sign in…" link on the sign-in step.
  "signin.provider.group",
  "signin.menu.signIn",
  "devices.lede",
  "update.whatsNew",
]);

// Keys one state's drawing leaves out on purpose.
function leftOutFor(view: { component: string; state: string }, key: string) {
  // The Replace step confirms on its own button: its "Replace a device" openers are gone.
  if (
    (view.component === "LicenseChoice" && view.state === "replace-open") ||
    (view.component === "SignIn" && view.state === "replace")
  )
    return key === "signin.replace.open" || key === "signin.replace.openSystem";
  // Restart when ready queues the restart of a download in flight: an available update offers
  // Update now and Later (UI-KITS.md §4.1).
  if (view.component === "UpdatePrompt" && view.state === "available")
    return key === "update.restartWhenReady";
  return false;
}

// A key whose argument the corpus row leaves out is not drawn (never as `{name}`); the kit says so.
const dropped = new Set<string>();
const warn = vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
  const hit = /^\[pk\] (\S+) has no value/.exec(String(m));
  if (hit) dropped.add(hit[1]!);
});
afterEach(() => {
  dropped.clear();
  resetMissingWarnings();
});
void warn;

async function draw(row: Row): Promise<PkElement> {
  const tag = TAGS[row.expect.component as ComponentName];
  const el = document.createElement(tag) as PkElement;
  // A row without `elapsedMs` means the DL7 delay has passed; the element's live model would
  // otherwise hold the loading state empty for its first 250 ms.
  // The runner plays a host that answers the controls that open another screen.
  el.handles = "unlock review use-code";
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
  const rows = familyRows(matrix, family);
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
        if (LEFT_OUT.has(key) || leftOutFor(view, key)) continue;
        // The request QR encodes the request code: with none to encode, nothing is drawn.
        if (key === "a11y.qrRequest" && !el.input.offline?.requestCode) {
          expect(root.querySelector(`[data-key="${key}"]`)).toBeNull();
          continue;
        }
        if (dropped.has(key)) {
          expect(root.querySelector(`[data-key="${key}"]`)).toBeNull();
          continue;
        }
        const keyed = root.querySelector(`[data-key="${key}"]`);
        if (key.startsWith("a11y.") && !dropped.has(key)) {
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
        // A choice drawn as a radio row (keep, create) is not a button.
        const asRow = root.querySelector(`[role="radio"] [data-key="${key}"]`);
        // Add your name and email heads AddToAccount's form: its action there is the heading.
        // The sign-in form's attach step is the same screen.
        const heads =
          (view.component === ("AddToAccount" as string) ||
            (view.component === "SignIn" && view.state === "attach")) &&
          key === "activate.recommend.action";
        if ((role === "button" || role === "menu") && !asRow && !heads)
          expect(
            root.querySelector(`button[data-key="${key}"]`),
            `${key} is a control`,
          ).not.toBeNull();
        // A title key that labels the view's primary (Activate's Replace a device) is a control.
        if (
          role === "title" &&
          keyed &&
          el.view.component !== "GraceBanner" &&
          key !== view.decisions.primary
        )
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
        expect([
          view.decisions.primary,
          ...drawn,
          // The offline activation's one filled control is its own (Activate, or Done).
          ...(view.component === "OfflineActivation"
            ? ["offlineActivation.submit", "common.done"]
            : []),
          // The form's Done step always offers Start.
          ...(view.component === "SignIn" ? ["signin.done.start"] : []),
          ...(view.component === "Activate" ? ["common.done"] : []),
          // Working keeps the pressed control, busy, so focus stays on it.
          ...(view.component === "UnlockSync" ? ["unlockSync.unlock"] : []),
        ]).toContain(filled[0]!.getAttribute("data-key"));
      // DL4/DL6: a view with a primary draws it as the one filled control (a destructive
      // confirm's is the danger fill).
      if (
        view.decisions.primary !== null &&
        !dropped.has(view.decisions.primary) &&
        view.component !== "PolarisKeyGate" &&
        view.component !== "OfflineActivation" &&
        !(LAYOUTS[view.component].quiet ?? []).includes(view.decisions.primary)
      )
        expect(
          root.querySelector(
            `:is([data-variant="primary"],[data-variant="danger"])[data-key="${view.decisions.primary}"]`,
          ),
          `${view.decisions.primary} is the filled control`,
        ).not.toBeNull();
    });
  });
}
