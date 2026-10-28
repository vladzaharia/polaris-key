// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall ui.theme ui.i18n
//
// Every component row of conformance/corpus/v2/ui-matrix.json, drawn by its React kit component
// (plans/UK-02b.md §8), held to the same contract as the elements: the view is the row's (state,
// sorted copy keys, sorted actions, the Must not), a `hidden` row draws nothing, every key the view
// shows is on screen (as text, or as the accessible name it labels), every catalog `button` key is
// a control, every `title` key a heading, and the view's primary is the one filled control (DL4).

import { kitComponent } from "../src/kit/kitComponent.js";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Copy,
  viewOf,
  type ComponentName,
  type CopyTable,
  type UiInput,
} from "@polaris-key/ui-core";
import {
  resolveTheme,
  themeSummary,
  type ThemeContext,
  type ThemeOptions,
  type ThemeSummary,
} from "@polaris-key/ui-core/theme";
import {
  KIT_COPY_EN,
  KIT_COPY_LOCALES,
  loadKitCopy,
} from "@polaris-key/brand/kit-copy";

import { LAYOUTS, formStep } from "@polaris-key/elements/contract";

import * as Kit from "@polaris-key/react/kit";
import { DIRECT_COMPONENT_STATE_FIXTURES } from "./kitFixtures.js";

type Obj = Record<string, unknown>;
interface Row {
  name: string;
  input: UiInput;
  expect: {
    component: ComponentName;
    state: string;
    copy: string[];
    actions?: string[];
  };
  mustNot?: { states?: string[] };
}
interface ThemeRowInput {
  kit?: string;
  preset?: ThemeOptions["preset"];
  colorScheme?: ThemeOptions["colorScheme"];
  integrator?: ThemeOptions["product"];
  presentation?: ThemeContext["presentation"];
  bundle?: ThemeContext["bundle"];
  platform?: ThemeContext["platform"];
}
interface ThemeRow {
  name: string;
  input: ThemeRowInput;
  expect: ThemeSummary;
}
interface I18nRow {
  name: string;
  locale: string;
  key: string;
  args: Record<string, string | number>;
  overrides?: Record<string, Record<string, string>>;
  expect: string;
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
  "cloudSync",
] as const;
const en = new Copy({ tables: { en: KIT_COPY_EN } });

function withDefaults(input: UiInput, defaults: Obj): UiInput {
  const out: Obj = { ...input };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((out[k] as Obj | undefined) ?? {}) };
    else if (!(k in out)) out[k] = v;
  }
  // The runner plays a host that can renew: the corpus lists Renew on the expired row, and a kit
  // draws it only for such a host (SwiftUI `renewURL`, Compose `onRenew`).
  if (!("renew" in out)) out["renew"] = { url: "https://example.com/renew" };
  return out as UiInput;
}

/** Keys the kit leaves out on purpose: no "or" divider over the sign-in methods (DL4) and no
 *  "Sign in…" link on the sign-in step. */
const LEFT_OUT = new Set([
  "signin.provider.group",
  "signin.menu.signIn",
  // The pane's title says what the list is; the lede repeats it (the elements leave it out too).
  "devices.lede",
  // A heading with no notes under it.
  "update.whatsNew",
]);

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
// A key whose argument the corpus row leaves out is not drawn (never as `{name}`); the kit says so,
// once per key, so the set is kept for the file.
const dropped = new Set<string>();
vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
  const hit = /^\[pk\] (\S+) has no value/.exec(String(m));
  if (hit) dropped.add(hit[1]!);
});
afterEach(cleanup);

// NearbyApproval is not a public export (UXR-kits-v7 B4): the matrix draws the internal component.
// The Cloud Sync screens' public exports load on demand (U-42.2): the matrix draws the plain part
// they load, which draws at once.
const COMPONENTS = {
  ...Kit,
  NearbyApproval: kitComponent("NearbyApproval"),
  UnlockSync: kitComponent("UnlockSync"),
  RecoveryCode: kitComponent("RecoveryCode"),
  RingChange: kitComponent("RingChange"),
} as unknown as Record<
  string,
  ((p: Kit.KitProps & { children?: ReactNode }) => ReactNode) | undefined
>;

