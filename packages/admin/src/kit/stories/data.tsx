import * as React from "react";
import {
  DeviceTable,
  type DeviceRow,
} from "../../console/components/DeviceTable.js";
import { DescriptionList } from "../../ui/DescriptionList.js";
import { Grid } from "../../ui/Grid.js";
import { Stepper } from "../../ui/Stepper.js";
import { Timeline, TimelineItem } from "../../ui/Timeline.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Button } from "../../ui/Button.js";
import { EmptyState } from "../../ui/EmptyState.js";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  type DataColumn,
  type DataTableProps,
  type Facet,
  type TableState,
} from "../../ui/data-table/index.js";
import type { Story } from "../types.js";

/** A fixed "now" so stories render the same every time (3 Oct 2026, 12:00 UTC). */
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 24 * 3600 * 1000;

interface LicenseRow {
  id: string;
  name: string;
  email: string;
  status: "active" | "expired" | "disabled";
  tier: string;
  seats: number;
  keys: number;
}

const TIERS = ["Pro", "Edu", "Studio"];
const STATUSES: LicenseRow["status"][] = [
  "active",
  "active",
  "active",
  "expired",
  "disabled",
];
const NAMES = [
  "Studio Pro",
  "Lab 3",
  "Old seat",
  "Night shift",
  "Field kit",
  "Booth A",
  "Archive",
];

function licenses(n: number): LicenseRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `lic_${String(i + 1).padStart(4, "0")}`,
    name: `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ""}`,
    email: `holder${i + 1}@example.com`,
    status: STATUSES[i % STATUSES.length]!,
    tier: TIERS[i % TIERS.length]!,
    seats: (i * 7) % 6,
    keys: (i % 3) + 1,
  }));
}

const COLUMNS: DataColumn<LicenseRow>[] = [
  {
    id: "name",
    header: "Holder",
    accessorKey: "name",
    meta: { priority: 1, primary: true },
  },
  { id: "email", header: "Email", accessorKey: "email", meta: { priority: 2 } },
  {
    id: "status",
    header: "Status",
    accessorKey: "status",
    meta: { priority: 1 },
    cell: ({ row }) => (
      <StatusPill domain="license" state={row.original.status} />
    ),
  },
  { id: "tier", header: "Tier", accessorKey: "tier", meta: { priority: 2 } },
  {
    id: "seats",
    header: "Seats",
    accessorKey: "seats",
    meta: { priority: 2, numeric: true },
  },
  {
    id: "keys",
    header: "Keys",
    accessorKey: "keys",
    meta: { priority: 3, numeric: true },
  },
  {
    id: "id",
    header: "Id",
    accessorKey: "id",
    meta: { priority: 3, mono: true },
  },
];

const FACETS: Facet<LicenseRow>[] = [
  {
    id: "status",
    label: "Status",
    options: [
      { value: "active", label: "Active" },
      { value: "expired", label: "Expired" },
      { value: "disabled", label: "Disabled" },
    ],
  },
  {
    id: "tier",
    label: "Tier",
    options: TIERS.map((t) => ({ value: t, label: t })),
  },
];

/** A DataTable with local state (stories have no router). */
function Table(
  props: Partial<DataTableProps<LicenseRow>> & {
    initial?: Partial<TableState>;
    rows?: number;
  },
): React.ReactElement {
  const { initial, rows = 12, ...rest } = props;
  const [state, setState] = React.useState<TableState>({
    ...EMPTY_TABLE_STATE,
    ...initial,
  });
  const data = React.useMemo(() => licenses(rows), [rows]);
  return (
    <DataTable<LicenseRow>
      id="kit-licenses"
      caption="Licenses"
      data={data}
      columns={COLUMNS}
      getRowId={(r) => r.id}
      rowLabel={(r) => r.name}
      rowHref={(r) => `#/__kit?license=${r.id}`}
      facets={FACETS}
      search={{
        placeholder: "Search name, email or id",
        columns: ["name", "email", "id"],
      }}
      rowActions={(r) => [
        { label: "Edit holder…", onSelect: () => undefined },
        { label: "Mint key", onSelect: () => undefined },
        { type: "separator" },
        {
          label: "Disable license…",
          tone: "danger",
          onSelect: () => undefined,
          disabledReason:
            r.status === "disabled" ? "Already disabled" : undefined,
        },
      ]}
      state={state}
      onStateChange={setState}
      {...rest}
    />
  );
}

