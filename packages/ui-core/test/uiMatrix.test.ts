// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall ui.theme ui.i18n
//
// The JS runner of conformance/corpus/v2/ui-matrix.json (plans/UK-02b.md §5): every row of all
// ten families, never one skipped. Component rows drive the model `expect.component` names (the
// signIn family through `SignInModel`) and compare the state, the sorted copy keys and the sorted
// actions, and a negative row's Must not; theme rows pin the theme resolver; i18n rows the catalog
// lookup and the ICU-subset formatter over brand's generated tables. A row a natural model fails
// is a bug against the row or the model, never a reason to weaken this runner (AGENTS.md rule 1).
// A view's strings, made text from its own arguments, show no raw `{name}` (see "no raw
// placeholder" below).

import { describe, expect, it } from "vitest";
import { loadKitCopy, KIT_COPY_LOCALES } from "@polaris-key/brand/kit-copy";

import {
  Copy,
  UI_MATRIX_VERSION,
  type CopyTable,
  type View,
} from "../src/index.js";
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

// ── No raw placeholder ──────────────────────────────────────────────────────────────────────────
//
// copy.ts leaves a missing argument visible as `{name}` on purpose (policy.test.ts), so a model
// that forgets one is caught here: for every row of every component family, in every launch
// locale, over each key the view shows and its primary's label. Two kinds of argument are not the
// view's to hold:
//
//   RENDERER_ARGS  what a renderer fills in itself: the phrase for "this device" (the catalog's,
//                  in the kit's locale) and the values of each row of a list the input carries
//   GAPS           the display facts a corpus row leaves out of its input (a tier, a download
//                  size, the date grace ends). `UiInput` has a member for each; a state's `facts`
//                  are what a producer supplies, and with them it shows nothing open
//
// A gap is named per state, and the test fails when one stops being true, so the list cannot
// rot: it is every state that draws a raw `{name}` when it is drawn from its bare row.

const copies = KIT_COPY_LOCALES.map(
  (locale) => new Copy({ tables: tables as { en: CopyTable }, locale }),
);

const RENDERER_ARGS: Readonly<Record<string, readonly string[]>> = {
  "*": ["thisDevice"],
  "signin.choice.lede": ["device"],
  "signin.replace.meta": ["platform", "when"],
  "devices.meta": ["platform", "when"],
  "a11y.renameDevice": ["device"],
  "a11y.removeDevice": ["device"],
  "signin.choice.devices": ["used", "limit"],
  "signin.choice.meta": ["origin", "term"],
  "signin.term.until": ["date"],
  "releaseNotes.version": ["version"],
  "releaseNotes.released": ["date"],
  "settings.range": ["min", "max"],
};

const BUNDLE = {
  slug: "tidewater",
  name: "Tidewater Studio",
  version: "2.4.1",
};
const PROGRESS = { size: "21 MB", total: "52 MB", timeLeft: "20 seconds" };
const ENTITLEMENT = { entitlement: { tier: "Pro" } };

const GAPS: Readonly<
  Record<string, { open: Record<string, string[]>; facts: Obj | null }>
