/**
 * Overview's Integration card (ST-41; products.overview): the next step with its reason, the one
 * primary action of the page, beside the gauge, which counts the features an SDK has been seen
 * using and shows each platform's own meter. Replaces the setup checklist, Trust & SDK and the
 * welcome. Hiding it is the operator's choice (`core.setup`, from Integration's foot); while hidden
 * the card is gone and the header's menu offers "Show Integration".
 */

import * as React from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, Check, Circle, CircleAlert } from "lucide-react";
import type { IntegrationView } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import {
  FEATURE_LABEL,
  progress,
  type NextStep,
} from "../model/integration.js";
import { PlatformMeters } from "./PlatformMeters.js";

const ICON = {
  verified: <Check aria-hidden className="size-4 text-success" />,
  not_seen: <Circle aria-hidden className="size-4 text-fg-muted" />,
  blocked: <CircleAlert aria-hidden className="size-4 text-warning" />,
} as const;
const WORD = {
  verified: "Verified",
  not_seen: "Not seen yet",
  blocked: "Waiting on setup",
} as const;

export function IntegrationCard({
  slug,
  query,
  next,
  focusHeading = false,
}: {
  slug: string;
  query: UseQueryResult<IntegrationView>;
  next: NextStep | null;
  /** Take focus on mount (the card was just shown again). */
  focusHeading?: boolean;
}): React.ReactElement {
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  const view = query.data;
  const body = query.isPending ? (
    <Skeleton className="h-28 w-full" />
  ) : query.isError || !view ? (
    <ErrorState
      compact
      error={query.error}
      onRetry={() => void query.refetch()}
    />
  ) : view.features.length === 0 ? (
    <p className="text-sm text-fg-muted">No feature is turned on.</p>
  ) : (
    <Body slug={slug} view={view} next={next} />
  );
  return (
    <section
      aria-labelledby="overview-integration"
      data-testid="integration-card"
      className="col-span-full overflow-hidden rounded-xl border border-border bg-surface-raised"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <h2
          id="overview-integration"
          ref={heading}
          tabIndex={-1}
          className="text-base font-semibold text-fg-strong focus-visible:outline-hidden"
        >
          Integration
        </h2>
        <Link
          to={r.integration(slug)}
          className="inline-flex min-h-6 items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
        >
          Open Integration
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </header>
      {body}
    </section>
  );
}

function Body({
  slug,
  view,
  next,
}: {
  slug: string;
  view: IntegrationView;
  next: NextStep | null;
}): React.ReactElement {
  const { verified, total } = progress(view);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4 p-4 sm:p-5">
        {next ? (
          <div className="space-y-3">
            <p className="text-base text-fg-strong">{next.reason}</p>
            <Button asChild>
              <Link to={next.to}>
                {next.text}
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            </Button>
          </div>
        ) : (
          <p className="text-base text-fg-strong">Every feature is Verified.</p>
        )}
        <ul aria-label="Features" className="divide-y divide-border">
          {view.features.map((f) => (
            <li key={f.id}>
              <Link
                to={r.integration(slug, { feature: f.id })}
                className="flex min-h-9 items-center gap-2 py-1.5 text-sm hover:bg-hover"
              >
                {ICON[f.status]}
                <span className="min-w-0 flex-1 text-fg">
                  {FEATURE_LABEL[f.id]}
                </span>
                <span className="text-fg-muted">{WORD[f.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-4 border-t border-border p-4 sm:p-5 lg:border-l lg:border-t-0">
        <p className="text-sm text-fg">
          <span className="text-2xl font-semibold text-fg-strong">
            {verified}
          </span>{" "}
          of {total} {total === 1 ? "feature" : "features"} Verified
        </p>
        <PlatformMeters view={view} />
      </div>
    </div>
  );
}
