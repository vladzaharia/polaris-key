import * as React from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Breadcrumbs } from "../../console/components/Breadcrumbs.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PageTabs, TabPanel } from "../../console/components/PageTabs.js";
import { CollectionTemplate } from "../../console/templates/Collection.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
} from "../../console/templates/Dashboard.js";
import {
  DangerAction,
  DangerZone,
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../console/templates/Settings.js";
import { Button } from "../../ui/Button.js";
import { BarList } from "../../ui/charts/BarList.js";
import { Meter } from "../../ui/charts/Meter.js";
import { StatTile } from "../../ui/charts/StatTile.js";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  type DataColumn,
  type TableState,
} from "../../ui/data-table/index.js";
import { Input } from "../../ui/Input.js";
import { SourceBadge } from "../../ui/SourceBadge.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Timestamp } from "../../ui/Timestamp.js";
import type { Story } from "../types.js";

/** A fixed "now" so stories render the same every time (3 Oct 2026, 12:00 UTC). */
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

interface RunRow {
  id: string;
  job: string;
  outcome: "ok" | "failed" | "running";
  startedAt: number;
  durationMs: number;
}

const RUNS: RunRow[] = [
  {
    id: "run_9",
    job: "Expire licenses",
    outcome: "ok",
    startedAt: NOW - 12 * MIN,
    durationMs: 840,
  },
  {
    id: "run_8",
    job: "Prune sessions",
    outcome: "running",
    startedAt: NOW - 2 * MIN,
    durationMs: 0,
  },
  {
    id: "run_7",
    job: "Refresh store status",
    outcome: "failed",
    startedAt: NOW - HOUR,
    durationMs: 30_000,
  },
  {
    id: "run_6",
    job: "Expire licenses",
    outcome: "ok",
    startedAt: NOW - 25 * HOUR,
    durationMs: 790,
  },
];

const OUTCOME = {
  ok: { tone: "success", label: "Succeeded" },
  failed: { tone: "danger", label: "Failed" },
  running: { tone: "accent", label: "Running" },
} as const;

const RUN_COLUMNS: DataColumn<RunRow>[] = [
  {
    id: "job",
    header: "Job",
    accessorKey: "job",
    meta: { priority: 1, primary: true },
  },
  {
    id: "outcome",
    header: "Outcome",
    accessorKey: "outcome",
    meta: { priority: 1 },
    cell: ({ row }) => (
      <StatusPill tone={OUTCOME[row.original.outcome].tone}>
        {OUTCOME[row.original.outcome].label}
      </StatusPill>
    ),
  },
  {
    id: "startedAt",
    header: "Started",
    accessorKey: "startedAt",
    meta: { priority: 2 },
    cell: ({ row }) => <Timestamp at={row.original.startedAt} now={NOW} />,
  },
  {
    id: "durationMs",
    header: "Duration",
    accessorKey: "durationMs",
    meta: { priority: 3, numeric: true },
    cell: ({ row }) =>
      row.original.outcome === "running"
        ? "—"
        : `${(row.original.durationMs / 1000).toFixed(1)} s`,
  },
];

function RunsTable({ id }: { id: string }): React.ReactElement {
  const [state, setState] = React.useState<TableState>(EMPTY_TABLE_STATE);
  return (
    <DataTable<RunRow>
      id={id}
      caption="Scheduled job runs"
      data={RUNS}
      columns={RUN_COLUMNS}
      getRowId={(r) => r.id}
      rowLabel={(r) => r.job}
      facets={[
        {
          id: "outcome",
          label: "Outcome",
          options: [
            { value: "ok", label: "Succeeded" },
            { value: "failed", label: "Failed" },
            { value: "running", label: "Running" },
          ],
        },
      ]}
      search={{ placeholder: "Search jobs", columns: ["job"] }}
      state={state}
      onStateChange={setState}
    />
  );
}

function DashboardDemo(): React.ReactElement {
  return (
    <DashboardTemplate
      header={
        <PageHeader
          title="Operations"
          description="This deployment's scheduled work, storage and traffic."
          freshness={{
            updatedAt: NOW - 2 * MIN,
            onRefresh: () => undefined,
            now: NOW,
          }}
        />
      }
      attention={
        <AttentionList
          items={[
            {
              id: "a1",
              tone: "danger",
              object: "Refresh store status",
              reason: "Failed on its last run: the store API timed out.",
              action: { label: "View run", href: "#/__kit" },
              at: NOW - HOUR,
            },
            {
              id: "a2",
              tone: "warning",
              object: "Signing key rk-2026-09",
              reason: "Expires in 12 days.",
              action: { label: "Rotate…", onSelect: () => undefined },
            },
          ]}
        />
      }
      tiles={
        <>
          <StatTile
            label="Requests today"
            value="48,210"
            sparkline={[30, 34, 41, 38, 44, 47, 48]}
          />
          <StatTile
            label="Error rate"
            value="0.4 %"
            delta={{ value: "−0.1", tone: "success", label: "vs yesterday" }}
          />
          <StatTile label="Jobs failed (24 h)" value="1" />
          <StatTile label="Artifact storage" loading />
        </>
      }
      primary={
        <Panel
          title="Recent job runs"
          action={
            <Button variant="link" size="sm">
              View all
            </Button>
          }
        >
          <RunsTable id="kit-t1-runs" />
        </Panel>
      }
      side={
        <Panel title="Storage">
          <div className="space-y-4">
            <Meter label="Database" value={412} max={5_000} format="count" />
            <Meter
              label="Artifacts"
              value={0.82}
              max={1}
              format="percent"
              tone="warning"
            />
            <BarList
              label="Largest products"
              items={[
                { label: "DJ Deck", value: 1_840 },
                { label: "Field Recorder", value: 920 },
                { label: "Lab Suite", value: 310 },
              ]}
            />
          </div>
        </Panel>
      }
    />
  );
}

