/** The Licenses page's footer while more pages wait (P0-29). */

import * as React from "react";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { Button } from "../../../../ui/Button.js";

export function LoadMoreLicenses({
  query,
}: {
  query: Pick<
    UseInfiniteQueryResult,
    "hasNextPage" | "isFetchingNextPage" | "fetchNextPage"
  >;
}): React.ReactElement | null {
  if (!query.hasNextPage) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-xs text-fg-muted">
        Search, filters and sorting cover the loaded licenses.
      </p>
      <Button
        variant="outline"
        size="sm"
        loading={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
      >
        Load more
      </Button>
    </div>
  );
}
