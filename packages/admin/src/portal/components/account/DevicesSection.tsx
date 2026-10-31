import * as React from "react";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import { PORTAL_FMT } from "../../date.js";
import type { PortalAccountDevice } from "../../api.js";
import { useAccountDevices, useRemoveAccountDevice } from "../../data.js";
import { deviceOsName } from "../../model/library.js";
import { focusPageHeading } from "../../router.js";
import { focusSectionHeading } from "../../focus.js";
import {
  DeviceRowHead,
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
 * page's Devices card does. The section is absent while nothing is listed, on a Worker without the
 * route and while it loads, so an account with no such device sees nothing.
 *
 * The restore notice's "Remove this device" link lands here (`#/account/devices`) and carries no
 * device id: the person finds the row by its name and its badge.
 */
export function DevicesSection(): React.ReactElement | null {
  const devices = useAccountDevices();
  const list = devices.data;
  if (devices.isPending || !list || list.length === 0) return null;
  return (
    <SectionCard
      id="devices"
      title={t("locker.account.devices")}
      subtitle={t("locker.devices.subtitle")}
    >
      <ul className="divide-y divide-border border-t border-border">
        {list.map((d) => (
          <AccountDeviceRow
            key={`${d.product}/${d.deviceId}`}
            device={d}
            last={list.length === 1}
          />
        ))}
      </ul>
    </SectionCard>
  );
}

function AccountDeviceRow({
  device,
  last,
}: {
  device: PortalAccountDevice;
  /** The only device listed: the section goes with it, so focus goes to the page heading. */
  last: boolean;
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
            {device.restored ? (
              <li>
                {t("locker.devices.removeRestoredAll", {
                  product: device.productName,
                })}
              </li>
            ) : null}
            <li>{t("locker.devices.emailConfirm")}</li>
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
                announce(t("locker.devices.removedPlain", { name }));
                // The row leaves with the refetch; focus never falls to `body`.
                if (last) focusPageHeading();
                else focusSectionHeading("devices");
              },
            },
          )
        }
      />
    </li>
  );
}
