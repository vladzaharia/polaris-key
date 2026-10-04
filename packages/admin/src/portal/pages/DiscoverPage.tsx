import * as React from "react";
import { Button } from "../../ui/Button.js";
import { StationaryStar } from "../../ui/EmptyState.js";
import { href, useDocumentTitle } from "../router.js";

/**
 * Discover (PORTAL.md §4.16). The Worker cannot list offers yet (G24, PX-W10), so Discover is
 * hidden from the nav and a typed `#/discover` shows the honest empty state.
 */
export function DiscoverPage(): React.ReactElement {
  useDocumentTitle("Discover");
  return (
    <section className="flex flex-col items-center gap-4 py-16 text-center">
      <StationaryStar />
      <h1 className="text-3xl font-bold text-fg-strong">
        Nothing to add right now
      </h1>
      <p className="max-w-prose text-fg-muted">
        When a developer offers something to your account, like a free game, a
        beta or an app your team gets, it appears here.
      </p>
      <Button asChild variant="outline">
        <a href={href.library()}>Back to your library</a>
      </Button>
    </section>
  );
}
