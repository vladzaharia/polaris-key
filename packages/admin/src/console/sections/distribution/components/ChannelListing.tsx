/**
 * A channel's Listing tab (A-22.5): the listing this store takes, read-only. The store's fields
 * from the fit report (`GET …/listing/fit`), each with the shared value (its overrides on top),
 * whether it is copied by hand or set in the store, and its fit issues. Editing is on
 * Settings → Presentation → Listing, one link away. Listing text is data, shown escaped.
 */

import * as React from "react";
import type { ListingFitResponse, ListingResponse } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Section } from "../../../../ui/Section.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { issueLine } from "../../storefronts/components/FitReport.js";
import { EditListingLink } from "../../storefronts/components/EditListingLink.js";
import { useListing, useListingFit } from "../../storefronts/data.js";
import { fieldLabel } from "../../storefronts/model/listingFields.js";
import type { ChannelRow } from "../../../../api.js";
import type { ChannelTabProps } from "./channelTabs.js";

/**
 * The listing column each store channel is projected to (the Worker's `LISTING_STORES`, pinned by
 * a test); a channel not listed has no listing of its own.
 */
export const LISTING_COLUMN: Readonly<Record<string, string>> = {
  "app-store": "app-store",
  "google-play": "play",
  "microsoft-store": "ms-store",
  steam: "steam",
  flathub: "flathub",
  snap: "snap",
  winget: "winget",
  fdroid: "fdroid",
  "polaris-key": "polaris-key",
};

/** The Listing tab shows for a channel that has a listing of its own. */
export const hasListing = (channel: ChannelRow): boolean =>
  channel.id in LISTING_COLUMN;

type Cell = ListingFitResponse["stores"][number]["cells"][number];
type Locale = ListingResponse["locales"][number];

export interface ListingFact {
  key: string;
  label: string;
  /** The model field it is projected from. */
  from: string;
  /** Empty when the store takes it but it is not written, or is set in the store. */
  value: string;
  plane: Cell["plane"];
  present: boolean;
  overridden: boolean;
  issues: { text: string; blocking: boolean }[];
}

const asText = (v: unknown): string =>
  Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "";

/** The model fields that live under the app's `urls`, as the projection reads them. */
const URL_KEY: Readonly<Record<string, string>> = {
  website: "website",
  supportUrl: "support",
  privacyUrl: "privacy",
  marketingUrl: "marketing",
  eulaUrl: "eula",
};

/** The shared value for a model field in the default locale. */
function modelValue(data: ListingResponse, from: string): string {
  const app = data.listing?.app;
  const locale = data.locales.find((l) => l.locale === app?.defaultLocale) as
    | Locale
    | undefined;
  const url = URL_KEY[from];
  if (url) return asText(app?.urls?.[url]);
  return asText(
    (locale as Record<string, unknown> | undefined)?.[from] ??
      (app as Record<string, unknown> | undefined)?.[from],
  );
}

/** The facts the API serves for one store column, in the default locale. */
export function listingFacts(
  data: ListingResponse,
  fit: ListingFitResponse["stores"][number],
): ListingFact[] {
  const dl = data.listing?.app.defaultLocale ?? null;
  return fit.cells
    .filter((c) => c.locale === null || c.locale === dl)
    .map((c) => {
      const o = data.overrides.find(
        (x) =>
          x.store === fit.store &&
          x.field === c.from &&
          (x.locale === null || x.locale === dl),
      );
      return {
        key: `${c.field}:${c.locale ?? ""}`,
        from: c.from,
        label: fieldLabel(c.field),
        value:
          c.plane === "manual"
            ? ""
            : o
              ? asText(o.value)
              : modelValue(data, c.from),
        plane: c.plane,
        present: c.present,
        overridden: !!o,
        issues: fit.issues
          .filter(
            (i) => i.from === c.from && (i.locale === null || i.locale === dl),
          )
          .map((i) => ({
            text: issueLine(i),
            blocking: i.severity === "block",
          })),
      };
    });
}

