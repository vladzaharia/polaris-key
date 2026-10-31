"use client";
// K.2T (SAVES.R): the SaveConflict screen and the CloudSyncStatus transfer states bound to the
// saves client. Both are the plain part when the host passes the input (the host drives them);
// with none, inside `<PolarisKeyProvider>`, they follow `adapter.cloudSync.saves`:
//
//   SaveConflict      the first conflict a write ended with. A choice runs `saves.resolve` with the
//                     bytes the host hands in (`bytes`, the local copy; none is needed to keep the
//                     other copy), then moves on: keeping, kept, or failed with Try again.
//   CloudSyncStatus   `transferring` (with the counted fraction), `transfer-failed` and `conflict`,
//                     only while a save is moving; otherwise the host's input stands.
//
// No value, key or path passes through here: the input carries counts and states.

import { useContext, useEffect, useRef, useState } from "react";
import type { UiInput } from "@polaris-key/ui-core";
import type {
  RangedSource,
  SaveConflict as Conflict,
  SaveKeep,
} from "@polaris-key/client-core/sync";

import { PolarisContext } from "../react/context.js";
import type { BrowserSaves, SaveTransferEvent } from "../core/cloudSync.js";

type Cloud = NonNullable<UiInput["cloudSync"]>;
type ConflictInput = NonNullable<UiInput["saveConflict"]>;

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** A size, display-ready ("38 MB"). */
export function sizeText(bytes: number): string {
  let n = Math.max(0, bytes);
  let u = 0;
  while (n >= 1000 && u < UNITS.length - 1) {
    n /= 1000;
    u++;
  }
  return `${n >= 10 || u === 0 ? Math.round(n) : Math.round(n * 10) / 10} ${UNITS[u]}`;
}

/** The saves of the provider's adapter, or null outside one (or where the adapter has none). */
export function useBoundSaves(): BrowserSaves | null {
  const adapter = useContext(PolarisContext)?.adapter;
  return (
    (adapter?.cloudSync as { saves?: BrowserSaves } | undefined)?.saves ?? null
  );
}

/** Re-render on every change of the saves' transfers and conflicts. */
function useSavesTick(saves: BrowserSaves | null): SaveTransferEvent | null {
  const [last, setLast] = useState<SaveTransferEvent | null>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!saves) return;
    return saves.onTransfers((e) => {
      if (e) setLast(e);
      bump((n) => n + 1);
    });
  }, [saves]);
  return last;
}

/**
 * The Cloud Sync strip's transfer states while a save moves, over the host's input: running or
 * paused writes are `transferring` (the bar counts the bytes), a failed one `transfer-failed`
 * (until the next write starts), an unsettled conflict `conflict`. Nothing moving leaves the
 * host's input as it was.
 */
export function useTransferInput(
  input: UiInput | undefined,
): UiInput | undefined {
  const saves = useBoundSaves();
  const last = useSavesTick(saves);
  if (!saves) return input;
  const running = saves.transfers();
  const base = input?.cloudSync;
  const patch = (c: Partial<Cloud> & Pick<Cloud, "state">): UiInput => ({
    ...input,
    cloudSync: { ...base, ...c },
  });
  if (running.length > 0) {
    const done = running.reduce((n, t) => n + t.progress.done, 0);
    const total = running.reduce((n, t) => n + t.progress.total, 0);
    const counted = total > 0;
    return patch({
      state: "transferring",
      transfer: counted
        ? {
            size: sizeText(done),
            total: sizeText(total),
            fraction: Math.min(1, done / total),
          }
        : {},
    });
  }
  if (last?.type === "transferFailed")
    return patch({ state: "transfer-failed" });
  if (saves.conflicts().length > 0)
    return patch({ state: "conflict", canReview: true });
  return input;
}

export interface BoundConflict {
  /** The input to draw, or undefined when the host drives the screen or nothing is pending. */
  input: UiInput | undefined;
  onKeep: (keep: SaveKeep) => void;
  onRetry: () => void;
  onChooseAgain: () => void;
  onCancel: () => void;
  onDone: () => void;
}

/** The pending conflict as the SaveConflict screen's input, and the handlers that settle it. */
export function useBoundConflict(
  hostInput: UiInput | undefined,
  bytes:
    | ((
        c: Conflict,
      ) => Uint8Array | RangedSource | Promise<Uint8Array | RangedSource>)
    | undefined,
): BoundConflict {
  const saves = useBoundSaves();
  useSavesTick(saves);
  const [step, setStep] = useState<ConflictInput["step"]>("choose");
  const [keep, setKeep] = useState<SaveKeep | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // Shown until it is dismissed, so Kept still reads after the saves forgot the conflict.
  const held = useRef<Conflict | null>(null);
  const pending = saves?.conflicts()[0] ?? null;
  if (pending !== null && step === "choose") held.current = pending;
  const c = held.current;
  const driven = hostInput?.saveConflict !== undefined || saves === null;

  const run = async (k: SaveKeep): Promise<void> => {
    if (!saves || !c) return;
    setKeep(k);
    setStep("keeping");
    try {
      const local = bytes ? await bytes(c) : null;
      if (local === null && k !== "remote") throw new Error("no local copy");
      const t = await saves.resolve(c, k, local ?? new Uint8Array(0));
      const out = await t.done;
      if (!live.current) return;
      setStep(out.state === "done" ? "kept" : "failed");
    } catch {
      if (live.current) setStep("failed");
    }
  };
  const reset = (): void => {
    if (c) saves?.dismissConflict(c.id);
    held.current = null;
    setStep("choose");
    setKeep(undefined);
  };
  const input: UiInput | undefined =
    driven || !c
      ? undefined
      : {
          ...hostInput,
          saveConflict: {
            step,
            local: {},
            remote: c.remote === null ? null : {},
            bothAvailable: c.bothAvailable,
            ...(keep ? { keep } : {}),
          },
        };
  return {
    input,
    onKeep: (k) => void run(k),
    onRetry: () => keep && void run(keep),
    onChooseAgain: () => {
      setStep("choose");
      setKeep(undefined);
    },
    onCancel: reset,
    onDone: reset,
  };
}