for (const family of FAMILIES) {
  const rows = matrix[family] as Row[];
  describe(`react kit × ui-matrix.json ${family}`, () => {
    it.each(rows.map((r) => [r.name, r] as const))("%s", (_n, row) => {
      const component = row.expect.component;
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
        if (LEFT_OUT.has(key) || dropped.has(key)) continue;
        // The request QR encodes the request code: with none to encode, nothing is drawn.
        if (key === "a11y.qrRequest" && !input.offline?.requestCode) continue;
        // An available update offers Update now and Later; Restart when ready queues the restart
        // of a download in flight, so the kit leaves it to the downloading state.
        if (
          key === "update.restartWhenReady" &&
          component === "UpdatePrompt" &&
          view.state === "available"
        )
          continue;
        // The Replace step confirms on its own button: no openers.
        if (
          (view.state === "replace" || view.state === "replace-open") &&
          /^signin\.replace\.open/.test(key)
        )
          continue;
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
        // A choice drawn as a radio row (keep, create) is not a button.
        const asRow = root!.querySelector(`[role="radio"] [data-key="${key}"]`);
        if ((role === "button" || role === "menu") && !asRow)
          expect(
            root!.querySelector(`button[data-key="${key}"]`),
            `${key} is a control`,
          ).not.toBeNull();
        // A title key that labels the view's primary (Activate's Replace a device) is a control.
        if (
          role === "title" &&
          keyed &&
          component !== "GraceBanner" &&
          key !== view.decisions.primary
        )
          expect(
            keyed.closest("h1,h2,.callout-title,.label") !== null,
            `${key} is a heading`,
          ).toBe(true);
      }
      // DL4: at most one filled control, the primary of the view drawn (the gate draws Welcome,
      // StatusScreen or the grace banner for its state; the sign-in form its step's body: the
      // handoff's code view, the license choice).
      const filled = [...root!.querySelectorAll('[data-variant="primary"]')];
      expect(filled.length).toBeLessThanOrEqual(1);
      const drawn =
        component === "PolarisKeyGate"
          ? (["Welcome", "StatusScreen", "GraceBanner"] as const).map(
              (c) => viewOf(c, input).decisions.primary,
            )
          : component === "SignIn"
            ? [formStep(input).body.decisions.primary]
            : [];
      if (filled.length === 1)
        expect([
          view.decisions.primary,
          ...drawn,
          // The form's Done step always offers Start.
          ...(component === "SignIn" ? ["signin.done.start"] : []),
          // A standalone Activate draws its own Done (as the elements do).
          ...(component === "Activate" ? ["common.done"] : []),
          // Working keeps the pressed control, busy, so focus stays on it.
          ...(component === "UnlockSync" ? ["unlockSync.unlock"] : []),
        ]).toContain(filled[0]!.getAttribute("data-key"));
      // DL4/DL6: a view with a primary draws it as the one filled control.
      if (
        view.decisions.primary !== null &&
        component !== "PolarisKeyGate" &&
        !(LAYOUTS[component].quiet ?? []).includes(view.decisions.primary)
      )
        expect(
          root!.querySelector(
            `:is([data-variant="primary"],[data-variant="danger"])[data-key="${view.decisions.primary}"]`,
          ),
          `${view.decisions.primary} is the filled control`,
        ).not.toBeNull();
      // The app renders under the grace banner, outside the kit root, so the kit's stylesheet
      // never reaches it.
      if (component === "PolarisKeyGate" && view.state === "grace")
        expect(root!.contains(container.querySelector("[data-app]"))).toBe(
          false,
        );
    });
  });
}

describe("React kit × direct component-state fixtures", () => {
  it.each(
    DIRECT_COMPONENT_STATE_FIXTURES.map(
      (fixture) => [fixture.id, fixture] as const,
    ),
  )("%s", (_id, fixture) => {
    const input: UiInput = {
      elapsedMs: 60_000,
      ...withDefaults(fixture.input, matrix.vocabulary.defaults),
    };
    const view = viewOf(fixture.component, input);
    expect({ component: view.component, state: view.state }).toEqual({
      component: fixture.component,
      state: fixture.state,
    });
    const Component = COMPONENTS[fixture.component]!;
    expect(Component, `${fixture.component} is exported`).toBeTypeOf(
      "function",
    );
    const { container } = render(<Component input={input} />);
    const root = container.querySelector<HTMLElement>(".pk-root");
    expect(root, "a kit root").not.toBeNull();
    expect(root!.dataset.component).toBe(fixture.component);
    expect(root!.dataset.state).toBe(fixture.state);
  });
});

const REACT_THEME_ROWS = (matrix.theme as ThemeRow[]).filter(
  (row) => row.input.kit === "react",
);

function resolveReactTheme(row: ThemeRow): ThemeSummary {
  const input = row.input;
  return themeSummary(
    resolveTheme(
      {
        ...(input.preset === undefined ? {} : { preset: input.preset }),
        ...(input.colorScheme === undefined
          ? {}
          : { colorScheme: input.colorScheme }),
        ...(input.integrator === undefined
          ? {}
          : { product: input.integrator }),
      },
      {
        kit: "react",
        presentation:
          input.presentation === undefined
            ? (matrix.vocabulary.defaults
                .presentation as ThemeContext["presentation"])
            : input.presentation,
        bundle: (input.bundle ??
          matrix.vocabulary.defaults.bundle) as ThemeContext["bundle"],
        platform: (input.platform ??
          matrix.vocabulary.defaults.platform) as ThemeContext["platform"],
      },
    ),
  );
}

describe("React kit × ui-matrix.json theme", () => {
  it("contains React identity rows", () => {
    expect(REACT_THEME_ROWS.length).toBeGreaterThan(0);
  });

  it.each(REACT_THEME_ROWS.map((row) => [row.name, row] as const))(
    "%s",
    (_name, row) => {
      expect(resolveReactTheme(row)).toEqual(row.expect);
    },
  );
});

const tables: { en: CopyTable } & Record<string, CopyTable> = {
  en: KIT_COPY_EN,
};
beforeAll(async () => {
  await Promise.all(
    KIT_COPY_LOCALES.map(async (locale) => {
      tables[locale] = await loadKitCopy(locale);
    }),
  );
});
const I18N_ROWS = matrix.i18n as I18nRow[];

describe("React kit × ui-matrix.json i18n", () => {
  it("contains catalog rows", () => {
    expect(I18N_ROWS.length).toBeGreaterThan(0);
  });

  it.each(I18N_ROWS.map((row) => [row.name, row] as const))(
    "%s",
    (_name, row) => {
      const copy = new Copy({
        tables,
        locale: row.locale,
        ...(row.overrides === undefined ? {} : { overrides: row.overrides }),
      });
      expect(copy.format(row.key, row.args)).toBe(row.expect);
    },
  );
});
