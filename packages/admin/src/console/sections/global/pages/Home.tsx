import * as React from "react";
import { Plus } from "lucide-react";
import type { AttentionItemDto } from "../../../../api.js";
import { releaseSourceOf } from "../../../../lib/products.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { GithubIcon } from "../../../../ui/GithubIcon.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useCan } from "../../../access/useCan.js";
import {
  useAttention,
  usePlatformReady,
  useProducts,
} from "../../../data/hooks.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import {
  AttentionList,
  useFirstLoad,
  type AttentionItem,
} from "../../../templates/Dashboard.js";
import {
  AllClear,
  CardSkeleton,
  LoadFailedCard,
} from "../components/HomeStates.js";
import { PlatformReady } from "../components/PlatformReady.js";
import { ProductShelf } from "../components/ProductShelf.js";
import { attentionHref, type HomeRow } from "../model/home.js";
import { cn } from "../../../../lib/cn.js";

/** The attention list's rows: the subject is the product, logo and name, linking to Overview. */
function attentionRows(
  items: readonly AttentionItemDto[],
  logo: (slug: string) => React.ReactNode,
): AttentionItem[] {
  return items.map((a) => ({
    id: a.id,
    tone: a.tone,
    object: (
      <Link
        to={r.overview(a.product.slug)}
        className="flex min-w-0 max-w-full items-start gap-2 text-fg-strong underline-offset-4 hover:underline"
      >
        {logo(a.product.slug)}
        <span className="min-w-0 line-clamp-2 break-words">
          {a.product.name}
        </span>
      </Link>
    ),
    objectTitle: a.product.name,
    reason: a.lines.join(" "),
    lines: a.lines,
    service: a.service ?? undefined,
    action: { label: a.action.label, href: attentionHref(a) },
  }));
}

/**
 * Home (ADMIN.md §6.1, ST-44): "what needs me, and where are my products?". Needs attention
 * (one server read, broken things only), Platform ready for a platform admin while it is
 * incomplete, and the products as cards or a table with filters. There are no tiles repeating the
 * attention count. Source order is attention, readiness, products, so every size keeps it: from
 * 1280 px attention takes two thirds and readiness the third beside it; from 1600 px readiness is
 * a 400 px aside beside both.
 *
 * Motion (MO-11): the Needs attention list staggers in when its data arrives on Home's first
 * visit in this document (`useFirstLoad`), never on a refetch or a return visit.
 */
