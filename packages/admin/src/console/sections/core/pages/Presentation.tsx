/**
 * Settings → Presentation (HA-06; notes/S-20 §6.3, owner decision 11; products.settings-presentation).
 *
 * "What customers see": the product icon and the art, each with where it comes from (the
 * manifest or an upload), its status, size and dimensions, and only the actions that apply, beside
 * a live preview of the sign-in card, the Library tile and the Discover card. Below: the rest of
 * the listing (icon, screenshots), any other hosted slot, and Hosting and quotas.
 *
 *   - Upload / Replace: the file goes to `POST …/assets/<slot>` and CLAIMS the slot: a resync and
 *     a CI push leave it alone until Revert. A refusal stays inline at the row.
 *   - Revert to manifest: a claimed slot whose source the manifest names goes back to it.
 *   - Delete copy: drops Polaris Key's copy at once (the image host stops serving it).
 *
 * Name, Accent and Description sit under the art (A-27.12): the base every channel's listing starts
 * from, each with its source (`PresentationBaseRows`). The wordmark has no hosted slot yet.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import { Callout } from "../../../../ui/Callout.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { qk } from "../../../data/queries.js";
import { useProduct } from "../../../data/hooks.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { HostingRows } from "../components/PresentationHosting.js";
import { PresentationBaseRows } from "../components/PresentationBaseRows.js";
import { PresentationPreview } from "../components/PresentationPreview.js";
import { PresentationSlotRow } from "../components/PresentationSlotRow.js";
import { fetchHostedAssets, layout } from "../model/presentationSlots.js";

export {
  binaryBytes,
  fetchHostedAssets,
  reasonWords,
  slotCap,
  slotLabel,
  sourceWords,
  statusOf,
  UPLOAD_ACCEPT,
} from "../model/presentationSlots.js";

export function PresentationPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const assets = useQuery({
    queryKey: qk.hostedAssets(slug),
    queryFn: () => fetchHostedAssets(slug),
  });
  const usage = useQuery({
    queryKey: qk.assetUsage(slug),
    queryFn: () => api.assetUsage(slug),
  });
  const product = useProduct(slug);
  useLoadingAnnouncement("presentation", assets.isPending);
  if (assets.isPending)
    return <PageSkeleton template="form" label="presentation" />;
  if (assets.isError)
    return (
      <ErrorState error={assets.error} onRetry={() => void assets.refetch()} />
    );
  const rows = assets.data;
  const byKey = new Map(rows.map((r) => [`${r.slot}@${r.locale}`, r]));
  const { presentation, listing, other } = layout(rows);
  const slotRow = (slot: string) => (
    <PresentationSlotRow
      key={slot}
      slug={slug}
      slot={slot}
      locale=""
      asset={byKey.get(`${slot}@`) ?? null}
      quotaFull={usage.data?.media.full}
    />
  );
  const [heroSlot, ...listingRest] = [
    listing.find((s) => s === "listing.header")!,
    ...listing.filter((s) => s !== "listing.header"),
  ];
  const heroUrl = byKey.get(`${heroSlot}@`)?.previewUrl ?? null;
  return (
    <div className="space-y-6" data-template="presentation">
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <SettingsSection
            id="presentation-customers"
            title="What customers see"
            description="Polaris Key hosts a copy of each file and serves it from its image host; your original is unchanged."
          >
            {usage.data?.media.full ? (
              <div id="presentation-quota-full" className="px-5 py-4">
                <Callout tone="warning" title="Image quota full">
                  Uploads and replacements are off until space is freed. See{" "}
                  <a
                    href="#presentation-hosting"
                    className="py-1 text-accent-fg underline underline-offset-2"
                    onClick={(e) => {
                      e.preventDefault();
                      const to = document.getElementById(
                        "presentation-hosting",
                      );
                      to?.scrollIntoView({ block: "start" });
                      to?.focus();
                    }}
                  >
                    Hosting and quotas
                  </a>
                  .
                </Callout>
              </div>
            ) : null}
            {presentation.map(slotRow)}
            {slotRow(heroSlot!)}
          </SettingsSection>
          <PresentationBaseRows slug={slug} />
          <SettingsSection id="presentation-listing" title="Listing images">
            {listingRest.map(slotRow)}
          </SettingsSection>
          {other.length ? (
            <SettingsSection id="presentation-other" title="Other slots">
              {other.map((a) => (
                <PresentationSlotRow
                  key={`${a.slot}@${a.locale}`}
                  slug={slug}
                  slot={a.slot}
                  locale={a.locale}
                  asset={a}
                  quotaFull={usage.data?.media.full}
                />
              ))}
            </SettingsSection>
          ) : null}
        </div>
        <PresentationPreview
          name={product.data?.name ?? slug}
          presentation={product.data?.presentation}
          heroUrl={heroUrl}
        />
      </div>
      <SettingsSection
        id="presentation-hosting"
        title="Hosting and quotas"
        description="What Polaris Key holds for this product, against its quotas. Each file counts once, however many slots use it."
      >
        {usage.isPending ? (
          <div className="px-5 py-4">
            <PageSkeleton template="form" label="hosting and quotas" />
          </div>
        ) : usage.isError || !usage.data ? (
          <div className="px-5 py-4">
            <ErrorState
              error={usage.error}
              onRetry={() => void usage.refetch()}
            />
          </div>
        ) : (
          <HostingRows slug={slug} usage={usage.data} />
        )}
      </SettingsSection>
    </div>
  );
}
