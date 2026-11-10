import * as React from "react";
import { Download, Lock, Trash2 } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Meter } from "../../../ui/charts/Meter.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { formatRelative } from "../../../lib/format.js";
import { t } from "../../../lib/copy.js";
import type { PortalCloudSync } from "../../api.js";
import { YOUR_DATA_COPY } from "../../copy/yourData.js";
import { useExportSyncedData } from "../../data.js";
import { formatDayTime, PORTAL_FMT } from "../../date.js";
import type { LibraryProduct } from "../../model/library.js";
import { syncDevices, syncStorage } from "../../model/product.js";
import { focusPageHeading } from "../../router.js";
import { useDataDownload } from "../DownloadData.js";
import { SectionCard } from "./Card.js";
import { RemoveProductDataDialog } from "./RemoveProductDataDialog.js";

/**
 * Sync Across Devices (G26, PX-18; U-12.5's `GET /api/products/<p>/sync`): what the product's sync
 * holds for the person, read-only. How much of their limit it uses (a meter, warning from 80 %),
 * the tier that set the limit, when each device last synced, and that only their devices can read
 * it when the data is end-to-end encrypted. Sizes and times only: the Worker never sends a value,
 * a collection or a file name, and a device is its label.
 *
 * States: loading (a skeleton), error with Try again, empty (nothing stored yet), paused (the
 * operator's hold) and full (at the limit), each said in words, never by colour alone. A device's
 * time is relative ("3 min. ago") with the date and time as its title; there is no "Up to date"
 * (the Worker's time is a push or a pull, at most an hour stale).
 *
 * Once something is stored, two actions close the card (PX-18.2):
 *
 * - **Download synced data**: the product's export as a zip with every synced record and file
 *   (`?format=zip`), through Your data's download flow (a press starts it; a stale sign-in asks to
 *   confirm it's you in place, then runs it again; a refusal stays under the buttons).
 * - **Remove my data**: the whole product's removal, in Your data's dialog. A sync-only delete
 *   would be undone by the next push from a signed-in device, so there is none. After it, focus
 *   goes to this card's heading, since the summary that comes back may have no actions to return
 *   to.
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
  onLeftLibrary,
  now = Date.now(),
}: {
  product: LibraryProduct;
  summary: PortalCloudSync | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** A removal that also took the licenses: the product has left the library. */
  onLeftLibrary?: () => void;
  /** Milliseconds; the relative times count from it. */
  now?: number;
}): React.ReactElement {
  const [removing, setRemoving] = React.useState(false);
  return (
    <SectionCard id="sync" title={t("account.cloudSync")}>
      {loading ? (
        <Skeleton className="h-28 w-full" />
      ) : error || !summary ? (
        <ErrorState
          error={error}
          onRetry={onRetry}
          message={t("locker.sync.loadFailed")}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <SyncBody
          product={product}
          summary={summary}
          now={now}
          onRemove={() => setRemoving(true)}
        />
      )}
      {/* Outside the body: it stays mounted while the summary reads again after a removal. */}
      <RemoveProductDataDialog
        open={removing}
        onOpenChange={setRemoving}
        product={product}
        onLeftLibrary={onLeftLibrary}
        onRemoved={() =>
          focusPageHeading(() => document.getElementById("section-sync-h"))
        }
      />
    </SectionCard>
  );
}

function SyncBody({
  product,
  summary,
  now,
  onRemove,
}: {
  product: LibraryProduct;
  summary: PortalCloudSync;
  now: number;
  onRemove: () => void;
}): React.ReactElement {
  const productName = product.name;
  const storage = syncStorage(summary);
  const devices = syncDevices(summary);
  return (
    <div className="space-y-4">
      {summary.state === "paused" ? (
        <Callout tone="warning" title={t("core.codes.writes_paused.title")}>
          {t("core.codes.writes_paused.message")}
        </Callout>
      ) : summary.state === "full" ? (
        <Callout tone="warning" title={t("core.codes.quota_exceeded.title")}>
          {t("locker.sync.fullBody")}
        </Callout>
      ) : null}
      {summary.empty ? (
        <p className="text-sm text-fg-muted">
          {t("locker.sync.empty", { product: productName })}
        </p>
      ) : (
        <>
          <div className="space-y-1">
            {storage.meter ? (
              <Meter
                label={t("locker.sync.storage")}
                value={storage.meter.value}
                max={storage.meter.max}
                tone={storage.meter.tone}
                text={storage.text}
              />
            ) : (
              <p className="text-sm text-fg">{storage.text}</p>
            )}
            {storage.tier ? (
              <p className="text-xs text-fg-muted">
                {t("locker.sync.tierLimit", { tier: storage.tier })}
              </p>
            ) : null}
          </div>
          {devices.length > 0 ? (
            <div>
              <h3 className="text-sm font-medium text-fg-strong">
                {t("locker.sync.lastSynced")}
              </h3>
              <ul className="mt-2 divide-y divide-border border-t border-border">
                {devices.map((d, i) => (
                  <li
                    // Labels can repeat ("Unnamed device"), so the place is part of the key.
                    key={`${i}:${d.label}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-sm"
                  >
                    {/* `anywhere`: a long label with no break point never holds the row wider
                        than a 320 px screen (WCAG 1.4.10). */}
                    <bdi className="min-w-0 text-fg [overflow-wrap:anywhere]">
                      {d.label}
                    </bdi>
                    <time
                      dateTime={new Date(d.lastSyncAt * 1000).toISOString()}
                      title={formatDayTime(d.lastSyncAt)}
                      className="shrink-0 tabular-nums text-fg-muted first-letter:uppercase"
                    >
                      {formatRelative(d.lastSyncAt * 1000, now, PORTAL_FMT)}
                    </time>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      {summary.encryption === "e2e" && !summary.empty ? (
        <p className="flex items-start gap-2 text-sm text-fg-muted">
          <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("locker.sync.private")}
        </p>
      ) : null}
      {summary.empty ? null : (
        <SyncActions
          slug={product.slug}
          name={productName}
          onRemove={onRemove}
        />
      )}
    </div>
  );
}

/** Download synced data and Remove my data, side by side; stacked full width on a phone. */
function SyncActions({
  slug,
  name,
  onRemove,
}: {
  slug: string;
  name: string;
  onRemove: () => void;
}): React.ReactElement {
  const exportData = useExportSyncedData(slug);
  const flow = useDataDownload(exportData);
  // Wraps inside the button rather than past the card at 320 px or 200 % text (WCAG 1.4.10).
  const wraps =
    "h-auto min-h-9 w-full whitespace-normal py-1.5 max-sm:min-h-11 sm:w-auto";
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          ref={flow.button}
          variant="outline"
          className={wraps}
          iconStart={<Download aria-hidden />}
          loading={exportData.isPending}
          onClick={flow.start}
        >
          {t("locker.sync.download")}
        </Button>
        <Button
          variant="outline"
          className={`${wraps} border-danger-border text-danger`}
          iconStart={<Trash2 aria-hidden />}
          aria-label={t("locker.productData.removeAria", { product: name })}
          onClick={onRemove}
        >
          {YOUR_DATA_COPY["yourData.product.remove.title"]}
        </Button>
      </div>
      {flow.open ? flow.below : null}
    </div>
  );
}
