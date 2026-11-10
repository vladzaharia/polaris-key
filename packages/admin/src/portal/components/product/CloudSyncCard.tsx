import * as React from "react";
import { ChevronDown, Download, Lock } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Meter } from "../../../ui/charts/Meter.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { cn } from "../../../lib/cn.js";
import { t, tParts } from "../../../lib/copy.js";
import { formatRelative } from "../../../lib/format.js";
import type { PortalCloudSync } from "../../api.js";
import { useExportSyncedData } from "../../data.js";
import { formatDay, formatDayTime, PORTAL_FMT } from "../../date.js";
import { LINK_CLASS } from "../../linkClass.js";
import type { LibraryProduct } from "../../model/library.js";
import {
  syncDevices,
  syncStorage,
  type SyncDevice,
} from "../../model/product.js";
import { href, scrollBehavior } from "../../router.js";
import {
  ExportTooLarge,
  isExportTooLarge,
  useDataDownload,
} from "../DownloadData.js";
import { SectionCard } from "./Card.js";

/** Devices listed before "Show all N". */
const DEVICES_SHOWN = 5;

/**
 * Sync Across Devices (G26, PX-18; U-12.5's `GET /api/products/<p>/sync`): what the product's sync
 * holds for the person. The reading leads, the way the Devices card's does ("**142 MB** of 1 GB",
 * a bar beside it, warning from 80 %); the tier's allowance shows only near or at the limit, where
 * it explains it. Then when each device last synced (relative, the date and time for a pointer and
 * a screen reader alike), the five most recent first. Sizes and times only: the Worker never sends
 * a value, a collection or a file name, and a device is its label.
 *
 * States, each in words and never by colour alone: loading (a skeleton in the card's shape),
 * error with Try again, empty, paused (since when), full (how to make room), and removing (the
 * person removed their data and the last part is finishing: one line, nothing else).
 *
 * One action, **Download synced data**: the product's export as a zip with every synced record
 * and file, through Your data's download flow. With end-to-end encryption the line beside it says
 * the download, too, is readable only on their devices. Removal has one home on the page, Your
 * Data; a quiet link here moves focus to its Remove.
 *
 * The page shows this card only while the product view says sync is on (`services.sync`), so the
 * section, its nav entries and the jump palette's action come and go together.
 */
export function CloudSyncCard({
  product,
  summary,
  loading,
  error,
  onRetry,
  now = Date.now(),
}: {
  product: LibraryProduct;
  summary: PortalCloudSync | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Milliseconds; the relative times count from it. */
  now?: number;
}): React.ReactElement {
  return (
    <SectionCard id="sync" title={t("account.cloudSync")}>
      {loading ? (
        // The card's own shape: the reading, three device rows, the action.
        <div className="space-y-4" aria-busy>
          <Skeleton className="h-5 w-full" />
          <div className="space-y-3">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
          </div>
          <Skeleton className="h-9 w-48" />
        </div>
      ) : error || !summary ? (
        <ErrorState
          error={error}
          onRetry={onRetry}
          message={t("locker.sync.loadFailed")}
          className="border-0 p-0 shadow-none"
        />
      ) : summary.state === "removing" ? (
        <p className="text-sm text-fg-muted">{t("locker.sync.removing")}</p>
      ) : (
        <SyncBody product={product} summary={summary} now={now} />
      )}
    </SectionCard>
  );
}

function SyncBody({
  product,
  summary,
  now,
}: {
  product: LibraryProduct;
  summary: PortalCloudSync;
  now: number;
}): React.ReactElement {
  const storage = syncStorage(summary);
  const paused = summary.state === "paused";
  return (
    <div className="space-y-4">
      {paused ? (
        <Callout
          tone="warning"
          title={
            summary.pausedSince
              ? t("locker.sync.paused", {
                  date: sinceDay(summary.pausedSince, now),
                })
              : t("core.codes.writes_paused.title")
          }
        >
          {t("locker.sync.pausedBody")}
        </Callout>
      ) : summary.state === "full" ? (
        // One tone for one state: the callout and the meter are both danger at the limit.
        <Callout tone="danger" title={t("core.codes.quota_exceeded.title")}>
          {t("locker.sync.fullBody", { product: product.name })}
          {storage.tierNote ? ` ${storage.tierNote}` : null}
        </Callout>
      ) : null}
      {summary.empty ? (
        // Paused and empty: the callout says it all.
        paused ? null : (
          <p className="text-sm text-fg-muted">
            {t("locker.sync.empty", { product: product.name })}
          </p>
        )
      ) : (
        <>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-muted">
              <p className="min-w-0">
                {storage.limit
                  ? tParts("locker.sync.used", ["used"], {
                      limit: storage.limit,
                    }).map((part, i) =>
                      typeof part === "string" ? (
                        <React.Fragment key={i}>{part}</React.Fragment>
                      ) : (
                        <span key={i} className="font-semibold text-fg-strong">
                          {storage.used}
                        </span>
                      ),
                    )
                  : storage.text}
              </p>
              {storage.meter ? (
                <Meter
                  bar
                  label={t("locker.sync.storage")}
                  value={storage.meter.value}
                  max={storage.meter.max}
                  tone={storage.meter.tone}
                  text={storage.text}
                  className="flex-1"
                />
              ) : null}
            </div>
            {storage.tierNote && summary.state !== "full" ? (
              <p className="text-sm text-fg-muted">{storage.tierNote}</p>
            ) : null}
          </div>
          <DeviceList devices={syncDevices(summary)} now={now} />
          <SyncActions product={product} e2e={summary.encryption === "e2e"} />
        </>
      )}
    </div>
  );
}

