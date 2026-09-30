import * as React from "react";
import { AlertTriangle, MonitorSmartphone } from "lucide-react";
import {
  api,
  type DeviceCount,
  type ProductDeviceDetail,
  type ProductDeviceDto,
  type ProductDeviceStatusFilter,
} from "../api.js";
import { useResource } from "../context.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
  type ColumnDef,
} from "../components/ui/index.js";
import { absoluteTime, relativeTime } from "./format.js";
import { DeviceStatusBadge, formatStamp } from "./licenses/shared.js";

/** Radix Select cannot hold an empty-string item value, so "no filter" gets a sentinel. */
const ANY = "__any__";
const PAGE_SIZE = 50;

type LicensedFilter = "any" | "licensed" | "free";

interface Filters {
  status: ProductDeviceStatusFilter;
  platform: string | null;
  licensed: LicensedFilter;
  q: string;
}

const INITIAL: Filters = {
  status: "authorized",
  platform: null,
  licensed: "any",
  q: "",
};

/**
 * Platform → Devices: every device of the product, including the ones that hold no licence (an
 * open or requires-identity registration game has devices and no licences at all). The table is
 * the summary list; a device's fingerprint and facts load on demand in the detail drawer.
 * "Last seen" is the time of the device's most recent check-in, not a presence indicator.
 */
