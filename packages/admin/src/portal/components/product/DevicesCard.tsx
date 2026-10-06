import * as React from "react";
import {
  Glasses,
  Info,
  Laptop,
  Monitor,
  Smartphone,
  Tv,
  Watch,
} from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import type { PortalDevice, PortalLicenseDetail } from "../../api.js";
import { useRemoveDevice } from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import {
  devicesText,
  deviceFamily,
  deviceOsName,
  isSignInLicense,
} from "../../model/library.js";
import { ErrorPanel } from "../States.js";
import { SeatMeter } from "../SeatMeter.js";
import { SectionCard } from "./Card.js";

/**
 * Devices (§4.20, §4.22): the devices using a seat, each with **Remove**, which expands the row
 * in place into the consequences and the confirm (focus moves to its heading). Devices that no
 * longer use a seat are counted ("+1 not using a seat"). With the seat limit (G5, PX-W1) the
 * count reads "2 of 3 devices in use"; without it the limit is never guessed. Every licence, from
 * a key or from signing in, lists its devices with Remove (remote deauthorize); a key licence
 * drops its counter when a sign-in licence covers the product (owner, 2026-10-05).
 */
export function DevicesCard({
  productName,
  seatLimit,
  emailConfigured = false,
  showCount = true,
  detail,
  loading,
  error,
  onRetry,
}: {
  productName: string;
  /** False hides the counter and seat meter (the list stays). */
  showCount?: boolean;
  /** The licence's seat limit as activation enforces it, when the Worker sent it. */
  seatLimit?: number | null;
  /** The Worker can send mail (`capabilities.auth.magic`): only then promise a notice. */
  emailConfigured?: boolean;
  detail: PortalLicenseDetail | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const active = detail?.devices.filter((d) => d.status === "authorized") ?? [];
  const idle = (detail?.devices.length ?? 0) - active.length;
  const signIn = detail ? isSignInLicense(detail) : false;
  return (
    <SectionCard id="devices" title="Devices">
      {loading ? (
        <Skeleton className="h-28 w-full" />
      ) : error || !detail ? (
        <ErrorPanel
          error={error}
          onRetry={onRetry}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <>
          {showCount ? (
            <p className="mb-2 text-fg-muted">
              <span className="text-xl font-bold text-fg-strong">
                {active.length}
              </span>{" "}
              {seatLimit
                ? `of ${seatLimit} ${seatLimit === 1 ? "device" : "devices"}`
                : active.length === 1
                  ? "device"
                  : "devices"}{" "}
              in use
              {idle > 0 ? ` · +${idle} not using a seat` : ""}
            </p>
          ) : null}
          {seatLimit && showCount ? (
            <SeatMeter
              inUse={active.length}
              limit={seatLimit}
              className="mb-4"
            />
          ) : null}
          {active.length === 0 ? (
            <p className="py-3 text-sm text-fg-muted">
              {signIn
                ? `No device is signed in with this license. Sign in to ${productName} on a device to use it.`
                : `No device is using this license. Open ${productName} on a device to activate it.`}
            </p>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {active.map((d) => (
                <DeviceRow
                  key={d.deviceId}
                  device={d}
                  detail={detail}
                  productName={productName}
                  inUse={active.length}
                  seatLimit={showCount ? seatLimit : null}
                  showCount={showCount}
                  emailConfigured={emailConfigured}
                />
              ))}
            </ul>
          )}
          <p className="mt-3 flex gap-2 text-sm text-fg-muted">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            {signIn
              ? "Removing a device signs it out of this license at once."
              : "Removing a device frees its seat at once."}
          </p>
        </>
      )}
    </SectionCard>
  );
}

function deviceName(d: PortalDevice): string {
  return d.label?.trim() || "Unnamed device";
}

function DeviceGlyph({
  platform,
}: {
  platform: string | null;
}): React.ReactElement {
  const k = deviceFamily(platform);
  const Icon =
    k === "ios" || k === "android"
      ? Smartphone
      : k === "macos"
        ? Laptop
        : k === "tvos"
          ? Tv
          : k === "visionos"
            ? Glasses
            : k === "watchos"
              ? Watch
              : Monitor;
  return <Icon aria-hidden className="size-5" />;
}

export function DeviceRow({
  device,
  detail,
  productName,
  inUse,
  seatLimit,
  showCount = true,
  emailConfigured = false,
}: {
  device: PortalDevice;
  detail: PortalLicenseDetail;
  productName: string;
  inUse: number;
  seatLimit?: number | null;
  /** False drops the new count from the consequences (the card shows no counter). */
  showCount?: boolean;
  emailConfigured?: boolean;
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const removeRef = React.useRef<HTMLButtonElement>(null);
  const remove = useRemoveDevice(detail.product, detail.id);
  const name = deviceName(device);
  React.useEffect(() => {
    if (confirming) headingRef.current?.focus();
  }, [confirming]);
  const meta = [
    deviceOsName(device.platform),
    device.appVersion,
    `last seen ${formatRelative(device.lastSeen * 1000)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const panelId = `remove-${device.deviceId}`;

  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong">
          <DeviceGlyph platform={device.platform} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-fg-strong">{name}</p>
          <p className="text-sm text-fg-muted">{meta}</p>
        </div>
        {confirming ? null : (
          <Button
            ref={removeRef}
            variant="quiet"
            size="md"
            className="h-10"
            aria-label={`Remove ${name}`}
            aria-expanded={false}
            aria-controls={panelId}
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        )}
      </div>
      {confirming ? (
        <div
          id={panelId}
          className="mt-3 space-y-3 rounded-lg border border-danger-border bg-danger-subtle p-4"
        >
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="font-bold text-fg-strong outline-none"
          >
            Remove {name}?
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
            <li>
              {showCount
                ? `Its seat is free straight away: ${devicesText(inUse - 1, seatLimit)} in use.`
                : "Its seat is free straight away."}
            </li>
            <li>
              {isSignInLicense(detail)
                ? `${productName} on that device asks you to sign in again the next time it starts.`
                : `${productName} on that device asks to be activated the next time it starts.`}
            </li>
            {emailConfigured ? <li>We'll email you to confirm.</li> : null}
          </ul>
          {remove.error ? (
            <p role="alert" className="text-sm text-danger">
              {portalErrorCopy(remove.error).title}.{" "}
              {portalErrorCopy(remove.error).description}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => removeRef.current?.focus());
              }}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(device.deviceId, {
                  onSuccess: () => {
                    toast.success(`${name} was removed`, {
                      description: `${productName} has a free seat now.`,
                    });
                    announce(`${name} was removed`);
                  },
                })
              }
            >
              Remove {name}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