/** "Sep 30", with the year only when it is not this year's. */
function sinceDay(epochSeconds: number, now: number): string {
  const thisYear = new Date(now).getUTCFullYear();
  return formatDay(
    epochSeconds,
    new Date(epochSeconds * 1000).getUTCFullYear() !== thisYear,
  );
}

/** "Last synced": the most recent first, five of them until "Show all N". */
function DeviceList({
  devices,
  now,
}: {
  devices: SyncDevice[];
  now: number;
}): React.ReactElement | null {
  const [all, setAll] = React.useState(false);
  if (devices.length === 0) return null;
  const shown = all ? devices : devices.slice(0, DEVICES_SHOWN);
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-fg-strong">
          {t("locker.sync.lastSynced")}
        </h3>
        {devices.length > DEVICES_SHOWN ? (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
            className="inline-flex min-h-6 items-center gap-1 text-sm font-medium text-accent-fg hover:underline pointer-coarse:min-h-11"
          >
            {all
              ? t("locker.notes.fewer")
              : t("locker.packages.showAll", { count: devices.length })}
            <ChevronDown
              aria-hidden
              className={all ? "size-4 rotate-180" : "size-4"}
            />
          </button>
        ) : null}
      </div>
      <ul className="mt-2 divide-y divide-border border-t border-border">
        {shown.map((d, i) => (
          <li
            // Labels can repeat ("Unnamed device"), so the place is part of the key.
            key={`${i}:${d.label ?? ""}`}
            className="flex items-baseline gap-3 py-2 text-sm"
          >
            {/* `anywhere`: a long label with no break point wraps inside its column and never
                holds the row wider than a 320 px screen (WCAG 1.4.10). A device the Worker does
                not name (no label, or not signed in to this person now) is quieter than a name. */}
            <bdi
              className={cn(
                "min-w-0 flex-1 [overflow-wrap:anywhere]",
                d.label ? "font-medium text-fg-strong" : "text-fg-muted",
              )}
            >
              {d.label ?? t("devices.unnamed")}
            </bdi>
            <time
              dateTime={new Date(d.lastSyncAt * 1000).toISOString()}
              title={formatDayTime(d.lastSyncAt)}
              className="shrink-0 text-end tabular-nums text-fg-muted first-letter:uppercase"
            >
              {formatRelative(d.lastSyncAt * 1000, now, PORTAL_FMT)}
              {/* The date and time for a screen reader too, not only a pointer's tooltip. */}
              <span className="sr-only">, {formatDayTime(d.lastSyncAt)}</span>
            </time>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Download synced data, the end-to-end line beside it, and the way to Your Data's Remove. */
function SyncActions({
  product,
  e2e,
}: {
  product: LibraryProduct;
  e2e: boolean;
}): React.ReactElement {
  const exportData = useExportSyncedData(product.slug);
  const flow = useDataDownload(exportData, false, (err) =>
    isExportTooLarge(err) ? (
      <ExportTooLarge presentation={product.presentation} />
    ) : null,
  );
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-col gap-x-4 gap-y-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Button
          ref={flow.button}
          variant="outline"
          className="h-auto min-h-9 w-full whitespace-normal py-1.5 max-sm:min-h-11 sm:w-auto"
          iconStart={<Download aria-hidden />}
          loading={exportData.isPending}
          onClick={flow.start}
        >
          {t("locker.sync.download")}
        </Button>
        {/* Removal has one home, Your Data: this moves focus to its Remove. */}
        <a
          href={href.product(product.slug, "data")}
          onClick={(e) => {
            const remove = document.querySelector<HTMLElement>(
              "#section-data [data-remove-data]",
            );
            if (!remove) return;
            e.preventDefault();
            remove.scrollIntoView?.({
              block: "center",
              behavior: scrollBehavior(),
            });
            remove.focus({ preventScroll: true });
          }}
          className={cn(
            LINK_CLASS,
            // A 24 px target, 44 px under a coarse pointer (the customer-surface floor).
            "inline-flex min-h-6 items-center self-start text-sm sm:self-auto pointer-coarse:min-h-11",
          )}
        >
          {t("locker.sync.removeIn")}
        </a>
      </div>
      {e2e ? (
        <p className="flex items-start gap-2 text-sm text-fg-muted">
          <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("locker.sync.private")}
        </p>
      ) : null}
      {flow.open ? flow.below : null}
    </div>
  );
}
