/**
 * What a platform default or bound reaches (ST-16). Three places:
 *
 *  - the confirm dialog of a change or a revert (`useReachPlan`): the products whose effective
 *    value changes, named, with what each goes from and to. It leads the dialog, puts the count in
 *    the button, and holds Confirm until the count has resolved. A failed count keeps Confirm held
 *    and offers Try again: a change to every product is never confirmed blind.
 *  - the row's standing note (`FleetNote`): the products a ceiling clamps today, each with what it
 *    set and what is in effect. It comes with the settings list, so it is fresh after every write.
 *  - the row's muted line (`fleetMeta`): who uses a default.
 *
 * A platform write never rewrites a product row: it clamps, and reverting restores the product's
 * own value.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type PlatformFleet,
  type PlatformReach,
  type PlatformSetting,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import type { ConfirmPlan } from "../../../../ui/settings/useSettingWrite.js";
import { qk } from "../../../data/queries.js";
import { formatPlatformValue } from "./platformSettingRow.js";

const products = (n: number): string => (n === 1 ? "product" : "products");
const nameOf = (p: { name: string; product: string }): string =>
  p.name || p.product;
/** A name inside plain text, isolated so an RTL name cannot reorder the numbers around it. */
const isolated = (p: { name: string; product: string }): string =>
  `\u2068${nameOf(p)}\u2069`;

/** "all 14 products", "the product", "3 of 14 products". */
function countPhrase(n: number, total: number): string {
  if (total === 1) return "the product";
  if (n === total) return `all ${total} products`;
  return `${n} of ${total} ${products(total)}`;
}

/** "Lowers 4 of 14 products to 10", "Raises 3 of 14 products to their own values". */
export function reachLead(setting: PlatformSetting, r: PlatformReach): string {
  const verb = r.direction === "raise" ? "Raises" : "Lowers";
  const target =
    r.kind === "bound" && r.direction === "raise"
      ? r.reaches === 1
        ? "its own value"
        : "their own values"
      : formatPlatformValue(setting, r.to);
  return `${verb} ${countPhrase(r.reaches, r.total)} to ${target}`;
}

/** The button: "Lower 4 products to 10", "Raise the ceiling for 3 products". */
export function reachLabel(
  setting: PlatformSetting,
  r: PlatformReach,
  revert = false,
): string {
  const n = r.reaches;
  const who =
    r.total === 1
      ? "the product"
      : n === r.total
        ? `all ${n} products`
        : `${n} ${products(n)}`;
  if (revert) {
    return r.kind === "bound" && r.direction === "raise"
      ? `Revert: raise ${who}`
      : `Revert: ${r.direction} ${who} to ${formatPlatformValue(setting, r.to)}`;
  }
  if (r.kind === "bound" && r.direction === "raise")
    return `Raise the ceiling for ${who}`;
  return `${r.direction === "raise" ? "Raise" : "Lower"} ${who} to ${formatPlatformValue(setting, r.to)}`;
}

function ProductList({
  setting,
  r,
}: {
  setting: PlatformSetting;
  r: PlatformReach;
}): React.ReactElement {
  return (
    <ul className="mt-1 space-y-0.5 text-fg">
      {r.products.map((p) => (
        <li key={p.product} className="[overflow-wrap:anywhere]">
          <bdi className="font-medium text-fg-strong">{nameOf(p)}</bdi>:{" "}
          <span className="whitespace-nowrap">
            {formatPlatformValue(setting, p.from)} →{" "}
            {formatPlatformValue(setting, p.to)}
          </span>
          {p.inherited && r.kind === "bound" ? " (default)" : ""}
        </li>
      ))}
      {r.reaches > r.products.length ? (
        <li>and {r.reaches - r.products.length} more</li>
      ) : null}
    </ul>
  );
}

/**
 * The confirmation plan of a change (or revert) to `target.value`. A hook: the row calls it on
 * every render, and it fetches only while a confirmation is open.
 */
