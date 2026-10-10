// The shared fixtures (plans/UK-02b.md): ui-matrix.json read from the checkout, each row's input
// with its defaults, and the catalog's roles (packages/brand/kit-copy/en.json) to hold the
// elements' DOM to.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { UiInput } from "@polaris-key/ui-core";

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

export const COMPONENT_FAMILIES = [
  "gate",
  "activate",
  "signIn",
  "deviceLimit",
  "devices",
  "update",
  "settings",
  "paywall",
] as const;

export function readMatrix(): Obj & { vocabulary: Obj & { defaults: Obj } } {
  return JSON.parse(
    readFileSync(
      join(REPO, "conformance", "corpus", "v2", "ui-matrix.json"),
      "utf8",
    ),
  ) as Obj & { vocabulary: Obj & { defaults: Obj } };
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

/** The catalog's role of each kit key (`button`, `title`, `body`, …). */
export function roles(): Record<string, string> {
  const en = JSON.parse(
    readFileSync(
      join(REPO, "packages", "brand", "kit-copy", "en.json"),
      "utf8",
    ),
  ) as { messages: Record<string, { role: string }> };
  return Object.fromEntries(
    Object.entries(en.messages).map(([k, v]) => [k, v.role]),
  );
}
