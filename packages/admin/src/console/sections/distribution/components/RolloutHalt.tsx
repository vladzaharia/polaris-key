/**
 * **Halt everywhere…** (UX-08, EXPERIENCE.md O2), split from `RolloutDialogs`:
 * it halts every rollout of one release in one L2
 * confirm. A rollout that cannot be halted here (already halted, complete, or a store's mirror) is
 * listed as a disabled row with the reason, never a checked box (EXPERIENCE.md §7.1). A store's
 * row says what to do in the store under its channel: halt the staged rollout in Google Play,
 * pause the phased release in App Store Connect (P0-47; copy only, A-24 halts them from here).
 * When every live rollout is a store's, the dialog still opens, with only the store rows and the
 * confirm disabled, so the operator learns where to stop each one.
 */

import * as React from "react";
import { Lock, Pause } from "lucide-react";
import type { MatrixRolloutDto, Rollout } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { formatBasisPoints } from "../../../../lib/format.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { ConfirmDialog, confirmBlocked } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { SOURCE_NAMES } from "../model/format.js";
import { allowedVerbs } from "./RolloutDialogs.js";

const describe = (e: unknown): { title: string; description?: string } =>
  errorCopy(e, { area: "distribution", thing: "Rollout" });

// ── Halt everywhere (UX-08) ──────────────────────────────────────────────────────────────────

/** One rollout of the release, with the outlet's display name ("Google Play"). */
export interface HaltRow {
  rollout: Rollout | MatrixRolloutDto;
  outletName: string;
}

const rowKey = (r: Pick<Rollout, "outletId" | "channel">): string =>
  `${r.outletId}/${r.channel}`;

/** True when this console may halt the rollout (the server's own transition table). */
export function canHalt(r: Rollout | MatrixRolloutDto): boolean {
  return allowedVerbs(r).includes("halt");
}

/** What stopping a mirrored rollout is called in its store's own console (P0-47). */
const STORE_HALT: Record<string, string> = {
  play: "Halt the staged rollout in Google Play",
  asc: "Pause the phased release in App Store Connect",
};

/**
 * What to do in the store for a live rollout this console cannot halt (a store's mirror), or null.
 * "Halt the staged rollout in Google Play", "Pause the phased release in App Store Connect".
 */
export function storeHalt(r: Rollout | MatrixRolloutDto): string | null {
  if (canHalt(r) || !r.mirrored) return null;
  if (r.state === "halted" || r.state === "complete") return null;
  return (
    STORE_HALT[r.source] ?? `Halt it in ${SOURCE_NAMES[r.source] ?? r.source}`
  );
}

/** Why a row is not offered: "Already halted", "Complete", or what to do in the store. */
export function haltBlocker(r: Rollout | MatrixRolloutDto): string | null {
  if (canHalt(r)) return null;
  if (r.state === "halted") return "Already halted";
  if (r.state === "complete") return "Complete";
  return storeHalt(r) ?? "Can't be halted";
}

/** The share a row shows on the right: "20 %", "5 % · paused". */
function rowShare(r: Rollout | MatrixRolloutDto): string {
  const pct = formatBasisPoints(r.rolloutBp);
  return r.state === "paused" ? `${pct} · paused` : pct;
}

/** Some of the halts were refused: the dialog stays open and names them. */
export class PartialHaltError extends Error {
  constructor(
    readonly halted: string[],
    readonly refused: { where: string; error: unknown }[],
  ) {
    super(`${refused.length} of ${halted.length + refused.length} not halted`);
  }
}

/**
 * **Halt everywhere…**: every haltable rollout of one release, preselected, in one danger
 * confirm. Each halt is the same `rolloutAction` the per-rollout dialog sends, one after the other;
 * a refusal leaves the dialog open with the outlets that were not halted, while the rest stay
 * halted (and become "Already halted" rows when the matrix refetches).
 */
export function HaltEverywhereDialog({
  slug,
  open,
  version,
  previous,
  rows,
  onClose,
}: {
  slug: string;
  open: boolean;
  version: string;
  /** The release devices fall back to, when there is one ("2.3.2"). */
  previous?: string | null;
  rows: HaltRow[];
  onClose: () => void;
}): React.ReactElement | null {
  if (!open) return null;
  return (
    <HaltEverywhereConfirm
      slug={slug}
      version={version}
      previous={previous ?? null}
      rows={rows}
      onClose={onClose}
    />
  );
}

