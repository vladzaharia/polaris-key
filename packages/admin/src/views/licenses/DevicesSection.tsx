import * as React from "react";
import { MonitorSmartphone } from "lucide-react";
import { api, type DeviceDto } from "../../api.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Tooltip,
  useToast,
  type ColumnDef,
} from "../../components/ui/index.js";
import { DeviceStatusBadge, formatStamp } from "./shared.js";

/**
 * One row per device that activated this license: identity, hardware binding, software facts,
 * and first/last-seen. Deauthorizing frees a seat and forces re-activation; resetting the
 * hardware binding does NOT — it is the escape hatch for a false-positive drift lockout, so a
 * user whose machine was wrongly rejected keeps working. Mutations toast + call `onChanged`.
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
  const [resetTarget, setResetTarget] = React.useState<DeviceDto | null>(null);
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

  const resetFingerprint = async (): Promise<void> => {
    if (!resetTarget) return;
    setBusy(true);
    try {
      await api.resetDeviceFingerprint(slug, id, resetTarget.deviceId);
      toast.success(
        "Hardware binding cleared",
        "It re-binds on the next check-in.",
      );
      onChanged();
      setResetTarget(null);
    } catch (err) {
      toast.error(
        "Could not reset the hardware binding",
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
      id: "hardware",
      header: "Hardware",
      cell: (r) => <FingerprintCell device={r} />,
    },
    {
      id: "software",
      header: "Software",
      cell: (r) => <FactsCell device={r} />,
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
      id: "actions",
      header: "",
      headerClassName: "text-right",
      className: "text-right",
      cell: (r) => (
        <div className="flex justify-end gap-2">
          {r.fingerprint ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setResetTarget(r)}
              aria-label={`Reset the hardware binding for ${r.label || r.deviceId}`}
            >
              Reset binding
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setTarget(r)}>
            Deauthorize
          </Button>
        </div>
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

      <ConfirmDialog
        open={resetTarget != null}
        onOpenChange={(o) => !o && setResetTarget(null)}
        title="Reset this device's hardware binding?"
        description="The device stays authorized and keeps its seat. Its next check-in re-binds to whatever hardware it reports, which clears a false-positive hardware-change lockout."
        confirmLabel="Reset binding"
        loading={busy}
        onConfirm={resetFingerprint}
      />
    </div>
  );
}

function FingerprintCell({
  device,
}: {
  device: DeviceDto;
}): React.ReactElement {
  const fp = device.fingerprint;
  if (!fp) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (fp.status === "unverified") {
    return (
      <Tooltip content="This device activated without sending a hardware fingerprint — either it predates fingerprinting or the product has it disabled.">
        <Badge variant="outline">Unverified</Badge>
      </Tooltip>
    );
  }
  const drifted = (fp.lastDriftCount ?? 0) > 0;
  return (
    <div className="flex flex-col gap-1">
      <Tooltip
        content={`${fp.componentCount} components: ${Object.keys(fp.components).join(", ")}`}
      >
        <span className="font-mono text-xs text-muted-foreground">
          {fp.hwid ?? "—"}
        </span>
      </Tooltip>
      {drifted ? (
        <Tooltip
          content={`${fp.lastDriftCount} component(s) changed on ${formatStamp(fp.lastDriftAt)} and were tolerated.`}
        >
          <Badge variant="outline">Drifted</Badge>
        </Tooltip>
      ) : null}
    </div>
  );
}

function FactsCell({ device }: { device: DeviceDto }): React.ReactElement {
  const facts = device.facts;
  // Fall back to the metadata headers the device already sent, so a client that hasn't
  // reported facts yet still shows something useful rather than a bare dash.
  const os = facts?.os.name ?? device.platform;
  if (!os) return <span className="text-xs text-muted-foreground">—</span>;

  const version = facts?.os.version;
  const probes = facts?.probes ? Object.entries(facts.probes) : [];
  const present = probes.filter(([, v]) => v.present);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-foreground">
        {os}
        {version ? ` ${version}` : ""}
        {device.arch ? ` · ${device.arch}` : ""}
      </span>
      {device.appVersion ? (
        <span className="text-xs text-muted-foreground">
          app {device.appVersion}
        </span>
      ) : null}
      {present.length > 0 ? (
        <Tooltip
          content={present
            .map(([k, v]) => (v.version ? `${k} ${v.version}` : k))
            .join(", ")}
        >
          <Badge variant="outline">
            {present.length} of {probes.length} apps
          </Badge>
        </Tooltip>
      ) : null}
    </div>
  );
}
