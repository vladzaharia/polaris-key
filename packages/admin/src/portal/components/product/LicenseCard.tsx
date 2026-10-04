import * as React from "react";
import { Check, Info } from "lucide-react";
import { Skeleton } from "../../../ui/Skeleton.js";
import type { PortalLicenseDetail } from "../../api.js";
import type { LibraryProduct } from "../../model/library.js";
import { formatDay, licenseStatus, tierLabel } from "../../model/library.js";
import { coversVersions } from "../../model/product.js";
import { KeyMask } from "../KeyMask.js";
import { ProductStatusPill } from "../ProductStatus.js";
import { ErrorPanel } from "../States.js";
import { SectionCard } from "./Card.js";

/**
 * The License card (§4.20): status and tier, the facts that used to be hidden (updates,
 * versions, activation, offline days), the masked key and what the license includes. With
 * several licenses for the product, a switcher ("2 licenses · Pro, Edu") picks the one this
 * card, Devices and Package access describe. Get a new key waits for G7.
 */
export function LicenseCard({
  product,
  detail,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
}: {
  product: LibraryProduct;
  detail: PortalLicenseDetail | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: string;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const now = Math.floor(Date.now() / 1000);
  const switcherId = React.useId();
  const multiple = product.licenses.length > 1;
  return (
    <SectionCard
      id="license"
      title={`${product.name} license`}
      subtitle={detail?.email ? `Licensed to ${detail.email}` : undefined}
    >
      {multiple ? (
        <div className="mb-4 space-y-1">
          <label htmlFor={switcherId} className="text-sm text-fg-muted">
            {product.licenses.length} licenses ·{" "}
            {product.licenses
              .map((l) => tierLabel(l.tier) ?? "Standard")
              .join(", ")}
          </label>
          <select
            id={switcherId}
            value={selectedId}
            onChange={(e) => onSelect(e.target.value)}
            className="h-10 w-full rounded-md border border-border-strong bg-surface-page px-3 text-sm text-fg-strong"
          >
            {product.licenses.map((l) => (
              <option key={l.id} value={l.id}>
                {tierLabel(l.tier) ?? "Standard"} ·{" "}
                {licenseStatus(l, now).label}
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
        <LicenseFacts product={product} detail={detail} now={now} />
      )}
    </SectionCard>
  );
}

function LicenseFacts({
  product,
  detail,
  now,
}: {
  product: LibraryProduct;
  detail: PortalLicenseDetail;
  now: number;
}): React.ReactElement {
  const status = licenseStatus(detail, now);
  const tier = tierLabel(detail.tier);
  const updates =
    detail.expiresAt === null
      ? "For life"
      : detail.expiresAt <= now
        ? `Ended ${formatDay(detail.expiresAt)}`
        : `Until ${formatDay(detail.expiresAt)}`;
  const key = detail.keys.find((k) => k.status === "active") ?? detail.keys[0];
  const includes = detail.entitlements.filter((e) => e.key !== "channels");
  const channels = detail.channels;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <ProductStatusPill status={status} />
        {tier ? (
          <span className="inline-flex h-6 items-center rounded-md border border-border-strong px-2 text-xs text-fg-strong">
            {tier} license
          </span>
        ) : null}
      </div>
      {status.kind === "expired" || status.kind === "suspended" ? (
        <p className="rounded-lg border border-danger-border bg-danger-subtle p-3 text-sm text-fg">
          {status.kind === "expired"
            ? `${status.note}. To get newer versions, renew with ${product.presentation.developer ?? "the developer"}.`
            : `${product.presentation.developer ?? "The developer"} suspended this license. Contact them to find out why.`}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
        <div>
          <dt className="text-xs text-fg-muted">Updates included</dt>
          <dd className="mt-0.5 text-fg-strong">{updates}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Covers versions</dt>
          <dd className="mt-0.5 font-mono text-fg-strong">
            {coversVersions(detail)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Activated</dt>
          <dd className="mt-0.5 text-fg-strong">
            {formatDay(detail.activatedAt)}
          </dd>
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
        <ul aria-label="Included" className="flex flex-wrap gap-2">
          {includes.map((e) => (
            <li
              key={e.key}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong px-2.5 text-sm text-fg-strong"
            >
              <Check aria-hidden className="size-3.5 text-success" />
              {e.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
