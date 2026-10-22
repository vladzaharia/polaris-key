/**
 * Overview's hero (products.overview): the page's masthead. The left pane is the product's
 * identity and its one next step (the warning pill and subject, the statement, the page's one
 * primary); the right pane is Integration, a gauge per platform with Hide, until the operator
 * hides it. While the next step is an issue the pane wears a 3 px warning edge and a light wash.
 */

import * as React from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, CodeXml, EyeOff, Circle } from "lucide-react";
import type {
  IntegrationView,
  ProductDetail,
  ServiceSlug,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { formatRelative, fromSeconds } from "../../../../lib/format.js";
import { inlineCode } from "../../../../lib/inline.js";
import { ActionMenu, type ActionMenuItem } from "../../../../ui/ActionMenu.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { IdChip } from "../../../../ui/IdChip.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { platformProgress } from "../model/integration.js";
import type { HeroStep } from "../pages/overviewAttention.js";
import { OverviewByline } from "./OverviewByline.js";
import {
  PlatformGlyph,
  PLATFORM_ORDER,
  type PlatformKey,
} from "../../../../portal/components/Glyphs.js";

const LINK =
  "inline-flex min-h-6 items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline";

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function OverviewHero({
  slug,
  product,
  featureCount,
  step,
  fallback,
  stepPending,
  menu,
  pane,
}: {
  slug: string;
  product: ProductDetail;
  featureCount: number;
  step: HeroStep | null;
  /** The main action when there is no step (New license, Publish catalog, Enable features). */
  fallback: React.ReactNode;
  /** The integration read has not answered: the action is not decided yet. */
  stepPending: boolean;
  menu: ActionMenuItem[];
  /** The Integration pane, or null while it is hidden. */
  pane: React.ReactNode;
}): React.ReactElement {
  const issue = step?.issue === true;
  return (
    <div
      data-testid="overview-hero"
      data-issue={issue ? "" : undefined}
      className={cn(
        "relative col-span-full grid grid-cols-1 overflow-hidden rounded-xl border border-border bg-surface-raised",
        pane && "@min-[800px]:grid-cols-2 @min-[976px]:grid-cols-subgrid",
      )}
    >
      <div
        className={cn(
          "relative flex min-w-0 flex-col gap-8 p-6",
          pane
            ? "@min-[976px]:col-span-2 @min-[1488px]:col-span-3 @min-[1488px]:grid @min-[1488px]:grid-cols-subgrid @min-[1488px]:gap-y-0 @min-[1488px]:p-0"
            : "@min-[1488px]:grid @min-[1488px]:grid-cols-4 @min-[1488px]:gap-6 @min-[1488px]:p-0",
          issue && "bg-warning-subtle/40",
        )}
      >
        {issue ? (
          <span
            aria-hidden
            data-edge=""
            className="absolute inset-y-0 start-0 w-[3px] bg-warning"
          />
        ) : null}
        <header className="min-w-0 @min-[1488px]:p-6">
          <div className="@container grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <div className="flex min-w-0 flex-col items-start gap-3 @min-[18rem]:flex-row @min-[18rem]:items-center @min-[18rem]:gap-4">
              <ProductLogo
                name={product.name}
                presentation={product.presentation}
                size={48}
                className="shrink-0"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h1
                    tabIndex={-1}
                    data-page-title=""
                    className="line-clamp-2 min-w-0 text-2xl/8 font-medium tracking-tight text-fg-strong outline-hidden [overflow-wrap:anywhere] sm:text-headline-lg sm:leading-10 forced-colors:outline-none"
                  >
                    {product.name}
                  </h1>
                  <IdChip value={slug} noun="slug" head={32} />
                </div>
                <p className="text-sm text-fg-muted">
                  <OverviewByline
                    features={featureCount}
                    linked={product.releaseSource === "github"}
                    resyncedAt={product.sync?.lastSyncedAt}
                    createdAt={product.createdAt}
                  />
                </p>
              </div>
            </div>
            <ActionMenu label="More" items={menu} />
          </div>
        </header>
        <section
          aria-labelledby="overview-next"
          data-service={step?.service ?? "core"}
          className={cn(
            "min-w-0 space-y-5",
            pane
              ? "@min-[1488px]:col-span-2 @min-[1488px]:p-6"
              : "@min-[1488px]:col-span-3 @min-[1488px]:p-6",
          )}
        >
          <h2 id="overview-next" className="sr-only">
            Next step
          </h2>
          {step ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {step.issue ? (
                  <StatusPill tone={step.tone} size="sm">
                    {step.tone === "danger" ? "Problem" : "Warning"}
                  </StatusPill>
                ) : null}
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-strong">
                  {step.service ? (
                    <ServiceGlyph id={step.service as ServiceSlug} />
                  ) : null}
                  {step.subject}
                </span>
                {step.more > 0 ? (
                  <Link to={r.home({ q: slug })} className={LINK}>
                    +{step.more} more
                    <ArrowRight aria-hidden className="size-3.5" />
                  </Link>
                ) : null}
              </div>
              <p className="max-w-[60ch] text-pretty text-lg/6 text-fg-strong">
                {inlineCode(step.statement)}
              </p>
            </div>
          ) : (
            <p className="text-pretty text-lg/6 text-fg-strong">
              Nothing is waiting on you.
            </p>
          )}
          <div className="flex">
            {stepPending ? (
              <Skeleton className="h-10 w-36" />
            ) : step?.action ? (
              <Button asChild size="lg" className="max-sm:w-full">
                <Link to={step.action.href}>
                  {step.action.label}
                  <ArrowRight aria-hidden className="size-4" />
                </Link>
              </Button>
            ) : (
              fallback
            )}
          </div>
        </section>
      </div>
      {pane}
    </div>
  );
}

