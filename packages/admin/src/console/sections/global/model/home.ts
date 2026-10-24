/**
 * Home's pure model (ST-44): which features a product runs (one glyph each, in the canonical
 * order, never one per service), what the server's attention read says about them, and the
 * product table's filters. Attention itself is the server's (`GET /manage/api/attention`);
 * nothing here derives it.
 */

import type {
  AttentionItemDto,
  ProductDetail,
  ServiceSlug,
} from "../../../../api.js";
import { FEATURES, type FeatureRow } from "../../../../services.generated.js";
import { r } from "../../../routes.js";
import { globalPage, productPage } from "../../../routes.js";
import type { GlobalPageId } from "../../../nav.js";
import type { ProductPageId } from "../../../nav.js";

export type AttentionTone = "danger" | "warning";

/** A feature runs when any of its services does (Ship builds: release, distribution or update). */
export function runsFeature(p: ProductDetail, f: FeatureRow): boolean {
  return f.services.some((s) => p.services?.[s]?.enabled === true);
}

/** The features a product runs, in canonical order. */
export function runningFeatures(p: ProductDetail): FeatureRow[] {
  return FEATURES.filter((f) => runsFeature(p, f));
}

/** The feature a service belongs to. */
export function featureOfService(service: ServiceSlug): FeatureRow | null {
  return FEATURES.find((f) => f.services.includes(service)) ?? null;
}

/** Each service's landing page: where a feature's glyph on a card goes (its first service). */
const SERVICE_HOME: Record<ServiceSlug, (slug: string) => string> = {
  license: (slug) => r.licenses(slug),
  config: (slug) => r.catalog(slug),
  release: (slug) => r.releases(slug),
  distribution: (slug) => r.matrix(slug),
  update: (slug) => r.feed(slug),
  identity: (slug) => r.appSignIn(slug),
  sync: (slug) => r.syncData(slug),
  commerce: (slug) => r.commerceOverview(slug),
};

export function featureHref(f: FeatureRow, slug: string): string {
  return SERVICE_HOME[f.primary[0] ?? f.services[0]!](slug);
}

/** An attention item that belongs to a product (the platform's own has `product: null`). */
export type ProductAttentionItem = AttentionItemDto & {
  product: { slug: string; name: string };
};

/**
 * The server's read split once: a product's items feed its card, pill and facet; the platform's
 * own (the Cloud Sync pause) never do, so no product count is inflated by it.
 */
export function productItems(
  items: readonly AttentionItemDto[],
): ProductAttentionItem[] {
  return items.filter((a): a is ProductAttentionItem => a.product !== null);
}

export function platformItems(
  items: readonly AttentionItemDto[],
): AttentionItemDto[] {
  return items.filter((a) => a.product === null);
}

/** Where an attention item's fix lives: a product page, or a global page for a platform item. */
export function attentionHref(item: AttentionItemDto): string {
  if (item.product === null)
    return globalPage(item.action.page as GlobalPageId, item.action.query);
  return productPage(item.product.slug, item.action.page as ProductPageId, {
    query: item.action.query,
  });
}

const RANK: Record<AttentionTone, number> = { danger: 2, warning: 1 };

export function worstTone(
  items: readonly ProductAttentionItem[],
): AttentionTone {
  return items.reduce<AttentionTone>(
    (t, a) => (RANK[a.tone] > RANK[t] ? a.tone : t),
    "warning",
  );
}

/** The card's pill: the one issue named, or "N need attention". */
export function pillLabel(items: readonly ProductAttentionItem[]): string {
  return items.length === 1
    ? items[0]!.short
    : `${items.length} need attention`;
}

/** One feature's glyph on a card: its link, and the issues the attention read puts on it. */
export interface CardFeature {
  feature: FeatureRow;
  href: string;
  issues: ProductAttentionItem[];
  /** "Managed config: 1 needs attention", or the feature's label. */
  name: string;
}

export function cardFeatures(
  p: ProductDetail,
  attention: readonly ProductAttentionItem[],
): CardFeature[] {
  return runningFeatures(p).map((feature) => {
    const issues = attention.filter(
      (a) =>
        a.service !== null && featureOfService(a.service)?.id === feature.id,
    );
    return {
      feature,
      href: featureHref(feature, p.slug),
      issues,
      name:
        issues.length === 0
          ? feature.label
          : `${feature.label}: ${issues.length} ${issues.length === 1 ? "needs" : "need"} attention`,
    };
  });
}

/** "Licensing, Managed config: 1 needs attention, Ship builds": the pip row's one name. */
export function featuresSentence(features: readonly CardFeature[]): string {
  return features.length === 0
    ? "No features"
    : features.map((f) => f.name).join(", ");
}

/** The Home table's rows and filters. */
export interface HomeRow {
  product: ProductDetail;
  slug: string;
  name: string;
  attention: ProductAttentionItem[];
  verified: boolean;
  source: "github" | "manual";
}

export const HOME_FACETS = ["verified", "attention"] as const;

/** Search (name or slug) and the two facets; an empty selection filters nothing. */
export function filterHomeRows(
  rows: readonly HomeRow[],
  q: string,
  filters: Record<string, string[]>,
): HomeRow[] {
  const needle = q.trim().toLowerCase();
  const verified = filters.verified ?? [];
  const attention = filters.attention ?? [];
  return rows.filter(
    (row) =>
      (needle === "" ||
        row.name.toLowerCase().includes(needle) ||
        row.slug.toLowerCase().includes(needle)) &&
      (verified.length === 0 ||
        verified.includes(row.verified ? "yes" : "no")) &&
      (attention.length === 0 ||
        attention.includes(row.attention.length > 0 ? "yes" : "no")),
  );
}