const PLANE_NOTE: Record<Cell["plane"], string | null> = {
  api: null,
  copy: "Copied by hand",
  manual: "Set in the store",
};

const humanLocale = (tag: string): string => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
};

function Value({
  text,
  clamp,
}: {
  text: string;
  clamp: boolean;
}): React.ReactElement {
  const [all, setAll] = React.useState(false);
  const long = clamp && text.length > 280;
  return (
    <div className="min-w-0">
      <p
        dir="auto"
        className={`max-w-[70ch] whitespace-pre-wrap break-words text-start text-sm text-fg${long && !all ? " line-clamp-6" : ""}`}
      >
        {text}
      </p>
      {long ? (
        <Button
          variant="link"
          size="sm"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}

const isNotes = (from: string): boolean =>
  from === "releaseNotes" || from === "releaseNotesShort";

/** The header's fit line, from the store's own status. */
function fitLine(row: ListingFitResponse["stores"][number]): string {
  if (row.status === "green") return "Fits";
  const blocking = row.issues.filter((i) => i.severity === "block").length;
  return blocking ? `${blocking} blocking` : `${row.issues.length} to review`;
}

export function ChannelListing({
  slug,
  channel,
}: ChannelTabProps): React.ReactElement {
  const listing = useListing(slug);
  const fit = useListingFit(slug);
  const q = [listing, fit].find((x) => x.isError);
  if (listing.isPending || fit.isPending)
    return <Skeleton className="h-64 w-full" />;
  if (q)
    return (
      <ErrorState
        error={q.error}
        context={{ area: "distribution", thing: "Listing" }}
        onRetry={() => void q.refetch()}
      />
    );
  if (!fit.data?.exists || !listing.data?.listing)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="No listing yet"
        description="Write it in Settings → Presentation → Listing."
        primaryAction={
          <EditListingLink
            slug={slug}
            store={channel.id}
            variant="outline"
            label="Write the listing"
          />
        }
      />
    );
  const row = fit.data.stores.find(
    (s) => s.store === LISTING_COLUMN[channel.id],
  );
  const facts = row ? listingFacts(listing.data, row) : [];
  const dl = listing.data.listing.app.defaultLocale;
  return (
    <Section
      title="Listing"
      description={`What ${channel.label} takes, in ${humanLocale(dl)}.${row ? ` ${fitLine(row)}.` : ""}`}
      actions={
        <EditListingLink
          slug={slug}
          store={channel.id}
          label={`Edit ${channel.label} listing`}
        />
      }
    >
      {facts.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Nothing is projected to {channel.label} yet.
        </p>
      ) : (
        <dl className="divide-y divide-border">
          {facts.map((f) => (
            <div
              key={f.key}
              className="min-w-0 space-y-1 py-3 first:pt-0 last:pb-0"
            >
              <dt className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                <span>{f.label}</span>
                {f.overridden ? (
                  <StatusPill tone="info" icon={false} size="sm">
                    {channel.label} only
                  </StatusPill>
                ) : null}
                {PLANE_NOTE[f.plane] ? (
                  <span>· {PLANE_NOTE[f.plane]}</span>
                ) : null}
              </dt>
              <dd className="min-w-0">
                {f.plane === "manual" ? null : f.value ? (
                  <Value text={f.value} clamp={f.from === "description"} />
                ) : isNotes(f.from) ? (
                  <p className="text-sm text-fg-muted">
                    Written per release, on Releases.
                  </p>
                ) : (
                  <p className="text-sm text-fg-muted">
                    {f.present ? "Written" : "Not written yet"}
                  </p>
                )}
                {f.issues.map((i) => (
                  <p
                    key={i.text}
                    className={`mt-1 text-sm ${i.blocking ? "text-danger" : "text-warning"}`}
                  >
                    {i.text}
                  </p>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}
