import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import { Callout } from "../../../../ui/Callout.js";
import { EntityLink } from "../../../components/EntityLink.js";
import { holderQuery } from "../data.js";
import { draftEntries, type CatalogDraft } from "../model/catalogDraft.js";
import {
  holdsRemoved,
  removedValues,
  valueText,
  type ValueHolder,
} from "../model/valueUse.js";
import { useCatalogUsage } from "../data.js";

/** Reading each holder's value stops here; the rest are named as "and more". */
const READ_CAP = 25;

export interface KeyHolders {
  /** Everyone who sets the key, from the usage read. */
  total: number;
  /** Those read, with the value each sets. */
  holders: ValueHolder[];
  /** Setters beyond the read cap, not looked at (the counts per value are then partial). */
  unread: number;
}

/**
 * Who sets each of `keys` and to what: profiles, licenses and accounts, read from the usage read
 * and each one's own record (one shape per query key). `pending` is true while that is still being
 * read, so a gate waits instead of passing on a guess.
 */
export function useHolders(
  slug: string,
  keys: readonly string[],
): { byKey: Record<string, KeyHolders>; pending: boolean } {
  const usage = useCatalogUsage(slug, keys);

  type Ref = { kind: ValueHolder["kind"]; id: string; label: string };
  const refs = React.useMemo(() => {
    const out = new Map<string, Ref[]>();
    for (const key of keys) {
      const u = usage.data?.keys[key];
      if (!u) continue;
      out.set(key, [
        ...u.profiles.map((p) => ({
          kind: "profile" as const,
          id: p.id,
          label: p.name || p.id,
        })),
        ...u.licenses.map((l) => ({
          kind: "license" as const,
          id: l.id,
          label: l.name || l.email || l.id,
        })),
        ...(u.accounts ?? []).map((a) => ({
          kind: "account" as const,
          id: a.subject,
          label: a.subject,
        })),
      ]);
    }
    return out;
  }, [keys, usage.data]);

  // One read per distinct holder (a profile or account may set several keys).
  const distinct = React.useMemo(() => {
    const seen = new Map<string, Ref>();
    for (const list of refs.values())
      for (const r of list.slice(0, READ_CAP)) seen.set(`${r.kind}:${r.id}`, r);
    return [...seen.values()];
  }, [refs]);
  const reads = useQueries({
    queries: distinct.map((r) => ({
      // The key's cache holds the whole record (one shape per key); the config is read from it.
      ...holderQuery(slug, r.kind, r.id),
      select: (data: unknown): Record<string, { value?: unknown }> => {
        const d = data as {
          payload?: { config: Record<string, { value?: unknown }> };
          overrides?: { config: Record<string, { value?: unknown }> };
        };
        return d.payload?.config ?? d.overrides?.config ?? {};
      },
    })),
  });
  const pending =
    (keys.length > 0 && usage.isPending) || reads.some((q) => q.isPending);

  const byKey: Record<string, KeyHolders> = {};
  for (const key of keys) {
    const list = refs.get(key) ?? [];
    const holders: ValueHolder[] = [];
    for (const r of list.slice(0, READ_CAP)) {
      const i = distinct.findIndex((d) => d.kind === r.kind && d.id === r.id);
      const entry = reads[i]?.data?.[key];
      if (entry) holders.push({ ...r, value: entry.value });
    }
    byKey[key] = {
      total: list.length,
      holders,
      unread: Math.max(0, list.length - READ_CAP),
    };
  }
  return { byKey, pending };
}

export interface Removal {
  key: string;
  values: unknown[];
  holders: ValueHolder[];
  /** Holders beyond the read cap, not looked at. */
  unread: number;
}

/**
 * The draft's removed allowed values and who still holds each: profiles, licenses and accounts that
 * set the key to a value the draft no longer allows.
 */
export function useRemovals(
  slug: string,
  draft: CatalogDraft,
): { removals: Record<string, Removal>; pending: boolean } {
  const base = React.useMemo(
    () => new Map(draft.baseEntries.map((e) => [e.key, e])),
    [draft.baseEntries],
  );
  const targets = React.useMemo(() => {
    const out: { key: string; values: unknown[] }[] = [];
    for (const e of draftEntries(draft)) {
      const values = removedValues(base.get(e.key), e);
      if (values.length) out.push({ key: e.key, values });
    }
    return out;
  }, [draft, base]);
  const keys = React.useMemo(() => targets.map((t) => t.key), [targets]);
  const { byKey, pending } = useHolders(slug, keys);
  const removals: Record<string, Removal> = {};
  for (const t of targets) {
    const k = byKey[t.key];
    removals[t.key] = {
      ...t,
      holders: (k?.holders ?? []).filter((h) =>
        holdsRemoved(h.value, t.values),
      ),
      unread: k?.unread ?? 0,
    };
  }
  return { removals, pending };
}

/** The keys whose removed values someone still holds: Review waits while this is non-empty. */
export const blockedKeys = (removals: Record<string, Removal>): string[] =>
  Object.values(removals)
    .filter((r) => r.holders.length > 0)
    .map((r) => r.key);

/** Under the allowed values: who is left on a removed value (the chips themselves are in the row). */
export function RemovalWarning({
  slug,
  removal,
  describedBy,
}: {
  slug: string;
  removal: Removal | undefined;
  describedBy: string;
}): React.ReactElement | null {
  if (!removal || removal.holders.length === 0) return null;
  return (
    <Callout
      tone="warning"
      live
      title={`${removal.values.map(valueText).join(", ")} ${removal.values.length === 1 ? "is" : "are"} still in use`}
    >
      <p id={describedBy}>
        Change these to an allowed value first; Review waits until none holds a
        removed one. Nothing changes until you publish.
      </p>
      <ul className="mt-2 space-y-1">
        {removal.holders.map((h) => (
          <li key={`${h.kind}:${h.id}`} className="text-sm">
            <EntityLink
              slug={slug}
              kind={h.kind === "account" ? "user" : h.kind}
              id={h.id}
              label={h.label}
            />{" "}
            <span className="text-fg-muted">
              {h.kind === "profile"
                ? "profile"
                : h.kind === "license"
                  ? "license"
                  : "account"}{" "}
              sets{" "}
            </span>
            <code className="font-mono text-xs">{valueText(h.value)}</code>
          </li>
        ))}
        {removal.unread > 0 ? (
          <li className="text-sm text-fg-muted">
            and {removal.unread} more not checked
          </li>
        ) : null}
      </ul>
    </Callout>
  );
}
