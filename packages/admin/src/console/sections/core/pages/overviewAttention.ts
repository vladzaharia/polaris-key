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
import type { NextStep } from "../model/integration.js";

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

/** This product's attention items: the server's read plus the licenses about to expire. */
export function productAttentionItems(
  slug: string,
  server: readonly AttentionItemDto[] | undefined,
  licenses: { status: string; expiresAt: number | null }[] | undefined,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const a of server ?? []) {
    if (a.product.slug !== slug) continue;
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
        service: "license",
        object: "Licenses",
        reason: `${formatCount(expiring)} ${expiring === 1 ? "license expires" : "licenses expire"} within 14 days.`,
        action: { label: "View", href: r.licenses(slug) },
      });
    }
  }
  return items;
}

/**
 * The hero's one next step (products.overview): the first attention item, else the integration
 * read's next step, else none (the caller's main action follows). `more` counts the attention
 * items behind the first. `issue` is true for an attention item: the hero then wears the warning
 * edge and the pill; a next step is plain.
 */
export interface HeroStep {
  issue: boolean;
  tone: AttentionItem["tone"];
  /** The service the step belongs to, for the subject's glyph and the hero's accent. */
  service: string | undefined;
  subject: string;
  statement: string;
  action: { label: string; href: string } | null;
  more: number;
}

export function heroStep(
  items: readonly AttentionItem[],
  next: NextStep | null,
  subjectOf: (service: string | undefined) => string,
): HeroStep | null {
  const first = items[0];
  if (first)
    return {
      issue: true,
      tone: first.tone,
      service: first.service,
      subject: subjectOf(first.service),
      statement: first.lines?.join(" ") ?? first.reason,
      action: first.action?.href
        ? { label: first.action.label, href: first.action.href }
        : null,
      more: items.length - 1,
    };
  if (next)
    return {
      issue: false,
      tone: "info",
      service: undefined,
      subject: "Integration",
      statement: next.reason,
      action: { label: next.text, href: next.to },
      more: 0,
    };
  return null;
}
