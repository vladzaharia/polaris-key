import * as React from "react";
import { Button } from "../../../../ui/Button.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";

/** "Edit listing": the way in to Settings → Presentation → Listing for a Ship-builds-only member. */
export function EditListingLink({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to={r.listing(slug)}>Edit listing</Link>
    </Button>
  );
}
