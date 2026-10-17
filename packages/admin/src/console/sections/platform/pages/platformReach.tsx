/**
 * What a platform default or bound reaches (ST-16). In the confirm dialog of a change: how many
 * products it reaches, counted when the dialog opens. On the row of a bound: the products it
 * clamps today, each with the value it set and the one in effect. A platform write never
 * rewrites a product row; a clamped product keeps what it set.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type PlatformReach,
  type PlatformSetting,
} from "../../../../api.js";
import { Callout } from "../../../../ui/Callout.js";
import { qk } from "../../../data/queries.js";
import { formatPlatformValue } from "./platformSettingRow.js";

const plural = (n: number): string => (n === 1 ? "product" : "products");

function clampedList(
  setting: PlatformSetting,
  reach: PlatformReach,
): React.ReactElement {
  return (
    <ul className="mt-1 space-y-0.5">
      {reach.clamped.map((c) => (
        <li key={c.product}>
          <code className="font-mono text-xs">{c.product}</code> set{" "}
          {formatPlatformValue(setting, c.set)}, in effect{" "}
          {formatPlatformValue(setting, c.effective)}
        </li>
      ))}
      {reach.reaches > reach.clamped.length ? (
        <li>and {reach.reaches - reach.clamped.length} more</li>
      ) : null}
    </ul>
  );
}

function useReach(key: string, value?: number, fresh = false) {
  return useQuery({
    queryKey: qk.platformReach(key, value),
    queryFn: () => api.platformSettingReach(key, value),
    ...(fresh ? { gcTime: 0 } : {}),
  });
}

/** The count inside the confirm dialog, for a change to `to`. */
export function ReachCount({
  setting,
  to,
}: {
  setting: PlatformSetting;
  to: unknown;
}): React.ReactElement {
  const value = typeof to === "number" ? to : undefined;
  const q = useReach(setting.key, value, true);
  const r = q.data;
  let body: React.ReactNode;
  if (q.isPending) body = "Counting products…";
  else if (!r) body = "Couldn't count the products. Try again later.";
  else if (r.kind === "bound")
    body =
      r.reaches === 0 ? (
        "No product is above it."
      ) : (
        <>
          Clamps {r.reaches} of {r.total} {plural(r.total)} to{" "}
          {formatPlatformValue(setting, to)}. Their own values stay.
          {clampedList(setting, r)}
        </>
      );
  else
    body =
      r.reaches === 0
        ? "No product inherits it."
        : `Reaches ${r.reaches} of ${r.total} ${plural(r.total)}. The rest set their own.`;
  return (
    <p
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-fg-strong"
    >
      {body}
    </p>
  );
}

/** The row's standing note: the products this bound clamps today. Nothing when none. */
export function ClampedNote({
  setting,
}: {
  setting: PlatformSetting;
}): React.ReactElement | null {
  const q = useReach(setting.key);
  const r = q.data;
  if (!r || r.kind !== "bound" || r.reaches === 0) return null;
  return (
    <Callout
      tone="info"
      title={`Clamped by Platform: ${r.reaches} of ${r.total} ${plural(r.total)}`}
    >
      Each keeps what it set; the lower value is in effect.
      {clampedList(setting, r)}
    </Callout>
  );
}
