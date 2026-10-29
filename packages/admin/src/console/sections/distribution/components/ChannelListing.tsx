/**
 * A channel's Listing tab (A-22.5): the listing this store gets, read-only. The shared listing's
 * fields in its default locale, with this store's overrides applied and marked. Editing is on
 * Settings → Presentation → Listing, one link away. Listing text is data, shown escaped.
 */

import * as React from "react";
import type { ListingResponse } from "../../../../api.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Section } from "../../../../ui/Section.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useListing } from "../../storefronts/data.js";
import { EditListingLink } from "../../storefronts/components/EditListingLink.js";
import { fieldLabel } from "../../storefronts/model/listingFields.js";
import type { ChannelTabProps } from "./channelTabs.js";

/** The listing column a channel is projected to; a channel not listed has no store listing. */
const COLUMN: Readonly<Record<string, string>> = {
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

const APP_FIELDS = [
  "name",
  "developerName",
  "category",
  "contactEmail",
  "copyright",
] as const;
const TEXT_FIELDS = [
  "name",
  "subtitle",
  "shortDescription",
  "description",
  "keywords",
  "features",
  "promotionalText",
] as const;

export interface ListingFact {
  field: string;
  label: string;
  value: string;
  overridden: boolean;
}

const asText = (v: string | string[]): string =>
  Array.isArray(v) ? v.join(", ") : v;

/** The facts the API serves for one store column: the shared values, overrides on top. */
export function listingFacts(
  data: ListingResponse,
  column: string,
): ListingFact[] {
  const app = data.listing?.app;
  const locale = data.locales.find((l) => l.locale === app?.defaultLocale);
  const over = (field: string) =>
    data.overrides.find(
      (o) =>
        o.store === column &&
        o.field === field &&
        (o.locale === null || o.locale === app?.defaultLocale),
    );
  const out: ListingFact[] = [];
  for (const f of TEXT_FIELDS) {
    const o = over(f);
    const shared =
      (locale as Record<string, unknown> | undefined)?.[f] ??
      (f === "name" ? app?.name : undefined);
    const raw = o ? o.value : (shared as string | string[] | undefined);
    const value = raw === undefined ? "" : asText(raw);
    if (value)
      out.push({ field: f, label: fieldLabel(f), value, overridden: !!o });
  }
  for (const f of APP_FIELDS) {
    if (f === "name") continue;
    const v = app?.[f];
    if (v)
      out.push({ field: f, label: fieldLabel(f), value: v, overridden: false });
  }
  return out;
}

export function ChannelListing({
  slug,
  channel,
}: ChannelTabProps): React.ReactElement {
  const column = COLUMN[channel.id];
  const q = useListing(slug);
  const empty = (title: string, description: string) => (
    <EmptyState
      kind="first-run"
      headingLevel={2}
      title={title}
      description={description}
      primaryAction={<EditListingLink slug={slug} />}
    />
  );
  if (!column)
    return empty(
      `${channel.label} has no store listing`,
      "The shared listing is edited in Settings.",
    );
  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError)
    return (
      <ErrorState
        error={q.error}
        context={{ area: "distribution", thing: "Listing" }}
        onRetry={() => void q.refetch()}
      />
    );
  const facts = listingFacts(q.data, column);
  if (facts.length === 0)
    return empty(
      "No listing yet",
      `${channel.label} has nothing to show until the listing is written.`,
    );
  return (
    <Section
      title="Listing"
      description={`What ${channel.label} gets, in ${q.data.listing?.app.defaultLocale ?? "the default locale"}.`}
      actions={<EditListingLink slug={slug} />}
    >
      <DescriptionList
        rows
        items={facts.map((f) => ({
          term: f.label,
          detail: (
            <span className="whitespace-pre-wrap break-words">{f.value}</span>
          ),
          help: f.overridden ? "Override for this store." : undefined,
        }))}
      />
    </Section>
  );
}
