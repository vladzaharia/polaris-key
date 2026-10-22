// The scenes of the desktop chrome baselines (UK-06.6), shared by the React lane
// (test/browser/chrome.browser.test.tsx) and the elements' (elements/test/browser/chrome.browser.test.ts),
// so `pnpm ui:report` can hold the two renderers' `windows-*` baselines to the same pixels.

import matrixJson from "../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import type { UiInput } from "@polaris-key/ui-core";

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
export const SCENES = [
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
export type Scene = (typeof SCENES)[number];

/** A scene's input: the corpus row with the matrix defaults, a host that can renew and a served code. */
export function sceneInput(scene: Scene): UiInput {
  const out: Obj = { ...scene.row.input };
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
