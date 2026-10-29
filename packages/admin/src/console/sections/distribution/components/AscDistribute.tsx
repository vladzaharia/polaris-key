/**
 * The App Store channel's **Distribute** flow (A-17g; notes/S-14 §8.2, T6; re-homed from
 * Distribution → App Store by A-22.4): it takes a build of the product's pinned app to TestFlight
 * and the App Store, beside what App Store Connect has now (its versions and review submissions,
 * with the release controls). It is the first section of the channel's Releases tab.
 *
 * Steps, each in the URL (`?step=`, with `?build=` and `?version=`), so a refresh or a closed tab
 * resumes: **Build** (unexpired builds, newest first, polled while one is processing) → **Export
 * compliance** (only when unanswered) → **Release notes** (per locale; to TestFlight here, to the
 * App Store version in Version) → **TestFlight** (groups, beta review) → **Version** (reuse or
 * create, attach the build, What's New, release option, phased release) → **Preflight** (what
 * the API can see) → **Submit** (typed).
 *
 * Every write is a named Worker control (A-17d) confirmed at its ADMIN.md §5.2 level and sent with
 * one `Idempotency-Key` per intent (`AscActionDialog`): the Worker's ledger makes each step
 * resumable, and what each step shows afterwards is Apple's re-read, never the request. Submit for
 * review, release and completing a phased release are typed with the app's name. Everything is
 * read-only with the reason when the product has no usable App Store Connect connector.
 */

import { channelLabel } from "@polaris-key/manifest";
import { docsUrl } from "../../../../lib/docsLinks.js";
import * as React from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type {
  AscBetaGroupsResponse,
  AscBuildsResponse,
  AscVersionsResponse,
  ConnectorStatusDto,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Stepper, type WizardStep } from "../../../../ui/wizard/index.js";
import { Link, useSearchParam } from "../../../router.js";
import { codecs, r } from "../../../routes.js";
import {
  AscActionDialog,
  appleIdOf,
  ascBlocked,
  ascConnector,
  releaseNotesSeed,
  type AscIntent,
  type LocaleNotes,
} from "./ascShared.js";
import { StoreState } from "./AscStoreState.js";
import { PreflightStep, SubmitStep } from "./AscSubmitSteps.js";
import { VersionStep } from "./AscVersionStep.js";
import {
  BuildStep,
  ComplianceStep,
  NotesStep,
  TestFlightStep,
} from "./AscBuildSteps.js";
import type { StepCtx } from "./AscStepShared.js";
import { useWriteGate } from "../../../access/useCan.js";
import { patchQuery, useConnectorRead, useConnectors } from "../data.js";

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────

export const DISTRIBUTE_STEPS = [
  "build",
  "compliance",
  "notes",
  "testflight",
  "version",
  "preflight",
  "submit",
] as const;
export type DistributeStep = (typeof DISTRIBUTE_STEPS)[number];

const STEPS: WizardStep[] = [
  { id: "build", label: "Build" },
  { id: "compliance", label: "Export compliance" },
  { id: "notes", label: "Release notes" },
  { id: "testflight", label: channelLabel("testflight") },
  { id: "version", label: "Version" },
  { id: "preflight", label: "Preflight" },
  { id: "submit", label: "Submit" },
];

const stepCodec = codecs.oneOf(DISTRIBUTE_STEPS, "build");
const idCodec = codecs.string("");

/** A build still being processed is polled this often while the page is open (S-15 §6.5). */
const POLL_MS = 10_000;

const notesKey = (slug: string, buildId: string) =>
  `pk-asc-notes:${slug}:${buildId}`;

function readNotes(
  slug: string,
  buildId: string,
  releaseId: string | null,
): LocaleNotes[] {
  try {
    const raw = window.sessionStorage.getItem(notesKey(slug, buildId));
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      if (
        Array.isArray(v) &&
        v.every(
          (n) =>
            n &&
            typeof (n as LocaleNotes).locale === "string" &&
            typeof (n as LocaleNotes).text === "string",
        )
      )
        return v as LocaleNotes[];
    }
  } catch {
    // storage unavailable: start from the seed
  }
  return releaseNotesSeed(releaseId);
}

function writeNotes(slug: string, buildId: string, notes: LocaleNotes[]) {
  try {
    window.sessionStorage.setItem(
      notesKey(slug, buildId),
      JSON.stringify(notes),
    );
  } catch {
    // storage unavailable: the draft lasts as long as the page
  }
}