const DEVICES: DeviceRow[] = [
  {
    deviceId: "dev_8f2c41a9",
    label: "Ada's MacBook Pro",
    status: "authorized",
    firstSeen: (NOW - 30 * DAY) / 1000,
    lastSeen: (NOW - 2 * 3600 * 1000) / 1000,
    platform: "macos",
    arch: "arm64",
    appVersion: "2.4.0",
    sdkName: "swift",
    sdkVersion: "1.3.0",
    licenseId: "lic_0001",
    seatNo: 1,
  },
  {
    deviceId: "dev_19ab77c0",
    status: "authorized",
    firstSeen: (NOW - 60 * DAY) / 1000,
    lastSeen: (NOW - 14 * DAY) / 1000,
    platform: "windows",
    arch: "x64",
    appVersion: "2.3.9",
    licenseId: null,
    seatNo: null,
  },
  {
    deviceId: "dev_c0ffee12",
    label: "Studio PC",
    status: "deauthorized",
    firstSeen: (NOW - 90 * DAY) / 1000,
    lastSeen: (NOW - 40 * DAY) / 1000,
    platform: "linux",
    arch: "x64",
    appVersion: "2.1.0",
    licenseId: "lic_0002",
    seatNo: 3,
  },
];

const RELEASES = ["2.4.0", "2.3.9", "2.4.0-rc.2"];
const OUTLETS = ["direct", "App Store", "Google Play", "AltStore"];
const CELL: Record<string, string> = {
  "2.4.0:direct": "Live",
  "2.4.0:App Store": "In review",
  "2.4.0:Google Play": "Live · 25 %",
  "2.4.0:AltStore": "Held",
};
const cellText = (r: string, c: string): string =>
  CELL[`${r}:${c}`] ??
  (r.includes("rc") && c !== "direct" ? "Not available" : "Live");

function GridDemo(): React.ReactElement {
  const [opened, setOpened] = React.useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Grid
        label="Distribution matrix: releases by outlet"
        cornerLabel="Release"
        rows={RELEASES}
        columns={OUTLETS}
        getRowId={(r) => r}
        getColumnId={(c) => c}
        rowHeader={(r) => <span className="font-mono text-xs">{r}</span>}
        columnHeader={(c) => c}
        cell={(r, c) => (
          <StatusPill
            tone={
              cellText(r, c).startsWith("Live")
                ? "success"
                : cellText(r, c) === "Held"
                  ? "warning"
                  : "neutral"
            }
          >
            {cellText(r, c)}
          </StatusPill>
        )}
        cellLabel={(r, c) => `${r} on ${c}: ${cellText(r, c)}`}
        onCellActivate={(r, c) => setOpened(`${r} × ${c}`)}
      />
      <p className="text-xs text-fg-muted">
        {opened
          ? `Opened the cell drawer for ${opened}.`
          : "Arrow keys move; Enter opens a cell."}
      </p>
    </div>
  );
}

function StepperDemo(): React.ReactElement {
  const steps = [
    { id: "source", label: "Source" },
    { id: "basics", label: "Basics" },
    { id: "catalog", label: "Catalog" },
    { id: "defaults", label: "Defaults" },
    { id: "review", label: "Review" },
  ];
  const [current, setCurrent] = React.useState("catalog");
  return (
    <Stepper
      steps={steps}
      current={current}
      onStep={setCurrent}
      label="New product steps"
    />
  );
}

interface KitEvent {
  id: string;
  at: number;
  actor: { name: string } | "system";
  verb: string;
  target?: string;
  summary?: string;
}