export function Devices({ slug }: { slug: string }): React.ReactElement {
  const summary = useResource(`devices-summary:${slug}`, () =>
    api.productDeviceSummary(slug),
  );

  const [filters, setFilters] = React.useState<Filters>(INITIAL);
  // `q` is typed into `qDraft` and applied after a pause, so each keystroke is not a request.
  const [qDraft, setQDraft] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(
      () =>
        setFilters((f) =>
          f.q === qDraft.trim() ? f : { ...f, q: qDraft.trim() },
        ),
      300,
    );
    return () => clearTimeout(t);
  }, [qDraft]);

  const [rows, setRows] = React.useState<ProductDeviceDto[]>([]);
  const [next, setNext] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Guards against a slow earlier response overwriting the page for newer filters.
  const seq = React.useRef(0);

  const load = React.useCallback(
    (cursor: string | null) => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      api
        .productDevices(slug, {
          status: filters.status,
          platform: filters.platform ?? undefined,
          licensed:
            filters.licensed === "any"
              ? undefined
              : filters.licensed === "licensed",
          q: filters.q || undefined,
          limit: PAGE_SIZE,
          cursor,
        })
        .then((page) => {
          if (mine !== seq.current) return;
          setRows((prev) =>
            cursor ? [...prev, ...page.devices] : page.devices,
          );
          setNext(page.nextCursor);
        })
        .catch((e: unknown) => {
          if (mine !== seq.current) return;
          setError(e instanceof Error ? e.message : "Request failed.");
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    },
    [slug, filters],
  );

  React.useEffect(() => {
    setRows([]);
    setNext(null);
    load(null);
  }, [load]);

  const [openId, setOpenId] = React.useState<string | null>(null);

  const refreshAll = (): void => {
    summary.reload();
    load(null);
  };

  const set = (patch: Partial<Filters>): void =>
    setFilters((f) => ({ ...f, ...patch }));

  const columns = React.useMemo<ColumnDef<ProductDeviceDto>[]>(
    () => [
      {
        id: "device",
        header: "Device",
        cell: (r) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-foreground">
              {r.label || r.deviceId}
            </span>
            {r.label ? (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {r.deviceId}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: (r) => <DeviceStatusBadge status={r.status} />,
      },
      {
        id: "license",
        header: "Licence",
        cell: (r) =>
          r.licenseId ? (
            <span className="font-mono text-xs">
              {r.licenseId}
              {r.seatNo != null ? (
                <span className="text-muted-foreground">
                  {" "}
                  · seat {r.seatNo}
                </span>
              ) : null}
            </span>
          ) : (
            <Badge variant="outline">Licence-free</Badge>
          ),
      },
      {
        id: "platform",
        header: "Platform",
        cell: (r) => (
          <span className="text-xs">
            {r.platform ?? "—"}
            {r.arch ? ` · ${r.arch}` : ""}
          </span>
        ),
      },
      {
        id: "app",
        header: "App",
        cell: (r) => (
          <span className="text-xs">
            {r.appVersion ?? "—"}
            {r.sdkName ? (
              <span className="text-muted-foreground">
                {" "}
                · {r.sdkName}
                {r.sdkVersion ? ` ${r.sdkVersion}` : ""}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "lastSeen",
        header: "Last seen",
        className: "whitespace-nowrap text-muted-foreground",
        cell: (r) => (
          <time
            dateTime={new Date(r.lastSeen * 1000).toISOString()}
            title={absoluteTime(r.lastSeen)}
          >
            {relativeTime(r.lastSeen)}
          </time>
        ),
      },
    ],
    [],
  );

  const filtered =
    filters.status !== INITIAL.status ||
    filters.platform !== null ||
    filters.licensed !== "any" ||
    filters.q !== "";

  const platforms = summary.data?.byPlatform ?? [];

  return (
    <section aria-labelledby="devices-title" className="space-y-4">
      <header className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <h2
            id="devices-title"
            className="text-xl font-semibold tracking-tight"
          >
            Devices
          </h2>
          <p className="text-sm text-muted-foreground">
            Every device of{" "}
            <span className="font-medium text-foreground">{slug}</span>,
            including those that hold no licence.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          disabled={loading}
          aria-label="Refresh devices"
        >
          Refresh
        </Button>
      </header>

      <SummaryChips
        loading={summary.loading && !summary.data}
        data={summary.data}
        onPlatform={(platform) => set({ platform, status: "authorized" })}
        activePlatform={filters.platform}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <Input
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Device id or label starts with…"
            aria-label="Search devices by id or label prefix"
            maxLength={64}
          />
        </div>
        <div className="w-40">
          <Select
            value={filters.status}
            onValueChange={(v) =>
              set({ status: v as ProductDeviceStatusFilter })
            }
          >
            <SelectTrigger aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="authorized">Authorized</SelectItem>
              <SelectItem value="deauthorized">Deauthorized</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-40">
          <Select
            value={filters.licensed}
            onValueChange={(v) => set({ licensed: v as LicensedFilter })}
          >
            <SelectTrigger aria-label="Licence">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any licence</SelectItem>
              <SelectItem value="licensed">Licensed</SelectItem>
              <SelectItem value="free">Licence-free</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-44">
          <Select
            value={filters.platform ?? ANY}
            onValueChange={(v) => set({ platform: v === ANY ? null : v })}
          >
            <SelectTrigger aria-label="Platform">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any platform</SelectItem>
              {platforms
                .filter(
                  (p): p is DeviceCount & { value: string } => p.value != null,
                )
                .map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.value}
                  </SelectItem>
                ))}
              {filters.platform &&
              !platforms.some((p) => p.value === filters.platform) ? (
                <SelectItem value={filters.platform}>
                  {filters.platform}
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQDraft("");
              setFilters(INITIAL);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {error && rows.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load devices"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={() => load(null)}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.deviceId}
            loading={loading && rows.length === 0}
            onRowClick={(r) => setOpenId(r.deviceId)}
            onRowClickLabel={(r) => `Open device ${r.label || r.deviceId}`}
            empty={
              <EmptyState
                icon={<MonitorSmartphone aria-hidden />}
                title={filtered ? "No devices match" : "No devices yet"}
                description={
                  filtered
                    ? "Try widening the filters."
                    : "Devices appear here once a client registers or activates."
                }
                className="rounded-none border-0"
              />
            }
          />
          <div
            className="flex items-center justify-center gap-3"
            aria-live="polite"
          >
            {error && rows.length > 0 ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            {next ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => load(next)}
                loading={loading && rows.length > 0}
              >
                Load more
              </Button>
            ) : rows.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {rows.length} {rows.length === 1 ? "device" : "devices"}
              </p>
            ) : null}
          </div>
        </>
      )}

      <DeviceDrawer
        slug={slug}
        deviceId={openId}
        onClose={() => setOpenId(null)}
        onChanged={refreshAll}
      />
    </section>
  );
}

function SummaryChips({
  loading,
  data,
  onPlatform,
  activePlatform,
}: {
  loading: boolean;
  data: import("../api.js").ProductDeviceSummary | null;
  onPlatform: (platform: string | null) => void;
  activePlatform: string | null;
}): React.ReactElement {
  if (loading || !data) {
    return <Skeleton className="h-7 w-full max-w-md" />;
  }
  const n = (v: string): number =>
    data.byStatus.find((s) => s.value === v)?.count ?? 0;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-label="Device summary"
      role="group"
    >
      <Badge variant="outline">{data.total} total</Badge>
      <Badge variant="success">{n("authorized")} authorized</Badge>
      <Badge variant="default">{n("deauthorized")} deauthorized</Badge>
      <Badge variant="outline">{data.licensed.licensed} licensed</Badge>
      <Badge variant="outline">{data.licensed.licenceFree} licence-free</Badge>
      {data.byPlatform.map((p) => {
        const active = p.value != null && p.value === activePlatform;
        return p.value != null ? (
          <button
            key={p.value}
            type="button"
            aria-pressed={active}
            onClick={() => onPlatform(active ? null : p.value)}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Badge variant={active ? "success" : "outline"}>
              {p.value} {p.count}
            </Badge>
          </button>
        ) : (
          <Badge key="unknown" variant="outline">
            unknown platform {p.count}
          </Badge>
        );
      })}
    </div>
  );
}

