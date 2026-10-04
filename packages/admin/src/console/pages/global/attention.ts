/**
 * What needs the operator, per product (ADMIN.md §6.1 "Attention items"), derived from data the
 * console already holds: the registry row. `GET /products` carries each product's setup state,
 * which the worker computes for every product on every read (`admin/lib/shape.ts`
 * `productSetupView`), so Home lists attention for all products with no fetch per product. The
 * kinds that need other per-product reads (readiness, rollouts, expiring licenses) join through
 * A-8's summary endpoint; until then Home does not guess at them.
 */

import type { ProductDetail, ProductSetupAction } from "../../../api.js";
import { r } from "../../routes.js";

export type AttentionTone = "danger" | "warning" | "info";

export type AttentionKind =
  | "secret.missing"
  | "secret.usage"
  | "signing.missing"
  | "mint.pending"
  | "release.health"
  | "onboarding.next";

export interface ProductAttention {
  /** Unique across products: `<slug>:<server action id>`. */
  id: string;
  product: { slug: string; name: string };
  kind: AttentionKind;
  tone: AttentionTone;
  /** One line: why it needs the operator. */
  reason: string;
  action: { label: string; href: string };
}

function actionsOf(p: ProductDetail): ProductSetupAction[] {
  const raw =
    p.setup?.nextActions ??
    p.onboarding?.nextActions ??
    p.onboarding?.setup?.nextActions ??
    [];
  if (!Array.isArray(raw)) return [];
  return raw.map((a, i) =>
    typeof a === "string" ? { id: `action-${i}`, label: a } : a,
  );
}

/** A server route (`#/p/x/…`) is followed through the router's redirects; anything else is not. */
function safeRoute(route: string | undefined, fallback: string): string {
  return route && route.startsWith("#/") ? route : fallback;
}

/** One product's attention items, from its setup state's next actions. */
export function attentionFor(p: ProductDetail): ProductAttention[] {
  const product = { slug: p.slug, name: p.name || p.slug };
  return actionsOf(p).map((a, i): ProductAttention => {
    const id = a.id ?? `action-${i}`;
    const base = { id: `${p.slug}:${id}`, product };
    const [prefix, ...rest] = id.split(":");
    const subject = rest.join(":");
    switch (prefix) {
      case "secret":
        return {
          ...base,
          kind: "secret.missing",
          tone: "warning",
          reason: `Missing required secret ${subject}`,
          action: { label: "Set secret", href: r.keys(p.slug) },
        };
      case "secret-usage":
        return {
          ...base,
          kind: "secret.usage",
          tone: "warning",
          reason: `Secret ${subject} is not marked for edge minting`,
          action: { label: "Open keys & secrets", href: r.keys(p.slug) },
        };
      case "signing-key":
        return {
          ...base,
          kind: "signing.missing",
          tone: "danger",
          reason: "No usable signing key: nothing this product signs verifies",
          action: { label: "Open settings", href: r.settings(p.slug) },
        };
      case "edge-mint":
        return {
          ...base,
          kind: "mint.pending",
          tone: "warning",
          reason: `Edge-mint recipe ${subject} awaits approval`,
          action: { label: "Review recipe", href: r.edgeMint(p.slug) },
        };
      case "release":
        return {
          ...base,
          kind: "release.health",
          tone: "info",
          reason: "Release setup is incomplete",
          action: { label: "Review releases", href: r.releases(p.slug) },
        };
      default:
        return {
          ...base,
          kind: "onboarding.next",
          tone: "info",
          reason: a.label ?? a.title ?? "Finish setting up this product",
          action: {
            label: "Open",
            href: safeRoute(a.route ?? a.href, r.overview(p.slug)),
          },
        };
    }
  });
}

/** Every product's attention items. */
export function attentionAcross(products: ProductDetail[]): ProductAttention[] {
  return products.flatMap(attentionFor);
}
