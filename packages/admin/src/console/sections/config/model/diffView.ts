import type { ConfigEntry } from "../../../../api.js";
import type { FieldChange } from "../../../../lib/diff.js";
import { inAppLabel, typeLabel } from "../../../../lib/labels.js";
import type { DiffFieldView } from "../../../../ui/DiffViewer.js";
import { entryType } from "../components/entryType.js";
import { same } from "./mergeDraft.js";
import { valueText } from "./valueUse.js";

type View = DiffFieldView;

const show = (v: unknown): string =>
  v === undefined ? "—" : typeof v === "string" ? `"${v}"` : JSON.stringify(v);

/**
 * The Allowed values change as rows, when the enum is all that differs in the schema; `null`
 * otherwise, and the schema reads as its before and after JSON.
 */
function allowedValueRows(
  before: ConfigEntry,
  after: ConfigEntry,
): View | null {
  const b = (before.schema ?? {}) as Record<string, unknown>;
  const a = (after.schema ?? {}) as Record<string, unknown>;
  const { enum: be, ...bRest } = b;
  const { enum: ae, ...aRest } = a;
  if (!same(bRest, aRest)) return null;
  if (be !== undefined && !Array.isArray(be)) return null;
  if (ae !== undefined && !Array.isArray(ae)) return null;
  const was = (be ?? []) as unknown[];
  const now = (ae ?? []) as unknown[];
  return {
    field: "Allowed values",
    before: "",
    after: "",
    values: {
      added: now.filter((v) => !was.some((w) => same(w, v))).map(valueText),
      removed: was.filter((v) => !now.some((n) => same(n, v))).map(valueText),
      kept: now
        .filter((v) => was.some((w) => same(w, v)))
        .map(
          (v) =>
            valueText(v) +
            (after.default !== undefined && same(v, after.default)
              ? " (default)"
              : ""),
        ),
    },
  };
}

/**
 * A changed catalog entry's fields in the console's words: `kind` and `delivery` read as one
 * Type ("Setting → Minted token"), `managementDefault` as In the app ("Editable → Read-only").
 */
export function entryFieldView(change: {
  before: ConfigEntry;
  after: ConfigEntry;
  fields: FieldChange[];
}): View[] {
  const { before, after } = change;
  const out: View[] = [];
  let typeDone = false;
  let inAppDone = false;
  for (const f of change.fields) {
    if (f.field === "kind" || f.field === "delivery") {
      if (typeDone) continue;
      typeDone = true;
      out.push({
        field: "Type",
        before: typeLabel(before),
        after: typeLabel(after),
      });
    } else if (f.field === "managementDefault") {
      if (inAppDone) continue;
      inAppDone = true;
      out.push({
        field: "In the app",
        before: inAppLabel(before),
        after: inAppLabel(after),
      });
    } else if (f.field === "schema" && allowedValueRows(before, after)) {
      out.push(allowedValueRows(before, after)!);
    } else {
      out.push({
        field: f.field === "default" ? "Default" : f.field,
        before: show(f.before),
        after: show(f.after),
      });
    }
  }
  // Type and In the app lead the list.
  return out.sort(
    (a, b) =>
      Number(b.field === "Type") - Number(a.field === "Type") ||
      Number(b.field === "In the app") - Number(a.field === "In the app"),
  );
}

/** Keys whose Type changed from a published one: the SDK read changes, so it is breaking. */
export function typeChangeNotes(
  changed: { key: string; before: ConfigEntry; after: ConfigEntry }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of changed)
    if (entryType(c.before) !== entryType(c.after))
      out[c.key] =
        `Type ${typeLabel(c.before)} → ${typeLabel(c.after)} changes how the app reads it`;
  return out;
}

/**
 * Why a publish failed, in a sentence and never a status code (EXPERIENCE §0.3): the server not
 * answering in time, the server failing, or what `errorCopy` already says for a refusal.
 */
export function publishCause(
  error: unknown,
  copy: { description: string },
): string {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : 0;
  if (status === 504 || status === 408)
    return "Polaris Key didn't answer in time.";
  if (status >= 500) return "Polaris Key hit a problem on its side.";
  return copy.description;
}
