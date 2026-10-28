import * as React from "react";
import { ErrorState } from "../../../ui/ErrorState.js";
import { ExternalLink, Mail } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import type { PortalLicenseDetail } from "../../api.js";
import type { LibraryProduct, ProductStatus } from "../../model/library.js";
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
import { SectionCard } from "./Card.js";
import { LicenseTerm, termPlot } from "./LicenseTerm.js";
import { t } from "../../../lib/copy.js";

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
 * with a key", "Steam key", "From Steam", "From <Developer>", and "Sign-in" for one
 * granted through OIDC at sign-in (owner polish 2026-10-07). The term is not repeated as a meta
 * line: "Access" already says it (owner, 2026-10-06). Every licence is account-bound, so none is
 * labelled by type (owner decision, 2026-10-05). Get a new key waits for G7.
 *
 * The term leads (`LicenseTerm`, PX-28a): the end as words and, with a start and an end, a
 * timeline. It says what the Worker does today (P0-47): a licence works until its end date and
 * then stops, so the card never promises "Updates included" or newer versions on renewal. LX-41's
 * "keeps the last version" brings that wording back for the licences it covers. **Renew** lives
 * here and nowhere else on the page: an outlined link to the developer's own page for a license
 * that has ended or ends soon, and absent (never disabled) when the developer left no link. The
 * duration, add-ons and subscription lines are PX-28b's. Every string is a catalog key.
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
  const status = detail ? statusOf(product, detail, now) : null;
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
      // Tighter from 1024 px, so the Devices card below starts in the first screen at 1280 × 800.
      className="desk:p-5"
      // The page's h1 already names the product (the mockup's card says only "License").
      title={t("license.title")}
      aside={
        selected || ownIssue ? (
          <div
            data-license-pills=""
            className="flex min-w-0 max-w-[60%] flex-wrap items-center justify-end gap-1.5"
          >
            {/* The tier is an identity label, not a status: a quiet neutral pill (owner,
                2026-10-05), at the header's top right, before any issue pill (2026-10-07). */}
            {selected ? (
              <StatusPill tone="neutral" icon={false} className="max-w-full">
                {tierName(selected)}
              </StatusPill>
            ) : null}
            {ownIssue ? <ProductStatusPill status={ownIssue} /> : null}
          </div>
        ) : undefined
      }
    >
      {multiple ? (
        <div className="mb-4 space-y-1">
          <label htmlFor={switcherId} className="text-sm text-fg-muted">
            {t("license.switcher", {
              count: product.licenses.length,
              tier: product.licenses.map((l) => tierName(l)).join(", "),
            })}
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
                  keys: l.id === detail?.id ? detail.keys : undefined,
                  developer: product.presentation.developer,
                })}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {loading ? (
        // The card's own order: the term, then the facts in their two columns.
        <div className="space-y-5" aria-busy>
          <Skeleton className="h-24 w-full" />
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      ) : error || !detail ? (
        <ErrorState
          error={error}
          // Try again keeps the person here: ErrorState moves focus to the card's heading.
          onRetry={onRetry}
          message={t("locker.error.loadFailedLicense")}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <LicenseFacts product={product} detail={detail} now={now} />
      )}
    </SectionCard>
  );
}

/**
 * A license's status for its card. The library's status for the product's best license says
 * "Updates ended" when it still downloads an older build (§5.4); the card says the same for that
 * license, not "Expired" (which is for a license that stopped everything).
 */
