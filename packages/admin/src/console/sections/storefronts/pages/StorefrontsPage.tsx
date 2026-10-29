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
 *
 * A BUILT-IN store (`builtIn`, PS-06: its operations run first-party on Polaris Key's own tables)
 * has nothing to connect and no flow (SETUP.md D48): its tile says so and opens the store's own
 * page (`distribution/storefronts/<id>`, a `STORE_PANELS` line), and Add to storefronts leaves it
 * out. Which store is built in comes from the declaration, never from its name.
 */

import * as React from "react";
import { ArrowRight, Plus } from "lucide-react";
import type {
  StorefrontDto,
  StorefrontFollowUp,
  StorefrontStepDto,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import {
  DoneStep,
  prereqsMet,
  Wizard,
  type WizardStep,
} from "../../../../ui/wizard/index.js";
import { FLOW_STEPS, type FlowStep } from "../model/flowSteps.js";
import { PHASES_RUN, readCursor, writeCursor } from "../model/flowCursor.js";
import {
  ChooseStep,
  PlanReview,
  Prerequisites,
  prereqRows,
  StorePhase,
} from "../components/FlowPanels.js";
import { ASIDE, SKIPPABLE, TITLE, decidedStores } from "../model/flowCopy.js";
import { STOREFRONTS_FLOW } from "../../../wizard/flows.js";
import { skippedIn } from "../../../wizard/setup.js";
import { useSetup } from "../../../wizard/useSetup.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import {
  Link,
  navigate,
  useLocation,
  useSearchParam,
} from "../../../router.js";
import { channelInScope, navFeaturesOf } from "../../../nav.js";
import { useProduct } from "../../../data/hooks.js";
import { codecs, globalPage, r } from "../../../routes.js";
import { Panel } from "../../../templates/Dashboard.js";
import { useSlots, useStorefronts } from "../data.js";
import { StoreTile } from "../components/StoreTiles.js";
import { FlowSkeleton } from "../components/FlowSkeleton.js";
import { useCan, useWriteGate } from "../../../access/useCan.js";
import { EditListingLink } from "../components/EditListingLink.js";
import { FitReport } from "../components/FitReport.js";
import { ImportPanel } from "../components/ImportPanel.js";
import { SlotBoard } from "../components/SlotBoard.js";
import {
  followUpOf,
  StepDialog,
  type StepIntent,
} from "../components/StepDialog.js";
import { STORE_PANELS, StorePage } from "./StorePage.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { ScopeLine } from "../components/ScopeLine.js";
import { platformName } from "../../../../lib/vocab/platforms.js";

export { STORE_PANELS };
export { FLOW_STEPS, type FlowStep };

const STEPS: readonly WizardStep[] = STOREFRONTS_FLOW.steps.map((x) => ({
  id: x.id,
  label: x.label,
}));

const flowCodec = codecs.oneOf(["", "add"] as const, "");
const stepCodec = codecs.oneOf(FLOW_STEPS, "choose");
const storesCodec = codecs.string("");

export function StorefrontsPage({
  slug,
  store,
}: {
  slug: string;
  /** A store's own page (`distribution/storefronts/<id>`), when the URL names one. */
  store?: string;
}): React.ReactElement {
  if (store !== undefined) return <StorePage slug={slug} store={store} />;
  return <Catalogue slug={slug} />;
}

function Catalogue({ slug }: { slug: string }): React.ReactElement {
  const q = useStorefronts(slug);
  const product = useProduct(slug);
  const gate = useWriteGate("ship", slug);
  // A-20.7: only the stores the product's builds can reach (a declared one stays, flagged), and
  // never the built-in store. Everything shows while the facts load or when there are none.
  const features = navFeaturesOf(product.data);
  const stores = (q.data?.stores ?? []).filter(
    (s) => s.builtIn || channelInScope(features, s.id),
  );
  const outOfScope = new Set(
    (product.data?.channels ?? []).filter((c) => !c.inScope).map((c) => c.id),
  );
  const platforms = (product.data?.platforms ?? []).map((p) =>
    platformName(p.platform),
  );
  const columns =
    stores.length >= 3 ? "md:grid-cols-2 xl:grid-cols-3" : "md:grid-cols-2";
  const [flow] = useSearchParam("flow", flowCodec);
  const root = React.useRef<HTMLDivElement>(null);
  const hadFlow = React.useRef(Boolean(flow));
  React.useEffect(() => {
    // Leaving the flow only changes the query, and the link that was focused is gone: land on the page's h1.
    if (hadFlow.current && !flow) {
      const h1 = root.current?.querySelector("h1");
      if (h1) {
        h1.tabIndex = -1;
        h1.focus();
      }
    }
    hadFlow.current = Boolean(flow);
  }, [flow]);
  return (
    <div
      ref={root}
      className={`space-y-6${flow ? " mx-auto w-full max-w-[60rem]" : ""}`}
      data-template={flow ? "flow" : "collection"}
    >
      <PageHeader
        title={flow ? "Add to storefronts" : "Storefronts"}
        toolbar={flow ? undefined : <EditListingLink slug={slug} />}
        primaryAction={
          flow ? undefined : (
            <Button asChild disabledReason={gate.disabledReason}>
              <Link to={r.storefronts(slug, { flow: "add" })}>
                <Plus aria-hidden />
                Add to storefronts
              </Link>
            </Button>
          )
        }
      />
      {flow ? null : <ScopeLine platforms={platforms} />}
      {q.isPending || product.isPending || product.isPlaceholderData ? (
        flow ? (
          <FlowSkeleton slug={slug} />
        ) : (
          <Skeleton className="h-64 w-full" />
        )
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          context={{ area: "distribution", thing: "Storefronts" }}
        />
      ) : stores.length === 0 ? (
        <EmptyState
          kind="first-run"
          headingLevel={2}
          title="No storefronts yet"
          description="Supported stores are listed here once they are available."
          docs={docsUrl("storefronts")}
        />
      ) : flow ? (
        // A built-in store has no flow (SETUP.md D48): it is always on.
        <AddFlow
          slug={slug}
          stores={stores.filter((s) => !s.builtIn)}
          platforms={features !== null ? platforms : []}
        />
      ) : (
        <div
          data-top-aligned=""
          className={`grid items-start gap-4 ${columns}`}
        >
          {stores.map((s) => (
            <StoreTile
              key={s.id}
              slug={slug}
              store={s}
              hasPanel={Object.hasOwn(STORE_PANELS, s.id)}
              outOfScope={outOfScope.has(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Windows; Windows and macOS; Windows, macOS and Linux. */
function listNames(names: readonly string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ── The flow ──────────────────────────────────────────────────────────────────────────────────

function AddFlow({
  slug,
  stores,
  platforms,
}: {
  slug: string;
  stores: StorefrontDto[];
  /** The product's platform names, once known: an empty list of stores then means none fits, not "all built in". */
  platforms: string[];
}): React.ReactElement {
  const { route } = useLocation();
  const [step, setStep] = useSearchParam("step", stepCodec, { replace: false });
  const [storesRaw, setStoresRaw] = useSearchParam("stores", storesCodec);
  const [intent, setIntent] = React.useState<StepIntent | null>(null);
  const setup = useSetup(slug);
  const canPlatform = useCan("platform", null, "view");
  const slots = useSlots(slug);
  const [skipping, setSkipping] = React.useState(false);
  const skipGuard = React.useRef(false);
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
  const currentIndex = FLOW_STEPS.indexOf(current);
  const go = (s: FlowStep) => setStep(s);
  // A link to a later step with nothing chosen lands on Choose, and choosing never moves the step.
  React.useEffect(() => {
    if (chosen.length === 0 && step !== "choose")
      setStep("choose", { replace: true });
  });
  // Reopened with no place in the URL: resume where the operator left off.
  const resumed = React.useRef(false);
  React.useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    if (route.query.get("step") !== null || route.query.get("stores") !== null)
      return;
    const saved = readCursor(slug);
    if (!saved) return;
    const ids = saved.stores.split(",").filter((x) => known.has(x));
    if (ids.length === 0) return;
    setStoresRaw(ids.join(","));
    setStep(saved.step, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    if (chosen.length > 0) writeCursor(slug, current, picked.join(","));
  }, [slug, current, picked.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const listingColumns = chosen
    .map((s) => s.listingStore)
    .filter((x): x is string => x !== null);

  // ── Step state, from facts ──
  const readyStores = chosen.filter((s) => prereqsMet(prereqRows(s)));
  const groups = ["masters", ...listingColumns];
  const slotRows = (slots.data?.slots ?? []).filter(
    (x) =>
      groups.includes(x.group) && (x.state !== "missing" || x.kind === "human"),
  );
  const needed = slotRows.filter(
    (x) =>
      x.state === "review" || (x.state === "missing" && x.kind === "human"),
  ).length;
  const accepted = slotRows.filter((x) => x.state === "accepted").length;
  const phaseSteps = (pred: (p: string) => boolean) =>
    chosen.flatMap((s) => s.steps.filter((x) => pred(x.phase)));
  const runSteps = phaseSteps((p) => PHASES_RUN.has(p));
  const submitSteps = phaseSteps((p) => p === "submit");
  const doneCount = (l: StorefrontStepDto[]) =>
    l.filter((x) => x.state === "done").length;
  type Fact = { done: boolean; decided?: string } | null;
  const facts: Record<FlowStep, Fact> = {
    choose: chosen.length
      ? { done: true, decided: decidedStores(chosen) }
      : { done: false },
    prerequisites: {
      done: chosen.length > 0 && readyStores.length === chosen.length,
      decided:
        chosen.length === 1
          ? undefined
          : `${readyStores.length} of ${chosen.length} stores ready`,
    },
    // No store-neutral fact says a listing is right or a plan was read: those stay neutral once visited.
    listing: null,
    assets: slots.isSuccess
      ? {
          done: slotRows.length > 0 && needed === 0,
          decided: needed
            ? `${accepted} accepted, ${needed} needed`
            : `${accepted} accepted`,
        }
      : null,
    plan: null,
    run: {
      done: runSteps.length > 0 && doneCount(runSteps) === runSteps.length,
      decided: `${doneCount(runSteps)} of ${runSteps.length} steps done`,
    },
    submit: {
      done:
        submitSteps.length > 0 && doneCount(submitSteps) === submitSteps.length,
      decided: `${doneCount(submitSteps)} of ${submitSteps.length} steps done`,
    },
  };
  const skippedList = skippedIn(setup.choices, STOREFRONTS_FLOW.id);
  const [furthest, setFurthest] = React.useState(currentIndex);
  React.useEffect(() => {
    setFurthest((f) => Math.max(f, currentIndex));
  }, [currentIndex]);
  const completed: string[] = [];
  const unmet: string[] = [];
  const visited: string[] = [];
  FLOW_STEPS.forEach((id, i) => {
    if (id === current || skippedList.includes(id)) return;
    const f = facts[id];
    if (f?.done && (i < currentIndex || i <= furthest)) completed.push(id);
    else if (i < currentIndex && f && !f.done) unmet.push(id);
    else if (i <= furthest) visited.push(id);
  });
  const steps: WizardStep[] = STEPS.map((x) => ({
    ...x,
    decided: facts[x.id as FlowStep]?.decided,
  }));
  // Choose with nothing chosen has no decided line yet.
  if (chosen.length === 0) steps[0] = { ...steps[0]!, decided: undefined };

  const gate = setup.allowed
    ? undefined
    : (setup.disabledReason ?? "You can't change setup choices.");
  const alreadySkipped = skippedList.includes(current);
  const skip = async () => {
    if (skipGuard.current) return;
    skipGuard.current = true;
    setSkipping(true);
    try {
      if (await setup.skip(STOREFRONTS_FLOW.id, current))
        go(FLOW_STEPS[currentIndex + 1]!);
    } finally {
      skipGuard.current = false;
      setSkipping(false);
    }
  };
  const next = async () => {
    // Going on from a skipped step means it was done after all: the skip is cleared.
    if (alreadySkipped && !(await setup.unskip(STOREFRONTS_FLOW.id, current)))
      return;
    go(FLOW_STEPS[currentIndex + 1]!);
  };
  const doneStores = chosen.filter((s) => {
    const l = s.steps.filter((x) => x.phase === "submit");
    return l.length > 0 && l.every((x) => x.state === "done");
  });

  if (stores.length === 0 && platforms.length > 0)
    return (
      <EmptyState
        kind="no-results"
        headingLevel={2}
        title={`No other store fits ${listNames(platforms)}`}
        primaryAction={
          <Button asChild>
            <Link to={r.storefronts(slug)}>Back to storefronts</Link>
          </Button>
        }
        docs={docsUrl("channels")}
      />
    );
  if (stores.length === 0)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="Every storefront here is built in"
        description={
          canPlatform
            ? "Connect a store in Store connections to add it here."
            : "Ask a platform admin to connect a store in Store connections, and it appears here."
        }
        primaryAction={
          canPlatform ? (
            <Button asChild>
              <Link to={globalPage("platform-stores")}>
                Open Store connections
              </Link>
            </Button>
          ) : undefined
        }
      />
    );

  return (
    <>
      <Wizard
        centered={false}
        focusOnMount
        label="Add to storefronts"
        steps={steps}
        current={current}
        done={completed}
        unmet={unmet}
        visited={visited}
        skipped={skippedList}
        onStep={(id) => go(id as FlowStep)}
        onUndoSkip={(id) => void setup.unskip(STOREFRONTS_FLOW.id, id)}
        title={TITLE[current]!}
        aside={
          <>
            <h3 className="text-sm font-semibold text-fg-strong">
              What happens here
            </h3>
            <p>{ASIDE[current]}</p>
            <a
              href={docsUrl("storefronts")}
              className="py-1 text-accent-fg underline-offset-4 hover:underline"
            >
              Storefronts in the docs
            </a>
          </>
        }
        footer={{
          later: (
            <Button variant="ghost" asChild>
              <Link to={r.storefronts(slug)}>Do this later</Link>
            </Button>
          ),
          onSkip:
            SKIPPABLE.has(current) && !alreadySkipped
              ? () => void skip()
              : undefined,
          skipDisabledReason: gate,
          skipLoading: skipping || setup.saving,
          onBack:
            index > 0 && current !== "choose"
              ? () => go(FLOW_STEPS[currentIndex - 1]!)
              : undefined,
          reason:
            chosen.length === 0 ? "Choose a storefront to continue" : undefined,
          // The last step's typed confirmation is its action; there is no filled primary beside it.
          primary:
            current === "submit" ? undefined : (
              <Button
                // Two filled buttons make two primaries: while a step's own actions are open,
                // Continue is the quiet one (B-224).
                variant={
                  (current === "assets" || current === "run") &&
                  !facts[current]?.done
                    ? "outline"
                    : "primary"
                }
                disabledReason={
                  chosen.length === 0
                    ? "Choose a storefront to continue"
                    : undefined
                }
                onClick={() => void next()}
              >
                Continue
                <ArrowRight aria-hidden />
              </Button>
            ),
        }}
      >
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
            <Panel title="Fit report" headingLevel={3}>
              <FitReport slug={slug} stores={listingColumns} />
            </Panel>
            <Panel
              title="Import"
              headingLevel={3}
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
        {current === "submit" && doneStores.length > 0 ? (
          <DoneStep
            result={`${doneStores.map((s) => s.label).join(", ")}: sent for review`}
          />
        ) : null}
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
      </Wizard>
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
    </>
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
