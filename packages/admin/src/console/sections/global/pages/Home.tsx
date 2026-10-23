import * as React from "react";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Eye, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  type AttentionItemDto,
  type PlatformSwitchSetting,
} from "../../../../api.js";
import { LogoMark } from "../../../../components/brand/Logo.js";
import { formatSince } from "../../../../lib/format.js";
import { releaseSourceOf } from "../../../../lib/products.js";
import { ActionMenu } from "../../../../ui/ActionMenu.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { GithubIcon } from "../../../../ui/GithubIcon.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useCanOpenHref } from "../../../access/context.js";
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
import {
  PauseWritesDialog,
  type PauseNotice,
} from "../../sync/PauseWritesDialog.js";
import {
  attentionHref,
  platformItems,
  productItems,
  type HomeRow,
} from "../model/home.js";
import { useSetupGuideHidden } from "../model/setupGuide.js";
import { cn } from "../../../../lib/cn.js";
import { toast } from "../../../../ui/toast.js";
import { reads } from "../../../data/reads.js";

/**
 * The platform row's first line: the server's fact with when and by whom folded in, "Cloud Sync
 * writes are paused for every product, since 1:14 PM (Ana Lima)." The name is isolated (FSI to
 * PDI) so a right-to-left name cannot move the parenthesis or the period.
 */
function factLine(first: string, a: AttentionItemDto): string {
  const base = first.replace(/[.]$/, "");
  const who = a.by ? `\u2068${a.by}\u2069` : null;
  if (a.since)
    return `${base}, since ${formatSince(a.since * 1000)}${who ? ` (${who})` : ""}.`;
  return who ? `${base}, paused by ${who}.` : first;
}

/**
 * The attention list's rows. A product item's subject is the product, logo and name, linking to
 * Overview. A platform item (`product: null`) has the Polaris Key mark and "Platform" for a
 * subject, says since when and by whom, and its action opens the resume dialog in place.
 */
