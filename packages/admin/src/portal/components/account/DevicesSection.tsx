import * as React from "react";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import { PORTAL_FMT } from "../../date.js";
import type { PortalAccountDevice } from "../../api.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import {
  capabilitiesOrNone,
  useAccountDevices,
  useCapabilities,
  useRemoveAccountDevice,
} from "../../data.js";
import { deviceOsName } from "../../model/library.js";
import { focusSectionHeading } from "../../focus.js";
import {
  DeviceRowHead,
  RemoveTail,
  RemovePanel,
  useRemoveConfirm,
} from "../product/DeviceRowParts.js";
import { AccountCard as SectionCard } from "./AccountCard.js";
import { t } from "../../../lib/copy.js";

/**
 * Devices (DEVICE-REMOVAL): the account's devices that hold no licence, for every product whose
 * portal is on: an app that uses sign-in or Cloud Sync alone, and a device that signed in from
 * the platform backup ("Signed in from backup"). Devices with a licence stay on the product's page.
 * Each row has **Remove**, which opens the consequences and the confirm in place, as the product
 * page's Devices card does. The section is absent while nothing was listed, on a Worker without the
 * route and while it loads, so an account with no such device sees nothing ({@link devicesVisible}).
 *
 * The restore notice's "Remove this device" link lands here (`#/account/devices`) and carries no
 * device id: the person finds the row by its name and its badge.
 */
export function DevicesSection({
  shown,
  wanted,
}: {
  /** The page's verdict ({@link devicesVisible}); the nav entry follows the same one. */
  shown: boolean;
  /** The page was opened at `#/account/devices`. */
  wanted: boolean;
}): React.ReactElement | null {
  const devices = useAccountDevices();
  const caps = capabilitiesOrNone(useCapabilities());
  const list = devices.data;
  const hadRows = React.useRef(false);
  if (list && list.length > 0) hadRows.current = true;
  if (!shown) return null;
  return (
    <SectionCard
      id="devices"
      title={t("locker.account.devices")}
      subtitle={t("locker.devices.subtitle")}
    >
      {devices.error ? (
        <ErrorState
          account
          error={devices.error}
          onRetry={() => void devices.refetch()}
          message={t("locker.error.loadFailedDevices")}
          className="border-0 p-0 shadow-none"
        />
      ) : !list || list.length === 0 ? (
        // After the last removal, or a link to a device that is already gone.
        <p className="text-sm text-fg-muted" data-devices-empty="">
          {t(
            wanted && !hadRows.current
              ? "locker.devices.gone"
              : "locker.devices.none",
          )}
        </p>
      ) : (
        <ul className="-mx-4 divide-y divide-border border-y border-border desk:-mx-5 bigtext:max-sm:mx-0 [&>li]:px-4 desk:[&>li]:px-5 bigtext:max-sm:[&>li]:px-0">
          {list.map((d) => (
            <AccountDeviceRow
              key={`${d.product}/${d.deviceId}`}
              device={d}
              emailConfigured={caps.auth.magic}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/**
 * Whether the Devices card (and its nav entry) shows: while it has rows, after they were all
 * removed this visit, on a failed load (the restore notice's link must land on the error, not on
 * nothing), and when the page was opened at it (then it says the device is gone). Hidden while it
 * loads and on a Worker without the route (404). `hadRows` is the page's ref, set here.
 */
export function devicesVisible(
  query: {
    isPending: boolean;
    error: unknown;
    data: unknown[] | null | undefined;
  },
  hadRows: { current: boolean },
  wanted: boolean,
): boolean {
  if (query.isPending) return false;
  if (query.error) return true;
  if (query.data == null) return false;
  if (query.data.length > 0) hadRows.current = true;
  return query.data.length > 0 || hadRows.current || wanted;
}

function AccountDeviceRow({
  device,
  emailConfigured,
}: {
  device: PortalAccountDevice;
  emailConfigured: boolean;
}): React.ReactElement {
  const { confirming, setConfirming, headingRef, removeRef, keep } =
    useRemoveConfirm();
  const remove = useRemoveAccountDevice();
  const name = device.label?.trim() || t("devices.unnamed");
  const meta = [device.productName, deviceOsName(device.platform)]
    .filter(Boolean)
    .join(" · ");
  const seen = t("locker.freeDevice.lastSeen", {
    when: formatRelative(device.lastSeen * 1000, Date.now(), PORTAL_FMT),
  });
  const panelId = `remove-${device.product}-${device.deviceId}`;
  return (
    <li className="py-3 @container" data-device-product={device.product}>
      <DeviceRowHead
        platform={device.platform}
        name={name}
        restored={device.restored}
        meta={meta}
        oneLine
        seen={seen}
        confirming={confirming}
        removeRef={removeRef}
        panelId={panelId}
        onRemove={() => setConfirming(true)}
      />
      <RemovePanel
        id={panelId}
        open={confirming}
        name={name}
        headingRef={headingRef}
        consequences={
          <>
            <li>
              {t("locker.devices.nextSignIn", { product: device.productName })}
            </li>
            <RemoveTail
              restored={device.restored}
              productName={device.productName}
              emailConfigured={emailConfigured}
            />
          </>
        }
        error={Boolean(remove.error)}
        removing={remove.isPending}
        onKeep={keep}
        onRemove={() =>
          remove.mutate(
            { product: device.product, deviceId: device.deviceId },
            {
              onSuccess: () => {
                toast.success(t("locker.methods.removed", { name }));
                // The row leaves with the refetch; focus never falls to `body`. The card stays,
                // with a line for the last row, so its heading is always there.
                focusSectionHeading("devices");
              },
            },
          )
        }
      />
    </li>
  );
}
