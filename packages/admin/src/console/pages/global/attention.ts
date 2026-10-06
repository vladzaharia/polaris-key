/**
 * What needs the operator, per product (ADMIN.md §6.1 "Attention items"), derived from data the
 * console already holds: the registry row. `GET /products` carries each product's setup state,
 * which the worker computes for every product on every read (`admin/lib/shape.ts`
 * `productSetupView`), so Home lists attention for all products with no fetch per product. The
 * kinds that need other per-product reads (readiness, rollouts, expiring licenses) join through
 * A-8's summary endpoint; until then Home does not guess at them.
 */

import type {
  ProductDetail,
  ProductSetupAction,
  ServiceSlug,
} from "../../../api.js";
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
  /**
   * The service the item belongs to, so Home's product card can put the pill in that service's
   * row (docs/design/console-product-card/); `null` for the product itself (its signing key, its
   * setup, a secret nothing names).
   */
  service: ServiceSlug | null;
  /** The pill's word on the card: the problem in two or three words ("Needs approval"). */
  short: string;
  action: { label: string; href: string };
}

/**
 * Which service needs a product secret, from what the setup state says names it
 * (`setup.secrets[].sources`, worker `collectRequiredSecrets`): the custom OIDC client secret is
 * Identity's, an edge-mint recipe's signing key is Config's (Edge mint lives under Config).
 */
function secretService(p: ProductDetail, name: string): ServiceSlug | null {
  const sources = p.setup?.secrets?.find((s) => s.name === name)?.sources ?? [];
  if (sources.some((s) => s.startsWith("OIDC"))) return "identity";
  if (sources.some((s) => s.startsWith("Edge mint"))) return "config";
  return null;
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

/**
 * One product's attention items: its setup state's next actions, plus every missing required
 * secret and an unexplained "needs attention" status, so Home, Products and the product's
 * Overview checklist (which reads the same setup state) never disagree.
 */
export function attentionFor(p: ProductDetail): ProductAttention[] {
  const product = { slug: p.slug, name: p.name || p.slug };
  const items = fromActions(p, product);
  const ids = new Set(items.map((i) => i.id));
  const missing = new Set([
    ...(p.setup?.missingSecrets ?? []),
    ...(p.setup?.secrets ?? []).filter((s) => !s.configured).map((s) => s.name),
  ]);
  for (const name of missing) {
    const id = `${p.slug}:secret:${name}`;
    if (ids.has(id)) continue;
    items.push({
      id,
      product,
      kind: "secret.missing",
      tone: "warning",
      reason: `Missing required secret ${name}`,
      service: secretService(p, name),
      short: "Secret missing",
      action: { label: "Set secret", href: r.keys(p.slug) },
    });
  }
  const modules = Array.isArray(p.setup?.modules) ? p.setup.modules : [];
  for (const m of modules as unknown as Record<string, unknown>[]) {
    if (m.id !== "edgeMint") continue;
    for (const recipe of (m.pendingApproval as string[] | undefined) ?? []) {
      const id = `${p.slug}:edge-mint:${recipe}`;
      if (ids.has(id)) continue;
      items.push({
        id,
        product,
        kind: "mint.pending",
        tone: "warning",
        reason: `Edge-mint recipe ${recipe} awaits approval`,
        service: "config",
        short: "Needs approval",
        action: { label: "Review recipe", href: r.edgeMint(p.slug) },
      });
    }
  }
  const status = p.setup?.status;
  if (
    items.length === 0 &&
    status &&
    !["ok", "complete", "healthy"].includes(status)
  ) {
    items.push({
      id: `${p.slug}:setup`,
      product,
      kind: "onboarding.next",
      tone: "info",
      reason: "Setup is not finished",
      service: null,
      short: "Setup not finished",
      action: { label: "Open", href: r.overview(p.slug) },
    });
  }
  return items;
}

function fromActions(
  p: ProductDetail,
  product: { slug: string; name: string },
): ProductAttention[] {
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
          service: secretService(p, subject),
          short: "Secret missing",
          action: { label: "Set secret", href: r.keys(p.slug) },
        };
      case "secret-usage":
        return {
          ...base,
          kind: "secret.usage",
          tone: "warning",
          reason: `Secret ${subject} is not marked for edge minting`,
          service: "config",
          short: "Secret not marked",
          action: { label: "Open keys & secrets", href: r.keys(p.slug) },
        };
      case "signing-key":
        return {
          ...base,
          kind: "signing.missing",
          tone: "danger",
          reason: "No usable signing key: nothing this product signs verifies",
          service: null,
          short: "No signing key",
          action: { label: "Open settings", href: r.settings(p.slug) },
        };
      case "edge-mint":
        return {
          ...base,
          kind: "mint.pending",
          tone: "warning",
          reason: `Edge-mint recipe ${subject} awaits approval`,
          service: "config",
          short: "Needs approval",
          action: { label: "Review recipe", href: r.edgeMint(p.slug) },
        };
      case "release":
        return {
          ...base,
          kind: "release.health",
          tone: "info",
          reason: "Release setup is incomplete",
          service: "release",
          short: "Needs setup",
          action: { label: "Review releases", href: r.releases(p.slug) },
        };
      default:
        return {
          ...base,
          kind: "onboarding.next",
          tone: "info",
          reason: a.label ?? a.title ?? "Finish setting up this product",
          service: null,
          short: "Setup not finished",
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
