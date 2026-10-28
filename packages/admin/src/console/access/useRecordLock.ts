import type { PageAction } from "../../ui/PageHeader.js";
import { useWriteGate } from "./useCan.js";
import type { AreaId } from "./can.js";

/**
 * A record page for a view-only member (P5): `lock` is the `WriteLock` props for its write
 * controls, and `writes` puts the permission reason on each of the header's write actions (a
 * read action, "View in activity", stays out of it). The permission is the reason that matters
 * to this member, so it comes before the action's own ("A yanked release can't be promoted").
 */
export function useRecordLock(area: AreaId, slug: string) {
  const gate = useWriteGate(area, slug);
  return {
    gate,
    lock: { locked: !gate.allowed, reason: gate.disabledReason },
    writes: (items: PageAction[]): PageAction[] =>
      gate.disabledReason
        ? items.map((i) => ({ ...i, disabledReason: gate.disabledReason }))
        : items,
  };
}
