import * as React from "react";
import { Github, Plus, Search } from "lucide-react";
import type { ProductDetail, ServiceSlug } from "../../../api.js";
import { formatCount, fromSeconds } from "../../../lib/format.js";
import { label, PROVIDER_LABELS } from "../../../lib/labels.js";
import { releaseSourceOf } from "../../../lib/products.js";
import { SERVICE_TABLE } from "../../../services.generated.js";
import { Button } from "../../../ui/Button.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Input } from "../../../ui/Input.js";
import { Select } from "../../../ui/Select.js";
import { ServiceGlyph, serviceLabel } from "../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProducts } from "../../data/hooks.js";
import { codecs, Link, useSearchParam } from "../../router.js";
import { r } from "../../routes.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
  type AttentionItem,
} from "../../templates/Dashboard.js";
import { attentionAcross, type ProductAttention } from "./attention.js";

const SORTS = ["recent", "name", "attention"] as const;
type HomeSort = (typeof SORTS)[number];
const SORT_LABELS: Record<HomeSort, string> = {
  recent: "Recently changed",
  name: "Name",
  attention: "Needs attention",
};
const sortCodec = codecs.oneOf(SORTS, "recent");
const qCodec = codecs.string();

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

/** Does a product match a Home filter (name or slug, case-insensitive)? */
export function matchesProduct(p: ProductDetail, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    p.slug.toLowerCase().includes(needle) ||
    (p.name ?? "").toLowerCase().includes(needle)
  );
}

function sortProducts(
  products: ProductDetail[],
  sort: HomeSort,
  counts: Map<string, number>,
): ProductDetail[] {
  const byName = (a: ProductDetail, b: ProductDetail) =>
    (a.name || a.slug).localeCompare(b.name || b.slug);
  return [...products].sort((a, b) => {
    if (sort === "name") return byName(a, b);
    if (sort === "attention") {
      return (
        (counts.get(b.slug) ?? 0) - (counts.get(a.slug) ?? 0) || byName(a, b)
      );
    }
    return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || byName(a, b);
  });
}

/**
 * Home (ADMIN.md §6.1, T1): "what needs me across all products?". Fixes DSH-1 to DSH-7: no
 * constant tiles (every figure is live), the list refreshes with the registry query (SH-1), the
 * product name is the link and "Open" is explicit (no hover-only card), no schema jargon, one
 * name for the registry ("Products"), the first-run state opens the wizard, and the cards can be
 * filtered and sorted (both in the URL) and show what each product runs and whether it is healthy.
 *
 * Recent activity across products needs A-2b (a platform-wide feed); without it the panel is
 * omitted rather than faked.
 */
export function Home(): React.ReactElement {
  const products = useProducts();
  const [q, setQ] = useSearchParam("q", qCodec);
  const [sort, setSort] = useSearchParam("sort", sortCodec);

  const list = React.useMemo(() => products.data ?? [], [products.data]);
  const attention = React.useMemo(() => attentionAcross(list), [list]);
  const counts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const a of attention)
      m.set(a.product.slug, (m.get(a.product.slug) ?? 0) + 1);
    return m;
  }, [attention]);

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

  const healthy = list.filter((p) => !counts.get(p.slug)).length;
  const linked = list.filter((p) => releaseSourceOf(p) === "github").length;
  const shown = sortProducts(
    list.filter((p) => matchesProduct(p, q)),
    sort,
    counts,
  );

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
            value={formatCount(counts.size)}
            secondary={
              attention.length > 0
                ? `${formatCount(attention.length)} open ${attention.length === 1 ? "item" : "items"}`
                : undefined
            }
          />
          <StatTile
            label="Setup complete"
            loading={loading}
            value={`${formatCount(healthy)} of ${formatCount(list.length)}`}
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
        title="All products"
        action={
          <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:w-auto">
            <Input
              aria-label="Filter products"
              placeholder="Filter products"
              prefix={<Search aria-hidden className="size-4" />}
              clearable
              value={q}
              onValueChange={setQ}
              className="w-full sm:w-56"
            />
            <Select
              aria-label="Sort products"
              value={sort}
              onChange={(v) => setSort((v ?? "recent") as HomeSort)}
              options={SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
              className="w-36 sm:w-44"
            />
          </div>
        }
      >
        {loading ? (
          <ul
            aria-label="Products"
            aria-busy
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="h-40 animate-pulse rounded-lg border border-border bg-surface-sunken motion-reduce:animate-none"
              />
            ))}
          </ul>
        ) : shown.length === 0 ? (
          <EmptyState
            kind="no-results"
            title="No products match"
            filters={`name or slug: ${q}`}
            onClearFilters={() => setQ("")}
          />
        ) : (
          <ul
            aria-label="Products"
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {shown.map((p) => (
              <li key={p.slug}>
                <ProductCard product={p} attention={counts.get(p.slug) ?? 0} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </DashboardTemplate>
  );
}

/**
 * One product on Home. The name is the one link (DSH-3); its hit area stretches over the whole
 * card (a pseudo-element), so a click anywhere opens the product without a second "Open" link.
 */
function ProductCard({
  product: p,
  attention,
}: {
  product: ProductDetail;
  attention: number;
}): React.ReactElement {
  const services = runningServices(p);
  const name = p.name || p.slug;
  return (
    <article
      aria-label={name}
      className="relative flex h-full flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 hover:border-border-strong has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-fg-strong">
            <Link
              to={r.overview(p.slug)}
              className="underline-offset-4 outline-hidden after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:underline focus-visible:ring-0"
            >
              {name}
            </Link>
          </h3>
          <p className="truncate font-mono text-xs text-fg-muted">{p.slug}</p>
        </div>
        <span className="shrink-0 text-xs text-fg-muted">
          {label(PROVIDER_LABELS, releaseSourceOf(p))}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {services.map((s) => (
          <ServiceGlyph key={s} id={s} />
        ))}
        <span className={services.length ? "sr-only" : "text-xs text-fg-muted"}>
          {runsSentence(services)}
        </span>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        {attention > 0 ? (
          <StatusPill tone="warning" size="sm">
            {attention === 1
              ? "1 needs attention"
              : `${attention} need attention`}
          </StatusPill>
        ) : (
          <StatusPill tone="success" size="sm">
            Setup complete
          </StatusPill>
        )}
        {Number.isFinite(p.modifiedAt) ? (
          <span className="text-xs text-fg-muted">
            Changed <Timestamp at={fromSeconds(p.modifiedAt)} />
          </span>
        ) : null}
      </div>
    </article>
  );
}
