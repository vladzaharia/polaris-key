import * as React from "react";
import { Info } from "lucide-react";
import { Skeleton } from "../../../ui/Skeleton.js";
import type { PortalLicenseDetail } from "../../api.js";
import type { LibraryProduct } from "../../model/library.js";
import {
  formatDay,
  licenseOrigin,
  licenseStatus,
} from "../../model/library.js";
import {
  coversVersions,
  licenseOptionLabel,
  tierName,
} from "../../model/product.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { KeyMask } from "../KeyMask.js";
import { isIssueStatus, ProductStatusPill } from "../ProductStatus.js";
import { ErrorPanel } from "../States.js";
import { SectionCard } from "./Card.js";

/**
 * The License card (§4.20): the tier as a neutral pill at the top right of the card's header, the
 * facts as text (updates, versions, activation, offline days), the masked key and what the
 * license includes as a plain list. The status shows once, in the page header (EXPERIENCE §0.6
 * P4): this card adds an issue pill, after the tier, only when the license it describes has a
 * different issue from the one the page header shows. The device count is the Devices card's
 * alone (owner polish 2026-10-07). With several licenses for the product, a switcher ("2
 * licenses · Pro, Edu") picks the one this card, Devices and Package access describe; each option
 * names the tier and its short origin ("Pro · Key …3WPLDA", "Standard · Sign-in", "Free · From
 * Acme"). How the licence reached the person is the **License source** fact beside "Activated",
 * in plain words the Worker's `origin` decides (PX-23, S-24 D21): "Key ending 3WPLDA" or "Added
 * with a key", "Steam key", "From Steam", "From <Developer>", and "Automatic Grant" for one
 * granted through OIDC at sign-in (owner polish 2026-10-07). The term is not repeated as a meta
 * line: "Access" already says it (owner, 2026-10-06). Every licence is account-bound, so none is
 * labelled by type (owner decision, 2026-10-05). Get a new key waits for G7.
 *
 * "Access" says what the Worker does today (P0-47): a licence works until its end date and then
 * stops, so the card never promises "Updates included" or newer versions on renewal. LX-41's
 * "keeps the last version" brings that wording back for the licences it covers.
 */