export function useReachPlan(
  setting: PlatformSetting,
  target: { value: unknown; revert: boolean } | null,
  propagationSeconds: number,
  tail: string,
): ConfirmPlan | undefined {
  const value = typeof target?.value === "number" ? target.value : undefined;
  // Try again keeps its frame: a refetch with no data resets the query to pending.
  const [retrying, setRetrying] = React.useState(false);
  const [retried, setRetried] = React.useState(false);
  const q = useQuery({
    queryKey: qk.platformReach(setting.key, value),
    queryFn: () => api.platformSettingReach(setting.key, value),
    enabled: target !== null && setting.link != null,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  React.useEffect(() => {
    if (!q.isFetching) setRetrying(false);
  }, [q.isFetching]);
  if (target === null || !setting.link) return undefined;
  const r = q.data;
  const line = `${tail} Takes effect within ${propagationSeconds} seconds.`;
  const frame = (children: React.ReactNode): React.ReactNode => (
    <div role="status" aria-live="polite" className="min-h-16 text-sm text-fg">
      {children}
    </div>
  );
  if (!r) {
    return q.isError || retrying
      ? {
          hold: true,
          consequences: [line],
          summary: frame(
            <>
              <p className="font-medium text-fg-strong">
                Couldn&apos;t count the products this reaches, so you can&apos;t
                save yet.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                loading={q.isFetching}
                onClick={() => {
                  setRetrying(true);
                  setRetried(true);
                  void q.refetch();
                }}
              >
                Try again
              </Button>
            </>,
          ),
        }
      : {
          hold: true,
          consequences: [line],
          summary: frame(<p>Counting products…</p>),
        };
  }
  if (r.reaches === 0)
    return {
      summary: frame(
        <p className="font-medium text-fg-strong">
          {r.total === 0 ? "There are no products yet." : "No product changes."}
        </p>,
      ),
      consequences: [line],
    };
  const others =
    r.kind === "default" && r.reaches < r.total
      ? `The ${r.total - r.reaches === 1 ? "other keeps its" : `other ${r.total - r.reaches} keep their`} own value.`
      : r.kind === "bound" &&
          r.direction === "lower" &&
          r.reaches > 1 &&
          r.products.every((p) => !p.inherited)
        ? "Each keeps the value it set."
        : null;
  // A lowered quota refuses new files to a product already over it.
  const lines =
    r.direction === "lower" && setting.key.startsWith("assets.quota.")
      ? [
          `${tail} A product over ${formatPlatformValue(setting, r.to)} can't add new ones until it's under. Takes effect within ${propagationSeconds} seconds.`,
        ]
      : [line];
  return {
    confirmLabel: reachLabel(setting, r, target.revert),
    summary: frame(
      <>
        <Lead focus={retried}>{reachLead(setting, r)}:</Lead>
        <ProductList setting={setting} r={r} />
        {others ? <p className="mt-2 text-fg-muted">{others}</p> : null}
      </>,
    ),
    consequences: lines,
  };
}

/** The lead line; after Try again it takes the focus the button leaves. */
function Lead({
  focus,
  children,
}: {
  focus: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = React.useRef<HTMLParagraphElement>(null);
  React.useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <p ref={ref} tabIndex={-1} className="font-medium text-fg-strong">
      {children}
    </p>
  );
}

/** The row's standing note: the products a ceiling clamps today. Nothing when none. */
export function FleetNote({
  setting,
}: {
  setting: PlatformSetting;
}): React.ReactElement | null {
  const f = setting.fleet;
  if (!f || f.kind !== "bound" || f.count === 0) return null;
  return (
    <Callout
      tone="info"
      title={`Clamped by Platform: ${f.count} of ${f.total} ${products(f.total)}`}
    >
      <ul className="space-y-0.5">
        {f.products.map((c) => (
          <li key={c.product} className="[overflow-wrap:anywhere]">
            <bdi className="font-medium text-fg-strong">{nameOf(c)}</bdi>{" "}
            {c.inherited ? "default" : "set"}{" "}
            {formatPlatformValue(setting, c.set)}, in effect{" "}
            {formatPlatformValue(setting, c.effective)}
          </li>
        ))}
        {f.count > f.products.length ? (
          <li>and {f.count - f.products.length} more</li>
        ) : null}
      </ul>
    </Callout>
  );
}

/** The muted line under a default row: "12 products use this · Acme sets 8 GiB". */
export function fleetMeta(setting: PlatformSetting): string | undefined {
  const f: PlatformFleet | undefined = setting.fleet;
  if (!f || f.kind !== "default" || f.total === 0) return undefined;
  const use =
    f.inheriting === 0
      ? "No product uses this"
      : f.inheriting === f.total && f.total === 1
        ? "The product uses this"
        : `${f.inheriting} of ${f.total} ${products(f.total)} use this`;
  const own = f.own.map(
    (o) => `${isolated(o)} sets ${formatPlatformValue(setting, o.value)}`,
  );
  return [use, ...own.slice(0, 2)].join(" · ");
}
