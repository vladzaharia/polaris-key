/**
 * Distribution → App Store (A-17g; notes/S-14 §8.2, T6): the **Distribute** flow that takes a build
 * of the product's pinned app to TestFlight and the App Store, beside what App Store Connect has
 * now (its versions and review submissions, with the release controls).
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

import * as React from "react";
import { ArrowLeft, ArrowRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import type {
  AscBetaGroupDto,
  AscBetaGroupsResponse,
  AscBuildDto,
  AscBuildsResponse,
  AscPreflightCheck,
  AscPreflightResponse,
  AscSubmissionItemsResponse,
  AscVersionDto,
  AscVersionsResponse,
  ConnectorStatusDto,
} from "../../../api.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { FormField } from "../../../ui/form.js";
import { IconButton } from "../../../ui/IconButton.js";
import { Input } from "../../../ui/Input.js";
import { RadioCards } from "../../../ui/RadioCards.js";
import { Select } from "../../../ui/Select.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { Spinner } from "../../../ui/Spinner.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Stepper, type Step } from "../../../ui/Stepper.js";
import { Textarea } from "../../../ui/Textarea.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { Link, useSearchParam } from "../../router.js";
import { codecs, r } from "../../routes.js";
import { Panel } from "../../templates/Dashboard.js";
import { SettingsRow } from "../../templates/Settings.js";
import {
  ASC_LINKS,
  AscActionDialog,
  AscLink,
  PLATFORM_LABEL,
  WHATS_NEW_MAX,
  appleIdOf,
  appleTone,
  appleWords,
  ascBlocked,
  ascConnector,
  buildLabel,
  notesError,
  releaseNotesSeed,
  type AscIntent,
  type LocaleNotes,
} from "./ascShared.js";
import { patchQuery, useConnectorRead, useConnectors } from "./data.js";

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

const STEPS: Step[] = [
  { id: "build", label: "Build" },
  { id: "compliance", label: "Export compliance" },
  { id: "notes", label: "Release notes" },
  { id: "testflight", label: "TestFlight" },
  { id: "version", label: "Version" },
  { id: "preflight", label: "Preflight" },
  { id: "submit", label: "Submit" },
];

const stepCodec = codecs.oneOf(DISTRIBUTE_STEPS, "build");
const idCodec = codecs.string("");

/** A build still being processed is polled this often while the page is open (S-15 §6.5). */
const POLL_MS = 10_000;

const ms = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

const RELEASE_TYPES = [
  {
    value: "AFTER_APPROVAL",
    label: "After approval",
    description:
      "App Store Connect releases the version as soon as App Review approves it.",
  },
  {
    value: "MANUAL",
    label: "Manually",
    description: "The approved version waits until you release it here.",
  },
  {
    value: "SCHEDULED",
    label: "Scheduled",
    description:
      "Released once approved, not before the date you choose (on the hour).",
  },
] as const;

const RELEASE_LABEL: Record<string, string> = {
  AFTER_APPROVAL: "After approval",
  MANUAL: "Manually",
  SCHEDULED: "Scheduled",
};

// ── Notes draft (sessionStorage: nothing in it is secret) ─────────────────────────────────────

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

