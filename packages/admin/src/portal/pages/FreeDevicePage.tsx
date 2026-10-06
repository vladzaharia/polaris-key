import * as React from "react";
import {
  CheckCircle2,
  Glasses,
  Info,
  Laptop,
  Monitor,
  Smartphone,
  Tv,
  Watch,
} from "lucide-react";
import { Button } from "../../ui/Button.js";
import { RadioCards } from "../../ui/RadioCards.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { announce } from "../../ui/LiveRegion.js";
import { formatRelative } from "../../lib/format.js";
import type {
  PortalAccount,
  PortalProduct,
  PortalProductDevice,
} from "../api.js";
import { FlowCard, FocusedFlow } from "../components/FocusedFlow.js";
import { SeatMeter } from "../components/SeatMeter.js";
import { ErrorPanel } from "../components/States.js";
import {
  capabilitiesOrNone,
  useCapabilities,
  useProduct,
  useRemoveDevice,
} from "../data.js";
import { isNotFound, portalErrorCopy } from "../errors.js";
import {
  deviceFamily,
  deviceOsName,
  presentationFrom,
} from "../model/library.js";
import { deviceSeats } from "../model/product.js";
import { allowedReturn } from "../model/returnUrl.js";
import { href, useDocumentTitle } from "../router.js";
import { NotFoundProduct } from "./NotFoundProduct.js";

/** The `for=` label as display text only (it is never markup): trimmed and bounded. */
export function forLabel(raw: string | null): string | null {
  const v = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return v ? v.slice(0, 64) : null;
}

/**
 * Where "back" goes: the app when its return URL is declared, else the product page. Only an app
 * that sent the person (`return=` present and declared) is named "Back to <product>" (§0.6 P4,
 * §11.2); without one, the way back is the product's page here, and says so. At 390 px the
 * header holds the lockup and about 16 characters, so the words after the product's name are a
 * `tail` that phones drop ("See Orbit Survey"), instead of truncating the name (FLOWS.md P-6).
 */
export function flowBack(
  product: string,
  name: string,
  returnUrl: string | null,
): { label: string; href: string; external: boolean; tail?: string } {
  return returnUrl
    ? { label: `Back to ${name}`, href: returnUrl, external: true }
    : {
        label: `See ${name}`,
        tail: "in your library",
        href: href.product(product),
        external: false,
      };
}

/**
 * Device limit, the focused flow (PORTAL.md §4.25, PX-10): `#/p/<product>/free-device?for=&return=`,
 * the target of an app's `device_limit` (G15 `manageUrl`, PX-W8). The licence's devices that use
 * a seat as radio cards, the least recently seen preselected; the consequences; one primary that
 * removes it; then the way back to the app ("Back to <product>", "press Try again"), only to a
 * declared return URL. Without one, nothing mentions going back to an app. The seats come from
 * `deviceSeats`, the same source the product page's Devices card reads (§0.6 P4).
 */
