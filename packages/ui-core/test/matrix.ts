// Shared helpers for the ui-matrix.json runner: read the file from the checkout, give a row's
// input its defaults (`vocabulary.defaults`), and drive the model the row names.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SignInModel,
  viewOf,
  type ComponentName,
  type UiInput,
  type View,
} from "../src/index.js";

export const REPO = join(import.meta.dirname, "..", "..", "..");

export type Obj = Record<string, unknown>;

export interface Row {
  name: string;
  input: Obj;
  expect: {
    component: string;
    state: string;
    copy: string[];
    actions?: string[];
  };
  mustNot?: {
    invariant: string;
    states?: string[];
    copy?: string[];
    actions?: string[];
  };
}

export interface UiMatrix {
  uiMatrixVersion: number;
  vocabulary: Obj & { defaults: Obj };
  [family: string]: unknown;
}

/** The matrix, read from the checkout as the runner contract asks (plans/UK-02b.md §5). */
export function readMatrix(): UiMatrix {
  return JSON.parse(
    readFileSync(
      join(REPO, "conformance", "corpus", "v2", "ui-matrix.json"),
      "utf8",
    ),
  ) as UiMatrix;
}

/** A member the input omits takes `vocabulary.defaults`; capabilities merge member by member. */
export function withDefaults(input: Obj, defaults: Obj): UiInput {
  const out: Obj = { ...input };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((input[k] as Obj | undefined) ?? {}) };
    else if (!(k in input)) out[k] = v;
  }
  return out as UiInput;
}

const SIGN_IN = new Set(["SignIn", "SignInHandoff", "LicenseChoice"]);

/** Drive the model the row names: the signIn family through `SignInModel` (plans/UK-02b.md §5),
 *  every other component through its view model. */
export function run(row: Row, defaults: Obj): View {
  const input = withDefaults(row.input, defaults);
  const component = row.expect.component as ComponentName;
  if (SIGN_IN.has(component))
    return SignInModel.restore(input).view(
      component as "SignIn" | "SignInHandoff" | "LicenseChoice",
    );
  return viewOf(component, input);
}

/** The generated `UI_MATRIX_VERSION` of an SDK's constants module. */
export function generatedVersion(file: string): number {
  const m = /export const UI_MATRIX_VERSION = (\d+);/.exec(
    readFileSync(join(REPO, file), "utf8"),
  );
  if (!m) throw new Error(`${file}: no UI_MATRIX_VERSION`);
  return Number(m[1]);
}
