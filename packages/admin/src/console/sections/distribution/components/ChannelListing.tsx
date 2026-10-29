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
import {
  useListing,
  useListingFit,
  useStorefronts,
} from "../../storefronts/data.js";
import { fieldLabel } from "../../storefronts/model/listingFields.js";
import type { ChannelRow } from "../../../../api.js";
import type { ChannelTabProps } from "./channelTabs.js";

/** The store channels that have a listing column (the Worker's `LISTING_STORES`). */
const LISTING_CHANNELS: ReadonlySet<string> = new Set([
  "app-store",
  "google-play",
  "microsoft-store",
  "steam",
  "flathub",
  "snap",
  "winget",
  "fdroid",
  "polaris-key",
]);

/** The Listing tab shows for a channel that has a listing of its own. */
export const hasListing = (channel: ChannelRow): boolean =>
  LISTING_CHANNELS.has(channel.id);

type Cell = ListingFitResponse["stores"][number]["cells"][number];
type Locale = ListingResponse["locales"][number];

export interface ListingFact {
  key: string;
  label: string;
  /** Empty when the store takes it but it is not written, or is set in the store. */
  value: string;
  plane: Cell["plane"];
  present: boolean;
  overridden: boolean;
  issues: string[];
}

const asText = (v: unknown): string =>
  Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "";

/** The shared value for a model field in the default locale. */
function modelValue(data: ListingResponse, from: string): string {
  const app = data.listing?.app;
  const locale = data.locales.find((l) => l.locale === app?.defaultLocale) as
    | Locale
    | undefined;
  if (from.startsWith("urls."))
    return asText(app?.urls?.[from.slice("urls.".length)]);
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
          .map(issueLine),
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

export function ChannelListing({
  slug,
  channel,
}: ChannelTabProps): React.ReactElement {
  const listing = useListing(slug);
  const fit = useListingFit(slug);
  const stores = useStorefronts(slug);
  const q = [listing, fit, stores].find((x) => x.isError);
  if (listing.isPending || fit.isPending || stores.isPending)
    return <Skeleton className="h-64 w-full" />;
  if (q)
    return (
      <ErrorState
        error={q.error}
        context={{ area: "distribution", thing: "Listing" }}
        onRetry={() => void q.refetch()}
      />
    );
  const column = stores.data?.stores.find(
    (s) => s.id === channel.id,
  )?.listingStore;
  const row = column ? fit.data?.stores.find((s) => s.store === column) : null;
  if (!fit.data?.exists || !listing.data?.listing || !row)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="No listing yet"
        description="Write it in Settings → Presentation → Listing."
        primaryAction={
          <EditListingLink slug={slug} store={channel.id} variant="outline" />
        }
      />
    );
  const facts = listingFacts(listing.data, row);
  const dl = listing.data.listing.app.defaultLocale;
  const status = row.issues.length ? `${row.issues.length} to review` : "Fits";
  return (
    <Section
      title="Listing"
      description={`What ${channel.label} takes, in ${humanLocale(dl)}. ${status}.`}
      actions={
        <EditListingLink
          slug={slug}
          store={channel.id}
          label={`Edit ${channel.label} listing`}
        />
      }
    >
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
                <Value
                  text={f.value}
                  clamp={
                    f.label === "Description" || f.label === "Full description"
                  }
                />
              ) : (
                <p className="text-sm text-fg-muted">Not written yet</p>
              )}
              {f.issues.map((i) => (
                <p key={i} className="mt-1 text-sm text-warning">
                  {i}
                </p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
