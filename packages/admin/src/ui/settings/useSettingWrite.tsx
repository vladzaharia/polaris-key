import * as React from "react";
import { errorCopy } from "../../lib/errorCopy.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { announce } from "../LiveRegion.js";
import { Textarea } from "../Textarea.js";
import {
  LEVEL_RANK,
  confirmLevel,
  draftError,
  formatSettingValue,
  intentOf,
  sameValue,
  saveCopy,
  type SettingConfirm,
  type SettingLevel,
  type SettingSpec,
  type ValueLabels,
} from "./model.js";

/** What a save carries beyond the value: the version read, the level confirmed, a reason. */
export interface WriteContext {
  expectedVersion: number;
  level: SettingLevel;
  reason?: string;
}

/** The confirmation a revert asks, worded by the page (what it returns to depends on the scope). */
export interface RevertPlan {
  level: SettingLevel;
  title: string;
  confirmLabel: string;
  consequences: string[];
  run: (ctx: { expectedVersion: number }) => Promise<unknown>;
  /** After it succeeds (a toast). */
  onDone?: (result: unknown) => void;
}

export interface SettingWriteOptions {
  label: string;
  /** The setting's key, typed to confirm an L3 change. */
  settingKey: string;
  spec: SettingSpec;
  confirm: SettingConfirm;
  labels?: ValueLabels;
  /** The value in force, and the version a write must carry. */
  value: unknown;
  version: number;
  /** A write needs a reason. */
  critical?: boolean;
  /** A switch or choice commits on change; anything else keeps a draft until Save. */
  commit: "immediate" | "explicit";
  save: (value: unknown, ctx: WriteContext) => Promise<unknown>;
  /** After a save succeeds (a toast, Undo). */
  onSaved?: (
    result: unknown,
    done: { value: unknown; level: SettingLevel },
  ) => void;
  /** Extra lines for the confirmation of a change to `to`. */
  consequences?: (to: unknown) => string[];
  /** The confirmation of Revert, or `null` when there is nothing to revert. */
  revertPlan?: () => RevertPlan | null;
  /** Refetch the setting; resolves when the new value is in. */
  reload?: () => Promise<unknown>;
  /** A refused write because the setting changed since it was read. */
  isConflict: (error: unknown) => boolean;
  /** The words of an error from the API. */
  describeError?: (error: unknown) => { title: string; description?: string };
}

type Pending =
  | { kind: "set"; value: unknown; level: SettingLevel }
  | { kind: "revert"; plan: RevertPlan; level: SettingLevel };

/** Where a conflict stands: just refused, or reloaded and ready to retry. */
export type ConflictState = null | "refused" | "reloaded";

/**
 * The write half of the settings engine (ST-07). One flow for every settings surface:
 *
 * - a draft held until Save (`explicit`) or committed on change (`immediate`);
 * - the confirm level of the registry, per direction: L0 saves at once, L1 a caution, L2 a
 *   danger, L3 types the key; a critical setting also asks for a reason;
 * - every write carries the `expectedVersion` it read; a 409 never overwrites. The row names the
 *   conflict, keeps the operator's draft and offers Reload;
 * - a failed save keeps the input and shows its error in the row's slot.
 */
