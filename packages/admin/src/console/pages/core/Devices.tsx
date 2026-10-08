/**
 * Core → Devices (T2 + routed drawer; docs/design/ADMIN.md §2.3, §7.2 chunk 5). Every device of
 * the product, licensed or license-free.
 *
 * - One device table, shared with the license record (chunk 3's `DeviceTable`, DEV-8); its
 *   license column links to the license (DEV-1).
 * - The drawer is routed (`devices/:deviceId`): linkable, Back closes it, and it shows every fact
 *   the server keeps (DEV-2, DEV-3).
 * - Filters (status, platform, license, search) are the table's URL state and are applied by the
 *   server, which pages by cursor; the summary tiles are filters too, and say what they count
 *   (DEV-4, DEV-5). The total for the current filter shows when the summary can answer it.
 * - Search is a prefix on the device id or label, as the server matches (DEV-6).
 */

import * as React from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Download, MonitorSmartphone } from "lucide-react";
import {
  api,
  type ProductDevicePage,
  type ProductDeviceQuery,
  type ProductDeviceSummary,
} from "../../../api.js";
import { cn } from "../../../lib/cn.js";
import { formatCount, formatIso, fromSeconds } from "../../../lib/format.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import {
  downloadCsv,
  toCsv,
  type RowActionItem,
} from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { DeviceDrawer } from "../../components/DeviceDrawer.js";
import { DeviceTable, type DeviceRow } from "../../components/DeviceTable.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { navigate, useLocation } from "../../router.js";
import { r } from "../../routes.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { intentOf } from "./confirmGate.js";

const PAGE_SIZE = 50;
const FACETS = ["status", "platform"] as const;

export function fetchDeviceSummary(
  slug: string,
): Promise<ProductDeviceSummary> {
  return api.productDeviceSummary(slug);
}

