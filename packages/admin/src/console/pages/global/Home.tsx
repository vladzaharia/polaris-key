import * as React from "react";
import { ArrowRight, Github, Plus } from "lucide-react";
import type { ProductDetail, ServiceSlug } from "../../../api.js";
import { formatCount, fromSeconds } from "../../../lib/format.js";
import { releaseSourceOf } from "../../../lib/products.js";
import { SERVICE_TABLE } from "../../../services.generated.js";
import { Button } from "../../../ui/Button.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { ProductLogo } from "../../../ui/ProductLogo.js";
import { ServiceGlyph, serviceLabel } from "../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useMe, useProducts } from "../../data/hooks.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
  type AttentionItem,
} from "../../templates/Dashboard.js";
import {
  attentionAcross,
  type AttentionTone,
  type ProductAttention,
} from "./attention.js";

/** Home shows the most recently changed products; Products is the whole registry (EXPERIENCE C17). */
export const HOME_PRODUCT_LIMIT = 6;

/** A card lists at most this many rows: past it, three rows and the rest as glyph links. */
export const LEDGER_MAX_ROWS = 4;

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

/**
 * Which services get a row and which collapse into the last row's glyph links. Up to
 * `LEDGER_MAX_ROWS` services each get a row. Past that, three rows (services with an issue first,
 * then the service table's order) and the rest as links; the rows keep the table's order.
 */
export function ledgerRows(
  services: ServiceSlug[],
  withIssues: ReadonlySet<ServiceSlug>,
): { rows: ServiceSlug[]; more: ServiceSlug[] } {
  if (services.length <= LEDGER_MAX_ROWS) return { rows: services, more: [] };
  const ordered = [
    ...services.filter((s) => withIssues.has(s)),
    ...services.filter((s) => !withIssues.has(s)),
  ];
  const picked = new Set(ordered.slice(0, LEDGER_MAX_ROWS - 1));
  return {
    rows: services.filter((s) => picked.has(s)),
    more: services.filter((s) => !picked.has(s)),
  };
}

/** Each service's landing page (`nav.ts`): where its row and its glyph link go. */
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
 * docs/design/console-product-card/). The whole registry, with search, sort and facets, is the
 * Products page (EXPERIENCE C17). Healthy is silence: no "Setup complete" tile or pill (C2).
 *
 * Recent activity across products needs A-2b (a platform-wide feed); without it the panel is
 * omitted rather than faked.
 */
export function Home(): React.ReactElement {
  const products = useProducts();
  const me = useMe();

  const list = React.useMemo(() => products.data ?? [], [products.data]);
  const attention = React.useMemo(() => attentionAcross(list), [list]);
  const byProduct = React.useMemo(() => {
    const m = new Map<string, ProductAttention[]>();
    for (const a of attention)
      m.set(a.product.slug, [...(m.get(a.product.slug) ?? []), a]);
    return m;
  }, [attention]);
  const schemaVersions = React.useMemo(
    () =>
      new Map((me.data?.products ?? []).map((p) => [p.slug, p.schemaVersion])),
    [me.data],
  );

  const loading = products.isPending;
  const failed = products.isError && !products.data;
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
      attention={<AttentionList items={items} />}
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
                className="pk-skeleton h-40 rounded-lg border border-border"
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
                  schemaVersion={schemaVersions.get(p.slug)}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </DashboardTemplate>
  );
}

/** One service's fact on the card, or `null` when it has none to show. */
function serviceFact(
  service: ServiceSlug,
  schemaVersion: number | undefined,
): string | null {
  // Schema vN rides `/me`, which the shell has already loaded (`getActiveSchema`).
  if (service === "config" && schemaVersion !== undefined)
    return schemaVersion > 0 ? `Schema v${schemaVersion}` : "No catalog";
  return null;
}

/** A pill naming the issue, or counting several. */
function IssuePill({
  items,
  many,
}: {
  items: ProductAttention[];
  many: (n: number) => string;
}): React.ReactElement {
  return (
    <StatusPill tone={worstTone(items)} size="sm">
      {items.length === 1 ? items[0]!.short : many(items.length)}
    </StatusPill>
  );
}

