import * as React from "react";
import type { DeviceDto, ProductDeviceDto } from "../../api.js";
import { fromSeconds } from "../../lib/format.js";
import { PLATFORM_LABELS } from "../../lib/labels.js";
import {
  DataTable,
  type DataColumn,
  type DataTableProps,
  type Facet,
  type RowActionItem,
  type TableState,
} from "../../ui/data-table/index.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Timestamp } from "../../ui/Timestamp.js";
import { Link } from "../router.js";
import { EntityLink, entityHref } from "./EntityLink.js";

/** A device row: the product Devices list's shape, or a license's device (no license column). */
export type DeviceRow =
  | ProductDeviceDto
  | (DeviceDto & { licenseId?: undefined; seatNo?: undefined });

export interface DeviceTableProps {
  /** The product the devices belong to (for links). */
  slug: string;
  devices: DeviceRow[];
  /** Show the License column (Core → Devices). The license record's Devices tab hides it. */
  showLicense?: boolean;
  /** Row actions, already filtered to the valid ones (Deauthorize only when authorized…). */
  rowActions?: (device: DeviceRow) => RowActionItem[];
  /** Default: the routed device drawer (`devices/:id`). */
  rowHref?: (device: DeviceRow) => string;
  state?: TableState;
  onStateChange?: (next: TableState) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: React.ReactNode;
  pagination?: DataTableProps<DeviceRow>["pagination"];
  /** Namespaces the table's preferences; default "devices". */
  id?: string;
  /** "Now" for stable relative times (stories, tests). */
  now?: number;
  /**
   * The platform facet's choices. Default: the platforms in `devices`. A server-paged caller
   * passes the product's full list (its summary), since a filtered page holds only one.
   */
  platforms?: string[];
  /** The search box's placeholder, when the server searches differently. */
  searchPlaceholder?: string;
}

const STATUS_FACET: Facet<DeviceRow> = {
  id: "status",
  label: "Status",
  options: [
    { value: "authorized", label: "Authorized" },
    { value: "deauthorized", label: "Deauthorized" },
  ],
};

/**
 * The one device table (ADMIN.md §7.2: built in chunk 3 so the Core → Devices page (chunk 5) and
 * the license record's Devices tab (chunk 6) share it, DEV-8). Presentational: the caller fetches,
 * filters on the server when it pages, and passes the row actions that are valid per row.
 */
export function DeviceTable({
  slug,
  devices,
  showLicense = true,
  rowActions,
  rowHref,
  state,
  onStateChange,
  loading,
  error,
  onRetry,
  empty,
  pagination,
  id = "devices",
  now,
  platforms: platformList,
  searchPlaceholder = "Search device, id or version",
}: DeviceTableProps): React.ReactElement {
  const columns = React.useMemo<DataColumn<DeviceRow>[]>(() => {
    const cols: DataColumn<DeviceRow>[] = [
      {
        id: "device",
        header: "Device",
        accessorFn: (d) => d.label || d.deviceId,
        meta: { priority: 1, primary: true, csv: (d) => d.deviceId },
        cell: ({ row }) => {
          const d = row.original;
          return (
            <span className="flex min-w-0 max-w-[22rem] flex-col">
              {d.label ? (
                <span className="truncate">{d.label}</span>
              ) : (
                // No label: a muted placeholder, not the 32-character id in bold.
                <span className="truncate font-normal text-fg-muted">
                  Unnamed device
                </span>
              )}
              <span className="truncate font-mono text-xs font-normal text-fg-muted">
                {d.deviceId}
              </span>
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        accessorKey: "status",
        meta: { priority: 1 },
        cell: ({ row }) => (
          <StatusPill domain="device" state={row.original.status} />
        ),
      },
    ];
    if (showLicense) {
      cols.push({
        id: "license",
        header: "License",
        accessorFn: (d) => d.licenseId ?? "",
        meta: { priority: 1 },
        cell: ({ row }) => {
          const d = row.original;
          if (!d.licenseId)
            return (
              <StatusPill tone="neutral" icon={null}>
                License-free
              </StatusPill>
            );
          return (
            <span className="text-xs">
              <EntityLink slug={slug} kind="license" id={d.licenseId} />
              {d.seatNo != null ? (
                <span className="text-fg-muted"> · seat {d.seatNo}</span>
              ) : null}
            </span>
          );
        },
      });
    }
    cols.push(
      {
        id: "platform",
        header: "Platform",
        accessorFn: (d) =>
          [
            d.platform ? (PLATFORM_LABELS[d.platform] ?? d.platform) : null,
            d.arch,
          ]
            .filter(Boolean)
            .join(" · "),
        meta: { priority: 2 },
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap">
            {(getValue() as string) || "—"}
          </span>
        ),
      },
      {
        id: "app",
        header: "App",
        accessorFn: (d) => d.appVersion ?? "",
        meta: { priority: 2, mono: true },
        cell: ({ row }) => {
          const d = row.original;
          return (
            <span>
              {d.appVersion ?? "—"}
              {d.sdkName ? (
                <span className="font-sans text-fg-muted">
                  {" "}
                  · {d.sdkName}
                  {d.sdkVersion ? ` ${d.sdkVersion}` : ""}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "firstSeen",
        header: "Added",
        accessorKey: "firstSeen",
        meta: {
          priority: 3,
          csv: (d) => new Date(fromSeconds(d.firstSeen)).toISOString(),
        },
        cell: ({ row }) => (
          <Timestamp at={fromSeconds(row.original.firstSeen)} now={now} />
        ),
      },
      {
        id: "lastSeen",
        header: "Last seen",
        accessorKey: "lastSeen",
        meta: {
          priority: 1,
          csv: (d) => new Date(fromSeconds(d.lastSeen)).toISOString(),
        },
        cell: ({ row }) => (
          <Timestamp at={fromSeconds(row.original.lastSeen)} now={now} />
        ),
      },
    );
    return cols;
  }, [showLicense, slug, now]);

  const platforms = React.useMemo(
    () =>
      [
        ...new Set(
          platformList ??
            devices.map((d) => d.platform).filter((p): p is string => !!p),
        ),
      ]
        .sort()
        .map((p) => ({ value: p, label: PLATFORM_LABELS[p] ?? p })),
    [devices, platformList],
  );
  const facets: Facet<DeviceRow>[] = [
    STATUS_FACET,
    ...(platforms.length > 1
      ? [
          {
            id: "platform",
            label: "Platform",
            options: platforms,
            accessor: (d: DeviceRow) => d.platform,
          },
        ]
      : []),
  ];

  return (
    <DataTable<DeviceRow>
      id={id}
      caption="Devices"
      data={devices}
      columns={columns}
      getRowId={(d) => d.deviceId}
      rowLabel={(d) => d.label || d.deviceId}
      rowHref={
        rowHref ?? ((d) => entityHref(slug, { kind: "device", id: d.deviceId }))
      }
      linkComponent={Link}
      rowActions={rowActions}
      facets={facets}
      search={{
        placeholder: searchPlaceholder,
        columns: ["device", "app", "license"],
      }}
      state={state}
      onStateChange={onStateChange}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={empty}
      pagination={pagination}
      mobile="cards"
    />
  );
}