function SettingsDemo(): React.ReactElement {
  return (
    <SettingsTemplate
      header={
        <PageHeader
          title="Settings"
          description="Values this deployment reads at runtime. Each row saves on its own."
        />
      }
      sections={[
        { id: "kit-t4-sessions", title: "Sessions" },
        { id: "kit-t4-mail", title: "Mail" },
        { id: "kit-t4-danger", title: "Danger zone" },
      ]}
    >
      <SettingsSection
        id="kit-t4-sessions"
        title="Sessions"
        description="How long an operator stays signed in."
      >
        <SettingsRow
          label="Session lifetime"
          htmlFor="kit-t4-lifetime"
          help="Hours before the console asks to sign in again."
          source={
            <SourceBadge
              source="runtime"
              by="ops@example.com"
              at={NOW - 3 * HOUR}
              onRevert={() => undefined}
            />
          }
        >
          <Input
            id="kit-t4-lifetime"
            defaultValue="12"
            inputMode="numeric"
            suffix="hours"
          />
        </SettingsRow>
        <SettingsRow
          label="Idle timeout"
          htmlFor="kit-t4-idle"
          help="Minutes of inactivity before a session ends."
          source={<SourceBadge source="default" />}
        >
          <Input
            id="kit-t4-idle"
            defaultValue="60"
            inputMode="numeric"
            suffix="minutes"
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        id="kit-t4-mail"
        title="Mail"
        description="Where sign-in links and receipts come from."
        source={<SourceBadge source="deploy" />}
      >
        <SettingsRow label="From address">
          <span className="font-mono text-xs">no-reply@example.com</span>
        </SettingsRow>
      </SettingsSection>
      <DangerZone id="kit-t4-danger">
        <DangerAction
          title="Sign out every operator"
          consequence="Every console session ends now; operators sign in again."
          action={<Button variant="danger">Sign out everyone…</Button>}
        />
      </DangerZone>
    </SettingsTemplate>
  );
}

function CollectionDemo(): React.ReactElement {
  const [tab, setTab] = React.useState("runs");
  return (
    <CollectionTemplate
      header={
        <PageHeader
          eyebrow={
            <Breadcrumbs
              items={[
                { label: "Platform", to: "#/__kit" },
                { label: "Operations" },
              ]}
            />
          }
          title="Job runs"
          titleAside={
            <span className="text-sm tabular-nums text-fg-muted">
              {RUNS.length}
            </span>
          }
          description="Every scheduled run on this deployment, newest first."
          primaryAction={<Button iconStart={<RefreshCw />}>Run now…</Button>}
          secondaryActions={[
            { label: "Export CSV", onSelect: () => undefined },
          ]}
          tabs={
            <PageTabs
              label="Operations"
              idPrefix="kit-t2"
              value={tab}
              onChange={setTab}
              items={[
                { value: "runs", label: "Job runs", count: RUNS.length },
                { value: "deploys", label: "Deploy history" },
              ]}
            />
          }
        />
      }
      summary={
        <>
          <StatTile label="Runs (24 h)" value="96" />
          <StatTile label="Failed" value="1" />
          <StatTile label="Median duration" value="0.8 s" />
          <StatTile label="Next run" value="in 3 min" />
        </>
      }
    >
      <TabPanel idPrefix="kit-t2" value="runs" current={tab}>
        <RunsTable id="kit-t2-table" />
      </TabPanel>
      <TabPanel idPrefix="kit-t2" value="deploys" current={tab}>
        <p className="text-sm text-fg-muted">
          Each deploy of this Worker, with its version and who ran it.
        </p>
      </TabPanel>
    </CollectionTemplate>
  );
}

export const stories: Story[] = [
  {
    id: "template-dashboard",
    group: "Templates",
    title: "T1 · Dashboard",
    description:
      "Header with freshness, the attention list, 2–4 tiles that load on their own, a 2/3 + 1/3 row that stacks under 1024 px.",
    render: () => <DashboardDemo />,
  },
  {
    id: "template-collection",
    group: "Templates",
    title: "T2 · Collection",
    description:
      "Breadcrumbs, a header with one primary action, panel tabs, a summary strip and the DataTable.",
    render: () => <CollectionDemo />,
  },
  {
    id: "template-settings",
    group: "Templates",
    title: "T4 · Settings",
    description:
      "Sectioned cards, a per-row source, the 'On this page' rail at 1280 px and the danger zone last.",
    render: () => <SettingsDemo />,
  },
  {
    id: "page-header",
    group: "Templates",
    title: "PageHeader",
    description:
      "One h1, one primary action, two secondary actions inline and the rest (danger last) in More actions.",
    render: () => (
      <PageHeader
        eyebrow={
          <Breadcrumbs
            items={[
              { label: "Licenses", to: "#/__kit" },
              { label: "Studio Pro" },
            ]}
          />
        }
        title="Studio Pro"
        titleAside={<StatusPill domain="license" state="active" />}
        description="Pro tier · 3 seats · holder ada@example.com"
        primaryAction={<Button iconStart={<Plus />}>Mint key</Button>}
        secondaryActions={[
          { label: "Edit holder…", onSelect: () => undefined },
          { label: "Extend…", onSelect: () => undefined },
          { label: "Copy id", onSelect: () => undefined },
        ]}
        dangerActions={[
          { label: "Disable license…", onSelect: () => undefined },
        ]}
      />
    ),
  },
];
