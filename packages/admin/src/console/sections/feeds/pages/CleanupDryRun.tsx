/**
 * Feed cleanup (F-36 notice, F-38a dialog; mockup `packages.cleanup-dry-run`): the callout on
 * Packages that says when cleanup starts, and the dialog behind "See the dry run". The dialog
 * reads `POST <feeds base>/prune {apply: false}` (a plan; nothing is stored), lists what goes per
 * package and what is held back, and exports the whole plan as CSV. Deleting early is a separate
 * danger action behind an L2 confirm; the primary button only closes. After an apply the plan is
 * read again (the write's invalidation covers the plan and the notice).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ListChecks, Trash2 } from "lucide-react";
import type {
  FeedPrunePackage,
  FeedPruneReport,
  FeedScope,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import {
  formatBytes,
  formatCount,
  formatShort,
} from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { csvValue, downloadCsv, toCsv } from "../../../../ui/data-table/csv.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { mutate } from "../../../data/mutations.js";
import { feedPruneQuery, feedRetentionQuery } from "../data.js";
import { ECOSYSTEM_LABELS } from "../model/model.js";

const day = (seconds: number): string => formatShort(seconds * 1000);

function versions(n: number): string {
  return `${formatCount(n)} ${n === 1 ? "version" : "versions"}`;
}

const KEPT_REASON = {
  pinned: "pinned by a channel",
  referenced: "named by another version",
} as const;

/** First and last version a package loses, as the plan lists them. */
function range(p: FeedPrunePackage): string {
  const first = p.prune[0]?.version;
  const last = p.prune[p.prune.length - 1]?.version;
  return first && last && first !== last ? `${first} … ${last}` : (first ?? "");
}

/** The whole plan as CSV: every version cleanup deletes, and every one it holds back. */
export function planCsv(report: FeedPruneReport): string {
  const rows: string[][] = [];
  for (const p of report.packages) {
    const eco = ECOSYSTEM_LABELS[p.ecosystem as keyof typeof ECOSYSTEM_LABELS];
    for (const v of p.prune)
      rows.push(
        [
          p.name,
          eco ?? p.ecosystem,
          v.version,
          "delete",
          "",
          v.files,
          v.bytes,
        ].map(csvValue),
      );
    for (const k of p.kept)
      rows.push(
        [
          p.name,
          eco ?? p.ecosystem,
          k.version,
          "keep",
          KEPT_REASON[k.reason],
          "",
          "",
        ].map(csvValue),
      );
  }
  return toCsv(
    ["Package", "Feed", "Version", "Action", "Reason", "Files", "Bytes"],
    rows,
  );
}

