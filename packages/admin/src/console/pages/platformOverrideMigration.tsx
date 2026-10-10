/**
 * Platform → Override migration (U-03; notes/S-17 §5.12, decision 21): the one-time move of every
 * product's licence config and secret overrides onto account overrides, from
 * `/manage/api/platform/override-migration` (worker `console/handlers/overrideMigration.ts`).
 *
 * The order is the Worker's and the page only offers the next step:
 *
 *   1. the owner flags the login card (I-07) and the Library (I-11) live in production: facts
 *      about production the console can't check, so each needs a confirm;
 *   2. the 30-day notice starts (both flagged), and can be withdrawn until the run;
 *   3. the run, once the notice has run its 30 days: typed `migrate`, a sign-in from the last
 *      five minutes, up to 25 products per call ("Continue run" until every product is through).
 *      Owned licences' config and secrets move to their owner's account overrides, unowned
 *      licences' are dropped. There is no undo in the console: for the 90-day report window the
 *      licences keep their old values (the RUNBOOK's rollback window), then the nightly job
 *      empties them;
 *   4. the report, kept 90 days, with a CSV download. Secret values are never in it.
 *
 * A dry run shows the report the run would write, for every product or one, and writes nothing.
 * The daily inventory counts each product's licences. Entitlement overrides stay on each licence
 * throughout.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  api,
  ApiError,
  type OverrideMigrationDryRun,
  type OverrideMigrationOutcome,
  type OverrideMigrationPhase,
  type OverrideMigrationProductCounts,
  type OverrideMigrationProgress,
  type OverrideMigrationReportRow,
  type OverrideMigrationState,
  type OverrideMigrationStoredRow,
} from "../../api.js";
import { confirmFor, triggerVariant } from "../../lib/actions.js";
import { errorCopy } from "../../lib/errorCopy.js";
import { formatCount, formatDate, fromSeconds } from "../../lib/format.js";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import {
  DataTable,
  downloadCsv,
  type DataColumn,
  type Facet,
} from "../../ui/data-table/index.js";
import { EmptyState } from "../../ui/EmptyState.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { Select } from "../../ui/Select.js";
import { PageSkeleton } from "../../ui/Skeleton.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Timestamp } from "../../ui/Timestamp.js";
import { toast } from "../../ui/toast.js";
import { EntityLink } from "../components/EntityLink.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useProducts } from "../data/hooks.js";
import { mutate } from "../data/mutations.js";
import { useOverrideMigration } from "../data/overrideMigration.js";
import { qk } from "../data/queries.js";
import { r } from "../routes.js";
import { SettingsRow, SettingsSection } from "../templates/Settings.js";
import { intentOf } from "./core/confirmGate.js";
import { StepUpCallout, useStepUp } from "./core/UserRelink.js";

// ── the model ─────────────────────────────────────────────────────────────────────────────────

export type PrerequisiteKey = "loginCard" | "library";

export const PREREQUISITES: {
  key: PrerequisiteKey;
  label: string;
  /** In a sentence: "the login card (I-07)". */
  name: string;
  /** The work package that ships it. */
  wp: string;
  help: string;
}[] = [
  {
    key: "loginCard",
    label: "Login card",
    name: "the login card (I-07)",
    wp: "I-07",
    help: "The sign-in card products show their players, so a customer can sign in and own a license.",
  },
  {
    key: "library",
    label: "Library",
    name: "the Library (I-11)",
    wp: "I-11",
    help: "The portal's Library, where a customer adds a license key to their account.",
  },
];

const prerequisiteName = (key: PrerequisiteKey): string =>
  PREREQUISITES.find((x) => x.key === key)!.name;

export const PHASE_LABELS: Record<
  OverrideMigrationPhase,
  { label: string; tone: "neutral" | "info" | "warning" | "success" }
