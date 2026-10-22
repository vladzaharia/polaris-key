/**
 * Distribution → Listing (A-18j; notes/S-15 §8.2, T3): the shared listing model outside the flow.
 * The editor itself is `core/components/listing/ListingEditor.tsx` (A-27.10); this page renders it
 * for the whole product, with no store scope.
 */

import * as React from "react";
import { ListingEditor } from "../../core/components/listing/ListingEditor.js";

export { LISTING_TABS } from "../../core/components/listing/ListingEditor.js";

export function ListingPage({ slug }: { slug: string }): React.ReactElement {
  return <ListingEditor slug={slug} />;
}
