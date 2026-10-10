// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall ui.theme ui.i18n
//
// The JS runner of conformance/corpus/v2/ui-matrix.json (plans/UK-02b.md §5): every row of all
// ten families, never one skipped. Component rows drive the model `expect.component` names (the
// signIn family through `SignInModel`) and compare the state, the sorted copy keys and the sorted
// actions, and a negative row's Must not; theme rows pin the theme resolver; i18n rows the catalog
// lookup and the ICU-subset formatter over brand's generated tables. A row a natural model fails
// is a bug against the row or the model, never a reason to weaken this runner (AGENTS.md rule 1).

import { describe, expect, it } from "vitest";
import { loadKitCopy, KIT_COPY_LOCALES } from "@polaris-key/brand/kit-copy";

import { Copy, UI_MATRIX_VERSION, type CopyTable } from "../src/index.js";
import { resolveTheme, themeSummary } from "../src/theme/index.js";
import {
  generatedVersion,
  readMatrix,
  run,
  type Obj,
  type Row,
} from "./matrix.js";

const MATRIX_FILE = "ui-matrix.json";
const matrix = readMatrix();
const defaults = matrix.vocabulary.defaults;

/** The component families, each a `ui.*` feature (ui-matrix.json family → features.json id). */
const FAMILIES = {
  gate: "ui.gate",
  activate: "ui.activate",
  signIn: "ui.signin",
  deviceLimit: "ui.devicelimit",
  devices: "ui.devices",
  update: "ui.update",
  settings: "ui.settings",
  paywall: "ui.paywall",
} as const;

describe(`${MATRIX_FILE}: the version`, () => {
  it("is the version these models implement, and every JS SDK's generated constant", () => {
    expect(matrix.uiMatrixVersion).toBe(UI_MATRIX_VERSION);
    expect(
      generatedVersion("packages/sdk-node/src/constants.generated.ts"),
    ).toBe(UI_MATRIX_VERSION);
    expect(
      generatedVersion("packages/sdk-react/src/constants.generated.ts"),
    ).toBe(UI_MATRIX_VERSION);
  });

  it("holds every family, theme and i18n included", () => {
    for (const family of [...Object.keys(FAMILIES), "theme", "i18n"])
      expect(Array.isArray(matrix[family]), family).toBe(true);
  });
});

for (const [family, feature] of Object.entries(FAMILIES)) {
  const rows = matrix[family] as Row[];
  describe(`${MATRIX_FILE} ${family} (${feature})`, () => {
    it.each(rows.map((r) => [r.name, r] as const))("%s", (_name, row) => {
      const view = run(row, defaults);
      expect(view.component).toBe(row.expect.component);
      expect({
        state: view.state,
        copy: [...view.copy].sort(),
        actions: [...view.actions].sort(),
      }).toEqual({
        state: row.expect.state,
        copy: [...row.expect.copy].sort(),
        actions: [...(row.expect.actions ?? [])].sort(),
      });
      if (row.mustNot) {
        for (const s of row.mustNot.states ?? [])
          expect(view.state).not.toBe(s);
        for (const k of row.mustNot.copy ?? [])
          expect(view.copy).not.toContain(k);
        for (const a of row.mustNot.actions ?? [])
          expect(view.actions).not.toContain(a);
      }
    });
  });
}

describe(`${MATRIX_FILE} theme (ui.theme)`, () => {
  const rows = matrix.theme as { name: string; input: Obj; expect: Obj }[];
  it.each(rows.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const i = row.input;
    const resolved = resolveTheme(
      {
        ...(i.preset !== undefined ? { preset: i.preset as "native" } : {}),
        ...(i.colorScheme !== undefined
          ? { colorScheme: i.colorScheme as "dark" }
          : {}),
        ...(i.integrator !== undefined ? { product: i.integrator as Obj } : {}),
      },
      {
        kit: i.kit as "react",
        presentation: (i.presentation === undefined
          ? defaults.presentation
          : i.presentation) as never,
        bundle: (i.bundle ?? defaults.bundle) as never,
        platform: (i.platform ?? defaults.platform) as never,
      },
    );
    expect(themeSummary(resolved)).toEqual(row.expect);
  });
});

// brand's generated tables: every kit string and the core copy under `core.*`, per locale.
const tables: Record<string, CopyTable> = {};
for (const l of KIT_COPY_LOCALES) tables[l] = await loadKitCopy(l);

describe(`${MATRIX_FILE} i18n (ui.i18n)`, () => {
  const rows = matrix.i18n as {
    name: string;
    locale: string;
    key: string;
    args: Record<string, string | number>;
    overrides?: Record<string, Record<string, string>>;
    expect: string;
  }[];
  it.each(rows.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const copy = new Copy({
      tables: tables as { en: CopyTable },
      locale: row.locale,
      ...(row.overrides ? { overrides: row.overrides } : {}),
    });
    expect(copy.format(row.key, row.args)).toBe(row.expect);
  });
});