/** The server query for the table's state. Two status values (or none) read as all. */
export function deviceQuery(
  status: string[],
  platform: string[],
  license: string,
  q: string,
): ProductDeviceQuery {
  return {
    status: status.length === 1 ? (status[0] as "authorized") : "all",
    ...(platform.length === 1 ? { platform: platform[0] } : {}),
    ...(license === "licensed"
      ? { licensed: true }
      : license === "free"
        ? { licensed: false }
        : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
    limit: PAGE_SIZE,
  };
}

export function DevicesPage({
  slug,
  deviceId,
}: {
  slug: string;
  deviceId?: string;
}): React.ReactElement {
  const { route } = useLocation();
  const [state, setState] = useTableUrlState("devices", { facets: FACETS });
  const license = route.query.get("license") ?? "";
  const status = state.filters.status ?? [];
  const platform = state.filters.platform ?? [];
  const query = deviceQuery(status, platform, license, state.q);
  const queryKey = JSON.stringify(query);

  const summary = useQuery(
    {
      queryKey: qk.devicesSummary(slug),
      queryFn: () => fetchDeviceSummary(slug),
    },
    queryClient,
  );
  const list = useInfiniteQuery(
    {
      queryKey: [...qk.devices(slug), "list", queryKey],
      queryFn: ({ pageParam }) =>
        api.productDevices(slug, { ...query, cursor: pageParam }),
      initialPageParam: null as string | null,
      getNextPageParam: (last: ProductDevicePage) =>
        last.nextCursor ?? undefined,
    },
    queryClient,
  );
  useLoadingAnnouncement("devices", list.isPending);

  const rows = React.useMemo(
    () => list.data?.pages.flatMap((p) => p.devices) ?? [],
    [list.data],
  );
  const [deauth, setDeauth] = React.useState<DeviceRow | null>(null);

  const s = summary.data;
  const count = (v: string): number =>
    s?.byStatus.find((x) => x.value === v)?.count ?? 0;
  // The summary answers a total only for a status-only filter.
  const total =
    s && platform.length === 0 && !license && !state.q.trim()
      ? status.length === 1
        ? count(status[0]!)
        : s.total
      : undefined;
  const platforms = s?.byPlatform
    .map((p) => p.value)
    .filter((p): p is string => !!p);

  const setLicense = (next: string | null): void => {
    const params = new URLSearchParams(route.query);
    if (next) params.set("license", next);
    else params.delete("license");
    params.delete("cursor");
    const qs = params.toString();
    navigate(`${r.devices(slug)}${qs ? `?${qs}` : ""}`, { replace: true });
  };
  const setStatus = (next: string | null): void =>
    setState({
      ...state,
      cursor: null,
      filters: { ...state.filters, status: next ? [next] : [] },
    });
  const filtered =
    status.length > 0 || platform.length > 0 || !!license || !!state.q.trim();

  const exportLoaded = (): void => {
    const csv = toCsv(
      [
        "device_id",
        "label",
        "status",
        "license_id",
        "platform",
        "arch",
        "app_version",
        "first_seen",
        "last_seen",
      ],
      rows.map((d) => [
        d.deviceId,
        d.label ?? "",
        d.status,
        d.licenseId ?? "",
        d.platform ?? "",
        d.arch ?? "",
        d.appVersion ?? "",
        formatIso(fromSeconds(d.firstSeen)),
        formatIso(fromSeconds(d.lastSeen)),
      ]),
    );
    if (!downloadCsv(`${slug}-devices.csv`, csv))
      toast.error("Couldn't save the file");
  };

  const closeDrawer = (): void => {
    const qs = route.query.toString();
    navigate(`${r.devices(slug)}${qs ? `?${qs}` : ""}`);
  };
  const rowHref = (d: DeviceRow): string => {
    const qs = route.query.toString();
    return `${r.device(slug, d.deviceId)}${qs ? `?${qs}` : ""}`;
  };

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Devices"
          titleAside={
            s ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {formatCount(s.total)}
              </span>
            ) : null
          }
          refetching={list.isRefetching}
          secondaryActions={[
            {
              label: "Export CSV",
              icon: <Download aria-hidden />,
              onSelect: exportLoaded,
              disabledReason: rows.length ? undefined : "Nothing is loaded.",
            },
          ]}
        />
      }
      summary={
        // No devices at all: four zero tiles that filter nothing would only add noise.
        s && count("authorized") + count("deauthorized") > 0 ? (
          <>
            <FacetTile
              label="Authorized"
              value={count("authorized")}
              pressed={status.length === 1 && status[0] === "authorized"}
              onToggle={(on) => setStatus(on ? "authorized" : null)}
            />
            <FacetTile
              label="Deauthorized"
              value={count("deauthorized")}
              pressed={status.length === 1 && status[0] === "deauthorized"}
              onToggle={(on) => setStatus(on ? "deauthorized" : null)}
            />
            <FacetTile
              label="Licensed"
              hint="authorized"
              value={s.licensed.licensed}
              pressed={license === "licensed"}
              onToggle={(on) => setLicense(on ? "licensed" : null)}
            />
            <FacetTile
              label="License-free"
              hint="authorized"
              value={s.licensed.licenseFree}
              pressed={license === "free"}
              onToggle={(on) => setLicense(on ? "free" : null)}
            />
          </>
        ) : undefined
      }
    >
      <DeviceTable
        slug={slug}
        devices={rows}
        platforms={platforms}
        searchPlaceholder="Device id or label starts with…"
        state={state}
        onStateChange={setState}
        loading={list.isPending}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        rowHref={rowHref}
        rowActions={(d) =>
          d.status === "authorized"
            ? ([
                { label: "Open", onSelect: () => navigate(rowHref(d)) },
                { type: "separator" },
                {
                  label: "Deauthorize…",
                  tone: "danger",
                  onSelect: () => setDeauth(d),
                },
              ] satisfies RowActionItem[])
            : [{ label: "Open", onSelect: () => navigate(rowHref(d)) }]
        }
        pagination={{
          mode: "cursor",
          onLoadMore: () => void list.fetchNextPage(),
          hasMore: list.hasNextPage,
          loadingMore: list.isFetchingNextPage,
          total,
        }}
        empty={
          filtered ? undefined : (
            <EmptyState
              kind="first-run"
              title="No devices yet"
              description="A device appears here the first time it registers or activates a license. Point an SDK at this product to see one."
              docs="/docs/admin/licenses-and-devices/"
            />
          )
        }
      />
      {license ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <MonitorSmartphone aria-hidden className="size-4" />
          Showing {license === "free" ? "license-free" : "licensed"} devices
          only.
          <button
            type="button"
            className="text-accent-fg underline-offset-4 hover:underline"
            onClick={() => setLicense(null)}
          >
            Show all
          </button>
        </p>
      ) : null}

      <DeviceDrawer slug={slug} deviceId={deviceId} onClose={closeDrawer} />
      <ConfirmDialog
        open={deauth !== null}
        onOpenChange={(o) => !o && setDeauth(null)}
        intent={intentOf("device.deauthorize")}
        title={`Deauthorize ${deauth?.label || deauth?.deviceId || "device"}?`}
        consequences={
          deauth?.licenseId
            ? [
                "The device loses access and its token is revoked.",
                "Its seat on the license is freed.",
                "To use the license again it must re-activate.",
              ]
            : [
                "The device loses access and its token is revoked.",
                "It holds no license, so no seat is freed.",
                "Under open registration it can register again on its next start.",
              ]
        }
        confirmLabel="Deauthorize"
        describeError={(e) => errorCopy(e, { thing: "Device" })}
        onConfirm={async () => {
          await mutate("deauthorizeProductDevice", slug, deauth!.deviceId);
          toast.success("Device deauthorized");
        }}
      />
    </CollectionTemplate>
  );
}

/** A summary tile that is also a filter (`aria-pressed`); it says what it counts. */
function FacetTile({
  label,
  hint,
  value,
  pressed,
  onToggle,
}: {
  label: string;
  hint?: string;
  value: number;
  pressed: boolean;
  onToggle: (on: boolean) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onToggle(!pressed)}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border bg-surface-raised px-4 py-3 text-left",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
        pressed
          ? "border-accent bg-accent-subtle"
          : "border-border hover:border-border-strong",
      )}
    >
      <span className="text-xs font-bold text-fg-muted">
        {label}
        {hint ? <span className="font-normal"> · {hint}</span> : null}
      </span>
      <span className="text-2xl font-bold tabular-nums text-fg-strong">
        {formatCount(value)}
      </span>
      {pressed ? (
        <span className="text-xs text-fg-muted">
          Filtering · select to clear
        </span>
      ) : null}
    </button>
  );
}
