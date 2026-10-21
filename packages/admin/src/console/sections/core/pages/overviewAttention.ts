/**
 * Overview's Needs attention items (OVR-2): the server's attention read for this product (missing
 * secrets, a failed resync, a pending edge-mint recipe, an expiring store credential; the same
 * items Home lists) plus the licences about to expire. Split out of `Overview.tsx` for the page
 * budget.
 */

import * as React from "react";
import { useAttention } from "../../../data/hooks.js";
import { formatCount } from "../../../../lib/format.js";
import type { AttentionItemDto } from "../../../../api.js";
import type { AttentionItem } from "../../../templates/Dashboard.js";
import { attentionHref } from "../../global/model/home.js";
import { r } from "../../../routes.js";

const DAY = 86_400;

/**
 * True until the attention read first answers. Only that first answer holds the page skeleton: a
 * failed read refetches when the page remounts, and would otherwise flip it back in a loop.
 */
export function useAttentionPending(): boolean {
  const attention = useAttention();
  const seen = React.useRef(false);
  if (!attention.isPending) seen.current = true;
  return !seen.current && attention.isPending;
}

/**
 * `skip` drops the signing-key and recipe items the Integration card's next step already says.
 * The caller also skips them while that read is pending, so the first-load stagger never lifts
 * an item the next step then takes back.
 */
export function productAttentionItems(
  slug: string,
  server: readonly AttentionItemDto[] | undefined,
  licenses: { status: string; expiresAt: number | null }[] | undefined,
  skip: { signing?: boolean; recipes?: boolean } = {},
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const a of server ?? []) {
    if (a.product.slug !== slug) continue;
    if (skip.signing && a.kind === "signing.missing") continue;
    if (skip.recipes && a.kind === "mint.pending") continue;
    items.push({
      id: a.id,
      tone: a.tone,
      object: a.short,
      reason: a.lines.join(" "),
      lines: a.lines,
      service: a.service ?? undefined,
      action: { label: a.action.label, href: attentionHref(a) },
    });
  }
  if (licenses) {
    const now = Date.now() / 1000;
    const expiring = licenses.filter(
      (l) =>
        l.status === "active" &&
        l.expiresAt !== null &&
        l.expiresAt > now &&
        l.expiresAt - now <= 14 * DAY,
    ).length;
    if (expiring > 0) {
      items.push({
        id: "expiring",
        tone: "warning",
        object: "Licenses",
        reason: `${formatCount(expiring)} ${expiring === 1 ? "license expires" : "licenses expire"} within 14 days.`,
        action: { label: "View", href: r.licenses(slug) },
      });
    }
  }
  return items;
}
