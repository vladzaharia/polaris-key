// The scenes of the desktop chrome baselines (UK-06.6), shared by the React lane
// (test/browser/chrome.browser.test.tsx) and the elements' (elements/test/browser/chrome.browser.test.ts),
// so `pnpm ui:report` can hold the two renderers' `windows-*` baselines to the same pixels.

import matrixJson from "../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import type { UiInput } from "@polaris-key/ui-core";
import {
  DIRECT_COMPONENT_STATE_FIXTURES,
  matrixComponentStateFixtures,
  type MatrixComponentRow,
} from "./kitFixtures.js";

type Obj = Record<string, unknown>;
interface Row {
  name: string;
  input: UiInput;
  expect: { component: string; state: string };
}
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
export const matrix = matrixJson as Obj & {
  vocabulary: Obj & { defaults: Obj };
};
const ROWS: Record<string, Row> = Object.fromEntries(
  FAMILIES.flatMap((f) => matrix[f] as Row[]).map((r) => [r.name, r]),
);

/** The board's screens (docs/design/ui-kits/windows.html): the gate, activate, sign-in (inline and
 *  as the sheet), device limit, update, settings and the state screens. */
const BOARD = [
  { row: "PolarisKeyGate/needs-activation" },
  { row: "Welcome/default: sign-in and a key" },
  { row: "Activate/parsed" },
  { row: "Activate/device-limit: a link to replace a device" },
  { row: "SignIn/methods: desktop (sheet)", sheet: true },
  { row: "SignIn/choose: desktop (sheet)", sheet: true },
  { row: "DeviceLimit/default: the devices listed in the app" },
  { row: "UpdatePrompt/available", dialog: true },
  { row: "UpdateProgress/downloading" },
  { row: "Settings/list" },
  { row: "AccountAndLicense/signed-in" },
  { row: "StatusScreen/revoked" },
  { row: "Devices/list" },
  { row: "Devices/error: the list could not load" },
].map((s) => {
  const row = ROWS[s.row];
  if (!row) throw new Error(`no ui-matrix row "${s.row}"`);
  return {
    ...s,
    id: `${row.expect.component}.${row.expect.state}`,
    component: row.expect.component,
    row,
  };
});
export interface Scene {
  id: string;
  component: string;
  row: Row;
  /** The sign-in form as a sheet over the host's window. */
  sheet?: boolean;
  /** The update prompt as a dialog over the host's window. */
  dialog?: boolean;
}
export const SCENES: Scene[] = BOARD;

/** A scene's input: the corpus row with the matrix defaults, a host that can renew and a served code. */
export function sceneInput(
  scene: Scene,
  platform?: { os: string; formFactor: string },
): UiInput {
  const out: Obj = { ...scene.row.input };
  if (platform) out["platform"] = platform;
  for (const [k, v] of Object.entries(matrix.vocabulary.defaults))
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((out[k] as Obj | undefined) ?? {}) };
    else if (!(k in out)) out[k] = v;
  if (!("renew" in out)) out["renew"] = { url: "https://example.com/renew" };
  const dc = (out as UiInput).deviceCode;
  if (dc && dc.userCode === undefined)
    out["deviceCode"] = { ...dc, userCode: "WDJB-MJHT" };
  return { elapsedMs: 60_000, ...out } as UiInput;
}

// ── The Windows chrome's scenes (UK-06.6 fix round) ─────────────────────────────────────────────
//
// The visual lane's own fixtures (kitFixtures: the same input every web baseline draws, such as the
// signed-in account with its person, licence and seats) for the screens, and the corpus's sheet rows
// for the sign-in sheets, drawn on a Windows machine ("this computer") over a host window.

const ROW_LIST: Row[] = FAMILIES.flatMap((f) => matrix[f] as Row[]);
const FIXTURES = [
  ...matrixComponentStateFixtures(ROW_LIST as unknown as MatrixComponentRow[]),
  ...DIRECT_COMPONENT_STATE_FIXTURES,
];

function fixtureScene(id: string, extra: Partial<Scene> = {}): Scene {
  const f = FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`no visual-lane fixture ${id}`);
  return {
    id,
    component: f.component,
    row: {
      name: f.row ?? id,
      input: f.input,
      expect: { component: f.component, state: f.state },
    },
    ...extra,
  };
}
function sheetScene(rowName: string): Scene {
  const row = ROWS[rowName];
  if (!row) throw new Error(`no ui-matrix row "${rowName}"`);
  return {
    id: `${row.expect.component}.${row.expect.state}`,
    component: row.expect.component,
    row,
    sheet: true,
  };
}

export const WINDOWS_SCENES: Scene[] = [
  fixtureScene("PolarisKeyGate.booting"),
  fixtureScene("PolarisKeyGate.needs-activation"),
  fixtureScene("Welcome.default"),
  fixtureScene("Activate.parsed"),
  fixtureScene("Activate.device-limit"),
  sheetScene("SignIn/methods: desktop (sheet)"),
  sheetScene("SignIn/choose: desktop (sheet)"),
  sheetScene("SignIn/key: Use a license key instead keeps the account (sheet)"),
  sheetScene("SignIn/code: Use a code instead (sheet)"),
  fixtureScene("DeviceLimit.default"),
  fixtureScene("UpdatePrompt.available", { dialog: true }),
  fixtureScene("UpdatePrompt.downloading", { dialog: true }),
  fixtureScene("Settings.list"),
  fixtureScene("AccountAndLicense.signed-in"),
  fixtureScene("AccountAndLicense.offline"),
  fixtureScene("StatusScreen.revoked"),
  fixtureScene("Devices.list"),
  fixtureScene("Devices.error"),
  fixtureScene("PolarisKeyGate.grace"),
];

/** A Windows machine: the platform every Windows scene is drawn on. */
export const WINDOWS_PLATFORM = { os: "windows", formFactor: "computer" };

/** The window behind a dialog: the host app, so the smoke layer has something to dim. Plain
 *  markup, the same in both renderers' lanes. */
export const HOST_APP_HTML = `<div data-host-app style="position:fixed;inset:0;display:grid;grid-template-rows:32px 1fr;font:14px/20px system-ui,sans-serif;color:#222;background:#eef1f4">
<div style="display:flex;align-items:center;padding:0 12px;background:#fff;border-bottom:1px solid #d9dde2;font-weight:600">Tidewater</div>
<div style="display:grid;grid-template-columns:minmax(0,200px) 1fr;min-width:0"><div style="padding:16px;border-inline-end:1px solid #d9dde2;background:#f7f8fa">Library<br>Mixes<br>Settings</div>
<div style="padding:24px;display:grid;gap:12px;align-content:start"><div style="height:56px;border-radius:4px;background:#fff;border:1px solid #d9dde2"></div><div style="height:56px;border-radius:4px;background:#fff;border:1px solid #d9dde2"></div><div style="height:56px;border-radius:4px;background:#fff;border:1px solid #d9dde2"></div></div></div></div>`;