/**
 * One product on Home, as a ledger (docs/design/console-product-card/, direction B).
 *
 * The header holds the logo, the name and the slug. The name is the card's one link to the
 * product: its hit area stretches over the card (`::after`), so a click anywhere opens Overview.
 * Each service the product runs is a row below: its glyph and label, and either its one fact at
 * the right edge or, when it needs something, a pill naming the problem. A row is a link (to the
 * fix when it carries a pill, to the service's page otherwise) that sits above the stretched name
 * link as a sibling, never nested in it. Past four services, three rows and the rest as glyph
 * links. Only an issue that belongs to the product itself (a signing key, its setup) is a pill in
 * the header. Healthy draws nothing (ADMIN.md §5.11).
 *
 * Focus on the name rings the whole card; focus on a service rings only that link.
 */
export function ProductCard({
  product: p,
  attention,
  schemaVersion,
}: {
  product: ProductDetail;
  attention: ProductAttention[];
  schemaVersion?: number;
}): React.ReactElement {
  const services = runningServices(p);
  const running = new Set(services);
  const name = p.name || p.slug;
  const issuesOf = new Map<ServiceSlug, ProductAttention[]>();
  const productIssues: ProductAttention[] = [];
  for (const a of attention) {
    if (a.service && running.has(a.service))
      issuesOf.set(a.service, [...(issuesOf.get(a.service) ?? []), a]);
    else productIssues.push(a);
  }
  const { rows, more } = ledgerRows(services, new Set(issuesOf.keys()));
  const syncedAt = p.setup?.sync?.lastSyncedAt;
  const synced =
    releaseSourceOf(p) === "github" && typeof syncedAt === "number";

  return (
    <article
      aria-label={name}
      className="relative flex w-full min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 hover:border-border-strong light:shadow-elevation-1 has-[a[data-card-link]:focus-visible]:ring-2 has-[a[data-card-link]:focus-visible]:ring-focus has-[a[data-card-link]:focus-visible]:ring-offset-2 has-[a[data-card-link]:focus-visible]:ring-offset-background"
    >
      <div data-card-header="" className="flex items-start gap-3">
        <ProductLogo name={name} presentation={p.presentation} size={40} />
        <div className="min-w-0 flex-1">
          <h3
            className="line-clamp-2 break-words text-base font-semibold text-fg-strong"
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
            className="truncate font-mono text-xs text-fg-muted"
            title={p.slug}
          >
            {p.slug}
          </p>
        </div>
        {productIssues.length > 0 ? (
          <IssuePill
            items={productIssues}
            many={(n) => `${n} need attention`}
          />
        ) : null}
      </div>
      {services.length === 0 ? (
        <p className="border-t border-border pt-3 text-sm text-fg-muted">
          No services
        </p>
      ) : (
        <ul
          aria-label="Services"
          className="flex flex-col border-t border-border pt-2"
        >
          {rows.map((s) => {
            const issues = issuesOf.get(s) ?? [];
            const fact = serviceFact(s, schemaVersion);
            return (
              <li key={s} className="-mx-2">
                <Link
                  to={
                    issues.length
                      ? issues[0]!.action.href
                      : SERVICE_HOME[s](p.slug)
                  }
                  data-service-row={s}
                  className="relative z-[1] grid h-8 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 text-sm hover:bg-surface-sunken max-sm:h-11"
                >
                  <ServiceGlyph id={s} />
                  <span className="truncate text-fg">{serviceLabel(s)}</span>
                  {issues.length > 0 ? (
                    <IssuePill items={issues} many={(n) => `${n} issues`} />
                  ) : fact ? (
                    <span className="whitespace-nowrap text-fg-muted tabular-nums">
                      {fact}
                    </span>
                  ) : (
                    <span />
                  )}
                </Link>
              </li>
            );
          })}
          {more.length > 0 ? (
            <li className="-mx-1 flex h-8 items-center gap-1 max-sm:h-11">
              {more.map((s) => (
                <Link
                  key={s}
                  to={SERVICE_HOME[s](p.slug)}
                  data-service={s}
                  aria-label={serviceLabel(s)}
                  title={serviceLabel(s)}
                  className="relative z-[1] grid size-7 place-items-center rounded-md hover:bg-accent-subtle max-sm:size-11"
                >
                  <ServiceGlyph id={s} />
                </Link>
              ))}
              <span className="ml-auto pr-1 text-xs text-fg-muted">
                {more.length} more
              </span>
            </li>
          ) : null}
        </ul>
      )}
      <p className="mt-auto text-xs text-fg-muted">
        {synced ? (
          <>
            Synced <Timestamp at={fromSeconds(syncedAt)} />
          </>
        ) : Number.isFinite(p.modifiedAt) ? (
          <>
            Changed <Timestamp at={fromSeconds(p.modifiedAt)} />
          </>
        ) : null}
      </p>
    </article>
  );
}
