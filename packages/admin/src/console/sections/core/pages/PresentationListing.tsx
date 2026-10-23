/**
 * Settings → Presentation → Listing (A-27.11, D11): the store listing's home. The page is the
 * listing editor (`components/listing/ListingEditor.tsx`) for the whole product, or for one
 * storefront when the switcher in its header names it (`?store=`, a storefront id). The
 * switcher is a route parameter, so a link from a storefront's page lands on that view.
 */

import * as React from "react";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { Select } from "../../../../ui/Select.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useProduct, useProductServices } from "../../../data/hooks.js";
import { Link, useSearchParam } from "../../../router.js";
import { codecs, productPage, r } from "../../../routes.js";
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
  const product = useProduct(slug);
  const [param, setParam] = useSearchParam("store", storeCodec);
  const stores = useStorefronts(slug);
  if (services && services.distribution?.enabled === false)
    return (
      <EmptyState
        kind="service-off"
        headingLevel={2}
        service="distribution"
        title={`Ship builds is off for ${product.data?.name ?? slug}`}
        description="Turn on Ship builds in Features to edit the store listing."
        primaryAction={
          <Button asChild>
            <Link to={r.services(slug)}>Open Features</Link>
          </Button>
        }
      />
    );
  // A storefront with a listing column. The param names its id (or its column, as older links did).
  const choices = stores.data?.stores.filter((s) => s.listingStore !== null);
  const chosen = choices?.find(
    (s) => s.id === param || s.listingStore === param,
  );
  const switcher = stores.isPending ? (
    <Skeleton className="h-9 w-full sm:w-64" />
  ) : choices && choices.length > 0 ? (
    <Select
      aria-label="Storefront"
      className="w-full sm:w-64"
      value={chosen?.id ?? ALL}
      options={[
        { value: ALL, label: "Every storefront" },
        ...choices.map((s) => ({ value: s.id, label: s.label })),
      ]}
      onChange={(v) => setParam(!v || v === ALL ? "" : v)}
    />
  ) : undefined;
  const notice = stores.isError ? (
    <Callout tone="warning" title="Couldn't load storefronts">
      Showing the shared listing.{" "}
      <Button size="xs" variant="outline" onClick={() => void stores.refetch()}>
        Try again
      </Button>
    </Callout>
  ) : undefined;
  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-fg-muted">
        <Link
          to={productPage(slug, "presentation")}
          className="rounded-xs py-1 underline-offset-4 hover:underline"
        >
          Presentation
        </Link>
        <span aria-hidden> › </span>
        <span>Listing</span>
      </nav>
      <ListingEditor
        slug={slug}
        {...(chosen ? { store: chosen.id } : {})}
        toolbar={switcher}
        notice={notice}
      />
    </div>
  );
}
