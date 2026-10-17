import type { ConfigEntry } from "../../../../api.js";
import type { FieldChange } from "../../../../lib/diff.js";
import { inAppLabel, typeLabel } from "../../../../lib/labels.js";
import { entryType } from "../components/entryType.js";

type View = { field: string; before: string; after: string };

const show = (v: unknown): string =>
  v === undefined ? "—" : typeof v === "string" ? `"${v}"` : JSON.stringify(v);

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
    } else {
      out.push({
        field: f.field,
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
