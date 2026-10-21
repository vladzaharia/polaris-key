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
import { Button } from "../../ui/Button.js";
import { RadioCards } from "../../ui/RadioCards.js";
import { announce } from "../../ui/LiveRegion.js";
import { SuccessCheck } from "../../ui/motion/index.js";
import { formatRelative } from "../../lib/format.js";
import type {
  PortalAccount,
  PortalProduct,
  PortalProductDevice,
} from "../api.js";
import {
  FocusedFlow,
  StickyActions,
  TaskFrame,
  TaskFrameSkeleton,
} from "../components/FocusedFlow.js";
import { SeatMeter } from "../components/SeatMeter.js";
import { ErrorPanel } from "../components/States.js";
import {
  capabilitiesOrNone,
  useCapabilities,
  useProduct,
  useRemoveDevice,
} from "../data.js";
import { isNotFound, portalErrorCopy } from "../errors.js";
import { consumeHeadingFocus } from "../focus.js";
import {
  deviceFamily,
  deviceOsName,
  presentationFrom,
} from "../model/library.js";
import { deviceSeats } from "../model/product.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { allowedReturn } from "../model/returnUrl.js";
import {
  focusPageHeading,
  href,
  scrollBehavior,
  useDocumentTitle,
} from "../router.js";
import { NotFoundProduct } from "./NotFoundProduct.js";
import { t, tParts } from "../../lib/copy.js";

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
    ? {
        label: t("locker.activate.backTo", { product: name }),
        href: returnUrl,
        external: true,
      }
    : {
        label: t("locker.freeDevice.see", { product: name }),
        tail: t("locker.freeDevice.seeTail"),
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
      ? t("locker.freeDevice.titleProduct", { product: p.name })
      : q.isPending
        ? null
        : t("locker.freeDevice.title"),
  );
  const returnUrl = p ? allowedReturn(params.get("return"), p.returnTo) : null;
  const back = flowBack(
    slug,
    p?.name ?? t("locker.freeDevice.theProduct"),
    returnUrl,
  );
  // An open product's entry (PS-04) has no licence and no devices to free: its page instead.
  const nothingToFree = p != null && p.licenses.length === 0;
  React.useEffect(() => {
    if (nothingToFree) window.location.replace(href.product(slug));
  }, [nothingToFree, slug]);
  return (
    <FocusedFlow back={back}>
      {q.isPending || nothingToFree ? (
        <TaskFrameSkeleton />
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
  if (days < 1) return t("locker.freeDevice.activeToday");
  if (days === 1) return t("locker.freeDevice.activeYesterday");
  if (days < 90) return t("locker.freeDevice.daysAgo", { count: days });
  return t("locker.freeDevice.lastSeen", { when: formatRelative(at * 1000) });
}

function deviceName(d: PortalProductDevice): string {
  return d.label?.trim() || t("devices.unnamed");
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
  // The one `h1` the frame draws, whichever state it shows.
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  // The device is removed: focus the success heading (MO-05's page focus, which never scrolls),
  // and bring it into view, smoothly or (reduced motion) at once: the same place either way.
  React.useEffect(() => {
    if (!removed) return;
    titleRef.current?.scrollIntoView?.({
      block: "nearest",
      behavior: scrollBehavior(),
    });
    focusPageHeading(() => titleRef.current);
  }, [removed]);
  // Arriving from the Activate dialog (`next=free-device`, PX-17): focus the flow's heading once
  // the dialog has left (through its exit) and handed focus back to its opener (§9.4, MO-05).
  React.useEffect(() => {
    if (consumeHeadingFocus(product.product))
      focusPageHeading(() => titleRef.current);
  }, [product.product]);
  // A failed removal: the busy Remove button was disabled while the request ran, which drops
  // focus to the page. Put it back on the control that failed, enabled again, so Enter tries
  // again; the choice, and the error beside it, stay.
  const removeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (remove.isError) removeRef.current?.focus();
  }, [remove.isError]);

  const name = product.name;
  const limit = seats.limit ?? 0;
  const inUse = seats.inUse;
  const full = seats.full;
  const target = forDevice ?? t("locker.methods.anotherDevice");
  const pickedDevice = holders.find((d) => d.deviceId === picked) ?? null;
  const support =
    pres.supportUrl ??
    (pres.supportEmail ? `mailto:${pres.supportEmail}` : null);
  const goBack = returnUrl ? (
    <Button asChild size="lg" className="h-12 w-full font-medium sm:w-auto">
      <a href={returnUrl}>{t("locker.activate.backTo", { product: name })}</a>
    </Button>
  ) : (
    <Button asChild size="lg" className="h-12 w-full font-medium sm:w-auto">
      <a href={href.product(product.product, "devices")}>
        {t("locker.freeDevice.seeDevices")}
      </a>
    </Button>
  );
  // "press Try again" only makes sense when an app sent the person here.
  const tryAgain = returnUrl ? (
    <>
      {" "}
      {tParts("locker.freeDevice.goBack", ["detail"], { product: name }).map(
        (part, i) =>
          typeof part === "string" ? (
            part
          ) : (
            <strong key={i} className="font-semibold text-fg-strong">
              {t("signin.retry")}
            </strong>
          ),
      )}
    </>
  ) : null;
  // The seat fact is said once beside the product's identity, where no other line of the state
  // says it (the free-seat state's lede does); the meter beside it is its picture.
  const seatsFact =
    limit > 0 ? t("a11y.seatMeter", { used: inUse, limit }) : null;
  const frame = (
    title: React.ReactNode,
    children: React.ReactNode,
    { icon, fact = true }: { icon?: React.ReactNode; fact?: boolean } = {},
  ) => (
    <TaskFrame
      slug={product.product}
      name={name}
      developer={pres.developer}
      tint={pres.tint}
      iconUrl={pres.iconUrl}
      task={t("locker.freeDevice.task")}
      title={title}
      titleRef={titleRef}
      titleIcon={icon}
      identityMeta={fact ? seatsFact : null}
      aside={limit > 0 ? <SeatMeter inUse={inUse} limit={limit} /> : null}
    >
      {children}
    </TaskFrame>
  );

  if (removed) {
    return frame(
      t("locker.methods.removed", { name: removed }),
      <div className="space-y-4">
        <p className="text-fg">
          {t("locker.freeDevice.removedNote", { product: name })}
          {tryAgain}
        </p>
        {goBack}
      </div>,
      {
        // The success check draws once (S-23 §6.4): no sparks, freeing a device is not a
        // first-time moment. It sits in a ring the size of the glyph it leads.
        icon: (
          <span className="inline-flex size-6 items-center justify-center rounded-full border-2 border-current text-success">
            <SuccessCheck size={14} />
          </span>
        ),
      },
    );
  }

  if (!full) {
    return frame(
      t("locker.freeDevice.freeTitle"),
      <div className="space-y-4">
        <p className="text-fg">
          {limit > 0
            ? t(
                limit === 1
                  ? "locker.freeDevice.freeOne"
                  : "locker.freeDevice.freeMany",
                { used: inUse, limit, device: target },
              )
            : forDevice
              ? t("locker.freeDevice.canAdd", { device: forDevice })
              : t("locker.freeDevice.canAddOther")}
          {tryAgain}
        </p>
        {goBack}
      </div>,
      { fact: false },
    );
  }

  const onRemove = (): void => {
    if (!pickedDevice) return;
    const label = deviceName(pickedDevice);
    remove.mutate(pickedDevice.deviceId, {
      onSuccess: () => {
        announce(
          t("locker.freeDevice.removedFrom", { device: label, product: name }),
        );
        setRemoved(label);
      },
    });
  };

  return frame(
    t("signin.choice.freeDevice"),
    <div className="space-y-4">
      <p id="free-lede" className="text-fg">
        {forDevice
          ? tParts("locker.freeDevice.lede", ["device"], { product: name }).map(
              (part, i) =>
                typeof part === "string" ? (
                  part
                ) : (
                  <strong key={i} className="font-semibold text-fg-strong">
                    {forDevice}
                  </strong>
                ),
            )
          : t("locker.freeDevice.lede", {
              product: name,
              device: t("locker.methods.anotherDevice"),
            })}
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
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg-strong">
                {deviceName(d)}
              </span>
              {d.deviceId === leastRecent && holders.length > 1 ? (
                <StatusPill tone="neutral" icon={false} size="sm">
                  {t("signin.replace.leastRecent")}
                </StatusPill>
              ) : null}
            </span>
          ),
          description: [
            deviceOsName(d.platform),
            d.appVersion,
            lastSeenText(d.lastSeen),
          ]
            .filter(Boolean)
            .join(" · "),
        }))}
      />
      {pickedDevice ? (
        <p id="free-consequence" className="flex gap-3 text-sm text-fg-muted">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {t("locker.freeDevice.signsOut", {
              device: deviceName(pickedDevice),
              product: name,
            })}
            {caps.auth.magic
              ? ` ${t("locker.freeDevice.emailConfirm", { email: account.email })}`
              : ""}
          </span>
        </p>
      ) : null}
      {remove.error ? (
        <p role="alert" className="text-sm text-danger">
          {t("locker.freeDevice.removeFailed", {
            device: pickedDevice
              ? deviceName(pickedDevice)
              : t("locker.freeDevice.theDevice"),
          })}{" "}
          {portalErrorCopy(remove.error).description}
        </p>
      ) : null}
      <StickyActions>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg" variant="outline" className="h-12">
            <a href={returnUrl ?? href.product(product.product)}>
              {t("signin.cancel")}
            </a>
          </Button>
          <Button
            ref={removeRef}
            size="lg"
            className="h-12 font-medium sm:flex-none"
            loading={remove.isPending}
            disabledReason={
              pickedDevice ? undefined : t("locker.freeDevice.choose")
            }
            aria-describedby={pickedDevice ? "free-consequence" : undefined}
            onClick={onRemove}
          >
            {/* The primary names what it does (§2 C5): this flow only frees the seat, so
                nothing "continues" (§4.25, FLOWS.md P-6). */}
            {pickedDevice
              ? t("locker.freeDevice.removeName", {
                  device: deviceName(pickedDevice),
                })
              : t("locker.freeDevice.remove")}
          </Button>
        </div>
      </StickyActions>
      {support ? (
        <p className="text-sm text-fg-muted">
          {t("locker.freeDevice.more")}{" "}
          <a
            href={support}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-fg hover:underline"
          >
            {t("locker.freeDevice.ask", {
              developer: pres.developer ?? t("license.developerFallback"),
            })}
          </a>
        </p>
      ) : null}
    </div>,
  );
}
