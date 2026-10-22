import * as React from "react";

export const LIST_CAP = 5;

/** Show five rows, then five more per click; fetch the next page when the loaded ones run out. */
export function useListCap<T>(more: {
  items: T[];
  hasMore: boolean;
  loadMore: () => void;
}): { items: T[]; hasMore: boolean; loadMore: () => void } {
  const [shown, setShown] = React.useState(LIST_CAP);
  return {
    items: more.items.slice(0, shown),
    hasMore: more.items.length > shown || more.hasMore,
    loadMore: () => {
      const next = shown + LIST_CAP;
      setShown(next);
      if (more.items.length < next && more.hasMore) more.loadMore();
    },
  };
}