> = {
  "GraceBanner.days-left": {
    open: { "grace.deadline": ["date"] },
    facts: { gate: { graceDate: "Dec 4, 2026" } },
  },
  "Toast.info": {
    open: { "a11y.toastTimer": ["time"] },
    facts: { toast: { closesIn: "8 seconds" } },
  },
  "Toast.with-progress": {
    open: { "updateProgress.downloading": ["size", "time", "total"] },
    facts: { update: { progress: PROGRESS } },
  },
  "Activate.done": {
    open: { "part.keyField.verdict": ["term", "tier"] },
    facts: { activation: { tier: "Pro", term: "Lifetime" } },
  },
  "SignIn.done": {
    open: { "signin.desktop.toast": ["name", "tier"] },
    facts: { account: { signedIn: true, holder: "Maya", tier: "Pro" } },
  },
  // The corpus elides the served user code (a visual render adds one).
  "SignInHandoff.code": {
    open: { "a11y.code": ["code"] },
    facts: { deviceCode: { userCode: "WDJB-MJHT" } },
  },
  // `LicenseChoiceRow.origin` is `store` and no more (plans/I-04.md §G): no input names the
  // store, so the React kit leaves the origin out of the row's meta line.
  "LicenseChoice.many": {
    open: { "signin.choice.origin.store": ["store"] },
    facts: null,
  },
  "UpdatePrompt.available": {
    open: { "update.current": ["size", "version"] },
    facts: { update: { size: "52 MB" }, bundle: BUNDLE },
  },
  "UpdatePrompt.downloading": {
    open: {
      "a11y.progress": ["size", "total"],
      "update.downloading": ["size", "total"],
      "update.timeLeft": ["time"],
    },
    facts: { update: { progress: PROGRESS } },
  },
  "UpdatePrompt.platform": {
    open: { "update.platform.command": ["command"] },
    facts: { update: { command: "winget upgrade Harbor.Tidewater" } },
  },
  "UpdateProgress.downloading": {
    open: {
      "a11y.progress": ["size", "total"],
      "updateProgress.downloading": ["size", "time", "total"],
    },
    facts: { update: { progress: PROGRESS } },
  },
  "AccountAndLicense.signed-in": {
    open: { "account.tier": ["tier"], "account.version": ["version"] },
    facts: { account: { tier: "Pro" }, bundle: BUNDLE },
  },
  "AccountAndLicense.key-only": {
    open: { "account.tier": ["tier"] },
    facts: { account: { tier: "Pro" } },
  },
  "Paywall.offers": {
    open: {
      "paywall.includes": ["tier"],
      "paywall.title": ["tier"],
      "paywall.upgrade": ["tier"],
    },
    facts: ENTITLEMENT,
  },
  "Paywall.purchasing": {
    open: { "paywall.upgrade": ["tier"] },
    facts: ENTITLEMENT,
  },
  "Paywall.purchased": {
    open: { "paywall.purchased": ["tier"] },
    facts: ENTITLEMENT,
  },
  "EntitlementGate.not-entitled": {
    open: { "entitlement.locked": ["tier"] },
    facts: ENTITLEMENT,
  },
};

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `input` with the display facts merged in, member by member (a row's own values stay). */
function withFacts(input: Obj, facts: Obj): Obj {
  const out: Obj = { ...input };
  for (const [k, v] of Object.entries(facts))
    out[k] = isObj(v) && isObj(out[k]) ? withFacts(out[k], v) : v;
  return out;
}

/** What a view leaves open: per key, the `{name}`s its strings still show in any launch locale. */
function unfilled(view: View): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  // The primary's label is drawn too, where the state's copy does not list it (Paywall.purchasing).
  const keys = new Set(view.copy);
  if (view.decisions.primary) keys.add(view.decisions.primary);
  for (const key of keys) {
    const args = view.keyArgs?.[key] ?? view.args;
    const theirs = [...RENDERER_ARGS["*"]!, ...(RENDERER_ARGS[key] ?? [])];
    const open = new Set<string>();
    for (const copy of copies)
      for (const m of copy.format(key, args).matchAll(/\{([A-Za-z]\w*)\}/g))
        if (!theirs.includes(m[1]!)) open.add(m[1]!);
    if (open.size > 0) out[key] = [...open].sort();
  }
  return out;
}

describe(`${MATRIX_FILE} no raw placeholder`, () => {
  const rows = Object.keys(FAMILIES).flatMap(
    (family) => matrix[family] as Row[],
  );
  const seen: Record<string, Record<string, string[]>> = {};

  it.each(rows.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const view = run(row, defaults);
    const id = `${view.component}.${view.state}`;
    const gap = GAPS[id];
    const open = unfilled(view);
    for (const [key, names] of Object.entries(open)) {
      for (const name of names)
        expect(
          gap?.open[key] ?? [],
          `${row.name}: ${key} shows {${name}}`,
        ).toContain(name);
      const into = (seen[id] ??= {});
      into[key] = [...new Set([...(into[key] ?? []), ...names])].sort();
    }
    // With the facts a producer supplies, the state shows nothing open.
    if (gap?.facts) {
      const full = run(
        { ...row, input: withFacts(row.input, gap.facts) },
        defaults,
      );
      expect(`${full.component}.${full.state}`).toBe(id);
      expect(unfilled(full), `${row.name} with its facts`).toEqual({});
    }
  });

  it("names each gap that is real, and no other", () => {
    expect(seen).toEqual(
      Object.fromEntries(Object.entries(GAPS).map(([id, g]) => [id, g.open])),
    );
  });
});
