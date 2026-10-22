import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { api } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { EntityLink } from "../../../components/EntityLink.js";
import { qk } from "../../../data/queries.js";
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

export interface Removal {
  key: string;
  values: unknown[];
  holders: ValueHolder[];
  /** Holders beyond the read cap, not looked at. */
  unread: number;
}

/**
 * The draft's removed allowed values and who still holds each: profiles, licenses and accounts that
 * set the key to a value the draft no longer allows. `pending` is true while that is still being
 * read, so Review waits instead of passing on a guess.
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
  const usage = useCatalogUsage(slug, keys);

  type Ref = { kind: ValueHolder["kind"]; id: string; label: string };
  const refs = React.useMemo(() => {
    const out = new Map<string, Ref[]>();
    for (const t of targets) {
      const u = usage.data?.keys[t.key];
      if (!u) continue;
      out.set(t.key, [
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
  }, [targets, usage.data]);

  // One read per distinct holder (a profile or account may set several removed keys).
  const distinct = React.useMemo(() => {
    const seen = new Map<string, Ref>();
    for (const list of refs.values())
      for (const r of list.slice(0, READ_CAP)) seen.set(`${r.kind}:${r.id}`, r);
    return [...seen.values()];
  }, [refs]);
  const reads = useQueries({
    queries: distinct.map((r) => ({
      queryKey:
        r.kind === "profile"
          ? qk.profile(slug, r.id)
          : r.kind === "license"
            ? qk.license(slug, r.id)
            : qk.userOverrides(slug, r.id),
      queryFn: async (): Promise<Record<string, { value?: unknown }>> =>
        r.kind === "profile"
          ? (await api.profile(slug, r.id)).payload.config
          : r.kind === "license"
            ? (await api.license(slug, r.id)).overrides.config
            : (await api.productUserOverrides(slug, r.id)).overrides.config,
    })),
  });
  const pending =
    (keys.length > 0 && usage.isPending) || reads.some((q) => q.isPending);

  const removals: Record<string, Removal> = {};
  for (const t of targets) {
    const list = refs.get(t.key) ?? [];
    const holders: ValueHolder[] = [];
    for (const r of list.slice(0, READ_CAP)) {
      const i = distinct.findIndex((d) => d.kind === r.kind && d.id === r.id);
      const entry = reads[i]?.data?.[t.key];
      if (entry && holdsRemoved(entry.value, t.values))
        holders.push({ ...r, value: entry.value });
    }
    removals[t.key] = {
      ...t,
      holders,
      unread: Math.max(0, list.length - READ_CAP),
    };
  }
  return { removals, pending };
}

/** The keys whose removed values someone still holds: Review waits while this is non-empty. */
export const blockedKeys = (removals: Record<string, Removal>): string[] =>
  Object.values(removals)
    .filter((r) => r.holders.length > 0)
    .map((r) => r.key);

/** The removed chips (dashed, struck, with Undo) and, under them, who is left on a removed value. */
export function RemovedValues({
  slug,
  removal,
  describedBy,
  onUndo,
}: {
  slug: string;
  removal: Removal | undefined;
  describedBy: string;
  onUndo: (value: unknown) => void;
}): React.ReactElement | null {
  if (!removal) return null;
  return (
    <div className="space-y-3" data-removed-values>
      <ul className="flex flex-wrap gap-2" aria-label="Removed values">
        {removal.values.map((v) => (
          <li
            key={valueText(v)}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-strong px-2 py-0.5 font-mono text-xs text-fg-muted"
          >
            <s>{valueText(v)}</s>
            <span className="sr-only"> (removed)</span>
            <Button
              size="xs"
              variant="ghost"
              iconStart={<RotateCcw aria-hidden />}
              onClick={() => onUndo(v)}
            >
              Undo
              <span className="sr-only"> removing {valueText(v)}</span>
            </Button>
          </li>
        ))}
      </ul>
      {removal.holders.length > 0 ? (
        <Callout
          tone="warning"
          live
          title={`${removal.values.map(valueText).join(", ")} ${removal.values.length === 1 ? "is" : "are"} still in use`}
        >
          <p id={describedBy}>
            Change these to an allowed value first; Review waits until none
            holds a removed one. Nothing changes until you publish.
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
      ) : null}
    </div>
  );
}
