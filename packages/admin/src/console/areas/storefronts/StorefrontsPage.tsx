/**
 * Distribution → Storefronts (A-18j; notes/S-15 §8.1, T6). Every registered storefront adapter is
 * a tile, rendered from its declaration: its connection (A-16), the product's app, and a capability
 * strip (API, CI, PR, link, not offered) through the badge F-11's feed pages share. A store added
 * to the Worker's registry appears here with no console change.
 *
 * **Add to storefronts** is one flow for every store, its step in the URL (`?flow=add&step=…
 * &stores=…`), so a refresh or a closed tab resumes; its progress is the Worker's ledger, which the
 * plan reads, so it resumes anywhere:
 *
 *   1. Choose storefronts     4. Assets (the slot board, accept per output)
 *   2. Prerequisites          5. Plan (every step with its mode; every external write listed)
 *   3. Listing (fit, import)  6. Run          7. Submit and release (typed)
 *
 * Store connections' **Set up** opens it pre-scoped to one store. A store without a team
 * connection is read-only, with the reason. Pills only for what needs attention.
 */

import * as React from "react";
import { ArrowLeft, ArrowRight, Check, Plus } from "lucide-react";
import type {
  StorefrontDto,
  StorefrontFollowUp,
  StorefrontStepDto,
} from "../../../api.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import {
  CapabilityBadge,
  CapabilityStrip,
  capabilitySummary,
} from "../../../ui/CapabilityBadge.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Stepper, type Step } from "../../../ui/Stepper.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Link, useSearchParam } from "../../router.js";
import { codecs, globalPage, r } from "../../routes.js";
import { Panel } from "../../templates/Dashboard.js";
import { useStorefronts } from "./data.js";
import { FitReport } from "./FitReport.js";
import { ImportPanel } from "./ImportPanel.js";
import { SlotBoard } from "./SlotBoard.js";
import { StepCard, stepKeyOf } from "./StepCard.js";
import { followUpOf, StepDialog, type StepIntent } from "./StepDialog.js";

