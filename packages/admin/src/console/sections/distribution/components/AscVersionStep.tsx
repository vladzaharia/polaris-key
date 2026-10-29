/**
 * Distribute flow, step 5: the App Store version. Split out of `components/AscDistribute.tsx`.
 */

import * as React from "react";
import { StepTitle, type StepCtx } from "./AscStepShared.js";
import type { AscBuildDto, AscVersionDto } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { Select } from "../../../../ui/Select.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { SettingsRow } from "../../../templates/Settings.js";
import {
  PLATFORM_LABEL,
  appleTone,
  appleWords,
  buildLabel,
  notesError,
  type LocaleNotes,
} from "./ascShared.js";

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────

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

export function VersionStep({
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