function DeviceDrawer({
  slug,
  deviceId,
  onClose,
  onChanged,
}: {
  slug: string;
  deviceId: string | null;
  onClose: () => void;
  onChanged: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [detail, setDetail] = React.useState<ProductDeviceDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<"deauthorize" | "reset" | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    if (!deviceId) return;
    let live = true;
    setDetail(null);
    setError(null);
    api
      .productDevice(slug, deviceId)
      .then((d) => live && setDetail(d))
      .catch(
        (e: unknown) =>
          live && setError(e instanceof Error ? e.message : "Request failed."),
      );
    return () => {
      live = false;
    };
  }, [slug, deviceId, version]);

  const act = async (kind: "deauthorize" | "reset"): Promise<void> => {
    if (!deviceId) return;
    setBusy(true);
    try {
      if (kind === "deauthorize") {
        await api.deauthorizeProductDevice(slug, deviceId);
        toast.success("Device deauthorized");
      } else {
        await api.resetProductDeviceFingerprint(slug, deviceId);
        toast.success(
          "Hardware binding cleared",
          "It re-binds on the next check-in.",
        );
      }
      setConfirm(null);
      setVersion((v) => v + 1);
      onChanged();
    } catch (err) {
      toast.error(
        kind === "deauthorize"
          ? "Could not deauthorize device"
          : "Could not reset the hardware binding",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  const licenceFree = detail != null && detail.licenseId === null;

  return (
    <>
      <Dialog open={deviceId != null} onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          className="left-auto right-0 top-0 h-full max-h-none max-w-xl translate-x-0 translate-y-0 rounded-none border-y-0 border-r-0"
          aria-describedby="device-drawer-desc"
        >
          <DialogHeader>
            <DialogTitle>{detail?.label || deviceId || "Device"}</DialogTitle>
            <DialogDescription id="device-drawer-desc">
              {detail?.label ? (
                <span className="font-mono">{detail.deviceId}</span>
              ) : (
                "Device detail"
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : !detail ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <DeviceFacts detail={detail} />
            )}
          </DialogBody>
          {detail ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              {detail.fingerprint ? (
                <Button variant="ghost" onClick={() => setConfirm("reset")}>
                  Reset binding
                </Button>
              ) : null}
              {detail.status === "authorized" ? (
                <Button
                  variant="outline"
                  onClick={() => setConfirm("deauthorize")}
                >
                  Deauthorize
                </Button>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm === "deauthorize"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Deauthorize this device?"
        description={
          licenceFree
            ? "The device loses access and its token is revoked. It holds no licence, so no seat is freed. Under open registration it can register again on its next start."
            : "The device loses access and must re-activate to use the licence again. This frees its device seat."
        }
        confirmLabel="Deauthorize"
        loading={busy}
        onConfirm={() => act("deauthorize")}
      />
      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Reset this device's hardware binding?"
        description="The device stays authorized. Its next check-in re-binds to whatever hardware it reports, which clears a false-positive hardware-change lockout."
        confirmLabel="Reset binding"
        loading={busy}
        onConfirm={() => act("reset")}
      />
    </>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function DeviceFacts({
  detail: d,
}: {
  detail: ProductDeviceDetail;
}): React.ReactElement {
  const fp = d.fingerprint;
  const facts = d.facts;
  return (
    <dl className="space-y-2">
      <Row label="Status">
        <DeviceStatusBadge status={d.status} />
      </Row>
      <Row label="Licence">
        {d.licenseId ? (
          <span className="font-mono text-xs">
            {d.licenseId}
            {d.seatNo != null ? ` · seat ${d.seatNo}` : ""}
          </span>
        ) : (
          "Licence-free (registered, no licence)"
        )}
      </Row>
      <Row label="First seen">{formatStamp(d.firstSeen)}</Row>
      <Row label="Last seen">{formatStamp(d.lastSeen)}</Row>
      <Row label="Platform">
        {d.platform ?? "—"}
        {d.arch ? ` · ${d.arch}` : ""}
      </Row>
      <Row label="App">{d.appVersion ?? "—"}</Row>
      <Row label="SDK">
        {d.sdkName
          ? `${d.sdkName}${d.sdkVersion ? ` ${d.sdkVersion}` : ""}`
          : "—"}
      </Row>
      {d.ua ? <Row label="User agent">{d.ua}</Row> : null}
      <Row label="Hardware">
        {!fp ? (
          "—"
        ) : fp.status === "unverified" ? (
          "Unverified (no fingerprint sent)"
        ) : (
          <span className="font-mono text-xs">
            {fp.hwid ?? "—"} · {fp.componentCount} components
            {(fp.lastDriftCount ?? 0) > 0
              ? ` · drifted ${formatStamp(fp.lastDriftAt)}`
              : ""}
          </span>
        )}
      </Row>
      {facts ? (
        <>
          <Row label="OS">
            {[facts.os.name, facts.os.version].filter(Boolean).join(" ") || "—"}
          </Row>
          <Row label="Runtime">
            {[facts.runtime.name, facts.runtime.version]
              .filter(Boolean)
              .join(" ") || "—"}
          </Row>
          <Row label="Locale">
            {[facts.locale, facts.timezone].filter(Boolean).join(" · ") || "—"}
          </Row>
        </>
      ) : null}
    </dl>
  );
}