export function useSettingWrite(o: SettingWriteOptions) {
  const latest = React.useRef(o);
  latest.current = o;
  const [draft, setDraft] = React.useState<unknown>(o.value);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [reason, setReason] = React.useState("");
  const [conflict, setConflict] = React.useState<ConflictState>(null);
  const [reloading, setReloading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{
    title: string;
    description?: string;
  } | null>(null);
  const conflictRef = React.useRef(conflict);
  conflictRef.current = conflict;

  // A new value from the server (a save, a revert, a resync) replaces the draft, except while
  // a conflict is open: the operator's input stays against the new value.
  React.useEffect(() => {
    if (conflictRef.current === null) setDraft(o.value);
  }, [o.value, o.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !sameValue(draft, o.value);
  const level = confirmLevel(o.spec, o.confirm, o.value, draft);
  const describe = (e: unknown) =>
    (o.describeError ?? ((x: unknown) => errorCopy(x, { thing: "Setting" })))(
      e,
    );

  /** Send the write. A conflict is recorded here; the caller decides what else to do. */
  const send = async (p: Pending): Promise<void> => {
    const cur = latest.current;
    setBusy(true);
    setError(null);
    try {
      if (p.kind === "set") {
        const ctx: WriteContext = {
          expectedVersion: cur.version,
          level: p.level,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        };
        const res = await cur.save(p.value, ctx);
        cur.onSaved?.(res, { value: p.value, level: p.level });
      } else {
        const res = await p.plan.run({ expectedVersion: cur.version });
        p.plan.onDone?.(res);
      }
      setConflict(null);
      setReason("");
    } catch (e) {
      if (cur.isConflict(e)) {
        setConflict("refused");
        announce(
          `${cur.label} changed since you loaded it. Nothing was saved.`,
        );
      }
      throw e;
    } finally {
      setBusy(false);
    }
  };

  /** Save the draft (or `value`): at once at L0, else through the confirmation. */
  const commit = (value: unknown = draft): void => {
    const cur = latest.current;
    const invalid = draftError(cur.spec, value);
    if (invalid) {
      setError({ title: invalid });
      return;
    }
    setError(null);
    const lv = confirmLevel(cur.spec, cur.confirm, cur.value, value);
    const p: Pending = { kind: "set", value, level: lv };
    if (LEVEL_RANK[lv] === 0 && !cur.critical) {
      send(p).catch((e: unknown) => {
        if (!cur.isConflict(e)) setError(describe(e));
      });
    } else setPending(p);
  };

  /** Change the value: immediately committed for a switch or choice, else a draft. */
  const propose = (value: unknown): void => {
    setDraft(value);
    if (
      latest.current.commit === "immediate" &&
      !sameValue(value, latest.current.value)
    )
      commit(value);
  };

  const discard = (): void => {
    setDraft(latest.current.value);
    setError(null);
    setConflict(null);
    announce(`Changes to ${latest.current.label} discarded`);
  };

  const revert = (): void => {
    const plan = latest.current.revertPlan?.();
    if (plan) setPending({ kind: "revert", plan, level: plan.level });
  };

  const cancel = (): void => {
    setPending(null);
    setReason("");
    if (latest.current.commit === "immediate") setDraft(latest.current.value);
  };

  const reload = async (): Promise<void> => {
    setReloading(true);
    try {
      await latest.current.reload?.();
      setConflict("reloaded");
      announce(`${latest.current.label} reloaded`);
    } finally {
      setReloading(false);
    }
  };

  const labels = o.labels;
  let dialog: React.ReactNode = null;
  if (pending) {
    const isRevert = pending.kind === "revert";
    const copy = isRevert
      ? {
          title: pending.plan.title,
          confirmLabel: pending.plan.confirmLabel,
        }
      : saveCopy(o.label, o.spec, pending.value, labels);
    const consequences = isRevert
      ? pending.plan.consequences
      : (o.consequences?.(pending.value) ?? [
          `${o.label} changes from ${formatSettingValue(o.spec, o.value, labels)} to ${formatSettingValue(o.spec, pending.value, labels)}.`,
        ]);
    const needsReason = !isRevert && o.critical === true;
    dialog = (
      <ConfirmDialog
        open
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
        intent={intentOf(pending.level)}
        title={copy.title}
        consequences={consequences}
        confirmLabel={copy.confirmLabel}
        confirmDisabled={needsReason && reason.trim() === ""}
        typedConfirmation={
          pending.level === "L3"
            ? { value: o.settingKey, label: `Type ${o.settingKey} to confirm` }
            : undefined
        }
        describeError={describe}
        onConfirm={async () => {
          try {
            await send(pending);
          } catch (e) {
            if (latest.current.isConflict(e)) {
              // Close: the row now names the conflict and offers the reload.
              setPending(null);
              return;
            }
            throw e;
          }
          setPending(null);
        }}
      >
        {needsReason ? (
          <label className="block space-y-1 text-sm">
            <span className="font-medium text-fg-strong">Reason</span>
            <Textarea
              value={reason}
              onValueChange={setReason}
              maxLength={500}
              rows={2}
              placeholder="Why this changes (kept in the activity log)"
            />
          </label>
        ) : null}
      </ConfirmDialog>
    );
  }

  return {
    draft,
    setDraft,
    dirty,
    level,
    /** Save will ask first (so the button says "Save…"). */
    asks: LEVEL_RANK[level] > 0 || o.critical === true,
    busy,
    error,
    clearError: () => setError(null),
    conflict,
    clearConflict: () => setConflict(null),
    reloading,
    propose,
    commit,
    discard,
    revert,
    reload,
    dialog,
  };
}
