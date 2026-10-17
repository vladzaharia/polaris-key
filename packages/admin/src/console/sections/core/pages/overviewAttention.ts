/**
 * Overview's Needs attention items (OVR-2): operational problems only, from the product's setup
 * state and its licenses. Split out of `Overview.tsx` for the page budget.
 */

import { formatCount } from "../../../../lib/format.js";
import type { ProductDetail } from "../../../../api.js";
import type { AttentionItem } from "../../../templates/Dashboard.js";
import { r } from "../../../routes.js";

const DAY = 86_400;

export function useAttention(
  slug: string,
  p: ProductDetail,
  licenses: { status: string; expiresAt: number | null }[] | undefined,
  skipSigning = false,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const setup = p.setup;
  if (!p.signing?.publicKey && !skipSigning) {
    items.push({
      id: "signing",
      tone: "warning",
      object: "Signing key",
      reason: "Nothing can be signed until one is activated.",
      action: { label: "Keys & secrets", href: r.keys(slug) },
    });
  }
  for (const sec of setup?.secrets ?? []) {
    if (sec.configured) continue;
    items.push({
      id: `secret-${sec.name}`,
      tone: "warning",
      object: `Secret ${sec.name}`,
      reason: "Not set.",
      action: { label: "Set", href: r.keys(slug) },
    });
  }
  if (setup?.sync?.status === "error") {
    items.push({
      id: "sync",
      tone: "danger",
      object: "Manifest sync",
      reason:
        setup.sync.message ?? "The last resync from the repository failed.",
      action: { label: "Repository", href: `${r.settings(slug)}` },
    });
  }
  const edge = moduleOf(p, "edgeMint");
  for (const id of (edge?.pendingApproval as string[] | undefined) ?? []) {
    items.push({
      id: `edge-${id}`,
      tone: "warning",
      object: `Edge-mint recipe ${id}`,
      reason: "Mints nothing until it is approved as it stands.",
      action: { label: "Review", href: r.edgeMint(slug) },
    });
  }
  for (const w of setup?.warnings ?? []) {
    items.push({
      id: `warn-${w}`,
      tone: "warning",
      object: w.startsWith("release:") ? "Release" : "Setup",
      reason: w.replace(/^release:\s*/, ""),
      action: w.startsWith("release:")
        ? { label: "Releases", href: r.releases(slug) }
        : undefined,
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

function moduleOf(
  p: ProductDetail,
  id: string,
): Record<string, unknown> | undefined {
  const modules = p.setup?.modules;
  if (!Array.isArray(modules)) return undefined;
  return modules.find((m) => m.id === id) as
    | Record<string, unknown>
    | undefined;
}
