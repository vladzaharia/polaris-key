import * as React from "react";
import { Eye, Plus } from "lucide-react";
import type { AttentionItemDto } from "../../../../api.js";
import { releaseSourceOf } from "../../../../lib/products.js";
import { ActionMenu } from "../../../../ui/ActionMenu.js";
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
  useMe,
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
import { useSetupGuideHidden } from "../model/setupGuide.js";
import { cn } from "../../../../lib/cn.js";
import { toast } from "../../../../ui/toast.js";

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
  const operator = useMe().data?.sub;
  const [guideHidden, setGuideHidden] = useSetupGuideHidden(operator);

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
  const allDone = Boolean(ready.data && ready.data.done >= ready.data.total);
  const readyShown = platform && !guideHidden;
  // The card takes a column beside attention; the finished one-line guide takes a row.
  const readyOpen = readyShown && !allDone;
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

  /** Ask a failed read again; once it answers, focus the card's heading (the card was replaced). */
  const retry = async (
    refetch: () => Promise<{ isSuccess: boolean }>,
    heading: string,
  ): Promise<void> => {
    if ((await refetch()).isSuccess)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(heading)?.focus(),
      );
  };
  const items = attentionRows(attention.data ?? [], logoOf);
  // The grid splits only when attention has rows to show (or is still loading or failed, so its
  // card holds the slot): a healthy platform's one-line all-clear never leaves a void beside the
  // guide, which then takes the row under it.
  const split =
    readyOpen && (attention.isPending || attention.isError || items.length > 0);
  const attentionSlot = attention.isPending ? (
    <CardSkeleton label="Needs attention" rows={2} />
  ) : attention.isError ? (
    <LoadFailedCard
      title="Needs attention"
      message="What needs attention didn't load."
      onRetry={() => retry(attention.refetch, "[data-home-grid] > section h2")}
    />
  ) : items.length > 0 ? (
    <AttentionList items={items} max={6} stagger={firstLoad} />
  ) : (
    <AllClear />
  );
  const dismissGuide = (): void => {
    setGuideHidden(true);
    toast.info("Platform ready hidden", {
      id: "platform-ready-hidden",
      description: "Show it again from Home's menu or Platform settings.",
      action: { label: "Undo", onClick: restoreGuide },
    });
    // The card is gone: focus goes on to the Products heading, never to the page.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>("[data-products-heading]")?.focus(),
    );
  };
  const restoreGuide = (): void => {
    setGuideHidden(false);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>("[data-platform-ready] h2")?.focus(),
    );
  };
  const readySlot = !readyShown ? null : ready.isPending ? (
    <CardSkeleton
      label="Platform ready"
      rows={3}
      className={split ? READY_AREA : undefined}
    />
  ) : ready.isError || !Array.isArray(ready.data?.rows) ? (
    <LoadFailedCard
      title="Platform ready"
      message="Platform ready didn't load."
      onRetry={() => retry(ready.refetch, "[data-platform-ready] h2")}
      className={split ? READY_AREA : undefined}
    />
  ) : (
    <PlatformReady
      ready={ready.data}
      onDismiss={dismissGuide}
      className={split ? READY_AREA : allDone ? READY_LINE : undefined}
    />
  );
  // A dismissed guide comes back from the header's menu; with nothing hidden there is no menu.
  const guideMenu =
    platform && guideHidden ? (
      <ActionMenu
        label="More actions"
        size="md"
        items={[
          {
            label: "Show Platform ready",
            icon: <Eye />,
            onSelect: restoreGuide,
          },
        ]}
      />
    ) : null;

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
          <div className="flex items-center gap-2">
            {guideMenu}
            <Button
              asChild
              variant="neutral"
              className="max-sm:flex-1"
              disabledReason={create.disabledReason}
            >
              <Link to={r.productNew()}>
                <Plus aria-hidden />
                New product
              </Link>
            </Button>
          </div>
        ) : (
          (guideMenu ?? undefined)
        )
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
        <div data-home-grid="" className="grid grid-cols-1 gap-6">
          {readySlot}
        </div>
      </div>
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
          split &&
            "@[60rem]:grid-cols-[minmax(0,2fr)_minmax(17.5rem,1fr)] @[80rem]:grid-cols-[minmax(0,1fr)_25rem]",
        )}
      >
        {attentionSlot}
        {readySlot}
        <div
          className={cn(
            "min-w-0",
            // Below 80rem the products take the full row under both cards (no well under the
            // shorter one); from 80rem the guide is an aside beside attention and the products.
            split &&
              "@[60rem]:col-span-full @[80rem]:col-span-1 @[80rem]:col-start-1 @[80rem]:row-start-2",
          )}
        >
          <ProductShelf
            rows={rows}
            loading={loading}
            attentionKnown={attention.isSuccess}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Platform ready beside attention from the 60rem split; from 80rem it is an aside spanning both
 * rows, so the products flow under attention, not under the taller card.
 */
const READY_AREA =
  "@[60rem]:col-start-2 @[60rem]:row-start-1 @[80rem]:row-span-2";
/** The finished guide is one line across the page, between attention and the products. */
const READY_LINE = "@[60rem]:col-span-full";