> = {
  idle: { label: "Not started", tone: "neutral" },
  notice: { label: "Notice running", tone: "info" },
  running: { label: "Running", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
};

/** What the page offers, from the state alone. `reason` is why an offered action is unavailable. */
export interface MigrationGates {
  /** The prerequisites not yet flagged live, in page order. */
  missing: PrerequisiteKey[];
  /** Why a flagged prerequisite can't be unflagged (the notice started), or null. */
  unflagLocked: string | null;
  startNotice: { visible: boolean; reason: string | null };
  withdrawNotice: { visible: boolean };
  run: {
    visible: boolean;
    /** The run started and has products left: the button continues it, with no new confirm. */
    continuing: boolean;
    reason: string | null;
  };
  /** The run has started, so it has report rows to show. */
  report: boolean;
  /** A dry run still has something to say (the run has not completed). */
  dryRun: boolean;
}

export function migrationGates(
  state: OverrideMigrationState,
  now: number = Date.now(),
): MigrationGates {
  const missing = PREREQUISITES.map((p) => p.key).filter(
    (k) => state.prerequisites[k].liveAt === null,
  );
  const { phase } = state;
  const runNotBefore = state.notice.runNotBefore;
  let runReason: string | null = null;
  if (phase === "notice" && !state.notice.runAllowed) {
    runReason =
      runNotBefore !== null && fromSeconds(runNotBefore) > now
        ? `The notice runs until ${formatDate(fromSeconds(runNotBefore))}. The run can't start before.`
        : "The notice window hasn't ended yet.";
  }
  return {
    missing,
    unflagLocked:
      phase === "idle"
        ? null
        : phase === "notice"
          ? "The notice has started. Withdraw it before unflagging."
          : "The migration has run.",
    startNotice: {
      visible: phase === "idle",
      reason:
        missing.length > 0
          ? `Flag ${missing.map(prerequisiteName).join(" and ")} live in production first.`
          : null,
    },
    withdrawNotice: { visible: phase === "notice" },
    run: {
      visible: phase === "notice" || phase === "running",
      continuing: phase === "running",
      reason: runReason,
    },
    report: state.run.id !== null,
    dryRun: phase !== "completed",
  };
}

const OUTCOMES: Record<
  OverrideMigrationOutcome,
  { label: string; tone: "success" | "warning" | "danger" }
> = {
  moved: { label: "Moved", tone: "success" },
  collapsed: { label: "Collapsed", tone: "warning" },
  dropped: { label: "Dropped", tone: "danger" },
};

/** A reported value, compactly. Only non-secret config values ever reach the console. */
function showValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value === "" ? '""' : value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The key names a row moves or drops: config keys, then secrets by name. */
export function rowKeys(row: OverrideMigrationReportRow): string {
  const parts = [...row.keys.config];
  if (row.keys.secrets.length)
    parts.push(...row.keys.secrets.map((k) => `${k} (secret)`));
  return parts.join(", ") || "—";
}

/**
 * What a row loses: a collapse's losing values (named only, for a secret or a value the catalog
 * does not declare), or a dropped licence's config values. Moved rows lose nothing.
 */
export function rowLost(row: OverrideMigrationReportRow): string[] {
  if (row.outcome === "collapsed") {
    return (row.values.collapsed ?? []).map((c) => {
      const from =
        c.keptFrom === "account" ? "the account's value" : c.keptFrom;
      return "lost" in c
        ? `${c.key}: ${showValue(c.lost)} (kept ${from})`
        : `${c.key} (kept ${from}; value not shown)`;
    });
  }
  if (row.outcome === "dropped") {
    const shown = row.values.config ?? {};
    return [
      ...row.keys.config.map((k) =>
        k in shown ? `${k}: ${showValue(shown[k])}` : k,
      ),
      ...row.keys.secrets.map((k) => `${k} (secret)`),
    ];
  }
  return [];
}

function reportColumns<
  T extends OverrideMigrationReportRow,
>(): DataColumn<T>[] {
  return [
    {
      id: "outcome",
      header: "Outcome",
      accessorFn: (row) => row.outcome,
      meta: { priority: 1, csv: (row) => OUTCOMES[row.outcome].label },
      cell: ({ row }) => {
        const o = OUTCOMES[row.original.outcome];
        return (
          <StatusPill tone={o.tone} size="sm">
            {o.label}
          </StatusPill>
        );
      },
    },
    {
      id: "product",
      header: "Product",
      accessorFn: (row) => row.product,
      meta: { priority: 2, mono: true },
    },
    {
      id: "license",
      header: "License",
      accessorFn: (row) => row.licenseId,
      meta: { priority: 1 },
      cell: ({ row }) => (
        <EntityLink
          slug={row.original.product}
          kind="license"
          id={row.original.licenseId}
        />
      ),
    },
    {
      id: "owner",
      header: "Owner",
      accessorFn: (row) => row.subject ?? "",
      meta: {
        priority: 1,
        csv: (row) =>
          row.subject ?? (row.subjectCreatedAtRun ? "created at the run" : ""),
      },
      cell: ({ row }) =>
        row.original.subject ? (
          <EntityLink
            slug={row.original.product}
            kind="user"
            id={row.original.subject}
            className="block max-w-[8rem] truncate"
            title={row.original.subject}
          />
        ) : row.original.subjectCreatedAtRun ? (
          <span className="text-fg-muted">Created at the run</span>
        ) : (
          <span className="text-fg-muted">No account</span>
        ),
    },
    {
      id: "buyer",
      header: "Buyer email",
      accessorFn: (row) => row.buyerEmail ?? "",
      meta: { priority: 2 },
      cell: ({ row }) =>
        row.original.buyerEmail ? (
          <span
            className="block max-w-[12rem] truncate"
            title={row.original.buyerEmail}
          >
            {row.original.buyerEmail}
          </span>
        ) : (
          "—"
        ),
    },
    {
      // The key names; the Lost values column already names what a row loses.
      id: "keys",
      header: "Keys",
      accessorFn: (row) => rowKeys(row),
      enableSorting: false,
      meta: { priority: 3, mono: true },
    },
    {
      id: "lost",
      header: "Lost values",
      accessorFn: (row) => rowLost(row).join("; "),
      enableSorting: false,
      meta: { priority: 1 },
      cell: ({ row }) => {
        const lost = rowLost(row.original);
        return lost.length ? (
          <ul className="space-y-0.5 font-mono text-xs">
            {lost.map((l) => (
              <li key={l} className="break-words">
                {l}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-fg-muted">None</span>
        );
      },
    },
  ];
}

const OUTCOME_FACET = <T extends OverrideMigrationReportRow>(): Facet<T>[] => [
  {
    id: "outcome",
    label: "Outcome",
    options: (["moved", "collapsed", "dropped"] as const).map((o) => ({
      value: o,
      label: OUTCOMES[o].label,
    })),
  },
];

const INVENTORY_COLUMNS: DataColumn<OverrideMigrationProductCounts>[] = [
  {
    id: "product",
    header: "Product",
    accessorFn: (p) => p.product,
    meta: { priority: 1, primary: true, mono: true },
  },
  {
    id: "licences",
    header: "Licenses with overrides",
    accessorFn: (p) => p.licences,
    meta: { priority: 1, numeric: true },
    cell: ({ row }) => formatCount(row.original.licences),
  },
  {
    id: "owned",
    header: "Move to owners",
    accessorFn: (p) => p.owned,
    meta: { priority: 1, numeric: true },
    cell: ({ row }) => formatCount(row.original.owned),
  },
  {
    id: "dropped",
    header: "Dropped",
    accessorFn: (p) => p.dropped,
    meta: { priority: 1, numeric: true },
    cell: ({ row }) => formatCount(row.original.dropped),
  },
  {
    id: "collapsing",
    header: "Collapsing accounts",
    accessorFn: (p) => p.collapsingAccounts,
    meta: { priority: 2, numeric: true },
    cell: ({ row }) => formatCount(row.original.collapsingAccounts),
  },
];

const HASH = r.platformOverrideMigration();

/**
 * A 409 here is the Worker refusing a step out of order (`notice_started`, `notice_window`,
 * `run_in_progress`…), not a concurrent edit: its own message says which.
 */
export function refusalCopy(
  e: unknown,
  thing: string,
): { title: string; description?: string } {
  if (
    e instanceof ApiError &&
    e.status === 409 &&
    e.message &&
    !e.message.startsWith("api ")
  )
    return { title: "Not possible right now", description: e.message };
  return errorCopy(e, { thing });
}

// ── the page ──────────────────────────────────────────────────────────────────────────────────

export function OverrideMigrationPage(): React.ReactElement {
  const q = useOverrideMigration();
  const header = (
    <PageHeader
      title="Override migration"
      titleAside={
        q.data ? (
          <StatusPill tone={PHASE_LABELS[q.data.state.phase].tone}>
            {PHASE_LABELS[q.data.state.phase].label}
          </StatusPill>
        ) : undefined
      }
      description="Moves every product's license config and secret overrides to account overrides, once."
      freshness={
        q.dataUpdatedAt
          ? {
              updatedAt: q.dataUpdatedAt,
              onRefresh: () => void q.refetch(),
              refreshing: q.isFetching,
            }
          : undefined
      }
    />
  );

  if (q.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="the override migration" />
      </div>
    );
  }
  if (!q.data?.state) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  return <MigrationBody header={header} state={q.data.state} />;
}

function MigrationBody({
  header,
  state,
}: {
  header: React.ReactNode;
  state: OverrideMigrationState;
}): React.ReactElement {
  const gates = migrationGates(state);
  // T4's sections without its "On this page" rail: the report tables need the width.
  return (
    <div className="space-y-6" data-template="settings">
      {header}
      <Callout tone="info" title="The production run is the owner's decision">
        It can be scheduled no earlier than {state.noticeDays} days after both
        the login card (I-07) and the Library (I-11) are live in production:
        flag both below once they are, then start the notice. At the run, owned
        licenses' config and secret overrides move to their owners' account
        overrides and unowned licenses' are dropped. Entitlement overrides stay
        on each license. From the run's start, OIDC licenses that aren't in an
        account stop receiving provisioned secrets, such as a VPN subscription
        URL: count them in the dry run before you start the notice.
      </Callout>
      <PrerequisitesSection state={state} gates={gates} />
      <NoticeSection state={state} gates={gates} />
      <RunSection state={state} gates={gates} />
      <InventorySection state={state} />
      {gates.dryRun ? <DryRunSection /> : null}
      {gates.report ? <ReportSection state={state} /> : null}
    </div>
  );
}

// ── prerequisites ─────────────────────────────────────────────────────────────────────────────

function PrerequisitesSection({
  state,
  gates,
}: {
  state: OverrideMigrationState;
  gates: MigrationGates;
}): React.ReactElement {
  const [change, setChange] = React.useState<{
    key: PrerequisiteKey;
    live: boolean;
  } | null>(null);
  const target = change
    ? PREREQUISITES.find((p) => p.key === change.key)!
    : null;
  return (
    <SettingsSection
      id="prerequisites"
      title="Prerequisites"
      description="The notice can start once both are live in production. The console can't check this: flag each one yourself."
    >
      <div className="divide-y divide-border">
        {PREREQUISITES.map((p) => {
          const flag = state.prerequisites[p.key];
          return (
            <SettingsRow
              key={p.key}
              label={`${p.label} (${p.wp})`}
              help={p.help}
              aside={
                flag.liveAt !== null ? (
                  <StatusPill tone="success" size="sm">
                    Live since {formatDate(fromSeconds(flag.liveAt))}
                  </StatusPill>
                ) : (
                  <StatusPill tone="neutral" size="sm">
                    Not flagged
                  </StatusPill>
                )
              }
            >
              {flag.liveAt !== null ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabledReason={gates.unflagLocked ?? undefined}
                  onClick={() => setChange({ key: p.key, live: false })}
                >
                  Unflag…
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setChange({ key: p.key, live: true })}
                >
                  Flag as live…
                </Button>
              )}
            </SettingsRow>
          );
        })}
      </div>
      <ConfirmDialog
        open={change !== null}
        onOpenChange={(o) => !o && setChange(null)}
        intent={intentOf(
          change?.live === false
            ? "overrideMigration.unflagPrerequisite"
            : "overrideMigration.flagPrerequisite",
        )}
        title={
          change?.live === false
            ? `Unflag ${target?.name}?`
            : `Is ${target?.name} live in production?`
        }
        consequences={
          change?.live === false
            ? [
                "The notice can't start until it is flagged again.",
                "Nothing else changes.",
              ]
            : [
                `Flag it only once ${target?.name} is live in production. This is the owner's assertion: the console can't check it.`,
                "Once both prerequisites are flagged, the 30-day notice can start.",
                "You can unflag it until the notice starts.",
              ]
        }
        confirmLabel={change?.live === false ? "Unflag" : "Flag as live"}
        describeError={(e) => refusalCopy(e, "Prerequisite")}
        onConfirm={async () => {
          if (!change) return;
          await mutate("putOverrideMigrationPrerequisites", {
            [change.key]: change.live,
          });
          toast.success(
            change.live
              ? `${target?.label} flagged as live`
              : `${target?.label} unflagged`,
          );
        }}
      />
    </SettingsSection>
  );
}

// ── notice ────────────────────────────────────────────────────────────────────────────────────

function NoticeSection({
  state,
  gates,
}: {
  state: OverrideMigrationState;
  gates: MigrationGates;
}): React.ReactElement {
  const [dialog, setDialog] = React.useState<"start" | "withdraw" | null>(null);
  const runDate = formatDate(Date.now() + state.noticeDays * 86_400_000);
  const { notice } = state;
  return (
    <SettingsSection
      id="notice"
      title="Notice"
      description={`The notice runs ${state.noticeDays} days. Meanwhile every license's Config tab, and the Licenses page of each product with affected licenses, say where its config and secret overrides go.`}
    >
      <div className="divide-y divide-border">
        <SettingsRow
          label="Status"
          help={
            notice.startedAt !== null
              ? undefined
              : "Starting it schedules the earliest run 30 days out. You can withdraw it until the run."
          }
          aside={
            notice.startedAt !== null ? (
              <span className="text-sm text-fg">
                Started <Timestamp at={fromSeconds(notice.startedAt)} />
              </span>
            ) : (
              <StatusPill tone="neutral" size="sm">
                Not started
              </StatusPill>
            )
          }
        >
          {gates.startNotice.visible ? (
            <Button
              size="sm"
              disabledReason={gates.startNotice.reason ?? undefined}
              onClick={() => setDialog("start")}
            >
              Start notice…
            </Button>
          ) : null}
          {gates.withdrawNotice.visible ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialog("withdraw")}
            >
              Withdraw notice…
            </Button>
          ) : null}
        </SettingsRow>
        {notice.runNotBefore !== null ? (
          <SettingsRow
            label="Earliest run"
            help="The run can't start before this date."
          >
            <Timestamp at={fromSeconds(notice.runNotBefore)} format="date" />
          </SettingsRow>
        ) : null}
      </div>
      <ConfirmDialog
        open={dialog === "start"}
        onOpenChange={(o) => !o && setDialog(null)}
        intent={intentOf("overrideMigration.startNotice")}
        title="Start the 30-day notice?"
        consequences={[
          `The run becomes possible on ${runDate}, and not before.`,
          "Every license's Config tab says where its config and secret overrides go: to the owner's account overrides, or dropped when no account owns the license.",
          "Products with affected licenses show the notice on their Licenses page.",
          "You can withdraw the notice until the run starts.",
        ]}
        confirmLabel="Start notice"
        describeError={(e) => refusalCopy(e, "Notice")}
        onConfirm={async () => {
          await mutate("startOverrideMigrationNotice");
          toast.success("Notice started", {
            description: `The run is possible from ${runDate}.`,
          });
        }}
      />
      <ConfirmDialog
        open={dialog === "withdraw"}
        onOpenChange={(o) => !o && setDialog(null)}
        intent={intentOf("overrideMigration.withdrawNotice")}
        title="Withdraw the notice?"
        consequences={[
          "License Config tabs and Licenses pages stop showing the move.",
          "A new notice runs its full 30 days before the run is possible again.",
        ]}
        confirmLabel="Withdraw notice"
        describeError={(e) => refusalCopy(e, "Notice")}
        onConfirm={async () => {
          await mutate("withdrawOverrideMigrationNotice");
          toast.success("Notice withdrawn");
        }}
      />
    </SettingsSection>
  );
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────