export function LicenseCard({
  product,
  detail,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  storeOf = () => null,
}: {
  product: LibraryProduct;
  detail: PortalLicenseDetail | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: string;
  onSelect: (id: string) => void;
  /** The store of an active purchase on a licence (PX-W6), or null. */
  storeOf?: (id: string) => string | null;
}): React.ReactElement {
  const now = Math.floor(Date.now() / 1000);
  const switcherId = React.useId();
  const multiple = product.licenses.length > 1;
  const status = detail ? licenseStatus(detail, now) : null;
  const ownIssue =
    status &&
    isIssueStatus(status) &&
    (status.kind !== product.status.kind ||
      status.label !== product.status.label)
      ? status
      : null;
  // The tier comes from the licence list, so it is in place before the detail loads.
  const selected =
    product.licenses.find((l) => l.id === selectedId) ?? detail ?? null;
  return (
    <SectionCard
      id="license"
      // A no-break space before the last word, so a narrow or zoomed heading never leaves
      // "license" alone on its own line.
      title={`${product.name}\u00a0license`}
      aside={
        selected || ownIssue ? (
          <div
            data-license-pills=""
            className="flex flex-wrap items-center justify-end gap-1.5"
          >
            {/* The tier is an identity label, not a status: a quiet neutral pill (owner,
                2026-10-05), at the header's top right, before any issue pill (2026-10-07). */}
            {selected ? (
              <StatusPill tone="neutral" icon={false}>
                {tierName(selected)}
              </StatusPill>
            ) : null}
            {ownIssue ? <ProductStatusPill status={ownIssue} /> : null}
          </div>
        ) : undefined
      }
      subtitle={detail?.email ? `Licensed to ${detail.email}` : undefined}
    >
      {multiple ? (
        <div className="mb-4 space-y-1">
          <label htmlFor={switcherId} className="text-sm text-fg-muted">
            {product.licenses.length} licenses ·{" "}
            {product.licenses.map((l) => tierName(l)).join(", ")}
          </label>
          <select
            id={switcherId}
            value={selectedId}
            onChange={(e) => onSelect(e.target.value)}
            className="h-10 w-full rounded-md border border-border-strong bg-surface-page px-3 text-sm text-fg-strong"
          >
            {product.licenses.map((l) => (
              <option key={l.id} value={l.id}>
                {licenseOptionLabel(l, licenseStatus(l, now), {
                  store: storeOf(l.id),
                  keys: l.id === detail?.id ? detail.keys : undefined,
                  developer: product.presentation.developer,
                })}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {loading ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error || !detail ? (
        <ErrorPanel
          error={error}
          onRetry={onRetry}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <LicenseFacts
          product={product}
          detail={detail}
          now={now}
          store={storeOf(detail.id)}
        />
      )}
    </SectionCard>
  );
}

function LicenseFacts({
  product,
  detail,
  now,
  store,
}: {
  product: LibraryProduct;
  detail: PortalLicenseDetail;
  now: number;
  store: string | null;
}): React.ReactElement {
  const status = licenseStatus(detail, now);
  const origin = licenseOrigin(detail, {
    keys: detail.keys,
    store,
    developer: product.presentation.developer,
  });
  const access =
    detail.expiresAt === null
      ? "Lifetime"
      : detail.expiresAt <= now
        ? `Ended ${formatDay(detail.expiresAt)}`
        : `Until ${formatDay(detail.expiresAt)}`;
  const key = detail.keys.find((k) => k.status === "active") ?? detail.keys[0];
  const includes = detail.entitlements.filter((e) => e.key !== "channels");
  const channels = detail.channels;
  const includedId = React.useId();
  return (
    <div className="space-y-5">
      {status.kind === "expired" || status.kind === "suspended" ? (
        <p className="rounded-lg border border-danger-border bg-danger-subtle p-3 text-sm text-fg">
          {status.kind === "expired"
            ? `${status.note}. Renew with ${product.presentation.developer ?? "the developer"} to use it again.`
            : `${product.presentation.developer ?? "The developer"} suspended this license. Contact them to find out why.`}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
        <div>
          <dt className="text-xs text-fg-muted">Access</dt>
          <dd className="mt-0.5 text-fg-strong">{access}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Covers versions</dt>
          <dd
            className={
              detail.minVersion || detail.maxVersion
                ? "mt-0.5 font-mono text-fg-strong"
                : "mt-0.5 text-fg-strong"
            }
          >
            {coversVersions(detail)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Activated</dt>
          <dd className="mt-0.5 text-fg-strong">
            {formatDay(detail.activatedAt)}
          </dd>
        </div>
        {/* How the licence reached the person, never a type (owner, 2026-10-05 and 2026-10-06). */}
        <div>
          <dt className="text-xs text-fg-muted">License source</dt>
          <dd className="mt-0.5 text-fg-strong">{origin}</dd>
        </div>
        {detail.maxOfflineDays !== null ? (
          <div>
            <dt className="text-xs text-fg-muted">Works offline for</dt>
            <dd className="mt-0.5 text-fg-strong">
              {detail.maxOfflineDays === 1
                ? "1 day"
                : `${detail.maxOfflineDays} days`}
            </dd>
          </div>
        ) : null}
        {channels.length ? (
          <div className="col-span-2">
            <dt className="text-xs text-fg-muted">Release channels</dt>
            <dd className="mt-0.5 text-fg-strong">{channels.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      {key ? (
        <div className="space-y-2">
          <p className="text-xs text-fg-muted">License key</p>
          <div className="flex items-center rounded-md border border-border bg-surface-sunken px-3 py-2.5">
            <KeyMask slug={product.slug} last4={key.last4} />
          </div>
          <p className="flex gap-2 text-sm text-fg-muted">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            {key.last4
              ? "Only the last 4 characters are kept, so a key can’t be shown in full."
              : "Polaris Key keeps only a fingerprint of your key, so it can’t be shown again. Keep the copy from your email or store."}
          </p>
        </div>
      ) : null}
      {includes.length ? (
        <div className="space-y-1 text-sm">
          <p id={includedId} className="text-xs text-fg-muted">
            Included
          </p>
          <ul aria-labelledby={includedId} className="space-y-1 text-fg-strong">
            {includes.map((e) => (
              <li key={e.key}>{e.label}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
