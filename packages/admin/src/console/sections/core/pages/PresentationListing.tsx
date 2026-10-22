/**
 * Settings → Presentation → Listing (A-27.11, D11): the store listing's home. The page is the
 * listing editor (`components/listing/ListingEditor.tsx`) for the whole product, or for one
 * channel's store when the store switcher names it (`?store=`, a storefront id). The switcher is
 * a route parameter, so a link from a store's page lands on that store's view.
 */

import * as React from "react";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { Select } from "../../../../ui/Select.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useProductServices } from "../../../data/hooks.js";
import { useSearchParam } from "../../../router.js";
import { codecs } from "../../../routes.js";
import { useStorefronts } from "../../storefronts/data.js";
import { ListingEditor } from "../components/listing/ListingEditor.js";

const storeCodec = codecs.string("");
const ALL = "all";

export function PresentationListingPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const services = useProductServices(slug);
  const [param, setParam] = useSearchParam("store", storeCodec);
  const stores = useStorefronts(slug);
  if (services && services.distribution?.enabled === false)
    return (
      <EmptyState
        kind="service-off"
        headingLevel={2}
        service="distribution"
        title="Distribution is off for this product."
        description="Turn it on in Features to edit the store listing."
      />
    );
  if (stores.isPending) return <Skeleton className="h-64 w-full" />;
  if (stores.isError)
    return (
      <ErrorState
        error={stores.error}
        onRetry={() => void stores.refetch()}
        context={{ area: "distribution", thing: "Storefronts" }}
      />
    );
  // A store with a listing column. The param names its id (or its column, as older links did).
  const choices = stores.data.stores.filter((s) => s.listingStore !== null);
  const chosen = choices.find(
    (s) => s.id === param || s.listingStore === param,
  );
  return (
    <div className="space-y-6" data-template="record">
      {choices.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <label
            htmlFor={`listing-store-${slug}`}
            className="text-sm font-medium text-fg-strong"
          >
            Store
          </label>
          <Select
            id={`listing-store-${slug}`}
            value={chosen?.id ?? ALL}
            options={[
              { value: ALL, label: "Every channel" },
              ...choices.map((s) => ({ value: s.id, label: s.label })),
            ]}
            onChange={(v) => setParam(!v || v === ALL ? "" : v)}
          />
        </div>
      ) : null}
      {chosen ? (
        <ListingEditor slug={slug} store={chosen.id} />
      ) : (
        <ListingEditor slug={slug} />
      )}
    </div>
  );
}
