// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall ui.theme ui.i18n
//
// UK-06.2 (UK-02b D9): the bridge-view proof of Node's ten `ui.*` rows. Every row of
// conformance/corpus/v2/ui-matrix.json (read, never edited) goes through the main-process half of
// `@polaris-key/node/electron`: a fake Node client in the row's state (its enabled services and
// the discovery presentation) sits behind `exposePolarisBridge` over the structured-clone IPC pair,
// the preload's bridge hands the renderer a `BridgeState`, and the renderer's side (what the
// DesktopAdapter does with it) feeds ui-core's view models. The view each row produces is compared
// with the row's expectation and snapshotted as JSON. The family run itself is ui-core's runner
// (packages/ui-core/test/uiMatrix.test.ts), also under Node's testRoots.
//
// A `hidden` row (a service off) must send the renderer no view: state "hidden", no copy, no actions.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServicesMap } from "@polaris-key/ui-core/browser/sdk/core/services.js";
import {
  Copy,
  SignInModel,
  viewOf,
  type ComponentName,
  type CopyTable,
  type UiInput,
} from "@polaris-key/ui-core";
import { resolveTheme, themeSummary } from "@polaris-key/ui-core/theme";
import type { PolarisKeyClient } from "../../src/client.js";
import { exposePolarisBridge } from "../../src/electron/index.js";
import { createPreloadBridge } from "../../src/electron/renderer.js";
import { KIT_COPY } from "../../src/kitCopy.generated.js";
import { SERVICE_SLUGS } from "../../src/services.generated.js";
import { allowApp, ipcPair } from "../electronIpc.js";

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
  mustNot?: { states?: string[]; copy?: string[]; actions?: string[] };
}

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const matrix = JSON.parse(
  readFileSync(
    join(REPO, "conformance", "corpus", "v2", "ui-matrix.json"),
    "utf8",
  ),
) as { vocabulary: { defaults: Obj } } & Record<string, unknown>;
const defaults = matrix.vocabulary.defaults;

const FAMILIES = Object.fromEntries(
  [
    ["gate", "gate"],
    ["activate", "activate"],
    ["signIn", "signin"],
    ["deviceLimit", "devicelimit"],
    ["devices", "devices"],
    ["update", "update"],
    ["settings", "settings"],
    ["paywall", "paywall"],
  ].map(([family, id]) => [family, `ui.${id}`]),
) as Record<string, string>;

/** The comparable shape of a view: its state and its sorted copy keys and actions. */
function shapeOf(v: { state: string; copy: string[]; actions: string[] }) {
  return {
    state: v.state,
    copy: [...v.copy].sort(),
    actions: [...v.actions].sort(),
  };
}

/** A fake Node client in a row's state: the services the product runs, its presentation. */
function fakeClient(services: readonly string[], presentation: unknown) {
  const caps = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [s, { enabled: services.includes(s) }]),
  ) as ServicesMap;
  return {
    getSyncState: () => ({
      activation: null,
      doc: null,
      lastSyncUnauthorized: false,
      blocked: null,
      lastVerifiedAt: null,
      highWaterMark: 0,
    }),
    capabilities: () => caps,
    config: { entries: () => null, localValues: () => ({}) },
    presentation: () => presentation,
    events: { on() {}, off() {} },
  } as unknown as PolarisKeyClient;
}

/** The renderer's `BridgeState` for a row's state, over the real main-process half. */
async function receive(services: readonly string[], presentation: unknown) {
  const ipc = ipcPair();
  const handle = exposePolarisBridge(fakeClient(services, presentation), {
    ipcMain: ipc.ipcMain,
    allowSender: allowApp,
  });
  const bridge = createPreloadBridge(ipc.ipcRenderer);
  const state = (await bridge.getSyncState()) as unknown as {
    capabilities: ServicesMap;
    presentation: unknown;
  };
  handle.close();
  return state;
}

/** What the renderer does with the state: the capability map and presentation become the input's
 *  `services` and `presentation`; everything else a row names is the model's own input. */