export function Home(): React.ReactElement {
  const products = useProducts();
  const attention = useAttention();
  // ST-29: creating a product is the Platform area's, and so is the readiness read.
  const create = useWriteGate("platform");
  const platform = useCan("platform");
  const ready = usePlatformReady(platform);

  const list = React.useMemo(() => products.data ?? [], [products.data]);
  const bySlug = React.useMemo(() => {
    const m = new Map<string, AttentionItemDto[]>();
    for (const a of attention.data ?? [])
      m.set(a.product.slug, [...(m.get(a.product.slug) ?? []), a]);
    return m;
  }, [attention.data]);
  const rows: HomeRow[] = React.useMemo(
    () =>
      [...list]
        .sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug))
        .map((p) => ({
          product: p,
          slug: p.slug,
          name: p.name || p.slug,
          attention: bySlug.get(p.slug) ?? [],
          verified: p.verified === true,
          source: releaseSourceOf(p),
        })),
    [list, bySlug],
  );

  // The slot is decided by who is asking (`/me`), never by what the read returns: a platform
  // admin's Platform ready has its place from the first paint, and leaves it only when complete.
  const readyOpen =
    platform && !(ready.data && ready.data.done >= ready.data.total);
  const loading = products.isPending;
  const failed = products.isError && !products.data;
  const firstLoad = useFirstLoad("home", attention.isPending);
  const logoOf = React.useCallback(
    (slug: string) => {
      const p = list.find((x) => x.slug === slug);
      return p ? (
        <ProductLogo
          name={p.name || p.slug}
          presentation={p.presentation}
          size={24}
        />
      ) : null;
    },
    [list],
  );

  const header = (
    <PageHeader
      title="Home"
      freshness={
        products.dataUpdatedAt
          ? {
              updatedAt: products.dataUpdatedAt,
              onRefresh: () => {
                void products.refetch();
                void attention.refetch();
                if (platform) void ready.refetch();
              },
              refreshing: products.isFetching || attention.isFetching,
            }
          : undefined
      }
      primaryAction={
        // With no products, the empty state's own two calls to action are the way in.
        platform && (loading || list.length > 0) ? (
          <Button asChild disabledReason={create.disabledReason}>
            <Link to={r.productNew()}>
              <Plus aria-hidden />
              New product
            </Link>
          </Button>
        ) : undefined
      }
    />
  );

  if (failed)
    return (
      <div className="space-y-6" data-template="dashboard">
        {header}
        <ErrorState
          error={products.error}
          onRetry={() => void products.refetch()}
        />
      </div>
    );

  if (!loading && list.length === 0)
    return (
      <div className="space-y-6" data-template="dashboard">
        {header}
        <EmptyState
          kind="first-run"
          headingLevel={2}
          title="Register your first product"
          description={
            <>
              Link a GitHub repository with a <code>.pkey/</code> directory, or
              start manually and add a repository later.
            </>
          }
          primaryAction={
            <Button asChild>
              <Link to={r.productNew({ via: "github" })}>
                <GithubIcon aria-hidden />
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
        {readyOpen && ready.data && Array.isArray(ready.data.rows) ? (
          <PlatformReady ready={ready.data} />
        ) : null}
      </div>
    );

  const items = attentionRows(attention.data ?? [], logoOf);
  const attentionSlot = attention.isPending ? (
    <CardSkeleton label="Needs attention" rows={2} />
  ) : attention.isError ? (
    <LoadFailedCard
      title="Needs attention"
      message="What needs attention didn't load."
      onRetry={() => void attention.refetch()}
    />
  ) : items.length > 0 ? (
    <AttentionList items={items} max={6} stagger={firstLoad} />
  ) : (
    <AllClear />
  );
  const readySlot = !readyOpen ? null : ready.isPending ? (
    <CardSkeleton label="Platform ready" rows={3} className={READY_AREA} />
  ) : ready.isError || !Array.isArray(ready.data?.rows) ? (
    <LoadFailedCard
      title="Platform ready"
      message="Platform ready didn't load."
      onRetry={() => void ready.refetch()}
      className={READY_AREA}
    />
  ) : (
    <PlatformReady ready={ready.data} className={READY_AREA} />
  );

  return (
    // The page is its own container: the split follows the content column's width, so a larger
    // text size or a narrow window stacks the cards instead of squeezing them.
    <div className="@container space-y-6" data-template="dashboard">
      {header}
      <div
        data-home-grid=""
        data-top-aligned=""
        className={cn(
          "grid grid-cols-1 items-start gap-6",
          readyOpen &&
            "@[60rem]:grid-cols-[minmax(0,2fr)_minmax(17.5rem,1fr)] @[80rem]:grid-cols-[minmax(0,1fr)_25rem]",
        )}
      >
        {attentionSlot}
        {readySlot}
        <div
          className={cn(
            "min-w-0",
            readyOpen &&
              "@[60rem]:col-span-2 @[80rem]:col-span-1 @[80rem]:col-start-1 @[80rem]:row-start-2",
          )}
        >
          <ProductShelf rows={rows} loading={loading} />
        </div>
      </div>
    </div>
  );
}

/** Platform ready beside the cards: below the split it stacks, at 80rem it is the aside. */
const READY_AREA =
  "@[80rem]:col-start-2 @[80rem]:row-span-2 @[80rem]:row-start-1";