// ── The page ──────────────────────────────────────────────────────────────────────────────────

export function AscDistribute({
  slug,
  name,
}: {
  slug: string;
  /** The channel's display name, for the empty state. */
  name: string;
}): React.ReactElement {
  const connectors = useConnectors(slug);
  const asc = ascConnector(connectors.data?.connectors);
  const blocked = connectors.data ? ascBlocked(asc) : null;
  const appleId = appleIdOf(asc);

  return (
    <div className="space-y-6" data-template="flow">
      {connectors.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : connectors.isError ? (
        <ErrorState
          error={connectors.error}
          onRetry={() => void connectors.refetch()}
          context={{ area: "distribution", thing: "Store connectors" }}
        />
      ) : blocked || !asc || !appleId ? (
        <EmptyState
          kind="first-run"
          headingLevel={3}
          title="App Store Connect can't be used for this product yet"
          description={blocked ?? "The connector names no app."}
          primaryAction={
            <Button variant="outline" asChild>
              <Link to={r.channel(slug, "app-store", "setup")}>
                Open {name} setup
              </Link>
            </Button>
          }
          docs={docsUrl("appStorePage")}
        />
      ) : (
        <DistributeFlow slug={slug} asc={asc} appleId={appleId} />
      )}
    </div>
  );
}

interface FlowProps {
  slug: string;
  asc: ConnectorStatusDto;
  appleId: string;
}

