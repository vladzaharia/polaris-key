/**
 * The panels the Add to storefronts steps and the Storefronts tiles share: one panel per chosen
 * store for Prerequisites, Plan and Run/Submit, the Choose cards, and the connection pill.
 */

import * as React from "react";
import type {
  StorefrontDto,
  StorefrontFollowUp,
  StorefrontStepDto,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import {
  CapabilityBadge,
  capabilitySummary,
} from "../../../../ui/CapabilityBadge.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { PrereqList, type Prereq } from "../../../../ui/wizard/index.js";
import { Link } from "../../../router.js";
import { globalPage } from "../../../routes.js";
import { Panel } from "../../../templates/Dashboard.js";
import {
  IDENTIFIER_LABELS,
  humanize,
} from "../../platform/pages/platformStores.js";
import { StepCard, stepKeyOf } from "./StepCard.js";
import type { StepIntent } from "./StepDialog.js";

/** A store's plan progress: steps done of all. */
export function progress(s: StorefrontDto): { done: number; total: number } {
  return {
    done: s.steps.filter((x) => x.state === "done").length,
    total: s.steps.length,
  };
}

export function ConnectionIssue({
  store,
}: {
  store: StorefrontDto;
}): React.ReactElement | null {
  if (store.connection.state === "not-configured")
    return (
      <StatusPill tone="warning" size="sm">
        Not connected
      </StatusPill>
    );
  if (store.connection.lastError)
    return (
      <StatusPill tone="danger" size="sm">
        Connection failing
      </StatusPill>
    );
  return null;
}

export function ChooseStep({
  stores,
  picked,
  onChange,
}: {
  stores: StorefrontDto[];
  picked: string[];
  onChange: (next: string[]) => void;
}): React.ReactElement {
  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">Storefronts to add the product to</legend>
      <div className="grid gap-3 md:grid-cols-2">
        {stores.map((s) => {
          const p = progress(s);
          return (
            <div
              key={s.id}
              data-store={s.id}
              className="flex h-full flex-col gap-2 rounded-lg border border-border bg-surface-raised p-4"
            >
              <div className="flex min-h-8 items-start justify-between gap-3">
                <Checkbox
                  label={s.label}
                  description={
                    s.outlets.length && p.total
                      ? `${p.done} of ${p.total} steps done`
                      : capabilitySummary(s.capabilities)
                  }
                  checked={picked.includes(s.id)}
                  onCheckedChange={(on) =>
                    onChange(
                      on ? [...picked, s.id] : picked.filter((x) => x !== s.id),
                    )
                  }
                />
                <ConnectionIssue store={s} />
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export const PREREQ_WORDS = { unknown: "Shown by the first write" } as const;

/** A store's prerequisites as the kit's rows; Open Store connections is the fix of an unmet one. */
export function prereqRows(store: StorefrontDto): Prereq[] {
  return store.prerequisites.map((p) => ({
    id: p.id,
    label: p.label,
    detail: p.detail,
    state: p.state,
    fix: p.page ? (
      <Button size="sm" variant="outline" asChild>
        <Link to={globalPage("platform-stores")}>Open Store connections</Link>
      </Button>
    ) : undefined,
  }));
}

/** The identifiers the flow shows; one the manifest leaves out is read from the assignment. */
function Identifiers({
  store,
}: {
  store: StorefrontDto;
}): React.ReactElement | null {
  const entries = Object.entries(store.identifiers ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className="text-sm font-medium text-fg-strong">App</h3>
      <dl
        aria-label={`${store.label} identifiers`}
        className="mt-1 divide-y divide-border text-sm"
      >
        {entries.map(([key, v]) => (
          <div
            key={key}
            className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5"
          >
            <dt className="text-fg-muted">
              {IDENTIFIER_LABELS[key] ?? humanize(key)}
            </dt>
            <dd className="min-w-0 break-all text-end">
              <code className="font-mono text-xs text-fg-strong">
                {v.value}
              </code>
              {v.source === "assigned" ? (
                <span className="ms-2 text-xs text-fg-muted">
                  From the assignment
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Prerequisites({
  store,
}: {
  store: StorefrontDto;
}): React.ReactElement {
  return (
    <Panel title={store.label} headingLevel={3}>
      {store.readOnly ? (
        <Callout tone="warning" title="Read-only">
          {store.readOnly}
        </Callout>
      ) : null}
      {store.prerequisites.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {store.label} is published from CI: no team connection or app to check
          here.
        </p>
      ) : (
        <PrereqList
          rows={prereqRows(store)}
          label={`${store.label} prerequisites`}
          words={PREREQ_WORDS}
        />
      )}
      <Identifiers store={store} />
    </Panel>
  );
}

export function PlanReview({
  store,
}: {
  store: StorefrontDto;
}): React.ReactElement {
  const writes = store.steps.flatMap((s: StorefrontStepDto) =>
    s.writes.map((w) => ({ step: s.label, write: w })),
  );
  return (
    <Panel title={store.label} headingLevel={3}>
      {store.readOnly ? (
        <Callout tone="warning" title="Read-only">
          {store.readOnly}
        </Callout>
      ) : null}
      <ol className="divide-y divide-border">
        {store.steps.map((s, i) => (
          <li
            key={s.id}
            className="flex min-h-10 items-center justify-between gap-3 py-1.5"
          >
            <span className="text-sm text-fg">
              <span className="tabular-nums text-fg-muted">{i + 1}. </span>
              {s.label}
              {s.typed ? (
                <span className="text-fg-muted"> · typed confirmation</span>
              ) : null}
            </span>
            <CapabilityBadge support={{ mode: s.mode }} />
          </li>
        ))}
      </ol>
      <h4 className="mt-4 text-sm font-semibold text-fg-strong">
        External writes
      </h4>
      {writes.length === 0 ? (
        <p className="text-sm text-fg-muted">
          None from Polaris Key: every step is done in {store.label}'s own
          console or by CI.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {writes.map((w) => (
            <li
              key={`${w.step}:${w.write}`}
              className="flex min-h-8 items-center justify-between gap-3"
            >
              <span className="text-sm text-fg-muted">{w.step}</span>
              <span className="font-mono text-xs text-fg">{w.write}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function StorePhase({
  slug,
  store,
  steps,
  onIntent,
  followUps,
}: {
  slug: string;
  store: StorefrontDto;
  steps: StorefrontStepDto[];
  onIntent: (i: StepIntent) => void;
  followUps: Record<string, StorefrontFollowUp>;
}): React.ReactElement {
  return (
    <Panel title={store.label} headingLevel={3}>
      {store.readOnly ? (
        <Callout tone="warning" title="Read-only">
          {store.readOnly}
        </Callout>
      ) : null}
      {steps.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {store.label} has no steps here: its state follows the store's own
          review and release.
        </p>
      ) : (
        <ol className="space-y-3">
          {steps.map((s) => (
            <StepCard
              key={s.id}
              slug={slug}
              store={store}
              step={s}
              readOnly={store.readOnly !== null}
              onIntent={onIntent}
              followUp={followUps[stepKeyOf(store.id, s.id)] ?? null}
            />
          ))}
        </ol>
      )}
    </Panel>
  );
}