export function AppStorePage({ slug }: { slug: string }): React.ReactElement {
  const connectors = useConnectors(slug);
  const asc = ascConnector(connectors.data?.connectors);
  const blocked = connectors.data ? ascBlocked(asc) : null;
  const appleId = appleIdOf(asc);

  return (
    <div className="space-y-6" data-template="flow">
      <PageHeader
        title="App Store"
        titleAside={
          asc && !blocked ? (
            <StatusPill tone="success">Connected</StatusPill>
          ) : null
        }
        meta={
          appleId ? (
            <span className="font-mono text-xs text-fg-muted">
              Apple ID {appleId}
            </span>
          ) : undefined
        }
      />
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
          headingLevel={2}
          title="App Store Connect can't be used for this product yet"
          description={blocked ?? "The connector names no app."}
          primaryAction={
            <Button variant="outline" asChild>
              <Link to={r.credentials(slug)}>Open Outlet credentials</Link>
            </Button>
          }
          docs="/docs/admin/app-store/"
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

  const open = (i: AscIntent, body?: React.ReactNode) => {
    setDialog(body ?? null);
    setIntent(i);
  };
  const ctx: StepCtx = { slug, appleId, build, version, open };

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
        completed={[...done]}
        onStep={(id) => setStep(id as DistributeStep)}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
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
                disabledReason={nextBlocked ? CONTINUE_REASON[step] : undefined}
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
        />
      </div>
      <AscActionDialog
        slug={slug}
        intent={intent}
        onClose={() => {
          setIntent(null);
          setDialog(null);
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

interface StepCtx {
  slug: string;
  appleId: string;
  build: AscBuildDto | null;
  version: AscVersionDto | null;
  open: (i: AscIntent, body?: React.ReactNode) => void;
}

function StepTitle({
  children,
  description,
  action,
}: {
  children: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <h2 id="wizard-step-title" className="text-lg font-bold text-fg-strong">
          {children}
        </h2>
        {description ? (
          <p className="text-sm text-fg-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ── 1. Build ──────────────────────────────────────────────────────────────────────────────────

function BuildStep({
  ctx,
  q,
  builds,
  onPick,
}: {
  ctx: StepCtx;
  q: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
    isFetching: boolean;
  };
  builds: AscBuildDto[];
  onPick: (id: string) => void;
}): React.ReactElement {
  return (
    <>
      <StepTitle
        description="Unexpired builds of the app, newest first."
        action={
          <Button
            size="sm"
            variant="outline"
            iconStart={<RefreshCw aria-hidden />}
            loading={q.isFetching}
            onClick={() => void q.refetch()}
          >
            Check now
          </Button>
        }
      >
        Choose a build
      </StepTitle>
      <div className="p-5">
        {q.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : q.isError ? (
          <ErrorState
            compact
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ area: "distribution", thing: "Builds" }}
          />
        ) : builds.length === 0 ? (
          <EmptyState
            variant="inline"
            kind="first-run"
            title="No builds yet"
            description="A build appears here once App Store Connect has received it from CI."
          />
        ) : (
          <RadioCards
            aria-label="Builds"
            columns={1}
            value={ctx.build?.id ?? null}
            onChange={onPick}
            options={builds.map((b) => ({
              value: b.id,
              disabled: b.processingState !== "VALID",
              label: (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{buildLabel(b)}</span>
                  {b.platform ? (
                    <span className="text-sm font-normal text-fg-muted">
                      {PLATFORM_LABEL[b.platform] ?? b.platform}
                    </span>
                  ) : null}
                </span>
              ),
              description: <BuildFacts build={b} />,
            }))}
          />
        )}
      </div>
      {ctx.build?.releaseId ? (
        <div className="border-t border-border">
          <SettingsRow
            label="Polaris Key release"
            help={`The release ${buildLabel(ctx.build)} was linked to.`}
          >
            <Link
              to={r.release(ctx.slug, ctx.build.releaseId)}
              className="font-mono text-xs text-accent-fg underline underline-offset-4"
            >
              {ctx.build.releaseId}
            </Link>
          </SettingsRow>
        </div>
      ) : null}
    </>
  );
}

function BuildFacts({ build }: { build: AscBuildDto }): React.ReactElement {
  const uploaded = ms(build.uploadedDate);
  const notes = [
    ...(build.upload?.errors ?? []).map((n) => ({ ...n, tone: "danger" })),
    ...(build.upload?.warnings ?? []).map((n) => ({ ...n, tone: "warning" })),
  ];
  return (
    <span className="mt-1 block space-y-1">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusPill
          size="sm"
          tone={appleTone(build.processingState)}
          icon={build.processingState === "PROCESSING" ? false : undefined}
        >
          {build.processingState === "PROCESSING" ? (
            <Spinner className="mr-1 size-3" label="Processing" />
          ) : null}
          {appleWords(build.processingState)}
        </StatusPill>
        {uploaded ? (
          <span>
            Uploaded <Timestamp at={uploaded} />
          </span>
        ) : null}
        {build.exportComplianceNeeded ? (
          <span>Export compliance unanswered</span>
        ) : null}
        {build.releaseId ? (
          <span>
            Release <span className="font-mono text-xs">{build.releaseId}</span>
          </span>
        ) : null}
      </span>
      {notes.length ? (
        <span className="block">
          {notes.map((n) => (
            <span
              key={`${n.tone}:${n.code}`}
              className={
                n.tone === "danger" ? "block text-danger" : "block text-warning"
              }
            >
              <span className="font-mono text-xs">{n.code}</span>
              {n.description ? ` · ${n.description}` : ""}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

// ── 2. Export compliance ──────────────────────────────────────────────────────────────────────

function ComplianceStep({
  ctx,
  build,
}: {
  ctx: StepCtx;
  build: AscBuildDto;
}): React.ReactElement {
  const [answer, setAnswer] = React.useState<"no" | "yes" | null>(null);
  const answered = build.usesNonExemptEncryption;
  return (
    <>
      <StepTitle description="App Store Connect holds a build for TestFlight and App Review until this is answered.">
        Export compliance
      </StepTitle>
      {answered !== null ? (
        <SettingsRow label="Build" help={buildLabel(build)}>
          <StatusPill tone="success">
            {answered
              ? "Uses non-exempt encryption"
              : "Doesn't use non-exempt encryption"}
          </StatusPill>
        </SettingsRow>
      ) : (
        <div className="space-y-4 p-5">
          <RadioCards
            aria-label="Export compliance"
            value={answer}
            onChange={setAnswer}
            options={[
              {
                value: "no",
                label: "Doesn't use non-exempt encryption",
                description:
                  "Only encryption that is exempt, such as HTTPS through the system's networking.",
              },
              {
                value: "yes",
                label: "Uses non-exempt encryption",
                description:
                  "App Store Connect then asks for export compliance documentation.",
              },
            ]}
          />
          <div className="flex justify-end">
            <Button
              disabledReason={answer ? undefined : "Choose an answer first."}
              onClick={() =>
                ctx.open({
                  action: "connector.exportCompliance",
                  control: "distribute/export-compliance",
                  title: `Answer export compliance for ${buildLabel(build)}?`,
                  consequences: [
                    answer === "yes"
                      ? "App Store Connect records that the build uses non-exempt encryption."
                      : "App Store Connect records that the build doesn't use non-exempt encryption.",
                    "The answer can't be changed for this build afterwards.",
                  ],
                  confirmLabel: "Save answer",
                  body: {
                    buildId: build.id,
                    usesNonExemptEncryption: answer === "yes",
                  },
                  done: `Answered export compliance for ${buildLabel(build)}`,
                })
              }
            >
              Save answer…
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// ── 3. Release notes ──────────────────────────────────────────────────────────────────────────

function NotesStep({
  ctx,
  build,
  notes,
  setNotes,
}: {
  ctx: StepCtx;
  build: AscBuildDto;
  notes: LocaleNotes[];
  setNotes: (n: LocaleNotes[]) => void;
}): React.ReactElement {
  const error = notesError(notes);
  const update = (i: number, patch: Partial<LocaleNotes>) =>
    setNotes(notes.map((n, j) => (j === i ? { ...n, ...patch } : n)));
  return (
    <>
      <StepTitle description="One set of notes per locale. They go to TestFlight here, and to the App Store version in Version.">
        Release notes
      </StepTitle>
      <div className="divide-y divide-border">
        {notes.map((n, i) => (
          <div
            key={i}
            className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-[8rem_minmax(0,1fr)_auto]"
          >
            <FormField<string>
              name={`notes-locale-${i}`}
              label="Locale"
              value={n.locale}
              onChange={(v) => update(i, { locale: v })}
            >
              {(field) => (
                <Input
                  id={field.id}
                  mono
                  value={n.locale}
                  autoComplete="off"
                  spellCheck={false}
                  onValueChange={(v) => update(i, { locale: v })}
                  aria-describedby={field["aria-describedby"]}
                />
              )}
            </FormField>
            <FormField<string>
              name={`notes-text-${i}`}
              label="What's New"
              help={`${n.text.length} / ${WHATS_NEW_MAX}`}
              value={n.text}
              onChange={(v) => update(i, { text: v })}
            >
              {(field) => (
                <Textarea
                  id={field.id}
                  rows={4}
                  autoGrow
                  value={n.text}
                  onValueChange={(v) => update(i, { text: v })}
                  aria-describedby={field["aria-describedby"]}
                />
              )}
            </FormField>
            <div className="flex items-start justify-end sm:pt-6">
              <IconButton
                label={`Remove ${n.locale || "this locale"}`}
                icon={<Trash2 aria-hidden />}
                disabled={notes.length === 1}
                onClick={() => setNotes(notes.filter((_, j) => j !== i))}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
        <Button
          variant="outline"
          size="sm"
          iconStart={<Plus aria-hidden />}
          onClick={() => setNotes([...notes, { locale: "", text: "" }])}
        >
          Add locale
        </Button>
        <Button
          disabledReason={error ?? undefined}
          onClick={() =>
            ctx.open({
              action: "connector.betaNotes",
              control: "distribute/beta-localization",
              title: `Save What to Test for ${buildLabel(build)}?`,
              consequences: [
                `TestFlight testers see these notes for build ${buildLabel(build)} (${notes
                  .map((n) => n.locale.trim())
                  .join(", ")}).`,
                "Saving again replaces them.",
              ],
              confirmLabel: "Save to TestFlight",
              body: notes.map((n) => ({
                buildId: build.id,
                locale: n.locale.trim(),
                whatsNew: n.text,
              })),
              done: `Saved TestFlight notes for ${buildLabel(build)}`,
            })
          }
        >
          Save to TestFlight…
        </Button>
      </div>
    </>
  );
}

// ── 4. TestFlight ─────────────────────────────────────────────────────────────────────────────

function TestFlightStep({
  ctx,
  build,
  groups,
  groupsQ,
}: {
  ctx: StepCtx;
  build: AscBuildDto;
  groups: AscBetaGroupDto[] | undefined;
  groupsQ: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
}): React.ReactElement {
  const [picked, setPicked] = React.useState<string[]>([]);
  const chosen = (groups ?? []).filter((g) => picked.includes(g.id));
  const external = (groups ?? []).some((g) => !g.isInternalGroup);
  return (
    <>
      <StepTitle description="Internal groups get the build at once. External groups see it after TestFlight's beta review.">
        TestFlight
      </StepTitle>
      <SettingsRow label="Internal testing">
        <StatusPill tone={appleTone(build.internalBuildState)}>
          {appleWords(build.internalBuildState)}
        </StatusPill>
      </SettingsRow>
      <div className="border-t border-border">
        <SettingsRow label="External testing">
          <StatusPill tone={appleTone(build.externalBuildState)}>
            {appleWords(build.externalBuildState)}
          </StatusPill>
        </SettingsRow>
      </div>
      <div className="space-y-3 border-t border-border p-5">
        {groupsQ.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : groupsQ.isError ? (
          <ErrorState
            compact
            error={groupsQ.error}
            onRetry={() => void groupsQ.refetch()}
            context={{ area: "distribution", thing: "TestFlight groups" }}
          />
        ) : !groups?.length ? (
          <EmptyState
            variant="inline"
            kind="first-run"
            title="No TestFlight groups"
            description="Create a group in App Store Connect, then come back to add the build to it."
          />
        ) : (
          <fieldset className="space-y-3">
            <legend className="text-sm font-bold text-fg-strong">Groups</legend>
            {groups.map((g) => (
              <Checkbox
                key={g.id}
                checked={picked.includes(g.id)}
                onCheckedChange={(on) =>
                  setPicked((p) =>
                    on ? [...p, g.id] : p.filter((x) => x !== g.id),
                  )
                }
                label={g.name ?? g.id}
                description={
                  g.isInternalGroup
                    ? "Internal: testers get the build at once."
                    : "External: testers get it after beta review."
                }
              />
            ))}
          </fieldset>
        )}
        {external ? (
          <p className="text-sm text-fg-muted">
            Beta review needs the app's Test Information (contact and
            description).{" "}
            <AscLink href={ASC_LINKS.testInformation(ctx.appleId)}>
              Test Information
            </AscLink>
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
        {external ? (
          <Button
            variant="outline"
            onClick={() =>
              ctx.open({
                action: "connector.betaReview",
                control: "distribute/testflight/beta-review",
                title: `Submit ${buildLabel(build)} for beta review?`,
                consequences: [
                  "App Store Connect sends the build to TestFlight's beta review.",
                  "External groups that have the build can test it once the review passes.",
                ],
                confirmLabel: "Submit for beta review",
                body: { buildId: build.id },
                done: `Submitted ${buildLabel(build)} for beta review`,
              })
            }
          >
            Submit for beta review…
          </Button>
        ) : null}
        <Button
          disabledReason={
            chosen.length ? undefined : "Tick at least one group first."
          }
          onClick={() =>
            ctx.open({
              action: "connector.testflightGroups",
              control: "distribute/testflight/groups",
              title: `Add ${buildLabel(build)} to ${chosen.length === 1 ? "1 group" : `${chosen.length} groups`}?`,
              consequences: chosen.map((g) =>
                g.isInternalGroup
                  ? `${g.name ?? g.id}: testers get the build at once.`
                  : `${g.name ?? g.id}: testers get it after beta review.`,
              ),
              confirmLabel: "Add to groups",
              body: {
                buildId: build.id,
                betaGroupIds: chosen.map((g) => g.id),
              },
              done: `Added ${buildLabel(build)} to TestFlight`,
              onDone: () => setPicked([]),
            })
          }
        >
          Add to groups…
        </Button>
      </div>
    </>
  );
}

// ── 5. Version ────────────────────────────────────────────────────────────────────────────────

const PLATFORM_OPTIONS = Object.entries(PLATFORM_LABEL).map(
  ([value, label]) => ({ value, label }),
);

const VERSION_STRING = /^\d{1,5}(\.\d{1,5}){0,3}$/;

/** `datetime-local` value → an ISO instant, or null. */
const isoOf = (local: string): string | null => {
  const t = Date.parse(local);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function VersionStep({
  ctx,
  build,
  versions,
  notes,
  onChoose,
}: {
  ctx: StepCtx;
  build: AscBuildDto;
  versions: AscVersionDto[];
  notes: LocaleNotes[];
  onChoose: (id: string | null) => void;
}): React.ReactElement {
  const v = ctx.version;
  const [platform, setPlatform] = React.useState<string | null>(
    build.platform ?? "IOS",
  );
  const [versionString, setVersionString] = React.useState(build.version ?? "");
  const [releaseType, setReleaseType] = React.useState<string>(
    v?.releaseType ?? "AFTER_APPROVAL",
  );
  const [when, setWhen] = React.useState("");
  React.useEffect(() => {
    if (v?.releaseType) setReleaseType(v.releaseType);
  }, [v?.id, v?.releaseType]);

  if (!v) {
    const reuse = versions.find(
      (x) =>
        x.editable &&
        x.platform === platform &&
        x.versionString === versionString.trim(),
    );
    const invalid = !VERSION_STRING.test(versionString.trim())
      ? "Use a version such as 1.2.0."
      : !platform
        ? "Choose a platform."
        : null;
    return (
      <>
        <StepTitle description="An editable version with this number is reused; otherwise App Store Connect creates one.">
          App Store version
        </StepTitle>
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <FormField<string | null>
            name="asc-platform"
            label="Platform"
            required
            value={platform}
            onChange={setPlatform}
          >
            {(field) => (
              <Select
                id={field.id}
                value={platform}
                onChange={setPlatform}
                options={PLATFORM_OPTIONS}
                aria-describedby={field["aria-describedby"]}
              />
            )}
          </FormField>
          <FormField<string>
            name="asc-version-string"
            label="Version"
            required
            value={versionString}
            onChange={setVersionString}
            error={versionString && invalid ? invalid : undefined}
          >
            {(field) => (
              <Input
                id={field.id}
                mono
                value={versionString}
                autoComplete="off"
                onValueChange={setVersionString}
                aria-describedby={field["aria-describedby"]}
              />
            )}
          </FormField>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
          <p className="text-sm text-fg-muted">
            {reuse
              ? `Version ${reuse.versionString} is ${appleWords(reuse.state).toLowerCase()} and will be reused.`
              : "App Store Connect creates a new version."}
          </p>
          <Button
            disabledReason={invalid ?? undefined}
            onClick={() =>
              ctx.open({
                action: "connector.versionCreate",
                control: "distribute/version",
                title: reuse
                  ? `Use App Store version ${versionString.trim()}?`
                  : `Create App Store version ${versionString.trim()}?`,
                consequences: [
                  reuse
                    ? "The editable version with this number is reused; nothing is created."
                    : `App Store Connect creates version ${versionString.trim()} for ${PLATFORM_LABEL[platform!] ?? platform}.`,
                ],
                confirmLabel: reuse ? "Use version" : "Create version",
                body: { platform, versionString: versionString.trim() },
                done: `Version ${versionString.trim()} is ready`,
                onDone: (res) => {
                  const id = res[0]?.versionId;
                  if (typeof id === "string") onChoose(id);
                },
              })
            }
          >
            {reuse ? "Use version…" : "Create version…"}
          </Button>
        </div>
      </>
    );
  }

  const attached = v.buildId === build.id;
  const notesProblem = notesError(notes);
  const scheduledIso = releaseType === "SCHEDULED" ? isoOf(when) : null;
  const releaseInvalid =
    releaseType === "SCHEDULED" &&
    (!scheduledIso || Date.parse(scheduledIso) <= Date.now())
      ? "Choose a date and time in the future."
      : null;
  return (
    <>
      <StepTitle
        action={
          <Button size="sm" variant="ghost" onClick={() => onChoose(null)}>
            Choose another version
          </Button>
        }
      >
        App Store version {v.versionString}
      </StepTitle>
      <div className="divide-y divide-border">
        <SettingsRow
          label="State"
          help={PLATFORM_LABEL[v.platform ?? ""] ?? v.platform ?? undefined}
        >
          <StatusPill tone={appleTone(v.state)}>
            {appleWords(v.state)}
          </StatusPill>
        </SettingsRow>
        <SettingsRow
          label="Build"
          help={
            attached
              ? `${buildLabel(build)} is attached.`
              : v.buildId
                ? "Another build is attached."
                : "No build is attached."
          }
        >
          {attached ? (
            <StatusPill tone="success">Attached</StatusPill>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabledReason={
                v.editable ? undefined : "This version can't change any more."
              }
              onClick={() =>
                ctx.open({
                  action: "connector.versionBuild",
                  control: "distribute/version/build",
                  title: `Attach ${buildLabel(build)} to version ${v.versionString}?`,
                  consequences: [
                    "App Review reviews this build with the version.",
                    "Another build can replace it until the version is submitted.",
                  ],
                  confirmLabel: "Attach build",
                  body: { versionId: v.id, buildId: build.id },
                  done: `Attached ${buildLabel(build)}`,
                })
              }
            >
              Attach {buildLabel(build)}…
            </Button>
          )}
        </SettingsRow>
        <SettingsRow
          label="What's New"
          help={notes
            .map((n) => n.locale.trim())
            .filter(Boolean)
            .join(", ")}
        >
          <Button
            size="sm"
            variant="outline"
            disabledReason={
              notesProblem
                ? `${notesProblem} Edit the notes in Release notes.`
                : undefined
            }
            onClick={() =>
              ctx.open({
                action: "connector.versionNotes",
                control: "distribute/version-localization",
                title: `Save What's New for version ${v.versionString}?`,
                consequences: [
                  "App Store users see these notes for the version once it is released.",
                  "Saving again replaces them until the version is submitted.",
                ],
                confirmLabel: "Save What's New",
                body: notes.map((n) => ({
                  versionId: v.id,
                  locale: n.locale.trim(),
                  whatsNew: n.text,
                })),
                done: `Saved What's New for ${v.versionString}`,
              })
            }
          >
            Apply release notes…
          </Button>
        </SettingsRow>
        <SettingsRow
          label="Release"
          help={
            v.releaseType
              ? `Now: ${RELEASE_LABEL[v.releaseType] ?? appleWords(v.releaseType)}${
                  v.earliestReleaseDate
                    ? `, not before ${new Date(v.earliestReleaseDate).toLocaleString()}`
                    : ""
                }`
              : undefined
          }
          align="block"
        >
          <div className="space-y-3">
            <RadioCards
              aria-label="Release"
              columns={3}
              value={releaseType}
              onChange={setReleaseType}
              options={RELEASE_TYPES}
            />
            <div className="flex flex-wrap items-end justify-end gap-3">
              {releaseType === "SCHEDULED" ? (
                <FormField<string>
                  name="asc-release-date"
                  label="Not before"
                  value={when}
                  onChange={setWhen}
                >
                  {(field) => (
                    <Input
                      id={field.id}
                      type="datetime-local"
                      value={when}
                      onValueChange={setWhen}
                      aria-describedby={field["aria-describedby"]}
                    />
                  )}
                </FormField>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabledReason={releaseInvalid ?? undefined}
                onClick={() =>
                  ctx.open({
                    action: "connector.releaseType",
                    control: "distribute/version/release-type",
                    title: `Release version ${v.versionString} ${(RELEASE_LABEL[releaseType] ?? releaseType).toLowerCase()}?`,
                    consequences: [
                      RELEASE_TYPES.find((t) => t.value === releaseType)
                        ?.description ?? "",
                      "This can change until the version is released.",
                    ],
                    confirmLabel: "Save release option",
                    body: {
                      versionId: v.id,
                      releaseType,
                      ...(scheduledIso
                        ? { earliestReleaseDate: scheduledIso }
                        : {}),
                    },
                    done: `Saved the release option for ${v.versionString}`,
                  })
                }
              >
                Save release option…
              </Button>
            </div>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Phased release"
          help="Over seven days App Store Connect offers the update to a growing share of users with automatic updates on."
        >
          {v.phasedReleaseId ? (
            <StatusPill tone={appleTone(v.phasedReleaseState)}>
              {appleWords(v.phasedReleaseState)}
            </StatusPill>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                ctx.open({
                  action: "connector.phasedReleaseCreate",
                  control: "distribute/version/phased-release",
                  title: `Use a phased release for version ${v.versionString}?`,
                  consequences: [
                    "The phased release starts when the version is released.",
                    "Pause, resume or release to everyone afterwards, beside the version on this page or in the Matrix.",
                  ],
                  confirmLabel: "Use phased release",
                  body: { versionId: v.id },
                  done: `Chose a phased release for ${v.versionString}`,
                })
              }
            >
              Use a phased release…
            </Button>
          )}
        </SettingsRow>
      </div>
    </>
  );
}

// ── 6. Preflight ──────────────────────────────────────────────────────────────────────────────

const CHECK_LABEL: Record<string, string> = {
  build: "Build",
  exportCompliance: "Export compliance",
  screenshots: "Screenshots",
  ageRating: "Age rating",
  reviewContact: "App Review contact",
  price: "Price",
  availability: "Availability",
  betaReviewDetails: "Beta review contact",
  betaLocalizations: "Beta test description",
  firstInAppPurchase: "First In-App Purchase",
  appPrivacy: "App Privacy",
};

function checkLink(id: string, appleId: string): string | null {
  switch (id) {
    case "screenshots":
    case "reviewContact":
      return ASC_LINKS.app(appleId);
    case "ageRating":
      return ASC_LINKS.appInformation(appleId);
    case "price":
    case "availability":
      return ASC_LINKS.pricing(appleId);
    case "betaReviewDetails":
    case "betaLocalizations":
      return ASC_LINKS.testInformation(appleId);
    case "firstInAppPurchase":
      return ASC_LINKS.inAppPurchases(appleId);
    case "appPrivacy":
      return ASC_LINKS.appPrivacy(appleId);
    default:
      return null;
  }
}

function checkPill(c: AscPreflightCheck): React.ReactElement {
  if (c.ok === true) return <StatusPill tone="success">Ready</StatusPill>;
  if (c.ok === null)
    return <StatusPill tone="neutral">Check in App Store Connect</StatusPill>;
  if (c.id.startsWith("beta"))
    return <StatusPill tone="warning">External testing only</StatusPill>;
  return <StatusPill tone="danger">Missing</StatusPill>;
}

function PreflightStep({
  ctx,
  version,
}: {
  ctx: StepCtx;
  version: AscVersionDto;
}): React.ReactElement {
  const q = useConnectorRead<AscPreflightResponse>(
    ctx.slug,
    "asc",
    "distribute/preflight",
    { versionId: version.id },
  );
  return (
    <>
      <StepTitle
        description="What App Store Connect's API shows about this version's readiness."
        action={
          <Button
            size="sm"
            variant="outline"
            iconStart={<RefreshCw aria-hidden />}
            loading={q.isFetching}
            onClick={() => void q.refetch()}
          >
            Check again
          </Button>
        }
      >
        Preflight
      </StepTitle>
      {q.isPending ? (
        <div className="p-5">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : q.isError ? (
        <div className="p-5">
          <ErrorState
            compact
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ area: "distribution", thing: "Preflight" }}
          />
        </div>
      ) : (
        <>
          <div className="px-5 pt-4">
            <Callout
              tone={q.data.ready ? "success" : "warning"}
              title={
                q.data.ready
                  ? "Nothing the API can see blocks the submission"
                  : "Fix the missing items before submitting"
              }
            >
              <p>
                Portal-only items are yours to confirm in App Store Connect.
              </p>
            </Callout>
          </div>
          <div className="mt-4 divide-y divide-border border-t border-border">
            {q.data.checks.map((c) => {
              const link = checkLink(c.id, ctx.appleId);
              return (
                <SettingsRow
                  key={c.id}
                  label={CHECK_LABEL[c.id] ?? c.id}
                  help={
                    <>
                      {c.missing?.length ? (
                        <span className="block">
                          Missing: {c.missing.join(", ")}
                        </span>
                      ) : null}
                      {link && c.ok !== true ? (
                        <AscLink href={link}>Open in App Store Connect</AscLink>
                      ) : null}
                    </>
                  }
                >
                  {checkPill(c)}
                </SettingsRow>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

// ── 7. Submit ─────────────────────────────────────────────────────────────────────────────────

function SubmitStep({
  ctx,
  version,
  sent,
}: {
  ctx: StepCtx;
  version: AscVersionDto;
  sent: boolean;
}): React.ReactElement {
  const platform = version.platform ?? "IOS";
  const q = useConnectorRead<AscSubmissionItemsResponse>(
    ctx.slug,
    "asc",
    "distribute/submission-items",
    { platform },
  );
  const [skip, setSkip] = React.useState<string[]>([]);
  const iaps = q.data?.inAppPurchaseVersions ?? [];
  const assets = q.data?.backgroundAssetVersions ?? [];
  const toggle = (id: string, on: boolean) =>
    setSkip((s) => (on ? s.filter((x) => x !== id) : [...s, id]));
  const iapIds = iaps
    .map((i) => i.inAppPurchaseVersionId)
    .filter((id) => !skip.includes(id));
  const assetIds = assets
    .map((a) => a.backgroundAssetVersionId)
    .filter((id) => !skip.includes(id));
  return (
    <>
      <StepTitle description="The version and the items you tick go to App Review together.">
        Submit for review
      </StepTitle>
      <SettingsRow
        label="Version"
        help={`${version.versionString} (${PLATFORM_LABEL[platform] ?? platform})`}
      >
        <StatusPill tone={appleTone(version.state)}>
          {appleWords(version.state)}
        </StatusPill>
      </SettingsRow>
      <div className="space-y-4 border-t border-border p-5">
        {q.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : q.isError ? (
          <ErrorState
            compact
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ area: "distribution", thing: "Submission items" }}
          />
        ) : (
          <>
            {q.data.firstInAppPurchase ? (
              <Callout
                tone="info"
                title="The first In-App Purchase goes through App Store Connect"
              >
                <p>
                  {q.data.firstInAppPurchaseNote}{" "}
                  <AscLink href={ASC_LINKS.inAppPurchases(ctx.appleId)}>
                    In-App Purchases
                  </AscLink>
                </p>
              </Callout>
            ) : null}
            {iaps.length || assets.length ? (
              <fieldset className="space-y-3">
                <legend className="text-sm font-bold text-fg-strong">
                  Also submit
                </legend>
                {iaps.map((i) => (
                  <Checkbox
                    key={i.inAppPurchaseVersionId}
                    checked={!skip.includes(i.inAppPurchaseVersionId)}
                    onCheckedChange={(on) =>
                      toggle(i.inAppPurchaseVersionId, on)
                    }
                    label={`In-App Purchase ${i.name ?? i.productId}`}
                    description={`${i.productId} · ${appleWords(i.state)}`}
                  />
                ))}
                {assets.map((a) => (
                  <Checkbox
                    key={a.backgroundAssetVersionId}
                    checked={!skip.includes(a.backgroundAssetVersionId)}
                    onCheckedChange={(on) =>
                      toggle(a.backgroundAssetVersionId, on)
                    }
                    label={`Background Asset ${a.assetPackIdentifier ?? a.backgroundAssetVersionId}`}
                    description={`Version ${a.version ?? "?"} · ${appleWords(a.appStoreReleaseState)}`}
                  />
                ))}
              </fieldset>
            ) : (
              <p className="text-sm text-fg-muted">
                No In-App Purchase or Background Asset is ready to go with this
                version.
              </p>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-5 py-4">
        {sent ? <StatusPill tone="info">With App Review</StatusPill> : null}
        <Button
          variant="danger"
          disabledReason={
            sent
              ? "This version is already with App Review."
              : !version.buildId
                ? "Attach a build in Version first."
                : undefined
          }
          onClick={() =>
            ctx.open({
              action: "connector.submitReview",
              control: "distribute/submit",
              title: `Submit version ${version.versionString} for App Review?`,
              consequences: [
                `App Store Connect sends version ${version.versionString}${
                  iapIds.length + assetIds.length
                    ? ` and ${iapIds.length + assetIds.length} more item${iapIds.length + assetIds.length === 1 ? "" : "s"}`
                    : ""
                } to App Review.`,
                "While it waits for review you can cancel the submission; once Apple approves it, the release option decides when it goes live.",
                "Type the app's name to confirm.",
              ],
              confirmLabel: "Submit for review",
              body: {
                versionId: version.id,
                ...(iapIds.length ? { inAppPurchaseVersionIds: iapIds } : {}),
                ...(assetIds.length
                  ? { backgroundAssetVersionIds: assetIds }
                  : {}),
              },
              done: `Submitted ${version.versionString} for App Review`,
            })
          }
        >
          Submit for review…
        </Button>
      </div>
    </>
  );
}

// ── App Store Connect now (the aside) ─────────────────────────────────────────────────────────

function StoreState({
  slug,
  appleId,
  asc,
  versions,
  submissions,
  builds,
  versionsQ,
  open,
}: {
  slug: string;
  appleId: string;
  asc: ConnectorStatusDto;
  versions: AscVersionDto[];
  submissions: AscVersionsResponse["submissions"];
  builds: AscBuildDto[];
  versionsQ: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  open: StepCtx["open"];
}): React.ReactElement {
  const has = (c: string) => asc.controls.includes(c);
  const releaseOf = (v: AscVersionDto) =>
    builds.find((b) => b.id === v.buildId)?.releaseId ?? null;
  const noRelease = "No Polaris Key release is linked to this version's build.";
  return (
    <aside aria-label="App Store Connect state" className="min-w-0 space-y-6">
      <Panel title="In App Store Connect" headingLevel={2}>
        {versionsQ.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : versionsQ.isError ? (
          <ErrorState
            compact
            error={versionsQ.error}
            onRetry={() => void versionsQ.refetch()}
            context={{ area: "distribution", thing: "App Store versions" }}
          />
        ) : versions.length === 0 ? (
          <p className="text-sm text-fg-muted">No App Store versions yet.</p>
        ) : (
          <ul className="-my-2 divide-y divide-border" aria-label="Versions">
            {versions.slice(0, 5).map((v) => {
              const releaseId = releaseOf(v);
              const held = v.state === "PENDING_DEVELOPER_RELEASE";
              const phased =
                v.phasedReleaseState === "ACTIVE" ||
                v.phasedReleaseState === "PAUSED";
              return (
                <li key={v.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-bold text-fg-strong">
                      <span className="font-mono">{v.versionString}</span>{" "}
                      <span className="font-normal text-fg-muted">
                        {PLATFORM_LABEL[v.platform ?? ""] ?? v.platform}
                      </span>
                    </span>
                    <StatusPill size="sm" tone={appleTone(v.state)}>
                      {appleWords(v.state)}
                    </StatusPill>
                  </div>
                  {v.phasedReleaseState ? (
                    <p className="text-xs text-fg-muted">
                      Phased release:{" "}
                      {appleWords(v.phasedReleaseState).toLowerCase()}
                    </p>
                  ) : null}
                  {(held && has("release")) || phased ? (
                    <div className="flex flex-wrap gap-2">
                      {held && has("release") ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabledReason={releaseId ? undefined : noRelease}
                          onClick={() =>
                            open({
                              action: "connector.releaseVersion",
                              control: "release",
                              title: `Release version ${v.versionString} on the App Store?`,
                              consequences: [
                                "The approved version goes live on the App Store.",
                                "App Store Connect cannot take a release back.",
                              ],
                              confirmLabel: `Release ${v.versionString}`,
                              body: { releaseId },
                              done: `Released ${v.versionString} on the App Store`,
                            })
                          }
                        >
                          Release…
                        </Button>
                      ) : null}
                      {phased &&
                      v.phasedReleaseState === "ACTIVE" &&
                      has("phased-release/pause") ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabledReason={releaseId ? undefined : noRelease}
                          onClick={() =>
                            open({
                              action: "connector.phasedPause",
                              control: "phased-release/pause",
                              title: `Pause the phased release of ${v.versionString}?`,
                              consequences: [
                                "App Store Connect stops adding users to the phased release.",
                                "Users who already have it keep it. Resume continues the schedule.",
                              ],
                              confirmLabel: `Pause ${v.versionString}`,
                              body: { releaseId },
                              done: `Paused the phased release of ${v.versionString}`,
                            })
                          }
                        >
                          Pause…
                        </Button>
                      ) : null}
                      {phased &&
                      v.phasedReleaseState === "PAUSED" &&
                      has("phased-release/resume") ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabledReason={releaseId ? undefined : noRelease}
                          onClick={() =>
                            open({
                              action: "connector.phasedResume",
                              control: "phased-release/resume",
                              title: `Resume the phased release of ${v.versionString}?`,
                              consequences: [
                                "App Store Connect continues the 7-day schedule.",
                              ],
                              confirmLabel: `Resume ${v.versionString}`,
                              body: { releaseId },
                              done: `Resumed the phased release of ${v.versionString}`,
                            })
                          }
                        >
                          Resume…
                        </Button>
                      ) : null}
                      {phased && has("phased-release/complete") ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabledReason={releaseId ? undefined : noRelease}
                          onClick={() =>
                            open({
                              action: "connector.phasedComplete",
                              control: "phased-release/complete",
                              title: `Release ${v.versionString} to every App Store user?`,
                              consequences: [
                                "App Store Connect ends the phased release and offers the version to all users.",
                                "This cannot be undone in App Store Connect.",
                                "Type the app's name to confirm: this is a release to everyone.",
                              ],
                              confirmLabel: `Release ${v.versionString}`,
                              body: { releaseId },
                              done: `Released ${v.versionString} to every user`,
                            })
                          }
                        >
                          Release to everyone…
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      {submissions.length ? (
        <Panel title="Review submissions" headingLevel={2}>
          <ul
            className="-my-2 divide-y divide-border"
            aria-label="Review submissions"
          >
            {submissions.map((s) => {
              const submitted = ms(s.submittedDate);
              return (
                <li key={s.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-fg">
                      {PLATFORM_LABEL[s.platform ?? ""] ?? s.platform}
                      {submitted ? (
                        <span className="text-fg-muted">
                          {" "}
                          · <Timestamp at={submitted} />
                        </span>
                      ) : null}
                    </span>
                    <StatusPill size="sm" tone={appleTone(s.state)}>
                      {appleWords(s.state)}
                    </StatusPill>
                  </div>
                  {s.cancelable ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        open({
                          action: "connector.cancelSubmission",
                          control: "distribute/submission/cancel",
                          title: "Cancel this review submission?",
                          consequences: [
                            "App Store Connect withdraws the submission from App Review.",
                            "The version can be submitted again afterwards.",
                          ],
                          confirmLabel: "Cancel submission",
                          body: { submissionId: s.id },
                          done: "Cancelled the review submission",
                        })
                      }
                    >
                      Cancel submission…
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}
      <p className="text-sm">
        <AscLink href={ASC_LINKS.app(appleId)}>
          Open the app in App Store Connect
        </AscLink>
      </p>
      <p className="text-sm">
        <Link
          to={r.commerce(slug)}
          className="text-accent-fg underline underline-offset-4"
        >
          App Store products in Commerce
        </Link>
      </p>
    </aside>
  );
}