function HaltEverywhereConfirm({
  slug,
  version,
  previous,
  rows,
  onClose,
}: {
  slug: string;
  version: string;
  previous: string | null;
  rows: HaltRow[];
  onClose: () => void;
}): React.ReactElement {
  // Opened with every haltable rollout chosen; rows the server refuses never enter the set.
  const [chosen, setChosen] = React.useState<Set<string>>(
    () =>
      new Set(
        rows.filter((r) => canHalt(r.rollout)).map((r) => rowKey(r.rollout)),
      ),
  );
  const targets = rows.filter(
    (r) => canHalt(r.rollout) && chosen.has(rowKey(r.rollout)),
  );
  const where = (r: HaltRow): string =>
    `${r.outletName} · ${r.rollout.channel}`;
  const n = targets.length;
  const inStores = rows.some((r) => storeHalt(r.rollout) !== null);
  // Every live rollout is a store's: nothing halts here, so the dialog only says where to.
  const storesOnly = inStores && !rows.some((r) => canHalt(r.rollout));
  const shown = storesOnly
    ? rows.filter((r) => storeHalt(r.rollout) !== null)
    : rows;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      intent="danger"
      title={
        storesOnly
          ? `Halt ${version} in its stores`
          : `Halt ${version} everywhere?`
      }
      description={
        storesOnly
          ? `No rollout of ${version} can be halted here. Stop each one in its store, as shown below.`
          : previous
            ? `Devices that haven't updated stay on ${previous}. Devices already on ${version} keep it.`
            : `Devices already on ${version} keep it.`
      }
      consequences={
        storesOnly
          ? []
          : [
              "Takes effect on each device's next feed check.",
              ...(inStores
                ? ["Stop store rollouts in each store, as shown below."]
                : []),
              previous
                ? `Resume per channel from Rollouts, or roll back to ${previous}.`
                : "Resume per channel from Rollouts.",
            ]
      }
      confirmLabel={n === 1 ? "Halt 1 rollout" : `Halt ${n} rollouts`}
      cancelLabel={storesOnly ? "Done" : undefined}
      {...confirmBlocked([n === 0, "No rollout to halt"])}
      describeError={(e) => {
        if (e instanceof PartialHaltError) {
          const first = e.refused[0]!;
          return {
            title:
              e.refused.length === 1
                ? `${first.where} was not halted`
                : `${e.refused.length} rollouts were not halted`,
            description: `${e.refused.map((x) => x.where).join(", ")}: ${describe(first.error).title}`,
          };
        }
        return describe(e);
      }}
      onConfirm={async () => {
        const halted: string[] = [];
        const refused: { where: string; error: unknown }[] = [];
        for (const row of targets) {
          const r = row.rollout;
          try {
            await mutate("rolloutAction", slug, r.outletId, r.channel, "halt", {
              deliverable: r.deliverableId,
              releaseId: r.releaseId,
            });
            halted.push(where(row));
          } catch (error) {
            refused.push({ where: where(row), error });
          }
        }
        if (halted.length)
          toast.success(`Halted ${version} on ${halted.join(", ")}`);
        if (refused.length) throw new PartialHaltError(halted, refused);
        onClose();
      }}
    >
      <ul
        aria-label="Rollouts"
        className="divide-y divide-border overflow-hidden rounded-lg border border-border"
      >
        {shown.map((row) => {
          const r = row.rollout;
          const key = rowKey(r);
          const inStore = storeHalt(r);
          if (inStore)
            // What to do in the store, as a second line under the channel.
            return (
              <li
                key={key}
                aria-disabled="true"
                className="flex min-h-11 items-center justify-between gap-3 bg-surface-sunken px-3 py-2 text-fg-muted"
              >
                <span className="flex min-w-0 items-start gap-2">
                  <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block break-words">{where(row)}</span>
                    <span className="block break-words text-xs text-fg">
                      {inStore}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-end tabular-nums">
                  {rowShare(r)}
                </span>
              </li>
            );
          const blocker = haltBlocker(r);
          if (blocker)
            return (
              <li
                key={key}
                aria-disabled="true"
                className="flex min-h-11 items-center justify-between gap-3 bg-surface-sunken px-3 py-2 text-fg-muted"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {r.state === "halted" ? (
                    <Pause aria-hidden className="size-4 shrink-0" />
                  ) : (
                    <Lock aria-hidden className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 break-words">{where(row)}</span>
                </span>
                <span className="max-w-[50%] text-end">{blocker}</span>
              </li>
            );
          return (
            <li
              key={key}
              className="flex min-h-11 items-center justify-between gap-3 px-3 py-2"
            >
              <Checkbox
                checked={chosen.has(key)}
                onCheckedChange={(on) =>
                  setChosen((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(key);
                    else next.delete(key);
                    return next;
                  })
                }
                label={where(row)}
              />
              <span className="shrink-0 text-end tabular-nums text-fg-muted">
                {rowShare(r)}
              </span>
            </li>
          );
        })}
      </ul>
    </ConfirmDialog>
  );
}
