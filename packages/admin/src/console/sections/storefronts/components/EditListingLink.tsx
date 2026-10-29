import * as React from "react";
import { Button } from "../../../../ui/Button.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";

/**
 * "Edit listing": the way in to Settings → Presentation → Listing for a Ship-builds-only member.
 * With `store` it lands on that storefront's view of the listing.
 */
export function EditListingLink({
  slug,
  store,
  variant = "ghost",
  label = "Edit listing",
}: {
  slug: string;
  store?: string;
  variant?: "ghost" | "outline";
  label?: string;
}): React.ReactElement {
  return (
    <Button asChild variant={variant} size="sm">
      <Link to={r.listing(slug, store ? { store } : undefined)}>{label}</Link>
    </Button>
  );
}