/** The Packages callout: when cleanup starts for a product that never chose. */
export function CleanupNotice({
  scope,
}: {
  scope: FeedScope;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const retention = useQuery({
    ...feedRetentionQuery(scope),
    enabled: scope.kind === "product",
  });
  const r = retention.data;
  if (!r || r.source !== "default" || !r.notice) return null;
  return (
    <>
      <Callout
        tone="warning"
        title={`Cleanup starts ${day(r.notice.startsAt)}`}
        action={
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            See the dry run
          </Button>
        }
      >
        From {day(r.notice.startsAt)}, each stable release deletes the dev and
        beta builds older than it. Nothing goes before.
      </Callout>
      <CleanupDryRun scope={scope} open={open} onOpenChange={setOpen} />
    </>
  );
}

function PlanRow({ p }: { p: FeedPrunePackage }): React.ReactElement {
  const eco = ECOSYSTEM_LABELS[p.ecosystem as keyof typeof ECOSYSTEM_LABELS];
  const cell = "px-3 py-2 align-top max-sm:block max-sm:px-0 max-sm:py-1";
  return (
    <tr className="border-b border-border max-sm:block max-sm:px-3 max-sm:py-2">
      <td className={cell}>
        <div className="font-mono text-sm break-all text-fg-strong">
          {p.name}
        </div>
        <div className="text-xs text-fg-muted">{eco ?? p.ecosystem}</div>
      </td>
      <td className={cell}>
        <span className="text-xs text-fg-muted sm:hidden">Deletes </span>
        {p.prune.length ? (
          <>
            <div>
              {versions(p.prune.length)} · {formatBytes(p.bytes)}
            </div>
            <div className="font-mono text-xs break-all text-fg-muted">
              {range(p)}
            </div>
          </>
        ) : (
          <span className="text-fg-muted">Nothing</span>
        )}
      </td>
      <td className={cell}>
        <span className="text-xs text-fg-muted sm:hidden">Keeps </span>
        <div>Every stable version</div>
        <div className="text-xs text-fg-muted">
          Dev and beta newer than {p.stable}
        </div>
        {p.kept.map((k) => (
          <div key={k.releaseId} className="text-xs text-fg-muted">
            <span className="font-mono break-all">{k.version}</span>,{" "}
            {KEPT_REASON[k.reason]}
          </div>
        ))}
      </td>
    </tr>
  );
}

function Body({
  report,
  readAt,
}: {
  report: FeedPruneReport;
  readAt: number;
}): React.ReactElement {
  const n = report.totals.versions;
  const held = report.packages.reduce((a, p) => a + p.kept.length, 0);
  const notice = report.retention.notice;
  const on = report.retention.prunePrereleases;
  const start = notice ? day(notice.startsAt) : null;
  const when = on
    ? "Cleanup is on. These go with the next stable release."
    : start && report.retention.source === "default"
      ? `These go with the first stable release after ${start}.`
      : "Cleanup is off. These stay unless you delete them now.";
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        <p className="m-0 text-xs text-fg-muted">
          Read {formatShort(readAt, { time: true })}
        </p>
        <p className="m-0 font-semibold text-fg-strong">
          {n ? when : "Nothing to delete."}
        </p>
        <p className="m-0 text-fg-muted">Copies on public registries stay.</p>
      </div>
      {n ? (
        <>
          <div
            role="region"
            aria-label="What cleanup deletes and keeps"
            tabIndex={0}
            className="overflow-x-auto rounded-lg border border-border"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">
                What cleanup deletes and keeps
              </caption>
              <thead className="max-sm:sr-only">
                <tr className="border-b border-border text-xs text-fg-muted">
                  <th className="px-3 py-2 text-start font-medium">Package</th>
                  <th className="px-3 py-2 text-start font-medium">Deletes</th>
                  <th className="px-3 py-2 text-start font-medium">Keeps</th>
                </tr>
              </thead>
              <tbody>
                {report.packages.map((p) => (
                  <PlanRow key={p.deliverableId} p={p} />
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold max-sm:block max-sm:py-2">
                  <td className="px-3 py-2 max-sm:block max-sm:px-0">
                    {report.packages.length}{" "}
                    {report.packages.length === 1 ? "package" : "packages"}
                  </td>
                  <td className="px-3 py-2 max-sm:block max-sm:px-0">
                    <span className="text-xs font-normal text-fg-muted sm:hidden">
                      Deletes{" "}
                    </span>
                    {versions(n)} · {formatBytes(report.totals.bytes)}
                  </td>
                  <td className="px-3 py-2 max-sm:block max-sm:px-0">
                    <span className="text-xs font-normal text-fg-muted sm:hidden">
                      Keeps{" "}
                    </span>
                    {held ? `${formatCount(held)} held back` : null}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {report.skipped.length ? (
            <p className="m-0 text-sm text-fg-muted">
              {formatCount(report.skipped.length)}{" "}
              {report.skipped.length === 1 ? "package has" : "packages have"} no
              stable release yet; nothing of{" "}
              {report.skipped.length === 1 ? "its" : "theirs"} goes.
            </p>
          ) : null}
          <p className="m-0 text-sm text-fg-muted">
            Kept: every stable version, and any dev or beta newer than the
            latest stable.{" "}
            <button
              type="button"
              className="inline-flex items-center gap-1 text-fg-strong underline underline-offset-2"
              onClick={() =>
                downloadCsv(
                  `cleanup-dry-run-${report.product}.csv`,
                  planCsv(report),
                )
              }
            >
              Download all {formatCount(n)} (CSV)
              <Download aria-hidden className="size-3.5" />
            </button>
          </p>
        </>
      ) : null}
    </div>
  );
}

export function CleanupDryRun({
  scope,
  open,
  onOpenChange,
}: {
  scope: FeedScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const plan = useQuery({
    ...feedPruneQuery(scope),
    enabled: open,
    // A plan is a point in time: read it again each time the dialog opens.
    staleTime: 0,
  });
  const gate = useWriteGate(
    "ship",
    scope.kind === "product" ? scope.slug : null,
  );
  const [confirming, setConfirming] = React.useState(false);
  const [turningOff, setTurningOff] = React.useState(false);
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const report = plan.data;
  const canTurnOff =
    !!report &&
    !report.retention.locked &&
    (report.retention.prunePrereleases ||
      report.retention.source === "default");

  const turnOff = async (): Promise<void> => {
    if (!report) return;
    setTurningOff(true);
    try {
      await mutate("saveFeedRetention", scope, {
        expectedVersion: report.retention.version,
        prunePrereleases: false,
      });
      toast.success("Cleanup turned off");
      onOpenChange(false);
    } catch (e) {
      if ((e as { status?: unknown } | null)?.status === 409) {
        toast.error("The cleanup setting changed. Review it and try again.");
        void plan.refetch();
      } else toast.error(errorCopy(e).title);
    } finally {
      setTurningOff(false);
    }
  };
  const n = report?.totals.versions ?? 0;
  const start =
    report?.retention.notice && report.retention.source === "default"
      ? day(report.retention.notice.startsAt)
      : null;

  const apply = async (): Promise<void> => {
    const res = await mutate("pruneFeeds", scope);
    const gone = res.totals.versions;
    if (res.totals.failed)
      toast.error(
        `${versions(gone)} deleted, ${formatCount(res.totals.failed)} failed. Run it again to retry.`,
      );
    else if (res.more)
      toast.success(
        `${versions(gone)} deleted. More remain: delete again to continue.`,
      );
    else toast.success(`${versions(gone)} deleted`);
    // The Delete button unmounts with the last version: focus the dialog title instead.
    requestAnimationFrame(() => titleRef.current?.focus());
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title="Cleanup dry run"
        titleRef={titleRef}
        glyph={<ListChecks aria-hidden className="size-5 text-fg-muted" />}
      >
        <DialogBody>
          {plan.isPending ? (
            <div aria-hidden data-skeleton="cleanup" className="space-y-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : plan.isError || !report ? (
            <ErrorState
              error={plan.error}
              compact
              onRetry={() => void plan.refetch()}
              context={{
                area: "distribution",
                thing: "The dry run",
                read: true,
              }}
            />
          ) : (
            <Body report={report} readAt={plan.dataUpdatedAt} />
          )}
        </DialogBody>
        <DialogFooter>
          {canTurnOff ? (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              loading={turningOff}
              disabledReason={gate.disabledReason}
              onClick={() => void turnOff()}
            >
              Turn off cleanup
            </Button>
          ) : null}
          {n ? (
            <Button
              variant="outline"
              className="border-danger-border text-danger"
              iconStart={<Trash2 aria-hidden />}
              disabledReason={gate.disabledReason}
              onClick={() => setConfirming(true)}
            >
              Delete {formatCount(n)} {n === 1 ? "version" : "versions"} now
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>
            {n && start ? `Keep the ${start} start` : "Close"}
          </Button>
        </DialogFooter>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        intent="danger"
        typedConfirmation={{
          value: scope.kind === "product" ? scope.slug : "delete",
          label: "Type the product slug",
        }}
        title={`Delete ${versions(n)} now?`}
        consequences={[
          "A deleted version can't be published again.",
          "Installs that ask for one fail.",
          `Frees ${formatBytes(report?.totals.freedBytes ?? 0)}.`,
        ]}
        confirmLabel={`Delete ${versions(n)}`}
        onConfirm={apply}
        describeError={(e) => errorCopy(e)}
      />
    </>
  );
}