const EVENTS: KitEvent[] = [
  {
    id: "e1",
    at: NOW - 40 * 60 * 1000,
    actor: { name: "Ada Lovelace" },
    verb: "published catalog",
    target: "version 8",
  },
  {
    id: "e2",
    at: NOW - 2 * 3600 * 1000,
    actor: { name: "Ada Lovelace" },
    verb: "disabled license",
    target: "Studio Pro",
    summary: "Chargeback; customer notified. Action code license.disable.",
  },
  {
    id: "e3",
    at: NOW - 26 * 3600 * 1000,
    actor: "system",
    verb: "evicted 3 device tokens for",
    target: "Lab 3",
  },
  {
    id: "e4",
    at: NOW - 4 * DAY,
    actor: { name: "CI release.yml" },
    verb: "set rollout 2.4.0 to 25 % on",
    target: "App Store",
  },
];

function CursorTable(): React.ReactElement {
  const [n, setN] = React.useState(10);
  return (
    <Table
      id="kit-cursor"
      rows={n}
      pagination={{
        mode: "cursor",
        hasMore: n < 30,
        total: 30,
        onLoadMore: () => setN((v) => v + 10),
      }}
    />
  );
}

function OffsetTable(): React.ReactElement {
  const [size, setSize] = React.useState(10);
  return (
    <Table
      id="kit-offset"
      rows={47}
      density="compact"
      pagination={{
        mode: "offset",
        pageSize: size,
        pageSizeOptions: [10, 25, 50],
        onPageSizeChange: setSize,
      }}
    />
  );
}

function Devices(): React.ReactElement {
  const [state, setState] = React.useState<TableState>(EMPTY_TABLE_STATE);
  return (
    <DeviceTable
      slug="djdl"
      id="kit-devices"
      devices={DEVICES}
      now={NOW}
      state={state}
      onStateChange={setState}
      rowHref={(d) => `#/__kit?device=${d.deviceId}`}
      rowActions={(d) =>
        d.status === "authorized"
          ? [
              { label: "Reset binding…", onSelect: () => undefined },
              { type: "separator" },
              {
                label: "Deauthorize…",
                tone: "danger",
                onSelect: () => undefined,
              },
            ]
          : [{ label: "Reset binding…", onSelect: () => undefined }]
      }
    />
  );
}

