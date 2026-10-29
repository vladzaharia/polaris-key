/**
 * Distribute flow, steps 1 to 4: Build, Export compliance, Release notes and TestFlight.
 * Split out of `components/AscDistribute.tsx`.
 */

import * as React from "react";
import { StepTitle, ms, type StepCtx } from "./AscStepShared.js";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AscBetaGroupDto, AscBuildDto } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { FormField } from "../../../../ui/form.js";
import { IconButton } from "../../../../ui/IconButton.js";
import { Input } from "../../../../ui/Input.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Spinner } from "../../../../ui/Spinner.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { SettingsRow } from "../../../templates/Settings.js";
import {
  ASC_LINKS,
  AscLink,
  PLATFORM_LABEL,
  WHATS_NEW_MAX,
  appleTone,
  appleWords,
  buildLabel,
  notesError,
  type LocaleNotes,
} from "./ascShared.js";

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────

export function BuildStep({
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
              className="py-1 font-mono text-xs text-accent-fg underline underline-offset-4"
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
            <Spinner className="me-1 size-3" label="Processing" />
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

export function ComplianceStep({
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

export function NotesStep({
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

export function TestFlightStep({
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
            <legend className="text-sm font-semibold text-fg-strong">
              Groups
            </legend>
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
