import * as React from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  AttentionList,
  type AttentionItem,
} from "../../../templates/Dashboard.js";
import { LoadFailedCard } from "../../global/components/HomeStates.js";

/** Overview's Needs attention slot: the list, or Home's load-failed card with Try again. */
export function OverviewAttention({
  read,
  items,
  stagger,
}: {
  read: UseQueryResult<unknown>;
  items: AttentionItem[];
  stagger: string | undefined;
}): React.ReactElement | null {
  if (read.isError)
    return (
      <LoadFailedCard
        title="Needs attention"
        message="What needs attention didn't load."
        onRetry={() => void read.refetch()}
      />
    );
  return read.isPending ? null : (
    <AttentionList items={items} stagger={stagger} />
  );
}
