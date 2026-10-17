/**
 * Overview's Integration card (ST-41): how far the app is, as counts of features an SDK has been
 * seen using (never a percentage someone typed), per platform, and the one next step. Replaces the
 * setup checklist, Trust & SDK and the welcome. "Hide Integration" is the operator's choice
 * (`core.setup`); a hidden card shrinks to one line that reopens it.
 */

import * as React from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, Check, Circle, CircleAlert } from "lucide-react";
import type { IntegrationView } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Panel } from "../../../templates/Dashboard.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { useSetup } from "../../../wizard/useSetup.js";
import { edit } from "../../../wizard/setup.js";
import {
  FEATURE_LABEL,
  platformProgress,
  progress,
  type NextStep,
} from "../model/integration.js";

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
}: {
  slug: string;
  query: UseQueryResult<IntegrationView>;
  next: NextStep | null;
}): React.ReactElement {
  const setup = useSetup(slug);
  const view = query.data;
  if (setup.choices.integrationHidden && view?.verified)
    return (
      <Panel
        title="Integration"
        action={
          <Button
            variant="ghost"
            size="sm"
            disabledReason={setup.allowed ? undefined : setup.disabledReason}
            onClick={() => void setup.save(edit.hideIntegration(null))}
          >
            Show Integration
          </Button>
        }
      >
        <p className="text-sm text-fg-muted">Hidden.</p>
      </Panel>
    );
  return (
    <Panel
      title="Integration"
      action={
        <Link
          to={r.integration(slug)}
          className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
        >
          Open Integration
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      }
    >
      {query.isPending ? (
        <Skeleton className="h-24 w-full" />
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
      )}
    </Panel>
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
  const platforms = platformProgress(view);
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-fg">
          <span className="text-2xl font-semibold text-fg-strong">
            {verified}
          </span>{" "}
          of {total} {total === 1 ? "feature" : "features"} Verified
        </p>
        <div aria-hidden className="mt-2 flex gap-1">
          {view.features.map((f) => (
            <span
              key={f.id}
              className={
                f.status === "verified"
                  ? "h-1.5 flex-1 rounded-full bg-success"
                  : "h-1.5 flex-1 rounded-full bg-surface-sunken"
              }
            />
          ))}
        </div>
      </div>
      <ul className="divide-y divide-border" aria-label="Features">
        {view.features.map((f) => (
          <li key={f.id} className="flex items-center gap-2 py-1.5 text-sm">
            {ICON[f.status]}
            <Link
              to={r.integration(slug, { feature: f.id })}
              className="min-w-0 flex-1 text-fg hover:underline"
            >
              {FEATURE_LABEL[f.id]}
            </Link>
            <span className="text-fg-muted">{WORD[f.status]}</span>
          </li>
        ))}
      </ul>
      {platforms.length > 0 ? (
        <ul
          aria-label="By platform"
          className="space-y-0.5 text-sm text-fg-muted"
        >
          {platforms.map((p) => (
            <li key={p.platform}>
              <span className="font-medium text-fg">{p.label}</span>{" "}
              {p.verified} of {p.total}
            </li>
          ))}
        </ul>
      ) : null}
      {next ? (
        <p className="text-sm text-fg-muted">
          Next: <span className="text-fg">{next.text}</span>
        </p>
      ) : null}
    </div>
  );
}
