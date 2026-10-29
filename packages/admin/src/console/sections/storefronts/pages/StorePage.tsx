/**
 * A storefront's own page, by store id (`distribution/storefronts/<id>`): one line per store that
 * has one. The built-in Polaris Key storefront's panel is the only one (PS-06). Since A-22.6 the
 * panel lives on the store's channel page, Sales tab (`embedded`), and this address opens it there;
 * SETUP.md's per-store pages add theirs to `STORE_PANELS`.
 */

import * as React from "react";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Link, navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { PolarisKeyPanel } from "../components/PolarisKeyPanel.js";

export const STORE_PANELS: Readonly<
  Record<
    string,
    (props: { slug: string; embedded?: boolean }) => React.ReactElement
  >
> = {
  "polaris-key": PolarisKeyPanel,
};

/** `distribution/storefronts/<id>`: the store's own page, or not found. */
export function StorePage({
  slug,
  store,
}: {
  slug: string;
  store: string;
}): React.ReactElement {
  const hasPanel = Object.hasOwn(STORE_PANELS, store);
  // A-22.6: a store's own page is the Sales tab of its channel page.
  React.useEffect(() => {
    if (hasPanel) navigate(r.channel(slug, store, "sales"), { replace: true });
  }, [hasPanel, slug, store]);
  if (hasPanel) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="space-y-6" data-template="collection">
      <PageHeader title="Storefronts" />
      <EmptyState
        kind="not-found"
        headingLevel={2}
        title="This storefront has no page of its own"
        description="Storefronts with a connection are set up from Add to storefronts."
        primaryAction={
          <Button asChild>
            <Link to={r.storefronts(slug)}>Open Storefronts</Link>
          </Button>
        }
        docs={docsUrl("storefronts")}
      />
    </div>
  );
}