function ProgressLine({
  progress,
}: {
  progress: OverrideMigrationProgress;
}): React.ReactElement {
  const w = progress.written;
  return (
    <Callout
      tone={progress.done ? "success" : "info"}
      live
      title={
        progress.done
          ? "The migration is complete"
          : "Products are left: continue the run"
      }
    >
      {formatCount(progress.productsDone.length)}{" "}
      {progress.productsDone.length === 1 ? "product" : "products"} done,{" "}
      {formatCount(progress.productsRemaining.length)} left. This step moved{" "}
      {formatCount(w.moved)}, collapsed {formatCount(w.collapsed)} and dropped{" "}
      {formatCount(w.dropped)} {w.dropped === 1 ? "license's" : "licenses'"}{" "}
      overrides.
      {progress.conflicts ? (
        <>
          {" "}
          {formatCount(progress.conflicts)}{" "}
          {progress.conflicts === 1 ? "account was" : "accounts were"} edited
          while the run wrote {progress.conflicts === 1 ? "it" : "them"}:
          continue the run to retry.
        </>
      ) : null}
    </Callout>
  );
}

function RunSection({
  state,
  gates,
}: {
  state: OverrideMigrationState;
  gates: MigrationGates;
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const { fresh: steppedUp, markStale } = useStepUp(true);
  const [progress, setProgress] =
    React.useState<OverrideMigrationProgress | null>(null);
  const [continuing, setContinuing] = React.useState(false);
  const policy = confirmFor("overrideMigration.run");

  /** One run call: up to 25 products. Throws so a dialog can show the refusal. */
  const step = async (): Promise<void> => {
    try {
      const res = await mutate("runOverrideMigration");
      setProgress(res.progress);
      if (res.progress.done) toast.success("The migration is complete");
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") markStale();
      throw e;
    }
  };

  const continueRun = async (): Promise<void> => {
    setContinuing(true);
    try {
      await step();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "step_up_required")) {
        const copy = refusalCopy(e, "Migration");
        toast.error(copy.title, { description: copy.description });
      }
    } finally {
      setContinuing(false);
    }
  };

  const { run } = state;
  return (
    <SettingsSection
      id="run"
      title="Run"
      description="Each step moves up to 25 products. From the first step, license config and secrets are frozen: each license's Config tab edits entitlements only."
    >
      <div className="divide-y divide-border">
        <SettingsRow
          label="Status"
          help={`Needs a sign-in from the last 5 minutes. There's no undo here: for ${state.reportDays} days the licenses keep their old values, which the runbook's rollback uses.`}
          aside={
            run.completedAt !== null ? (
              <span className="text-sm text-fg">
                Completed <Timestamp at={fromSeconds(run.completedAt)} />
              </span>
            ) : run.startedAt !== null ? (
              <span className="text-sm text-fg">
                Started <Timestamp at={fromSeconds(run.startedAt)} /> ·{" "}
                {formatCount(run.productsDone.length)}{" "}
                {run.productsDone.length === 1 ? "product" : "products"} done
              </span>
            ) : (
              <StatusPill tone="neutral" size="sm">
                Not started
              </StatusPill>
            )
          }
        >
          {gates.run.visible && gates.run.continuing ? (
            <Button
              size="sm"
              loading={continuing}
              disabledReason={
                gates.run.reason ??
                (steppedUp ? undefined : "Sign in again first.")
              }
              onClick={() => void continueRun()}
            >
              Continue run
            </Button>
          ) : null}
          {gates.run.visible && !gates.run.continuing ? (
            <Button
              size="sm"
              variant={triggerVariant("overrideMigration.run")}
              disabledReason={gates.run.reason ?? undefined}
              onClick={() => setConfirming(true)}
            >
              Run migration…
            </Button>
          ) : null}
        </SettingsRow>
        {run.reportExpiresAt !== null ? (
          <SettingsRow
            label="Report kept until"
            help={`The report is kept ${state.reportDays} days after the run, then deleted.`}
          >
            <Timestamp at={fromSeconds(run.reportExpiresAt)} format="date" />
          </SettingsRow>
        ) : null}
      </div>
      {gates.run.continuing && !steppedUp ? (
        <div className="px-5 pb-4">
          <StepUpCallout hash={HASH}>
            Running the migration needs a sign-in from the last five minutes.
            You come back to this page afterwards.
          </StepUpCallout>
        </div>
      ) : null}
      {progress ? (
        <div className="px-5 pb-4">
          <ProgressLine progress={progress} />
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        intent={intentOf("overrideMigration.run")}
        title="Run the license override migration?"
        consequences={[
          "Owned licenses' config and secret overrides move to their owners' account overrides.",
          "Unowned licenses' config and secret overrides are dropped. Their customers keep their entitlements.",
          "From the first step, license config and secrets are frozen.",
          `There's no undo in the console. For ${state.reportDays} days the licenses keep their old values (the runbook's rollback window), then they're emptied. The report is kept for ${state.reportDays} days.`,
        ]}
        typedConfirmation={
          policy.typedConfirmation
            ? { value: "migrate", label: "Type" }
            : undefined
        }
        confirmLabel="Run migration"
        confirmDisabled={!steppedUp}
        describeError={(e) => refusalCopy(e, "Migration")}
        onConfirm={step}
      >
        {steppedUp ? null : (
          <StepUpCallout hash={HASH}>
            Running the migration needs a sign-in from the last five minutes.
            You come back to this page afterwards.
          </StepUpCallout>
        )}
      </ConfirmDialog>
    </SettingsSection>
  );
}

// ── inventory ─────────────────────────────────────────────────────────────────────────────────

function Totals({
  totals,
}: {
  totals: { licences: number; owned: number; dropped: number };
}): React.ReactElement {
  return (
    <p className="text-sm text-fg">
      {formatCount(totals.licences)}{" "}
      {totals.licences === 1 ? "license carries" : "licenses carry"} config or
      secret overrides: {formatCount(totals.owned)} move to their owners,{" "}
      {formatCount(totals.dropped)} are dropped.
    </p>
  );
}

function InventorySection({
  state,
}: {
  state: OverrideMigrationState;
}): React.ReactElement {
  const inv = state.inventory;
  return (
    <SettingsSection
      id="inventory"
      title="Inventory"
      description={
        inv ? (
          <>
            Computed <Timestamp at={fromSeconds(inv.computedAt)} /> by the
            nightly maintenance job.
          </>
        ) : (
          "Computed by the nightly maintenance job."
        )
      }
    >
      <div className="space-y-3 px-5 py-4">
        {inv ? (
          <>
            <Totals totals={inv.totals} />
            <DataTable<OverrideMigrationProductCounts>
              id="override-migration-inventory"
              caption="Inventory by product"
              data={inv.products}
              columns={INVENTORY_COLUMNS}
              getRowId={(p) => p.product}
              rowHref={(p) => r.licenses(p.product)}
              exportCsv={false}
              mobile="cards"
              empty={
                <EmptyState
                  kind="first-run"
                  variant="inline"
                  title="No license carries config or secret overrides"
                  description="There is nothing to move or drop."
                />
              }
            />
          </>
        ) : (
          <EmptyState
            kind="first-run"
            variant="inline"
            title="No inventory yet"
            description="The nightly maintenance job counts each product's licenses. A dry run shows the same counts now."
          />
        )}
      </div>
    </SettingsSection>
  );
}

// ── dry run ───────────────────────────────────────────────────────────────────────────────────

/** The registry's products, for a product filter; `null` (the Select's empty option) is all. */
function useProductOptions(): { value: string; label: string }[] {
  const products = useProducts().data ?? [];
  return products.map((p) => ({
    value: p.slug,
    label: `${p.name} (${p.slug})`,
  }));
}

function ProductFilter({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string | null;
  onChange: (slug: string | null) => void;
}): React.ReactElement {
  const options = useProductOptions();
  return (
    <div className="min-w-56 space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-fg-strong">
        Products
      </label>
      <Select
        id={id}
        options={options}
        value={value}
        allowEmpty
        emptyLabel="All products"
        onChange={onChange}
      />
    </div>
  );
}

function DryRunSection(): React.ReactElement {
  const [product, setProduct] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    product: string | null;
    dry: OverrideMigrationDryRun;
  } | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const columns = React.useMemo(
    () => reportColumns<OverrideMigrationReportRow>(),
    [],
  );

  const runDry = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const dry = await mutate("overrideMigrationDryRun", product ?? undefined);
      setResult({ product, dry });
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };

  const counts = result
    ? result.dry.report.reduce(
        (acc, row) => ({ ...acc, [row.outcome]: acc[row.outcome] + 1 }),
        { moved: 0, collapsed: 0, dropped: 0 } as Record<
          OverrideMigrationOutcome,
          number
        >,
      )
    : null;

  return (
    <SettingsSection
      id="dry-run"
      title="Dry run"
      description="The report the run would write, now. It writes nothing, and no secret value is ever in it: secrets are listed by name."
    >
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <ProductFilter
            id="dry-run-product"
            value={product}
            onChange={setProduct}
          />
          <Button
            variant="outline"
            loading={running}
            onClick={() => void runDry()}
          >
            Run dry run
          </Button>
        </div>
        {error ? (
          <ErrorState
            compact
            error={error}
            onRetry={() => void runDry()}
            context={{ thing: "Product" }}
          />
        ) : null}
        {result && counts ? (
          <div className="space-y-3">
            <p className="text-sm text-fg" role="status">
              {result.product ?? "All products"}, computed{" "}
              <Timestamp at={fromSeconds(result.dry.computedAt)} />:{" "}
              {formatCount(counts.moved)} moved, {formatCount(counts.collapsed)}{" "}
              collapsed, {formatCount(counts.dropped)} dropped.
            </p>
            <DataTable<OverrideMigrationReportRow>
              id="override-migration-dry-run"
              caption="Dry run report"
              data={result.dry.report}
              columns={columns}
              getRowId={(row) => `${row.product}:${row.licenseId}`}
              facets={OUTCOME_FACET<OverrideMigrationReportRow>()}
              search={{
                placeholder: "Search license, owner or email",
                columns: ["license", "owner", "buyer", "product"],
              }}
              mobile="cards"
              empty={
                <EmptyState
                  kind="first-run"
                  variant="inline"
                  title="Nothing to move"
                  description="No license of these products carries config or secret overrides."
                />
              }
            />
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}

// ── report ────────────────────────────────────────────────────────────────────────────────────

function ReportSection({
  state,
}: {
  state: OverrideMigrationState;
}): React.ReactElement {
  const [product, setProduct] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState(false);
  const report = useQuery({
    queryKey: qk.overrideMigrationReport(product ?? ""),
    queryFn: () => api.overrideMigrationReport(product ?? undefined),
  });
  const columns = React.useMemo(
    () => reportColumns<OverrideMigrationStoredRow>(),
    [],
  );

  const download = async (): Promise<void> => {
    setDownloading(true);
    try {
      const csv = await api.overrideMigrationReportCsv(product ?? undefined);
      const name = `override-migration-report${product ? `-${product}` : ""}.csv`;
      if (!downloadCsv(name, csv)) toast.error("Couldn't save the file");
    } catch (e) {
      toast.error(e, { context: { thing: "Report" } });
    } finally {
      setDownloading(false);
    }
  };

  const expires = state.run.reportExpiresAt;
  return (
    <SettingsSection
      id="report"
      title="Report"
      description={
        expires !== null
          ? `What the run moved, collapsed and dropped, kept until ${formatDate(fromSeconds(expires))}. No secret value is ever in it.`
          : `What the run moved, collapsed and dropped so far, kept ${state.reportDays} days after the run. No secret value is ever in it.`
      }
    >
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <ProductFilter
            id="report-product"
            value={product}
            onChange={setProduct}
          />
          <Button
            variant="outline"
            iconStart={<Download aria-hidden />}
            loading={downloading}
            onClick={() => void download()}
          >
            Download CSV
          </Button>
        </div>
        <DataTable<OverrideMigrationStoredRow>
          id="override-migration-report"
          caption="Migration report"
          data={report.data?.rows ?? []}
          columns={columns}
          getRowId={(row) => `${row.runId}:${row.product}:${row.licenseId}`}
          facets={OUTCOME_FACET<OverrideMigrationStoredRow>()}
          search={{
            placeholder: "Search license, owner or email",
            columns: ["license", "owner", "buyer", "product"],
          }}
          loading={report.isPending}
          error={report.error ?? undefined}
          onRetry={() => void report.refetch()}
          exportCsv={false}
          mobile="cards"
          empty={
            <EmptyState
              kind="first-run"
              variant="inline"
              title="No report rows"
              description="The run wrote nothing for these products, or the report has expired."
            />
          }
        />
      </div>
    </SettingsSection>
  );
}