function attentionRows(
  items: readonly AttentionItemDto[],
  logo: (slug: string) => React.ReactNode,
  onPlatform: (item: AttentionItemDto) => void,
  platformBusy = false,
): AttentionItem[] {
  return items.map((a): AttentionItem => {
    if (a.product === null) {
      const [first = "", ...rest] = a.lines;
      const lines = [factLine(first, a), ...rest];
      return {
        id: a.id,
        tone: a.tone,
        object: (
          <span
            data-platform-subject=""
            className="flex min-w-0 max-w-full items-start gap-2"
          >
            {/* In rem, so the mark grows with the text like a product logo. */}
            <LogoMark size={24} title="" className="size-6 shrink-0" />
            <span className="min-w-0 break-words">Platform</span>
          </span>
        ),
        objectTitle: "Platform",
        reason: lines.join(" "),
        lines,
        service: a.service ?? undefined,
        action: {
          label: a.action.label,
          onSelect: () => onPlatform(a),
          busy: platformBusy,
        },
      };
    }
    const { slug, name } = a.product;
    return {
      id: a.id,
      tone: a.tone,
      object: (
        <Link
          to={r.overview(slug)}
          className="flex min-w-0 max-w-full items-start gap-2 text-fg-strong underline-offset-4 hover:underline"
        >
          {logo(slug)}
          <span className="min-w-0 line-clamp-2 break-words">{name}</span>
        </Link>
      ),
      objectTitle: name,
      reason: a.lines.join(" "),
      lines: a.lines,
      service: a.service ?? undefined,
      action: { label: a.action.label, href: attentionHref(a) },
    };
  });
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
  // ST-29: an item whose page the member's role does not open is not counted, any more than listed.
  const canOpen = useCanOpenHref();
  const openable = React.useMemo(
    () => (attention.data ?? []).filter((a) => canOpen(attentionHref(a))),
    [attention.data, canOpen],
  );
  const bySlug = React.useMemo(() => {
    const m = new Map<string, ReturnType<typeof productItems>>();
    for (const a of productItems(openable))
      m.set(a.product.slug, [...(m.get(a.product.slug) ?? []), a]);
    return m;
  }, [openable]);
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
  // The platform's own item (the Cloud Sync pause): its resume dialog opens here, on Home.
  const platformItem = platformItems(openable)[0];
  const [resumeOpen, setResumeOpen] = React.useState(false);
  const firstRunHeading = React.useRef<HTMLElement>(null);
  const [resumeBusy, setResumeBusy] = React.useState(false);
  const platformSettings = useQuery({
    ...reads.platformSettings(),
    retry: false,
    enabled: platformItem !== undefined,
  });
  const findPause = (
    view: { settings?: { key: string; kind: string }[] } | undefined,
  ): PlatformSwitchSetting | undefined =>
    view?.settings?.find(
      (x): x is PlatformSwitchSetting =>
        x.key === "cloudSync.writesPaused" && x.kind === "switch",
    );
  const paused = findPause(platformSettings.data);
  const pauseNotice: PauseNotice | null = platformItem
    ? {
        since: platformItem.since ?? null,
        by: platformItem.by ?? null,
        reason: platformItem.reason ?? null,
      }
    : null;
  /**
   * Resume writes: the dialog at once when the setting is read; otherwise the button works
   * (spinner) while the read is asked for, once more after a failure, and a second failure says
   * so with Retry. The dialog never opens on its own.
   */
  const askResume = async (): Promise<void> => {
    if (paused) {
      setResumeOpen(true);
      return;
    }
    setResumeBusy(true);
    let res = await platformSettings.refetch();
    if (res.isError) res = await platformSettings.refetch();
    setResumeBusy(false);
    if (findPause(res.data)) setResumeOpen(true);
    else
      toast.error(res.error ?? "Resume options didn't load", {
        id: "home-resume-read",
        context: { thing: "Cloud Sync setting" },
        action: { label: "Retry", onClick: () => void askResume() },
      });
  };
  // A successful resume clears the item (the write invalidates the read): the row's action is
  // gone, so focus goes to the card that took its place.
  const hadPlatformItem = React.useRef(false);
  React.useEffect(() => {
    if (platformItem) hadPlatformItem.current = true;
    else if (hadPlatformItem.current) {
      hadPlatformItem.current = false;
      // The row's card is gone: the Needs attention heading, else the all-clear line, else the
      // first-run heading, else the page heading; never the removed button's ghost.
      requestAnimationFrame(() => {
        for (const sel of [
          "[data-attention-list] h2",
          "[data-all-clear]",
          "[data-empty=first-run] h2",
          "h1",
        ]) {
          const el = document.querySelector<HTMLElement>(sel);
          if (el) {
            el.focus();
            if (document.activeElement === el) return;
          }
        }
      });
    }
  }, [platformItem]);
  const resumeDialog =
    paused && pauseNotice ? (
      <PauseWritesDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        setting={paused}
        to="off"
        propagationSeconds={platformSettings.data?.propagationSeconds ?? 30}
        notice={pauseNotice}
        reachUnlisted={list.length === 0}
      />
    ) : null;
  const items = attentionRows(
    openable,
    logoOf,
    () => void askResume(),
    resumeBusy,
  );
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
  const stepsOpen =
    ready.data && Array.isArray(ready.data.rows)
      ? ready.data.total - ready.data.done
      : 0;
  const guideMenu =
    platform && guideHidden ? (
      <>
        {stepsOpen > 0 ? (
          <Button
            variant="outline"
            size="sm"
            data-setup-steps-open=""
            onClick={restoreGuide}
          >
            {stepsOpen} setup {stepsOpen === 1 ? "step" : "steps"} open
          </Button>
        ) : null}
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
      </>
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
                if (platformItem) void platformSettings.refetch();
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
        {platformItem ? (
          <AttentionList
            items={attentionRows(
              [platformItem],
              logoOf,
              () => void askResume(),
              resumeBusy,
            )}
          />
        ) : null}
        {resumeDialog}
        <EmptyState
          kind="first-run"
          headingLevel={2}
          headingRef={firstRunHeading}
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
          docs={docsUrl("productsPage")}
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
      {resumeDialog}
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
