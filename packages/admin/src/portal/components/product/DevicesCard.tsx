import * as React from "react";
import { flushSync } from "react-dom";
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
import {
  CountUp,
  Expand,
  reducedMotion,
  viewTransition,
  viewTransitionsSupported,
} from "../../../ui/motion/index.js";
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
import { focusPageHeading, scrollBehavior } from "../../router.js";
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
 *
 * Motion (notes/S-23 §6.1; MO-06): the confirm opens with the expand pattern; when the devices
 * using a seat change (one removed here or elsewhere, one activated), the rows leave, close up and
 * enter in one `list` View Transition with the card as its scope, while the count counts and the
 * meter drains or fills. The new state is in the DOM before anything moves, and every change is
 * also said in words (the count, the announcement). Under reduced motion it is the same change at
 * once.
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
  const { view, listRef } = useListTransition(detail, !loading && !error);
  // What is drawn comes from `view` (the old one while a transition captures it); what a click
  // acts on comes from `detail`, the live data (a row already gone there does nothing, and a
  // removal's announcement counts from the live seats).
  const live = activeOf(detail);
  const liveIds = new Set(live.map((d) => d.deviceId));
  const seatsLeftAfter = useSeatsLeft(detail, live);
  const active = activeOf(view);
  const idle = (view?.devices.length ?? 0) - active.length;
  const signIn = view ? isSignInLicense(view) : false;
  return (
    <SectionCard id="devices" title="Devices" className="pk-vt-scope">
      {loading ? (
        <Skeleton className="h-28 w-full" />
      ) : error || !view ? (
        <ErrorPanel
          error={error}
          onRetry={onRetry}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <>
          {showCount ? (
            <p className="mb-2 text-fg-muted">
              <CountUp
                value={active.length}
                className="text-xl font-bold text-fg-strong"
              />{" "}
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
            // pk-vt-table: rows entering in a list transition wait for the others to close up
            // (motion.css, MO-09's timing).
            <ul
              ref={listRef}
              className="pk-vt-table divide-y divide-border border-t border-border"
            >
              {active.map((d) => (
                <DeviceRow
                  key={d.deviceId}
                  device={d}
                  detail={view}
                  productName={productName}
                  inUse={active.length}
                  seatsLeftAfter={seatsLeftAfter}
                  seatLimit={showCount ? seatLimit : null}
                  showCount={showCount}
                  emailConfigured={emailConfigured}
                  gone={!liveIds.has(d.deviceId)}
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

/** The devices using a seat. */
function activeOf(detail: PortalLicenseDetail | undefined): PortalDevice[] {
  return detail?.devices.filter((d) => d.status === "authorized") ?? [];
}

/**
 * How many devices use a seat once `deviceId`'s removal has landed, for its announcement. Read
 * when the removal lands, not at its click: removals can overlap, and one that lands first changes
 * what the other leaves. Counts the live devices (from a ref, so never a click's stale render)
 * less every removal that has landed and that the live data does not show yet.
 */
function useSeatsLeft(
  detail: PortalLicenseDetail | undefined,
  live: PortalDevice[],
): (deviceId: string) => number {
  const liveRef = React.useRef(live);
  liveRef.current = live;
  /** Removals that have landed while the live data still shows the device using a seat. */
  const landed = React.useRef(new Set<string>());
  // Once the live data shows a removal, it is forgotten (a device activated again counts).
  React.useEffect(() => {
    const ids = new Set(activeOf(detail).map((d) => d.deviceId));
    for (const id of landed.current)
      if (!ids.has(id)) landed.current.delete(id);
  }, [detail]);
  return React.useCallback((deviceId: string) => {
    if (liveRef.current.some((d) => d.deviceId === deviceId))
      landed.current.add(deviceId);
    return liveRef.current.filter((d) => !landed.current.has(d.deviceId))
      .length;
  }, []);
}

function sameIds(a: PortalDevice[], b: PortalDevice[]): boolean {
  return (
    a.length === b.length && a.every((d, i) => d.deviceId === b[i]!.deviceId)
  );
}

function listMotionOn(): boolean {
  return viewTransitionsSupported() && !reducedMotion();
}

/**
 * The list transition (S-23 §6.1 "list", §6.3), as DataTable runs it (MO-09): when a refetch
 * changes which devices of the same licence use a seat, the old view is held for the frame a
 * `list` View Transition needs to capture it, and the newest data lands inside the transition.
 * Everything else lands in the same render: the first load, another licence, a refetch that
 * changes nothing or only a device's details, an error, reduced motion, no View Transitions API.
 */
function useListTransition(
  detail: PortalLicenseDetail | undefined,
  ready: boolean,
): {
  view: PortalLicenseDetail | undefined;
  listRef: React.RefObject<HTMLUListElement | null>;
} {
  const [held, setHeld] = React.useState(detail);
  const moving =
    ready &&
    held !== undefined &&
    detail !== undefined &&
    held !== detail &&
    held.id === detail.id &&
    held.product === detail.product &&
    !sameIds(activeOf(held), activeOf(detail)) &&
    listMotionOn();
  if (held !== detail && !moving) setHeld(detail);
  /** The newest data, for a transition whose update runs a frame later. */
  const latest = React.useRef(detail);
  latest.current = detail;
  /** A transition has started and its update has not landed yet. */
  const pending = React.useRef(false);
  const listRef = React.useRef<HTMLUListElement>(null);

  React.useLayoutEffect(() => {
    if (!moving || pending.current) return;
    pending.current = true;
    const land = (): void => {
      if (!pending.current) return;
      pending.current = false;
      flushSync(() => setHeld(latest.current));
    };
    let finished: Promise<void>;
    try {
      ({ finished } = viewTransition(land, {
        type: "list",
        list: listRef.current,
      }));
    } catch {
      pending.current = false;
      setHeld(latest.current);
      return;
    }
    // If the browser never ran the update (it always should), the rows still land, and the
    // flag never outlives the transition.
    void finished.then(() => {
      if (!pending.current) return;
      pending.current = false;
      setHeld(latest.current);
    });
  });

  return { view: moving ? held : detail, listRef };
}

/** The page's `h1` (the product header's, focusable with `tabIndex={-1}`), from inside it. */
function pageHeading(from: HTMLElement | null): HTMLElement | null {
  const h1 = (from?.closest("main") ?? document).querySelector<HTMLElement>(
    "h1",
  );
  if (h1 && !h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
  return h1;
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
  seatsLeftAfter = () => inUse - 1,
  gone = false,
}: {
  device: PortalDevice;
  detail: PortalLicenseDetail;
  productName: string;
  /** The devices using a seat, as the card shows them (the consequences say what is left). */
  inUse: number;
  /**
   * The devices using a seat once this removal has landed, asked when it lands (the
   * announcement): counted from the live data, which differs from `inUse` while a list transition
   * holds the old view or another removal has landed meanwhile (`useSeatsLeft`).
   */
  seatsLeftAfter?: (deviceId: string) => number;
  seatLimit?: number | null;
  /** False drops the new count from the consequences (the card shows no counter). */
  showCount?: boolean;
  emailConfigured?: boolean;
  /**
   * The device no longer uses a seat in the live data: the row is only on screen while a list
   * transition captures it, and its buttons do nothing.
   */
  gone?: boolean;
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const removeRef = React.useRef<HTMLButtonElement>(null);
  const rowRef = React.useRef<HTMLLIElement>(null);
  const remove = useRemoveDevice(detail.product, detail.id);
  const name = deviceName(device);
  const meta = [
    deviceOsName(device.platform),
    device.appVersion,
    `last seen ${formatRelative(device.lastSeen * 1000)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const panelId = `remove-${device.deviceId}`;

  return (
    <li ref={rowRef} className="py-3">
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
            onClick={() => {
              if (!gone) setConfirming(true);
            }}
          >
            Remove
          </Button>
        )}
      </div>
      {/* The confirm opens in place (the expand pattern, S-23 §6.1): focus goes to its heading
          as soon as it shows, and once it has opened the region is brought into view. */}
      <Expand
        id={panelId}
        open={confirming}
        onOpen={() => headingRef.current?.focus({ preventScroll: true })}
        onOpened={(region) =>
          region.scrollIntoView?.({
            block: "nearest",
            behavior: scrollBehavior(),
          })
        }
      >
        <div className="pt-3">
          <div className="space-y-3 rounded-lg border border-danger-border bg-danger-subtle p-4">
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
                onClick={() => {
                  if (gone) return;
                  // The row leaves with the removal; find the page's heading while it is here.
                  const heading = pageHeading(rowRef.current);
                  remove.mutate(device.deviceId, {
                    onSuccess: () => {
                      // Said once, with the count as it is when the removal lands (S-23 §6.5: a
                      // freed seat is counted in text), never as it was at the click.
                      const left = seatsLeftAfter(device.deviceId);
                      toast.success(`${name} was removed`, {
                        description: `${productName} has a free seat now.`,
                      });
                      announce(
                        showCount
                          ? `${name} was removed. ${devicesText(left, seatLimit)} in use.`
                          : `${name} was removed.`,
                      );
                      // Focus never falls to `body` (FLOWS.md P-7): it goes to the product's
                      // `h1` (MO-05's page focus), without scrolling away from the list, which
                      // closes up where the person is looking.
                      focusPageHeading(() =>
                        heading?.isConnected ? heading : pageHeading(null),
                      );
                    },
                  });
                }}
              >
                Remove {name}
              </Button>
            </div>
          </div>
        </div>
      </Expand>
    </li>
  );
}