export const stories: Story[] = [
  {
    id: "data-table-default",
    group: "Data display",
    title: "DataTable: search, facets, sort, columns, row actions",
    description:
      "The holder is a real link; a click elsewhere on the row follows it. Facets show counts and removable chips. j/k move between rows.",
    render: () => (
      <Table
        initial={{
          filters: { status: ["active", "expired"] },
          sort: [{ id: "name", desc: false }],
        }}
      />
    ),
  },
  {
    id: "data-table-selection",
    group: "Data display",
    title: "DataTable: selection and the bulk bar",
    description:
      "Selecting rows replaces the filter bar with the bulk actions.",
    render: () => (
      <Table
        id="kit-selection"
        rows={6}
        selection={{
          mode: "multi",
          bulkActions: [
            { label: "Disable…", tone: "danger", onSelect: () => undefined },
            { label: "Export", onSelect: () => undefined },
          ],
        }}
      />
    ),
  },
  {
    id: "data-table-loading",
    group: "Data display",
    title: "DataTable: loading",
    description:
      "Skeleton rows match the columns; the live region announces the load.",
    render: () => <Table id="kit-loading" rows={0} loading />,
  },
  {
    id: "data-table-error",
    group: "Data display",
    title: "DataTable: error",
    description: "The error renders inline in the table body, with Retry.",
    render: () => (
      <Table
        id="kit-error"
        rows={0}
        error={new TypeError("Failed to fetch")}
        onRetry={() => undefined}
      />
    ),
  },
  {
    id: "data-table-empty",
    group: "Data display",
    title: "DataTable: first run",
    description: "No rows and no filters: the page's first-run state.",
    render: () => (
      <Table
        id="kit-empty"
        rows={0}
        empty={
          <EmptyState
            kind="first-run"
            title="No licenses yet"
            description="A license grants a holder access to DJDL on a set number of devices. Create one to issue the first key."
            primaryAction={<Button>Create license</Button>}
          />
        }
      />
    ),
  },
  {
    id: "data-table-no-results",
    group: "Data display",
    title: "DataTable: no results",
    description: "Filters that match nothing offer Clear filters.",
    render: () => (
      <Table
        id="kit-no-results"
        initial={{ q: "zzz", filters: { tier: ["Edu"] } }}
      />
    ),
  },
  {
    id: "data-table-cursor",
    group: "Data display",
    title: "DataTable: cursor pagination",
    description: "Load more appends the next server page.",
    render: () => <CursorTable />,
  },
  {
    id: "data-table-offset",
    group: "Data display",
    title: "DataTable: offset pagination and compact density",
    description: "A pager with a page size; compact rows are 36 px.",
    render: () => <OffsetTable />,
  },
  {
    id: "data-table-virtual",
    group: "Data display",
    title: "DataTable: 1,000 rows, virtualized",
    description:
      "Above 200 rows in client mode, only a window of rows is in the DOM.",
    render: () => <Table id="kit-virtual" rows={1000} />,
  },
  {
    id: "data-table-cards",
    group: "Data display",
    title: "DataTable: mobile cards",
    description:
      'Below 768 px, mobile="cards" lists the priority-1 columns as cards (narrow the window to see it).',
    render: () => <Table id="kit-cards" rows={4} mobile="cards" />,
  },
  {
    id: "device-table",
    group: "Data display",
    title: "DeviceTable",
    description:
      "The shared device table of Core → Devices and the license record's Devices tab.",
    render: () => <Devices />,
  },
  {
    id: "description-list",
    group: "Data display",
    title: "DescriptionList",
    description: "One, two or three columns; one column below 640 px.",
    render: () => (
      <div className="space-y-6">
        <DescriptionList
          columns={3}
          items={[
            { term: "Tier", detail: "Pro" },
            {
              term: "Expires",
              detail: "30 Sep 2027, 23:59 CEST",
              help: "The end of the holder's local day.",
            },
            {
              term: "Max offline",
              detail: "30 days",
              help: "From the product default.",
            },
            { term: "Channels", detail: "stable, beta" },
            { term: "Versions", detail: "2.0.0 and later" },
            { term: "Device limit", detail: "5 (tier)" },
          ]}
        />
        <DescriptionList
          items={[
            { term: "Registration", detail: "License required" },
            { term: "Fingerprint policy", detail: "Normal" },
          ]}
        />
      </div>
    ),
  },
  {
    id: "timeline",
    group: "Data display",
    title: "Timeline",
    description:
      "Grouped by day; runtime rows show Polaris Key; summaries expand.",
    render: () => (
      <Timeline<KitEvent>
        label="Activity for DJDL"
        items={EVENTS}
        now={NOW}
        timeZone="UTC"
        getKey={(e) => e.id}
        getTime={(e) => e.at}
        loadMore={{ hasMore: true, onLoadMore: () => undefined }}
        renderItem={(e) => (
          <TimelineItem
            actor={e.actor}
            verb={e.verb}
            target={
              e.target ? (
                <a
                  href="#/__kit"
                  className="font-bold text-accent-fg hover:underline"
                >
                  {e.target}
                </a>
              ) : undefined
            }
            at={e.at}
            timeZone="UTC"
            summary={e.summary}
          />
        )}
      />
    ),
  },
  {
    id: "grid",
    group: "Data display",
    title: "Grid (matrix primitive)",
    description:
      "One tab stop; arrows, Home/End, Ctrl+Home/End; Enter opens the cell drawer; each cell's name is a sentence.",
    render: () => <GridDemo />,
  },
  {
    id: "stepper",
    group: "Data display",
    title: "Stepper",
    description:
      "Completed steps go back; future steps are disabled with a reason.",
    render: () => <StepperDemo />,
  },
];
