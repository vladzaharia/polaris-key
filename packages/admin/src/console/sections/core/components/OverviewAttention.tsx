import * as React from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { LoadFailedCard } from "../../global/components/HomeStates.js";

/**
 * Overview's attention read. The items are the hero's next step (the first) and its "+N more"; the
 * only thing this draws is Home's load-failed card with Try again when the read failed.
 */
export function OverviewAttention({
  read,
}: {
  read: UseQueryResult<unknown>;
}): React.ReactElement | null {
  if (!read.isError) return null;
  return (
    <LoadFailedCard
      title="Needs attention"
      message="What needs attention didn't load."
      onRetry={() => void read.refetch()}
    />
  );
}