async function viewFromBridge(row: Row) {
  const services = (row.input.services as string[] | undefined) ?? [
    ...SERVICE_SLUGS,
  ];
  const presentation =
    "presentation" in row.input
      ? row.input.presentation
      : defaults.presentation;
  const state = await receive(services, presentation);
  const caps = state.capabilities;
  const enabled = SERVICE_SLUGS.filter((s) => caps[s].enabled);
  expect(enabled).toEqual(SERVICE_SLUGS.filter((s) => services.includes(s)));
  expect(state.presentation).toEqual(presentation ?? null);

  const input: Obj = { ...row.input, services: enabled };
  // null is "discovery carries none"; the bridge sent exactly what the row names.
  if ("presentation" in row.input || state.presentation !== null)
    input.presentation = state.presentation;
  for (const [k, v] of Object.entries(defaults))
    if (k === "capabilities")
      input[k] = { ...(v as Obj), ...((row.input[k] as Obj) ?? {}) };
    else if (!(k in input)) input[k] = v;
  const component = row.expect.component as ComponentName;
  const ui = input as unknown as UiInput;
  return ["SignIn", "SignInHandoff", "LicenseChoice"].includes(component)
    ? SignInModel.restore(ui).view(
        component as "SignIn" | "SignInHandoff" | "LicenseChoice",
      )
    : viewOf(component, ui);
}

for (const [family, feature] of Object.entries(FAMILIES)) {
  const rows = matrix[family] as Row[];
  describe(`bridge views: ${family} (${feature})`, () => {
    it.each(rows.map((r) => [r.name, r] as const))("%s", async (_n, row) => {
      const view = await viewFromBridge(row);
      expect(view.component).toBe(row.expect.component);
      expect(shapeOf(view)).toEqual(
        shapeOf({
          state: row.expect.state,
          copy: row.expect.copy,
          actions: row.expect.actions ?? [],
        }),
      );
      if (row.expect.state === "hidden") {
        // A service off sends the renderer no view.
        expect(view.copy).toEqual([]);
        expect(view.actions).toEqual([]);
      }
      for (const s of row.mustNot?.states ?? []) expect(view.state).not.toBe(s);
      for (const k of row.mustNot?.copy ?? [])
        expect(view.copy).not.toContain(k);
      for (const a of row.mustNot?.actions ?? [])
        expect(view.actions).not.toContain(a);
      expect(JSON.parse(JSON.stringify(view))).toMatchSnapshot();
    });
  });
}

describe("bridge views: a service turned off is hidden", () => {
  it("has hidden rows in the matrix, each answered with no view", () => {
    const hidden = Object.keys(FAMILIES)
      .flatMap((f) => matrix[f] as Row[])
      .filter((r) => r.expect.state === "hidden");
    expect(hidden.length).toBeGreaterThan(0);
  });
  it("the license service off hides the StatusScreen over the bridge", async () => {
    const view = await viewFromBridge({
      name: "x",
      input: {
        services: [
          "config",
          "release",
          "distribution",
          "update",
          "identity",
          "sync",
        ],
        registration: "open",
        gate: { status: "not-applicable" },
      },
      expect: { component: "StatusScreen", state: "hidden", copy: [] },
    });
    expect(view.state).toBe("hidden");
    expect(view.copy).toEqual([]);
  });
});

describe("bridge views: theme (ui.theme)", () => {
  const rows = matrix.theme as { name: string; input: Obj; expect: Obj }[];
  it.each(rows.map((r) => [r.name, r] as const))("%s", async (_n, row) => {
    const i = row.input;
    const presentation =
      i.presentation === undefined ? defaults.presentation : i.presentation;
    const state = await receive([...SERVICE_SLUGS], presentation);
    const overrides: Obj = {};
    if (i.preset !== undefined) overrides.preset = i.preset;
    if (i.colorScheme !== undefined) overrides.colorScheme = i.colorScheme;
    if (i.integrator !== undefined) overrides.product = i.integrator;
    const ctx = {
      kit: i.kit,
      presentation: state.presentation,
      bundle: i.bundle ?? defaults.bundle,
      platform: i.platform ?? defaults.platform,
    };
    const resolved = resolveTheme(overrides as never, ctx as never);
    const summary = themeSummary(resolved);
    expect(summary).toEqual(row.expect);
    expect(summary).toMatchSnapshot();
  });
});

describe("bridge views: i18n (ui.i18n)", () => {
  interface I18nRow {
    name: string;
    locale: string;
    key: string;
    args: Record<string, string | number>;
    overrides?: Record<string, Record<string, string>>;
    expect: string;
  }
  const rows = matrix.i18n as I18nRow[];
  it.each(rows.map((r) => [r.name, r] as const))("%s", (_n, row) => {
    // Node's own copy tables (kitCopy.generated.ts), the ones a main process ships.
    const copy = new Copy({
      tables: KIT_COPY as unknown as { en: CopyTable },
      locale: row.locale,
      ...(row.overrides ? { overrides: row.overrides } : {}),
    });
    const text = copy.format(row.key, row.args);
    expect(text).toBe(row.expect);
    expect(text).toMatchSnapshot();
  });
});
