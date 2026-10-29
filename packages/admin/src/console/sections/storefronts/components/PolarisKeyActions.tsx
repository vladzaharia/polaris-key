import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../../../../ui/Button.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";

/**
 * The Polaris Locker page's actions: open it in Locker, and edit its listing. Embedded in the
 * channel's Sales tab (A-22.6) only the first stays: Readiness already links to the listing.
 */
export function PolarisKeyActions({
  slug,
  lockerPage,
  embedded,
}: {
  slug: string;
  lockerPage: string | null;
  embedded: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      {lockerPage ? (
        <Button variant="outline" asChild>
          <a href={lockerPage} target="_blank" rel="noreferrer">
            Open in Polaris Locker
            <ExternalLink aria-hidden />
            <span className="sr-only"> (opens a new tab)</span>
          </a>
        </Button>
      ) : null}
      {embedded ? null : (
        <Button variant="outline" asChild>
          <Link to={r.listing(slug, { tab: "fit", store: "polaris-key" })}>
            Edit the listing
          </Link>
        </Button>
      )}
    </div>
  );
}