function statusOf(
  product: LibraryProduct,
  detail: PortalLicenseDetail,
  now: number,
): ProductStatus {
  const own = licenseStatus(detail, now);
  return own.kind === "expired" &&
    product.status.kind === "updatesEnded" &&
    product.best?.id === detail.id
    ? product.status
    : own;
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
  const status = statusOf(product, detail, now);
  const origin = licenseOrigin(detail, {
    keys: detail.keys,
    developer: product.presentation.developer,
  });
  const key = detail.keys.find((k) => k.status === "active") ?? detail.keys[0];
  const includes = detail.entitlements.filter((e) => e.key !== "channels");
  const channels = detail.channels.map(trackName);
  const developer = product.presentation.developer;
  const who = developer ?? t("license.developerFallback");
  const { supportUrl, supportEmail, website } = product.presentation;
  const renewing =
    status.kind === "expired" ||
    status.kind === "updatesEnded" ||
    status.kind === "expiresSoon";
  const renewHref = renewing
    ? (supportUrl ?? (supportEmail ? `mailto:${supportEmail}` : website))
    : null;
  const external = renewHref !== null && !renewHref.startsWith("mailto:");
  const charted = termPlot(detail.activatedAt, detail.expiresAt) !== null;
  return (
    <div className="space-y-5 desk:space-y-2">
      {status.kind === "suspended" ? (
        <p className="rounded-lg border border-danger-border bg-danger-subtle p-3 text-sm text-fg">
          {t("license.suspended", {
            developer: developer ?? t("license.developerFallbackCap"),
          })}
        </p>
      ) : (
        <LicenseTerm
          activatedAt={detail.activatedAt}
          expiresAt={detail.expiresAt}
          now={now}
          updatesEndedAt={
            status.kind === "updatesEnded" ? (status.version ?? null) : null
          }
        >
          {renewHref ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
              {status.kind === "expired" ? (
                <p className="text-sm text-fg-muted">{t("license.expired")}</p>
              ) : null}
              <Button
                asChild
                variant="quiet"
                className="h-auto min-h-11 w-full whitespace-normal py-2 text-start sm:w-auto"
              >
                <a
                  href={renewHref}
                  {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                >
                  {external ? (
                    <ExternalLink aria-hidden className="self-start" />
                  ) : (
                    <Mail aria-hidden className="self-start" />
                  )}
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {t("license.renew", { developer: who })}
                  </span>
                  {external ? (
                    <span className="sr-only">{t("getIt.newTab")}</span>
                  ) : null}
                </a>
              </Button>
            </div>
          ) : null}
        </LicenseTerm>
      )}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-4 text-sm min-[22rem]:grid-cols-2 bigtext:min-[22rem]:grid-cols-1 desk:gap-y-2">
        <Fact term={t("license.fact.versions")}>
          <span
            className={
              detail.minVersion || detail.maxVersion ? "font-mono" : undefined
            }
          >
            {coversVersions(detail)}
          </span>
        </Fact>
        {/* With no chart the start day is not on the page yet: say it, when there is one. */}
        {!charted && detail.activatedAt !== null && detail.activatedAt > 0 ? (
          <Fact term={t("core.activation.ok.title")}>
            {formatDay(detail.activatedAt)}
          </Fact>
        ) : null}
        {/* How the licence reached the person, never a type (owner, 2026-10-05 and 2026-10-06). */}
        <Fact term={t("license.fact.source")}>{origin}</Fact>
        {detail.maxOfflineDays !== null ? (
          <Fact term={t("license.fact.offline")}>
            {t("license.offline", { days: detail.maxOfflineDays })}
          </Fact>
        ) : null}
        {channels.length ? (
          <Fact term={t("license.fact.tracks", { count: channels.length })}>
            {channels.join(", ")}
          </Fact>
        ) : null}
        {/* The key is a fact like the others: the mask on one line with a disclosure, which holds
            why it is only a mask (a fingerprint, or the last 4 characters). */}
        {key ? (
          <Fact term={t("part.keyField.label")} wide>
            <div className="flex flex-wrap items-center gap-x-3">
              <KeyMask slug={product.slug} last4={key.last4} />
              <details className="text-xs text-fg-muted open:basis-full">
                <summary className="inline-flex min-h-6 pointer-coarse:min-h-11 cursor-pointer items-center rounded-sm underline [text-decoration-style:dotted] underline-offset-2 hover:text-fg-strong">
                  {t("license.key.why")}
                </summary>
                <p className="mt-1">
                  {key.last4
                    ? t("license.key.last4")
                    : t("license.key.fingerprint")}
                </p>
              </details>
            </div>
          </Fact>
        ) : null}
        {includes.length ? (
          <Fact term={t("license.fact.included")} wide>
            <ul
              aria-label={t("license.fact.included")}
              className="flex flex-wrap gap-x-4 gap-y-0.5"
            >
              {includes.map((e) => (
                <li key={e.key}>{e.label}</li>
              ))}
            </ul>
          </Fact>
        ) : null}
      </dl>
    </div>
  );
}

/** A release track as a person reads it: "stable" is "Stable", "early-access" "Early access". */
function trackName(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One fact: its label over its value (the two columns fall to one at 320 px or 200 % text). */
function Fact({
  term,
  wide = false,
  children,
}: {
  term: string;
  wide?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className={
        wide
          ? "min-[22rem]:col-span-2 bigtext:min-[22rem]:col-span-1"
          : undefined
      }
    >
      <dt className="text-xs text-fg-muted">{term}</dt>
      <dd className="mt-0.5 min-w-0 text-fg-strong desk:mt-0 [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}
