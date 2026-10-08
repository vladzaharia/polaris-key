import * as React from "react";
import { ArrowRight, Github, Plus } from "lucide-react";
import type { ProductDetail, ServiceSlug } from "../../../api.js";
import { formatCount } from "../../../lib/format.js";
import { releaseSourceOf } from "../../../lib/products.js";
import { SERVICE_TABLE } from "../../../services.generated.js";
import { Button } from "../../../ui/Button.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { ProductLogo } from "../../../ui/ProductLogo.js";
import { ServiceGlyph, serviceLabel } from "../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { useProducts } from "../../data/hooks.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
  useFirstLoad,
  type AttentionItem,
} from "../../templates/Dashboard.js";
import {
  attentionAcross,
  type AttentionTone,
  type ProductAttention,
} from "./attention.js";

/** Home shows the most recently changed products; Products is the whole registry (EXPERIENCE C17). */
export const HOME_PRODUCT_LIMIT = 6;

/** The services a product runs, in the service table's canonical order. */
export function runningServices(p: ProductDetail): ServiceSlug[] {
  return SERVICE_TABLE.map((s) => s.slug).filter(
    (slug) => p.services?.[slug]?.enabled === true,
  );
}

/** "Runs License, Config and Release", or "Runs no services". */
export function runsSentence(services: ServiceSlug[]): string {
  if (services.length === 0) return "Runs no services";
  const names = services.map((s) => serviceLabel(s));
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Runs ${list}`;
}

/** Newest change first, then by name: the products Home shows, capped at `limit`. */
export function recentProducts(
  products: ProductDetail[],
  limit: number = HOME_PRODUCT_LIMIT,
): ProductDetail[] {
  const byName = (a: ProductDetail, b: ProductDetail) =>
    (a.name || a.slug).localeCompare(b.name || b.slug);
  return [...products]
    .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || byName(a, b))
    .slice(0, limit);
}

/** Each service's landing page (`nav.ts`): where its icon on a card goes. */
const SERVICE_HOME: Record<ServiceSlug, (slug: string) => string> = {
  license: (slug) => r.licenses(slug),
  config: (slug) => r.catalog(slug),
  release: (slug) => r.releases(slug),
  distribution: (slug) => r.matrix(slug),
  update: (slug) => r.feed(slug),
  identity: (slug) => r.portal(slug),
  sync: (slug) => r.syncData(slug),
};

const TONE_RANK: Record<AttentionTone, number> = {
  danger: 3,
  warning: 2,
  info: 1,
};

function worstTone(items: ProductAttention[]): AttentionTone {
  return items.reduce<AttentionTone>(
    (t, a) => (TONE_RANK[a.tone] > TONE_RANK[t] ? a.tone : t),
    "info",
  );
}

/**
 * Home (ADMIN.md §6.1, T1): "what needs me across all products?". The Needs attention list
 * (every open item, each with its one fix), the fleet figures, and the most recently changed
 * products as cards that carry the product's logo and its services (owner request 2026-10-06,
 * docs/design/console-product-card/; simplified in the owner polish of 2026-10-07). The whole
 * registry, with search, sort and facets, is the Products page (EXPERIENCE C17). Healthy is
 * silence: no "Setup complete" tile or pill (C2).
 *
 * Recent activity across products needs A-2b (a platform-wide feed); without it the panel is
 * omitted rather than faked.
 *
 * Motion (MO-11): the Needs attention list staggers in when the products arrive on Home's first
 * visit in this document (`useFirstLoad`), never on a refetch or a return visit. The product cards
 * below do not stagger: the list is the one thing that enters.
 */
export function Home(): React.ReactElement {
  const products = useProducts();

  const list = React.useMemo(() => products.data ?? [], [products.data]);
  const attention = React.useMemo(() => attentionAcross(list), [list]);
  const byProduct = React.useMemo(() => {
    const m = new Map<string, ProductAttention[]>();
    for (const a of attention)
      m.set(a.product.slug, [...(m.get(a.product.slug) ?? []), a]);
    return m;
  }, [attention]);

  const loading = products.isPending;
  const failed = products.isError && !products.data;
  const firstLoad = useFirstLoad("home", loading);
  const description = loading
    ? "Loading your products"
    : `${formatCount(list.length)} ${list.length === 1 ? "product" : "products"}`;

  const header = (
    <PageHeader
      title="Home"
      description={description}
      freshness={
        products.dataUpdatedAt
          ? {
              updatedAt: products.dataUpdatedAt,
              onRefresh: () => void products.refetch(),
              refreshing: products.isFetching,
            }
          : undefined
      }
      primaryAction={
        // With no products, the empty state's own two calls to action are the way in.
        loading || list.length > 0 ? (
          <Button asChild>
            <Link to={r.productNew()}>
              <Plus aria-hidden />
              New product
            </Link>
          </Button>
        ) : undefined
      }
    />
  );

  if (failed) {
    return (
      <DashboardTemplate
        header={header}
        firstRun={
          <ErrorState
            error={products.error}
            onRetry={() => void products.refetch()}
          />
        }
      />
    );
  }

  if (!loading && list.length === 0) {
    return (
      <DashboardTemplate
        header={header}
        firstRun={
          <EmptyState
            kind="first-run"
            headingLevel={2}
            title="Register your first product"
            description={
              <>
                Link a GitHub repository with a <code>.pkey/</code> directory,
                or start manually and add a repository later.
              </>
            }
            primaryAction={
              <Button asChild>
                <Link to={r.productNew({ via: "github" })}>
                  <Github aria-hidden />
                  Link a repository
                </Link>
              </Button>
            }
            secondaryAction={
              <Button variant="outline" asChild>
                <Link to={r.productNew({ via: "manual" })}>Start manually</Link>
              </Button>
            }
            docs="/docs/admin/products/"
          />
        }
      />
    );
  }

  const linked = list.filter((p) => releaseSourceOf(p) === "github").length;
  const shown = recentProducts(list);

  const items: AttentionItem[] = attention.map((a: ProductAttention) => ({
    id: a.id,
    tone: a.tone,
    object: (
      <Link
        to={r.overview(a.product.slug)}
        className="text-fg-strong underline-offset-4 hover:underline"
      >
        {a.product.name}
      </Link>
    ),
    objectTitle: a.product.name,
    reason: a.reason,
    action: { label: a.action.label, href: a.action.href },
  }));

  return (
    <DashboardTemplate
      header={header}
      // Mounted with the data, so the first load's stagger starts with it (MO-11).
      attention={
        loading ? undefined : (
          <AttentionList items={items} stagger={firstLoad} />
        )
      }
      tiles={
        <>
          <StatTile
            label="Products"
            href={r.products()}
            loading={loading}
            value={formatCount(list.length)}
          />
          <StatTile
            label="Need attention"
            loading={loading}
            value={formatCount(byProduct.size)}
            secondary={
              attention.length > 0
                ? `${formatCount(attention.length)} open ${attention.length === 1 ? "item" : "items"}`
                : undefined
            }
          />
          <StatTile
            label="Linked to a repository"
            loading={loading}
            value={formatCount(linked)}
          />
        </>
      }
    >
      <Panel
        title="Recent products"
        action={
          <Link
            to={r.products()}
            className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
          >
            All products
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        }
      >
        {loading ? (
          <ul
            aria-label="Products"
            aria-busy
            className="pk-skeleton-group grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="pk-skeleton h-32 rounded-lg border border-border max-sm:h-12"
              />
            ))}
          </ul>
        ) : (
          <ul
            aria-label="Products"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {shown.map((p) => (
              <li key={p.slug} className="flex min-w-0">
                <ProductCard
                  product={p}
                  attention={byProduct.get(p.slug) ?? []}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </DashboardTemplate>
  );
}

/** A pill naming the issue, or counting several. */
function IssuePill({
  items,
  many,
  className,
}: {
  items: ProductAttention[];
  many: (n: number) => string;
  className?: string;
}): React.ReactElement {
  return (
    <StatusPill tone={worstTone(items)} size="sm" className={className}>
      {items.length === 1 ? items[0]!.short : many(items.length)}
    </StatusPill>
  );
}

/**
 * One product on Home (owner polish 2026-10-07: the simpler card that replaced the ledger of
 * docs/design/console-product-card/, direction B).
 *
 * The header holds the logo, the name and the slug, and a pill when the product needs something
 * (its one issue named, or "N need attention"; the Needs attention list above names each one).
 * The name is the card's one link to the product: its hit area stretches over the card
 * (`::after`), so a click anywhere opens Overview, and focus on it rings the whole card. Below it,
 * one row of icons, one per service the product runs, each named (`aria-label` and `title`) and
 * linking to that service's page as a sibling above the stretched name link, never nested in it.
 * Nothing else: no per-service facts, no rows, no footer. Healthy draws nothing (ADMIN.md §5.11).
 *
 * Below the small breakpoint the card is one line: the name, then one pip per service in that
 * service's accent (the brand's `data-service` tokens), the pips named together as an image
 * ("Runs License, Config and Release").
 */
export function ProductCard({
  product: p,
  attention,
}: {
  product: ProductDetail;
  attention: ProductAttention[];
}): React.ReactElement {
  const services = runningServices(p);
  const name = p.name || p.slug;
  const runs = runsSentence(services);

  return (
    <article
      aria-label={name}
      className="relative flex w-full min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 hover:border-border-strong light:shadow-elevation-1 has-[a[data-card-link]:focus-visible]:ring-2 has-[a[data-card-link]:focus-visible]:ring-focus has-[a[data-card-link]:focus-visible]:ring-offset-2 has-[a[data-card-link]:focus-visible]:ring-offset-background max-sm:flex-row max-sm:items-center max-sm:py-3"
    >
      <div
        data-card-header=""
        className="flex min-w-0 items-start gap-3 max-sm:flex-1 max-sm:items-center"
      >
        <ProductLogo
          name={name}
          presentation={p.presentation}
          size={40}
          className="max-sm:hidden"
        />
        <div className="min-w-0 flex-1">
          <h3
            className="line-clamp-2 break-words text-base font-semibold text-fg-strong max-sm:line-clamp-1"
            title={name}
          >
            <Link
              to={r.overview(p.slug)}
              data-card-link=""
              className="underline-offset-4 outline-hidden after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:underline focus-visible:ring-0 focus-visible:ring-offset-0"
            >
              {name}
            </Link>
          </h3>
          <p
            className="truncate font-mono text-xs text-fg-muted max-sm:hidden"
            title={p.slug}
          >
            {p.slug}
          </p>
        </div>
        {attention.length > 0 ? (
          <IssuePill
            items={attention}
            many={(n) => `${n} need attention`}
            className="max-sm:hidden"
          />
        ) : null}
      </div>
      {services.length === 0 ? (
        <p className="mt-auto border-t border-border pt-3 text-sm text-fg-muted max-sm:mt-0 max-sm:border-0 max-sm:pt-0">
          No services
        </p>
      ) : (
        <>
          <div className="mt-auto border-t border-border pt-2 max-sm:hidden">
            <ul
              aria-label="Services"
              data-service-icons=""
              className="-mx-1.5 flex flex-wrap items-center gap-0.5"
            >
              {services.map((s) => (
                <li key={s}>
                  <Link
                    to={SERVICE_HOME[s](p.slug)}
                    data-service-link={s}
                    aria-label={serviceLabel(s)}
                    title={serviceLabel(s)}
                    className="relative z-[1] grid size-8 place-items-center rounded-md hover:bg-surface-sunken"
                  >
                    <ServiceGlyph id={s} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <span
            role="img"
            aria-label={runs}
            title={runs}
            data-service-pips=""
            className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:hidden"
          >
            {services.map((s) => (
              <span
                key={s}
                data-service={s}
                data-pip={s}
                className="size-2.5 rounded-full bg-accent"
              />
            ))}
          </span>
        </>
      )}
    </article>
  );
}
