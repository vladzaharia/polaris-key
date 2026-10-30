/**
 * Distribute flow aside: what App Store Connect has now. Split out of `components/AscDistribute.tsx`.
 */

import * as React from "react";
import { ms, type StepCtx } from "./AscStepShared.js";
import type {
  AscBuildDto,
  AscVersionDto,
  AscVersionsResponse,
  ConnectorStatusDto,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { Panel } from "../../../templates/Dashboard.js";
import {
  ASC_LINKS,
  AscLink,
  PLATFORM_LABEL,
  appleTone,
  appleWords,
} from "./ascShared.js";

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────

// ── App Store Connect now (the aside) ─────────────────────────────────────────────────────────

export function StoreState({
  slug,
  appleId,
  asc,
  versions,
  submissions,
  builds,
  versionsQ,
  open,
  gate,
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
  gate?: string;
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
                    <span className="text-sm font-medium text-fg-strong">
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
                          variant="outline"
                          disabledReason={
                            gate ?? (releaseId ? undefined : noRelease)
                          }
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
                          disabledReason={
                            gate ?? (releaseId ? undefined : noRelease)
                          }
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
                          disabledReason={
                            gate ?? (releaseId ? undefined : noRelease)
                          }
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
                          variant="outline"
                          disabledReason={
                            gate ?? (releaseId ? undefined : noRelease)
                          }
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
                      disabledReason={gate}
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
          className="py-1 text-accent-fg underline underline-offset-4"
        >
          App Store products in Commerce
        </Link>
      </p>
    </aside>
  );
}