const isKey = (p: string): p is PlatformKey =>
  (PLATFORM_ORDER as readonly string[]).includes(p);

/** The hero's right pane: Integration, a gauge per platform with Hide, and when an SDK was last seen. */
export function IntegrationPane({
  slug,
  query,
  focusHeading = false,
  hide,
}: {
  slug: string;
  query: UseQueryResult<IntegrationView>;
  /** Take focus on mount (the pane was just shown again). */
  focusHeading?: boolean;
  /** Hide is offered once a feature is Verified; never automatic. */
  hide: { onHide: () => void; disabledReason?: string } | null;
}): React.ReactElement {
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  const view = query.data;
  const gauges = view ? platformProgress(view) : [];
  const seen = [...(view?.sightings ?? [])].sort(
    (a, b) => b.lastSeenAt - a.lastSeenAt,
  )[0];
  return (
    <section
      aria-labelledby="overview-integration"
      data-testid="integration-pane"
      className="flex min-w-0 flex-col gap-4 border-t border-border bg-surface-sunken p-6 @min-[800px]:border-s @min-[800px]:border-t-0"
    >
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2
          id="overview-integration"
          ref={heading}
          tabIndex={-1}
          className="text-base font-medium text-fg-strong outline-hidden"
        >
          <Link
            to={r.integration(slug)}
            className="group inline-flex items-center gap-1 underline-offset-4 hover:underline"
          >
            Integration
            <ArrowRight
              aria-hidden
              className="size-4 text-fg-muted group-hover:text-accent-fg"
            />
          </Link>
        </h2>
        {hide && view ? (
          <Button
            variant="link"
            size="sm"
            aria-label="Hide Integration"
            disabledReason={hide.disabledReason}
            onClick={hide.onHide}
            className="text-fg-muted no-underline"
          >
            <EyeOff aria-hidden className="size-4" />
            Hide
          </Button>
        ) : null}
      </div>
      {query.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : query.isError || !view ? (
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : view.features.length === 0 ? (
        <p className="text-sm text-fg-muted">No feature is turned on.</p>
      ) : gauges.length > 0 ? (
        <ul aria-label="By platform" className="space-y-4">
          {gauges.map((g) => (
            <li key={g.platform} className="space-y-1.5">
              <p className="flex items-center gap-2 text-sm">
                <span className="inline-flex items-center gap-2 font-medium text-fg-strong">
                  {isKey(g.platform) ? (
                    <PlatformGlyph platform={g.platform} />
                  ) : null}
                  {g.label}
                </span>
                <span className="ms-auto whitespace-nowrap text-fg-muted">
                  {g.verified} of {g.total} verified
                </span>
              </p>
              <div
                aria-hidden
                className="h-1 overflow-hidden rounded-full bg-border"
              >
                <div
                  className="h-full rounded-full bg-success"
                  style={{
                    width: `${g.total ? (g.verified / g.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-1.5 text-sm">
          <p className="flex items-center gap-2 text-fg-muted">
            <Circle
              aria-hidden
              className="size-4 border-dashed"
              strokeDasharray="3 3"
            />
            No app seen yet
          </p>
          <Link to={r.integration(slug)} className={LINK}>
            Add the SDK
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      )}
      {seen ? (
        <p className="mt-auto flex items-center gap-2 pt-2 text-sm text-fg-muted">
          <CodeXml aria-hidden className="size-4 shrink-0" />
          <span>
            Last seen {formatRelative(fromSeconds(seen.lastSeenAt))} ·{" "}
            <span className="whitespace-nowrap">
              {cap(seen.sdk.replace(/-server$/, ""))} SDK
              {seen.sdkVersion ? ` ${seen.sdkVersion}` : ""}
            </span>
          </span>
        </p>
      ) : null}
    </section>
  );
}
