/** The ways to add (PS-06): the kinds a listing may offer, and the stored list after a switch. */

import type { ObtainPathKind } from "../../../../api.js";

export const ALL_KINDS: readonly ObtainPathKind[] = [
  "group",
  "auto_issue",
  "open",
  "store_owned",
  "product_idp",
  "email_domain",
];

/** The ways to add, as the stored list: `null` again once every kind is on. */
export function nextOfferPaths(
  current: readonly ObtainPathKind[] | null,
  path: ObtainPathKind,
  on: boolean,
): ObtainPathKind[] | null {
  const set = new Set(current ?? ALL_KINDS);
  if (on) set.add(path);
  else set.delete(path);
  const next = ALL_KINDS.filter((k) => set.has(k));
  return next.length === ALL_KINDS.length ? null : next;
}
