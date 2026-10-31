import * as React from "react";
import { Glasses, Laptop, Monitor, Smartphone, Tv, Watch } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Expand } from "../../../ui/motion/index.js";
import { deviceFamily } from "../../model/library.js";
import { scrollBehavior } from "../../router.js";
import { t } from "../../../lib/copy.js";

/** The glyph for a device's platform. */
export function DeviceGlyph({
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

/** Focus a confirm's heading as it opens, then bring the opened region into view. */
function focusOnOpen(headingRef: React.RefObject<HTMLElement | null>) {
  return {
    onOpen: () => headingRef.current?.focus({ preventScroll: true }),
    onOpened: (region: HTMLElement) =>
      region.scrollIntoView?.({ block: "nearest", behavior: scrollBehavior() }),
  };
}

/**
 * The state of a row's remove confirm: open or not, the heading and Remove refs, and `keep`,
 * which closes it and puts focus back on the row's Remove.
 */
export function useRemoveConfirm() {
  const [confirming, setConfirming] = React.useState(false);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const removeRef = React.useRef<HTMLButtonElement>(null);
  const keep = (): void => {
    setConfirming(false);
    requestAnimationFrame(() => removeRef.current?.focus());
  };
  return { confirming, setConfirming, headingRef, removeRef, keep };
}

/** "Signed in from backup": the badge on a device that signed in by a restore key. */
export function RestoredBadge(): React.ReactElement {
  return (
    <span
      data-restored=""
      className="whitespace-nowrap rounded-full border border-border-strong px-2 py-0.5 align-middle text-xs font-medium text-fg-strong"
    >
      {t("locker.devices.restored")}
    </span>
  );
}

/**
 * One device row, as the mockup draws it: the glyph, the name (with the badge), what it runs and
 * when it was last seen, and **Remove** (gone while the confirm is open). A size container: in a
 * narrow card Remove goes under the meta line; from 20 rem of content it ends the row (B-089).
 */
export function DeviceRowHead({
  platform,
  name,
  restored,
  meta,
  seen,
  confirming,
  removeRef,
  panelId,
  onRemove,
  oneLine = false,
}: {
  platform: string | null;
  name: string;
  restored: boolean;
  meta: string;
  seen: string;
  confirming: boolean;
  removeRef: React.RefObject<HTMLButtonElement | null>;
  panelId: string;
  onRemove: () => void;
  /** The meta and the last-seen time on one line (the Account list's two-line rows). */
  oneLine?: boolean;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 @[20rem]:grid-cols-[auto_minmax(0,1fr)_auto] @[20rem]:items-center">
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong">
        <DeviceGlyph platform={platform} />
      </span>
      <div className="min-w-0">
        {/* Wraps, never cut short: two machines often differ only at the end of the name. The
            line follows the page's start edge; `bdi` shapes the name in its own direction. */}
        <p
          data-device-name=""
          className="flex flex-wrap items-center gap-x-2 gap-y-1 break-words text-start font-medium text-fg-strong"
        >
          {/* `min-w-0` and `anywhere`: in a flex line a long label with no break point would
              otherwise hold the row wider than a 320 px screen (WCAG 1.4.10). */}
          <bdi className="min-w-0 max-w-full [overflow-wrap:anywhere]">
            {name}
          </bdi>
          {restored ? <RestoredBadge /> : null}
        </p>
        {oneLine ? (
          <p className="text-sm text-fg-muted">
            {[meta, seen].filter(Boolean).join(" · ")}
          </p>
        ) : (
          <>
            {meta ? <p className="text-sm text-fg-muted">{meta}</p> : null}
            <p className="text-sm text-fg-muted first-letter:uppercase">
              {seen}
            </p>
          </>
        )}
      </div>
      {confirming ? null : (
        <Button
          ref={removeRef}
          variant="quiet"
          size="md"
          // In a very narrow card (320 px, or text at 200 %), under the icon and name too, so the
          // button has the row's whole width (WCAG 1.4.10). In px: a rem query scales with the text.
          className="col-start-2 h-10 justify-self-start max-sm:h-11 @max-[280px]:col-span-2 @max-[280px]:col-start-1 @[20rem]:col-start-3 @[20rem]:row-start-1"
          aria-label={t("locker.freeDevice.removeName", { device: name })}
          aria-expanded={false}
          aria-controls={panelId}
          onClick={onRemove}
        >
          {t("devices.remove")}
        </Button>
      )}
    </div>
  );
}

/**
 * The last consequences of a removal, shared by both confirms: backup sign-in ending for a device
 * that signed in from backup, then the notice email (only where the Worker can send mail).
 */
export function RemoveTail({
  restored,
  productName,
  emailConfigured,
}: {
  restored: boolean;
  productName: string;
  emailConfigured: boolean;
}): React.ReactElement {
  return (
    <>
      {restored ? (
        <li>
          {t("locker.devices.removeRestoredAll", { product: productName })}
        </li>
      ) : null}
      {emailConfigured ? <li>{t("locker.devices.emailConfirm")}</li> : null}
    </>
  );
}

/**
 * The confirm that opens in place under a row (the expand pattern, S-23 §6.1): focus goes to its
 * heading as soon as it shows, Escape keeps the device, and once it has opened the region is
 * brought into view. Under 22rem the two buttons stack full width, Remove last (§8's sheet
 * buttons).
 */
export function RemovePanel({
  id,
  open,
  name,
  headingRef,
  consequences,
  error,
  removing,
  onKeep,
  onRemove,
}: {
  id: string;
  open: boolean;
  name: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  consequences: React.ReactNode;
  error: boolean;
  removing: boolean;
  onKeep: () => void;
  onRemove: () => void;
}): React.ReactElement {
  return (
    <Expand id={id} open={open} {...focusOnOpen(headingRef)}>
      <div
        className="pt-3"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onKeep();
        }}
      >
        <div className="space-y-3 rounded-lg border border-danger-border bg-danger-subtle p-4 @container">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="font-medium text-fg-strong outline-none"
          >
            {t("locker.devices.removeAsk", { name })}
          </h3>
          <ul className="list-disc space-y-1 ps-5 text-sm text-fg">
            {consequences}
          </ul>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {t("devices.removeFailed", { device: name })}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 @[22rem]:flex-row @[22rem]:justify-end">
            <Button variant="outline" onClick={onKeep}>
              {t("locker.methods.keepIt")}
            </Button>
            {/* "Remove": the heading above already names the device; the name stays in the
                accessible name. */}
            <Button
              variant="danger"
              aria-label={t("locker.freeDevice.removeName", { device: name })}
              loading={removing}
              onClick={onRemove}
            >
              {t("devices.remove")}
            </Button>
          </div>
        </div>
      </div>
    </Expand>
  );
}
