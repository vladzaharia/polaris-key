import * as React from "react";
import { CheckCircle2, Info, Laptop, Monitor, Smartphone } from "lucide-react";
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
  normalisePlatform,
  osName,
  presentationFrom,
} from "../model/library.js";
import { allowedReturn } from "../model/returnUrl.js";
import { href, useDocumentTitle } from "../router.js";
import { NotFoundProduct } from "./NotFoundProduct.js";

/** The `for=` label as display text only (it is never markup): trimmed and bounded. */
export function forLabel(raw: string | null): string | null {
  const v = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return v ? v.slice(0, 64) : null;
}

/** Where "back" goes: the app when its return URL is declared, else the product page. */
export function flowBack(
  product: string,
  name: string,
  returnUrl: string | null,
): { label: string; href: string; external: boolean; tail?: string } {
  return returnUrl
    ? {
        label: `Back to ${name}`,
        tail: "without changes",
        href: returnUrl,
        external: true,
      }
    : {
        label: `Back to ${name}`,
        href: href.product(product),
        external: false,
      };
}

/**
 * Device limit, the focused flow (PORTAL.md §4.25, PX-10): `#/p/<product>/free-device?for=&return=`,
 * the target of an app's `device_limit` (G15 `manageUrl`, PX-W8). The licence's devices that use
 * a seat as radio cards, the least recently seen preselected; the consequences; one primary that
 * removes it; then the way back to the app ("press Try again"), only to a declared return URL.
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
  const k = normalisePlatform(platform);
  const Icon =
    k === "ios" || k === "android"
      ? Smartphone
      : k === "macos"
        ? Laptop
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
  const holders = license.devices
    .filter((d) => !d.dormant)
    .sort((a, b) => a.lastSeen - b.lastSeen);
  const leastRecent = holders[0]?.deviceId ?? null;
  const [picked, setPicked] = React.useState<string | null>(leastRecent);
  const [removed, setRemoved] = React.useState<string | null>(null);
  const remove = useRemoveDevice(product.product, license.id);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (removed) headingRef.current?.focus();
  }, [removed]);

  const name = product.name;
  const limit = license.deviceLimit;
  const inUse = license.activeSeatCount;
  const full = limit > 0 && inUse >= limit;
  const target = forDevice ?? "another device";
  const pickedDevice = holders.find((d) => d.deviceId === picked) ?? null;
  const support =
    pres.supportUrl ??
    (pres.supportEmail ? `mailto:${pres.supportEmail}` : null);
  const goBack = returnUrl ? (
    <Button asChild size="lg" className="h-12 w-full font-bold sm:w-auto">
      <a href={returnUrl}>Return to {name}</a>
    </Button>
  ) : (
    <Button asChild size="lg" className="h-12 w-full font-bold sm:w-auto">
      <a href={href.product(product.product, "devices")}>Open {name}</a>
    </Button>
  );
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
          {name} now has a free device. Go back to {name} and press{" "}
          <strong className="text-fg-strong">Try again</strong>.
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
            ? `${inUse} of ${limit} ${limit === 1 ? "device is" : "devices are"} in use, so ${target} can be added. `
            : `${target[0]!.toUpperCase()}${target.slice(1)} can be added. `}
          Go back to {name} and press{" "}
          <strong className="text-fg-strong">Try again</strong>.
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
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-fg-strong">{deviceName(d)}</span>
              {d.deviceId === leastRecent && holders.length > 1 ? (
                <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-bold text-fg-strong">
                  Least recent
                </span>
              ) : null}
            </span>
          ),
          description: [
            normalisePlatform(d.platform)
              ? osName(normalisePlatform(d.platform)!)
              : null,
            d.appVersion,
            lastSeenText(d.lastSeen),
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
          {pickedDevice
            ? `Remove ${deviceName(pickedDevice)} and continue`
            : "Remove a device and continue"}
        </Button>
      </div>
      <p className="text-sm text-fg-muted">
        Then go back to {name} and press{" "}
        <strong className="text-fg-strong">Try again</strong>.
        {support ? (
          <>
            {" "}
            Need more devices?{" "}
            <a
              href={support}
              target="_blank"
              rel="noreferrer"
              className="font-bold text-accent-fg hover:underline"
            >
              Ask {pres.developer ?? "the developer"}
            </a>
          </>
        ) : null}
      </p>
    </div>,
  );
}