export function FreeDevicePage({
  account,
  product: slug,
  params,
}: {
  account: PortalAccount;
  product: string;
  params: URLSearchParams;
}): React.ReactElement {
  const q = useProduct(slug);
  const p = q.data;
  useDocumentTitle(
    p
      ? `Free up a device · ${p.name}`
      : q.isPending
        ? null
        : "Free up a device",
  );
  const returnUrl = p ? allowedReturn(params.get("return"), p.returnTo) : null;
  const back = flowBack(slug, p?.name ?? "the product", returnUrl);
  return (
    <FocusedFlow back={back}>
      {q.isPending ? (
        <div aria-busy className="mx-auto max-w-[41rem] space-y-4">
          <h1 className="sr-only">Loading</h1>
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : q.error && isNotFound(q.error) ? (
        <NotFoundProduct email={account.email} />
      ) : q.error || !p ? (
        <ErrorPanel error={q.error} onRetry={() => void q.refetch()} asPage />
      ) : (
        <FreeDevice
          product={p}
          account={account}
          licenseId={params.get("license")}
          forDevice={forLabel(params.get("for"))}
          returnUrl={returnUrl}
        />
      )}
    </FocusedFlow>
  );
}

/** "active today", "active yesterday", "last seen 41 days ago" (§6.1 rule 9). */
export function lastSeenText(
  at: number,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const days = Math.floor((now - at) / 86_400);
  if (days < 1) return "active today";
  if (days === 1) return "active yesterday";
  if (days < 90) return `last seen ${days} days ago`;
  return `last seen ${formatRelative(at * 1000)}`;
}

function deviceName(d: PortalProductDevice): string {
  return d.label?.trim() || "Unnamed device";
}

function DeviceGlyph({ platform }: { platform: string | null }) {
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

function FreeDevice({
  product,
  account,
  licenseId,
  forDevice,
  returnUrl,
}: {
  product: PortalProduct;
  account: PortalAccount;
  licenseId: string | null;
  forDevice: string | null;
  returnUrl: string | null;
}): React.ReactElement {
  const caps = capabilitiesOrNone(useCapabilities());
  const pres = presentationFrom(product);
  const license =
    product.licenses.find((l) => l.id === licenseId) ?? product.licenses[0]!;
  const seats = deviceSeats(license);
  const holders = seats.holders;
  const leastRecent = holders[0]?.deviceId ?? null;
  const [picked, setPicked] = React.useState<string | null>(leastRecent);
  const [removed, setRemoved] = React.useState<string | null>(null);
  const remove = useRemoveDevice(product.product, license.id);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (removed) headingRef.current?.focus();
  }, [removed]);

  const name = product.name;
  const limit = seats.limit ?? 0;
  const inUse = seats.inUse;
  const full = seats.full;
  const target = forDevice ?? "another device";
  const pickedDevice = holders.find((d) => d.deviceId === picked) ?? null;
  const support =
    pres.supportUrl ??
    (pres.supportEmail ? `mailto:${pres.supportEmail}` : null);
  const goBack = returnUrl ? (
    <Button asChild size="lg" className="h-12 w-full font-bold sm:w-auto">
      <a href={returnUrl}>Back to {name}</a>
    </Button>
  ) : (
    <Button asChild size="lg" className="h-12 w-full font-bold sm:w-auto">
      <a href={href.product(product.product, "devices")}>See your devices</a>
    </Button>
  );
  // "press Try again" only makes sense when an app sent the person here.
  const tryAgain = returnUrl ? (
    <>
      {" "}
      Go back to {name} and press{" "}
      <strong className="text-fg-strong">Try again</strong>.
    </>
  ) : null;
  const card = (children: React.ReactNode) => (
    <FlowCard
      slug={product.product}
      name={name}
      developer={pres.developer}
      tint={pres.tint}
      iconUrl={pres.iconUrl}
      headerUrl={pres.headerUrl}
    >
      {children}
    </FlowCard>
  );

  if (removed) {
    return card(
      <div className="mt-2 space-y-4">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-3 text-[1.75rem] font-bold leading-tight text-fg-strong outline-none"
        >
          <CheckCircle2 aria-hidden className="size-7 shrink-0 text-success" />
          {removed} was removed
        </h1>
        <p className="text-fg">
          {name} now has a free device.
          {tryAgain}
        </p>
        {goBack}
      </div>,
    );
  }

  if (!full) {
    return card(
      <div className="mt-2 space-y-4">
        <h1 className="text-[1.75rem] font-bold leading-tight text-fg-strong">
          Your license has a free device
        </h1>
        {limit > 0 ? <SeatMeter inUse={inUse} limit={limit} /> : null}
        <p className="text-fg">
          {limit > 0
            ? `${inUse} of ${limit} ${limit === 1 ? "device is" : "devices are"} in use, so ${target} can be added.`
            : `${target[0]!.toUpperCase()}${target.slice(1)} can be added.`}
          {tryAgain}
        </p>
        {goBack}
      </div>,
    );
  }

  const onRemove = (): void => {
    if (!pickedDevice) return;
    const label = deviceName(pickedDevice);
    remove.mutate(pickedDevice.deviceId, {
      onSuccess: () => {
        announce(`${label} was removed from ${name}`);
        setRemoved(label);
      },
    });
  };

  return card(
    <div className="mt-2 space-y-4">
      <h1 className="text-[1.75rem] font-bold leading-tight text-fg-strong desk:text-[2rem]">
        Your license is on {inUse} of {limit}{" "}
        {limit === 1 ? "device" : "devices"}
      </h1>
      <SeatMeter inUse={inUse} limit={limit} />
      <p id="free-lede" className="text-fg">
        To use {name} on{" "}
        {forDevice ? (
          <strong className="text-fg-strong">{forDevice}</strong>
        ) : (
          "another device"
        )}
        , remove one of these. You can add it back later.
      </p>
      <RadioCards
        aria-labelledby="free-lede"
        name="free-device"
        columns={1}
        value={picked}
        onChange={setPicked}
        options={holders.map((d) => ({
          value: d.deviceId,
          icon: <DeviceGlyph platform={d.platform} />,
          label: (
            <span className="font-bold text-fg-strong">{deviceName(d)}</span>
          ),
          // "Least recent" is plain text in the meta, not a pill: pills are for issues
          // (FLOWS.md §2 C20, P-6).
          description: [
            deviceOsName(d.platform),
            d.appVersion,
            lastSeenText(d.lastSeen),
            d.deviceId === leastRecent && holders.length > 1
              ? "least\u00a0recent"
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
        }))}
      />
      {pickedDevice ? (
        <p className="flex gap-3 rounded-lg border border-border px-4 py-3 text-sm text-fg">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {name} on {deviceName(pickedDevice)} will ask to activate next time
            it opens. Its saved files stay on that device.
            {caps.auth.magic ? ` We'll email ${account.email} to confirm.` : ""}
          </span>
        </p>
      ) : null}
      {remove.error ? (
        <p role="alert" className="text-sm text-danger">
          {portalErrorCopy(remove.error).description}
        </p>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg" variant="outline" className="h-12">
          <a href={returnUrl ?? href.product(product.product)}>Cancel</a>
        </Button>
        <Button
          size="lg"
          className="h-12 font-bold sm:flex-1"
          loading={remove.isPending}
          disabledReason={
            pickedDevice ? undefined : "Choose a device to remove"
          }
          onClick={onRemove}
        >
          {/* The primary names what it does (§2 C5): this flow only frees the seat, so
              nothing "continues" (§4.25, FLOWS.md P-6). */}
          {pickedDevice
            ? `Remove ${deviceName(pickedDevice)}`
            : "Remove a device"}
        </Button>
      </div>
      {support ? (
        <p className="text-sm text-fg-muted">
          Need more devices?{" "}
          <a
            href={support}
            target="_blank"
            rel="noreferrer"
            className="font-bold text-accent-fg hover:underline"
          >
            Ask {pres.developer ?? "the developer"}
          </a>
        </p>
      ) : null}
    </div>,
  );
}
