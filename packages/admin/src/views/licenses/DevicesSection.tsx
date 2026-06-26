import * as React from "react";
import { MonitorSmartphone } from "lucide-react";
import { api, type DeviceDto } from "../../api.js";
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  useToast,
  type ColumnDef,
} from "../../components/ui/index.js";
import { DeviceStatusBadge, formatStamp } from "./shared.js";

/**
 * One row per device that activated this license, with first/last-seen and user-agent.
 * Deauthorizing a device (behind a confirm) frees
 * a seat and forces re-activation. Mutations toast + call `onChanged` to refresh the license.
 */
export function DevicesSection({
  slug,
  id,
  devices,
  onChanged,
}: {
  slug: string;
  id: string;
  devices: DeviceDto[];
  onChanged: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [target, setTarget] = React.useState<DeviceDto | null>(null);
  const [busy, setBusy] = React.useState(false);

  const deauthorize = async (): Promise<void> => {
    if (!target) return;
    setBusy(true);
    try {
      await api.deauthorizeDevice(slug, id, target.deviceId);
      toast.success("Device deauthorized");
      onChanged();
      setTarget(null);
    } catch (err) {
      toast.error(
        "Could not deauthorize device",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<DeviceDto>[] = [
    {
      id: "deviceId",
      header: "Device",
      cell: (r) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">
            {r.label || r.deviceId}
          </span>
          {r.label ? (
            <span className="font-mono text-xs text-muted-foreground">
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
      id: "firstSeen",
      header: "First seen",
      accessor: (r) => r.firstSeen,
      sortable: true,
      cell: (r) => formatStamp(r.firstSeen),
    },
    {
      id: "lastSeen",
      header: "Last seen",
      accessor: (r) => r.lastSeen,
      sortable: true,
      cell: (r) => formatStamp(r.lastSeen),
    },
    {
      id: "ua",
      header: "User agent",
      cell: (r) => (
        <span
          className="block max-w-xs truncate text-xs text-muted-foreground"
          title={r.ua}
        >
          {r.ua || "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      headerClassName: "text-right",
      className: "text-right",
      cell: (r) => (
        <Button size="sm" variant="outline" onClick={() => setTarget(r)}>
          Deauthorize
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={devices}
        rowKey={(r) => r.deviceId}
        empty={
          <EmptyState
            icon={<MonitorSmartphone aria-hidden />}
            title="No devices"
            description="Devices appear here once this license activates one with a key."
          />
        }
      />

      <ConfirmDialog
        open={target != null}
        onOpenChange={(o) => !o && setTarget(null)}
        title="Deauthorize this device?"
        description="The device loses access and must re-activate to use the license again. This frees a device seat."
        confirmLabel="Deauthorize"
        loading={busy}
        onConfirm={deauthorize}
      />
    </div>
  );
}