function DistributeFlow({ slug, asc, appleId }: FlowProps): React.ReactElement {
  const [stepRaw, setStep] = useSearchParam("step", stepCodec);
  const [buildId] = useSearchParam("build", idCodec);
  const [versionId] = useSearchParam("version", idCodec);
  const gate = useWriteGate("ship", slug);
  const [intent, setIntent] = React.useState<AscIntent | null>(null);
  const [dialog, setDialog] = React.useState<React.ReactNode>(null);

  // Polled while a build is processing (Apple takes minutes), as long as the page is open.
  const [polling, setPolling] = React.useState(false);
  const buildsQ = useConnectorRead<AscBuildsResponse>(
    slug,
    "asc",
    "distribute/builds",
    {},
    { poll: polling ? POLL_MS : false },
  );
  const processing = (buildsQ.data?.builds ?? []).some(
    (b) => b.processingState === "PROCESSING",
  );
  React.useEffect(() => setPolling(processing), [processing]);
  const groupsQ = useConnectorRead<AscBetaGroupsResponse>(
    slug,
    "asc",
    "distribute/beta-groups",
  );
  const versionsQ = useConnectorRead<AscVersionsResponse>(
    slug,
    "asc",
    "distribute/versions",
  );

  const builds = buildsQ.data?.builds ?? [];
  const build = builds.find((b) => b.id === buildId) ?? null;
  const versions = versionsQ.data?.versions ?? [];
  const version = versions.find((v) => v.id === versionId) ?? null;
  const submissions = versionsQ.data?.submissions ?? [];

  const [notes, setNotesState] = React.useState<LocaleNotes[]>(() =>
    releaseNotesSeed(null),
  );
  React.useEffect(() => {
    if (build) setNotesState(readNotes(slug, build.id, build.releaseId));
  }, [slug, build?.id, build?.releaseId]); // eslint-disable-line react-hooks/exhaustive-deps
  const setNotes = (n: LocaleNotes[]) => {
    setNotesState(n);
    if (build) writeNotes(slug, build.id, n);
  };

  // What each step needs before the next can start.
  const done = new Set<DistributeStep>();
  if (build && build.processingState === "VALID") done.add("build");
  if (done.has("build") && build && build.usesNonExemptEncryption !== null) {
    done.add("compliance");
    done.add("notes");
    done.add("testflight");
  }
  if (done.has("compliance") && version && version.buildId === build?.id) {
    done.add("version");
    done.add("preflight");
  }
  const sentForReview = submissions.some(
    (s) =>
      s.platform === version?.platform &&
      (s.state === "WAITING_FOR_REVIEW" || s.state === "IN_REVIEW"),
  );
  if (done.has("preflight") && sentForReview) done.add("submit");

  // The step shown: the asked one, unless an earlier one is still incomplete. Decided only once
  // Apple's answers are in, so a deep link is not rewritten while they load.
  const loaded = !!buildsQ.data && !!versionsQ.data;
  const askedIndex = DISTRIBUTE_STEPS.indexOf(stepRaw);
  const blocker = loaded
    ? DISTRIBUTE_STEPS.slice(0, askedIndex).find((s) => !done.has(s))
    : undefined;
  const step: DistributeStep = blocker ?? stepRaw;
  React.useEffect(() => {
    if (stepRaw !== step) setStep(step);
  }, [step, stepRaw, setStep]);
  // A step change starts at the top of the page, as a page change does (AppShell).
  const firstStep = React.useRef(true);
  React.useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    const main = document.getElementById("content");
    if (main) main.scrollTop = 0;
  }, [step]);

  // Focus has nowhere to go when the control that held it leaves (Continue into Submit, a closed
  // confirm whose button is gone): the step's title takes it, never the page (A-22.4 UX).
  const refocus = React.useCallback(() => {
    window.setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body)
        document
          .getElementById("wizard-step-title")
          ?.focus({ preventScroll: true });
    }, 120);
  }, []);
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (mounted.current) refocus();
    mounted.current = true;
  }, [step, refocus]);

  const open = (i: AscIntent, body?: React.ReactNode) => {
    setDialog(body ?? null);
    setIntent(i);
  };
  const ctx: StepCtx = {
    slug,
    appleId,
    build,
    version,
    open,
    gate: gate.disabledReason,
  };

  const index = DISTRIBUTE_STEPS.indexOf(step);
  const next = DISTRIBUTE_STEPS[index + 1];
  const prev = DISTRIBUTE_STEPS[index - 1];
  const nextBlocked = !done.has(step) && step !== "submit";

  return (
    <>
      <Stepper
        label="Distribute steps"
        steps={STEPS}
        current={step}
        done={[...done]}
        onStep={(id) => setStep(id as DistributeStep)}
      />
      <div className="@container">
        <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-3">
          <div className="min-w-0 space-y-6 @3xl:col-span-2">
            <section
              aria-labelledby="wizard-step-title"
              className="rounded-lg border border-border bg-surface-raised"
            >
              {step === "build" ? (
                <BuildStep
                  ctx={ctx}
                  q={buildsQ}
                  builds={builds}
                  onPick={(id) =>
                    patchQuery({ build: id, version: null, step: null })
                  }
                />
              ) : step === "compliance" && build ? (
                <ComplianceStep ctx={ctx} build={build} />
              ) : step === "notes" && build ? (
                <NotesStep
                  ctx={ctx}
                  build={build}
                  notes={notes}
                  setNotes={setNotes}
                />
              ) : step === "testflight" && build ? (
                <TestFlightStep
                  ctx={ctx}
                  build={build}
                  groups={groupsQ.data?.betaGroups}
                  groupsQ={groupsQ}
                />
              ) : step === "version" && build ? (
                <VersionStep
                  ctx={ctx}
                  build={build}
                  versions={versions}
                  notes={notes}
                  onChoose={(id) => patchQuery({ version: id })}
                />
              ) : step === "preflight" && version ? (
                <PreflightStep ctx={ctx} version={version} />
              ) : step === "submit" && version ? (
                <SubmitStep ctx={ctx} version={version} sent={sentForReview} />
              ) : (
                <div className="p-5">
                  <Skeleton className="h-40 w-full" />
                </div>
              )}
            </section>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              {prev ? (
                <Button
                  variant="outline"
                  iconStart={<ArrowLeft aria-hidden />}
                  onClick={() => setStep(prev)}
                >
                  Back
                </Button>
              ) : null}
              {next ? (
                <Button
                  iconEnd={<ArrowRight aria-hidden />}
                  disabledReason={
                    nextBlocked ? CONTINUE_REASON[step] : undefined
                  }
                  onClick={() => setStep(next)}
                >
                  Continue
                </Button>
              ) : null}
            </div>
          </div>
          <StoreState
            slug={slug}
            appleId={appleId}
            asc={asc}
            versions={versions}
            submissions={submissions}
            builds={builds}
            versionsQ={versionsQ}
            open={open}
            gate={gate.disabledReason}
          />
        </div>
      </div>
      <AscActionDialog
        slug={slug}
        intent={intent}
        onClose={() => {
          setIntent(null);
          setDialog(null);
          refocus();
        }}
      >
        {dialog}
      </AscActionDialog>
    </>
  );
}

const CONTINUE_REASON: Partial<Record<DistributeStep, string>> = {
  build: "Choose a processed build first.",
  compliance: "Answer export compliance for this build first.",
  version: "Choose a version and attach this build first.",
  preflight: "Choose a version and attach this build first.",
};
