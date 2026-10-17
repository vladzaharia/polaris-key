import type { ConfigEntry } from "../../../../api.js";

/**
 * Retired catalog spellings, in the validator's own words (`warnRetiredCatalogFields` in
 * `@polaris-key/manifest`), each with the fix. An entry that carries one still works.
 */
export function retiredNotes(entry: ConfigEntry): string[] {
  const notes: string[] = [];
  if (entry.secret === true && entry.kind === "config")
    notes.push(
      'Use `kind: "secret"` instead of `secret: true` on a config entry. Make it a Secret.',
    );
  if (entry.secret === true && entry.kind === "secret")
    notes.push(
      "`secret: true` is redundant on a secret entry and is dropped: the kind already says it.",
    );
  if (entry.delivery === "serverOnly")
    notes.push(
      "`delivery: serverOnly` has no consumer. Keep a secret only the Worker reads in the product's secrets (Keys and secrets), not the catalog. Make it a Secret.",
    );
  return notes;
}

/** The Default cell and field: a minted token has none, a secret is write-only. */
export function defaultText(entry: ConfigEntry): string | null {
  if (entry.kind === "secret" && entry.delivery === "edgeMint")
    return "Minted on request";
  if (entry.kind === "secret" || entry.secret === true) return "(write-only)";
  return null;
}
