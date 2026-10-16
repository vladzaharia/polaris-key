import type { ConfigEntry, UserSettingConflict } from "@polaris-key/catalog";

import type { SchemaType } from "./CatalogEntryForm.js";
import { typeLabel } from "../../../../lib/labels.js";

/** The console's type, over the stored `kind` and `delivery` (U-30). */
export type EntryType = "setting" | "secret" | "minted" | "flag";

export const ENTRY_TYPE_LABELS: Record<EntryType, string> = {
  setting: "Setting",
  secret: "Secret",
  minted: typeLabel({ kind: "secret", delivery: "edgeMint" }),
  flag: "Flag",
};

export function entryType(entry: ConfigEntry): EntryType {
  if (entry.kind === "config") return "setting";
  if (entry.kind === "flag") return "flag";
  return entry.delivery === "edgeMint" ? "minted" : "secret";
}

/** What each in-app visibility means to the person using the app. */
export const IN_APP_HELP: Record<string, string> = {
  default:
    "Listed in the app's settings. People can change it, and their choice syncs.",
  enforced: "Listed, but only you can change it, here or in a profile.",
  hidden: "Not listed in the app. The app still reads the value.",
};

export const TYPE_LABELS: Record<SchemaType, string> = {
  string: "Text",
  integer: "Whole number",
  number: "Number",
  boolean: "On / off",
  array: "List (JSON)",
  object: "Object (JSON)",
};

/** Where a synced setting's value roams (plans/U-01b.md D2), in the console's words. A key that
 *  does not sync is `user: {sync: "local"}`, the Syncs switch turned off. */
export const USER_SCOPE_OPTIONS: {
  value: "user" | "platform";
  label: string;
}[] = [
  { value: "user", label: "Everywhere the person signs in" },
  { value: "platform", label: "Per platform family" },
];

export const USER_CONFLICT_LABELS: Record<UserSettingConflict, string> = {
  lastWrite: "Last write wins",
  max: "Keep the highest",
  min: "Keep the lowest",
  merge: "Merge members",
};

export const WIDGETS = [
  "password",
  "select",
  "textarea",
  "switch",
  "stepper",
] as const;