export const FLOW_STEPS = [
  "choose",
  "prerequisites",
  "listing",
  "assets",
  "plan",
  "run",
  "submit",
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

const STEPS: Step[] = [
  { id: "choose", label: "Storefronts" },
  { id: "prerequisites", label: "Prerequisites" },
  { id: "listing", label: "Listing" },
  { id: "assets", label: "Assets" },
  { id: "plan", label: "Plan" },
  { id: "run", label: "Run" },
  { id: "submit", label: "Submit and release" },
];

const ASIDE: Record<FlowStep, string> = {
  choose:
    "Each store shows what Polaris Key does for it through the store's API, what CI does, and what you do from a link.",
  prerequisites:
    "Checked for each store: the team connection, the product's app, and the write permissions, which only a first write can prove.",
  listing:
    "One listing serves every store. The fit report shows what does not fit a store; nothing is ever cut to fit.",
  assets:
    "CI derives and composes the store art from your masters. Nothing reaches a store until you accept it here.",
  plan: "Every step, in order, with how it is done. The external writes are listed before anything runs.",
  run: "Each step shows what the store answers, read back after the write. You can leave and come back: progress is kept.",
  submit:
    "Submit and release are confirmed by typing the app's name as the store shows it.",
};

const flowCodec = codecs.oneOf(["", "add"] as const, "");
const stepCodec = codecs.oneOf(FLOW_STEPS, "choose");
const storesCodec = codecs.string("");

const PHASES_RUN = new Set(["setup", "listing", "assets", "store"]);

/** A store's plan progress: steps done of all. */
function progress(s: StorefrontDto): { done: number; total: number } {
  return {
    done: s.steps.filter((x) => x.state === "done").length,
    total: s.steps.length,
  };
}

function ConnectionIssue({
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

function StoreTile({
  slug,
  store,
}: {
  slug: string;
  store: StorefrontDto;
}): React.ReactElement {
  const p = progress(store);
  return (
    <section
      aria-label={store.label}
      data-store={store.id}
      className="flex h-full flex-col rounded-lg border border-border bg-surface-raised"
    >
      <div className="flex min-h-14 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-fg-strong">{store.label}</h2>
          <p className="truncate text-sm text-fg-muted">
            {store.app
              ? (store.app.name ?? store.app.id)
              : store.connection.state === "keyless"
                ? "Published from CI"
                : "No app assigned"}
          </p>
        </div>
        <ConnectionIssue store={store} />
      </div>
      <div className="flex-1 px-4 py-2">
        <CapabilityStrip
          label={`${store.label} capabilities`}
          items={store.capabilities.filter(
            (c) =>
              c.op !== "connect" && c.op !== "listApps" && c.op !== "status",
          )}
        />
      </div>
      <div className="flex min-h-14 items-center justify-between gap-3 border-t border-border px-4 py-2">
        <span className="text-sm text-fg-muted">
          {p.total
            ? `${p.done} of ${p.total} steps done`
            : capabilitySummary(store.capabilities)}
        </span>
        <Button size="sm" variant="outline" asChild>
          <Link
            to={r.storefronts(slug, {
              flow: "add",
              stores: store.id,
              step: "prerequisites",
            })}
          >
            Set up
          </Link>
        </Button>
      </div>
    </section>
  );
}

export function StorefrontsPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const q = useStorefronts(slug);
  const [flow] = useSearchParam("flow", flowCodec);
  return (
    <div className="space-y-6" data-template={flow ? "flow" : "collection"}>
      <PageHeader
        title={flow ? "Add to storefronts" : "Storefronts"}
        primaryAction={
          flow ? undefined : (
            <Button asChild>
              <Link to={r.storefronts(slug, { flow: "add" })}>
                <Plus aria-hidden />
                Add to storefronts
              </Link>
            </Button>
          )
        }
      />
      {q.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          context={{ area: "distribution", thing: "Storefronts" }}
        />
      ) : q.data.stores.length === 0 ? (
        <EmptyState
          kind="first-run"
          headingLevel={2}
          title="No storefronts are registered"
          description="Storefronts appear here as the Worker registers their adapters."
          docs="/docs/admin/storefronts/"
        />
      ) : flow ? (
        <AddFlow slug={slug} stores={q.data.stores} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data.stores.map((s) => (
            <StoreTile key={s.id} slug={slug} store={s} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── The flow ──────────────────────────────────────────────────────────────────────────────────

function AddFlow({
  slug,
  stores,
}: {
  slug: string;
  stores: StorefrontDto[];
}): React.ReactElement {
  const [step, setStep] = useSearchParam("step", stepCodec);
  const [storesRaw, setStoresRaw] = useSearchParam("stores", storesCodec);
  const [intent, setIntent] = React.useState<StepIntent | null>(null);
  // What each step's last run left to finish in the store's console (decision 6), by step key.
  const [followUps, setFollowUps] = React.useState<
    Record<string, StorefrontFollowUp>
  >({});
  const known = new Set(stores.map((s) => s.id));
  const picked = storesRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => known.has(s));
  const chosen = stores.filter((s) => picked.includes(s.id));
  const index = FLOW_STEPS.indexOf(step);
  // Nothing chosen: every later step waits on the first.
  const current: FlowStep = chosen.length === 0 ? "choose" : step;
  const completed = chosen.length
    ? FLOW_STEPS.slice(0, FLOW_STEPS.indexOf(current))
    : [];
  const go = (s: FlowStep) => setStep(s);
  const listingColumns = chosen
    .map((s) => s.listingStore)
    .filter((x): x is string => x !== null);

  return (
    <div className="space-y-6">
      <Stepper
        steps={STEPS}
        current={current}
        completed={[...completed]}
        onStep={(id) => go(id as FlowStep)}
        label="Add to storefronts"
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          {current === "choose" ? (
            <ChooseStep
              stores={stores}
              picked={picked}
              onChange={(next) => setStoresRaw(next.join(","))}
            />
          ) : null}
          {current === "prerequisites"
            ? chosen.map((s) => <Prerequisites key={s.id} store={s} />)
            : null}
          {current === "listing" ? (
            <>
              <Panel title="Fit report">
                <FitReport slug={slug} stores={listingColumns} />
              </Panel>
              <Panel
                title="Import"
                action={
                  <Button size="sm" variant="outline" asChild>
                    <Link to={r.listing(slug)}>Edit the listing</Link>
                  </Button>
                }
              >
                <ImportPanel slug={slug} />
              </Panel>
            </>
          ) : null}
          {current === "assets" ? (
            <SlotBoard slug={slug} groups={["masters", ...listingColumns]} />
          ) : null}
          {current === "plan"
            ? chosen.map((s) => <PlanReview key={s.id} store={s} />)
            : null}
          {current === "run" || current === "submit"
            ? chosen.map((s) => (
                <StorePhase
                  key={s.id}
                  slug={slug}
                  store={s}
                  steps={s.steps.filter((x) =>
                    current === "run"
                      ? PHASES_RUN.has(x.phase)
                      : x.phase === "submit",
                  )}
                  onIntent={setIntent}
                  followUps={followUps}
                />
              ))
            : null}
        </div>
        <aside className="space-y-2 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-fg">
          <h2 className="text-sm font-bold text-fg-strong">
            What happens here
          </h2>
          <p>{ASIDE[current]}</p>
          <a
            href="/docs/admin/storefronts/"
            className="text-accent-fg underline-offset-4 hover:underline"
          >
            Storefronts in the docs
          </a>
        </aside>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <Button variant="ghost" asChild>
          <Link to={r.storefronts(slug)}>Close</Link>
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {index > 0 && current !== "choose" ? (
            <Button
              variant="outline"
              onClick={() => go(FLOW_STEPS[FLOW_STEPS.indexOf(current) - 1]!)}
            >
              <ArrowLeft aria-hidden />
              Back
            </Button>
          ) : null}
          {current !== "submit" ? (
            <Button
              disabled={chosen.length === 0}
              onClick={() => go(FLOW_STEPS[FLOW_STEPS.indexOf(current) + 1]!)}
            >
              Continue
              <ArrowRight aria-hidden />
            </Button>
          ) : (
            <Button asChild>
              <Link to={r.storefronts(slug)}>
                <Check aria-hidden />
                Done
              </Link>
            </Button>
          )}
        </div>
      </div>
      <StepDialog
        slug={slug}
        intent={intent}
        onClose={() => setIntent(null)}
        onDone={(result, done) => {
          const key = done.stepKey;
          if (!key) return;
          const f = followUpOf(result);
          setFollowUps((s) => {
            const { [key]: _, ...rest } = s;
            return f ? { ...rest, [key]: f } : rest;
          });
        }}
      />
    </div>
  );
}

function ChooseStep({
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

const PREREQ_WORDS = {
  met: { tone: "success", word: "Met" },
  unmet: { tone: "danger", word: "Not met" },
  unknown: { tone: "neutral", word: "Shown by the first write" },
} as const;

function Prerequisites({
  store,
}: {
  store: StorefrontDto;
}): React.ReactElement {
  return (
    <Panel title={store.label} headingLevel={2}>
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
        <ul className="divide-y divide-border">
          {store.prerequisites.map((p) => (
            <li
              key={p.id}
              className="flex min-h-12 items-center justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-bold text-fg-strong">{p.label}</p>
                <p className="text-sm text-fg-muted">{p.detail}</p>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {p.state === "met" ? (
                  <span className="inline-flex items-center gap-1 text-sm text-success">
                    <Check aria-hidden className="size-4" />
                    {PREREQ_WORDS.met.word}
                  </span>
                ) : p.state === "unmet" ? (
                  <StatusPill tone="danger" size="sm">
                    {PREREQ_WORDS.unmet.word}
                  </StatusPill>
                ) : (
                  <span className="text-sm text-fg-muted">
                    {PREREQ_WORDS.unknown.word}
                  </span>
                )}
                {p.page && p.state === "unmet" ? (
                  <Button size="sm" variant="outline" asChild>
                    <Link to={globalPage("platform-stores")}>
                      Open Store connections
                    </Link>
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PlanReview({ store }: { store: StorefrontDto }): React.ReactElement {
  const writes = store.steps.flatMap((s: StorefrontStepDto) =>
    s.writes.map((w) => ({ step: s.label, write: w })),
  );
  return (
    <Panel title={store.label} headingLevel={2}>
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
      <h3 className="mt-4 text-sm font-bold text-fg-strong">External writes</h3>
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

function StorePhase({
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
    <Panel title={store.label} headingLevel={2}>
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

/** Store connections' "Set up": the flow, pre-scoped to one store. */
export function setUpHref(slug: string, store: string): string {
  return r.storefronts(slug, {
    flow: "add",
    stores: store,
    step: "prerequisites",
  });
}
