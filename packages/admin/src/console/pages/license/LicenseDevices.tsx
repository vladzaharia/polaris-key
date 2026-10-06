/**
 * The license's Devices tab (ADMIN.md §6.5.2): a Seats meter and the shared `DeviceTable` (the
 * Core → Devices table, scoped to this license; DEV-8). Row actions appear only when valid:
 * Deauthorize for a device that is still authorized (LDT-10), Reset binding when a hardware
 * binding exists. A row opens the shared device drawer, where the hardware facts, probes and
 * fingerprint components are visible text (LDT-15).
 */

import * as React from "react";
import type { DeviceDto, LicenseDetail } from "../../../api.js";
import { mutate } from "../../data/mutations.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { DeviceTable, type DeviceRow } from "../../components/DeviceTable.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { Meter } from "../../../ui/charts/Meter.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { toast } from "../../../ui/toast.js";
import type { RowActionItem } from "../../../ui/data-table/index.js";
import { seatLimitText, type SeatLimit } from "./shared.js";

/** Valid only while the device still holds the license. */
export function isAuthorized(d: Pick<DeviceDto, "status">): boolean {
  return d.status !== "deauthorized";
}

export function deviceActions(
  d: DeviceDto,
  on: { deauthorize: (d: DeviceDto) => void; reset: (d: DeviceDto) => void },
): RowActionItem[] {
  const items: RowActionItem[] = [];
  if (d.fingerprint)
    items.push({ label: "Reset binding", onSelect: () => on.reset(d) });
  if (isAuthorized(d))
    items.push({
      label: "Deauthorize",
      tone: "danger",
      onSelect: () => on.deauthorize(d),
    });
  return items;
}

export function LicenseDevices({
  slug,
  license,
  seats,
}: {
  slug: string;
  license: LicenseDetail;
  seats: SeatLimit;
}): React.ReactElement {
  const limit = seats.limit;
  const [state, setState] = useTableUrlState("devices", {
    namespace: true,
    facets: ["status", "platform"],
  });
  const [deauth, setDeauth] = React.useState<DeviceDto | null>(null);
  const [reset, setReset] = React.useState<DeviceDto | null>(null);
  const byId = React.useMemo(
    () => new Map(license.devices.map((d) => [d.deviceId, d])),
    [license.devices],
  );
  const name = (d: DeviceDto | null) => (d ? d.label || d.deviceId : "");

  return (
    <div className="space-y-4">
      <div className="max-w-sm space-y-1">
        {limit === null ? (
          <p className="text-sm text-fg-muted">
            {license.deviceCount}{" "}
            {license.deviceCount === 1 ? "device" : "devices"} · no device limit
          </p>
        ) : (
          <Meter
            label="Seats"
            value={license.deviceCount}
            max={limit}
            tone={license.deviceCount > limit ? "warning" : "accent"}
          />
        )}
        <p className="text-xs text-fg-muted" data-testid="seat-limit-source">
          Device limit: {seatLimitText(seats)}
        </p>
      </div>
      <DeviceTable
        id="license-devices"
        slug={slug}
        devices={license.devices as DeviceRow[]}
        showLicense={false}
        state={state}
        onStateChange={setState}
        rowActions={(row) => {
          const d = byId.get(row.deviceId);
          return d
            ? deviceActions(d, { deauthorize: setDeauth, reset: setReset })
            : [];
        }}
        empty={
          <EmptyState
            kind="first-run"
            title="No devices yet"
            description="A device appears here once it activates with one of this license's keys."
          />
        }
      />

      <ConfirmDialog
        open={deauth !== null}
        onOpenChange={(o) => !o && setDeauth(null)}
        intent={confirmFor("device.deauthorize").intent as "danger"}
        title={`Deauthorize ${name(deauth)}?`}
        consequences={[
          "The device loses access now: its token is revoked.",
          "Its seat is freed. To use the license again it must activate with a key.",
        ]}
        confirmLabel="Deauthorize"
        describeError={(e) => errorCopy(e, { thing: "Device" })}
        onConfirm={async () => {
          if (!deauth) return;
          await mutate("deauthorizeDevice", slug, license.id, deauth.deviceId);
          toast.success("Device deauthorized");
        }}
      />
      <ConfirmDialog
        open={reset !== null}
        onOpenChange={(o) => !o && setReset(null)}
        intent={confirmFor("device.resetBinding").intent as "caution"}
        title={`Reset the hardware binding of ${name(reset)}?`}
        consequences={[
          "The stored fingerprint is cleared; the device stays authorized and keeps its seat.",
          "Its next check-in binds to the hardware it reports then.",
        ]}
        confirmLabel="Reset binding"
        describeError={(e) => errorCopy(e, { thing: "Device" })}
        onConfirm={async () => {
          if (!reset) return;
          await mutate(
            "resetDeviceFingerprint",
            slug,
            license.id,
            reset.deviceId,
          );
          toast.success("Hardware binding cleared", {
            description: "It binds again at the next check-in.",
          });
        }}
      />
    </div>
  );
}
