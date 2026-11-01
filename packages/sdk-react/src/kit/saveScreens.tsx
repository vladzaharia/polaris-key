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

import {
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { UiInput } from "@polaris-key/ui-core";
import type {
  RangedSource,
  SaveConflict as Conflict,
  SaveKeep,
} from "@polaris-key/client-core/sync";

import { PolarisContext } from "../react/context.js";
import { developerError } from "../core/devNotice.js";
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

// The bound screens open on a page, per saves object. While one is open the strip defers to it
// (one live region, one error and Try again), then shows the conflict again if it is left pending.
const OPEN = new WeakMap<object, { n: number; subs: Set<() => void> }>();
function openEntry(saves: object) {
  let e = OPEN.get(saves);
  if (!e) OPEN.set(saves, (e = { n: 0, subs: new Set() }));
  return e;
}
function useScreenOpen(saves: BrowserSaves | null, show = false): boolean {
  useEffect(() => {
    if (!saves || !show) return;
    const e = openEntry(saves);
    e.n++;
    e.subs.forEach((f) => f());
    return () => {
      e.n--;
      e.subs.forEach((f) => f());
    };
  }, [saves, show]);
  return useSyncExternalStore(
    (f) => {
      if (!saves) return () => undefined;
      const e = openEntry(saves);
      e.subs.add(f);
      return () => e.subs.delete(f);
    },
    () => (saves ? openEntry(saves).n > 0 : false),
    () => false,
  );
}

function useOnline(): boolean {
  return useSyncExternalStore(
    (f) => {
      window.addEventListener("online", f);
      window.addEventListener("offline", f);
      return () => {
        window.removeEventListener("online", f);
        window.removeEventListener("offline", f);
      };
    },
    () => navigator.onLine !== false,
    () => true,
  );
}

/**
 * The Cloud Sync strip's transfer states while a save moves, over the host's input: running writes
 * are `transferring` (the bar counts the bytes; a whole upload that has counted none is
 * indeterminate), paused ones or an offline page `waiting`, a failed one `transfer-failed` (until
 * the next write starts or Try again), an unsettled conflict `conflict`. Nothing moving leaves the
 * host's input as it was, and so does an open SaveConflict screen: it owns the page's announcements.
 * `clearFailure` drops the failed state.
 */
export function useTransferInput(
  input: UiInput | undefined,
  /** Whether Try again can do anything (the host passed `onRetry` or `onAction`). Without it a
   *  failed save reads "not synced", with no Try again, until the next save succeeds. */
  canRetry = true,
): {
  input: UiInput | undefined;
  clearFailure: () => void;
  /** An open SaveConflict screen owns the page's announcements: the strip is silent. */
  muted: boolean;
} {
  const saves = useBoundSaves();
  const last = useSavesTick(saves);
  const screen = useScreenOpen(saves);
  const online = useOnline();
  const [cleared, setCleared] = useState<SaveTransferEvent | null>(null);
  const clearFailure = () => setCleared(last);
  if (!saves) return { input, clearFailure, muted: false };
  const running = saves.transfers();
  const base = input?.cloudSync;
  const patch = (c: Partial<Cloud> & Pick<Cloud, "state">): UiInput => ({
    ...input,
    cloudSync: { ...base, ...c },
  });
  const out = (i: UiInput | undefined) => ({
    input: i,
    clearFailure,
    muted: screen,
  });
  // The screen is open: the strip stays on the conflict (never the host's "Synced") and says
  // nothing; the screen announces itself once.
  if (screen)
    return out(
      saves.conflicts().length > 0 ? patch({ state: "conflict" }) : input,
    );
  const failed = last?.type === "transferFailed" && last !== cleared;
  if (running.length > 0) {
    // Offline, the engine backs off for a long time: say so at once (D-9).
    if (!online) return out(patch({ state: "waiting", reason: "network" }));
    if (running.every((t) => t.state === "paused"))
      return out(patch({ state: "waiting", reason: "background" }));
    const done = running.reduce((n, t) => n + t.progress.done, 0);
    const total = running.reduce((n, t) => n + t.progress.total, 0);
    // A single request reports nothing until it ends: no counted bytes, no bar stuck at 0 %.
    const counted = total > 0 && done > 0;
    return out(
      patch({
        state: "transferring",
        transfer: counted
          ? {
              size: sizeText(done),
              total: sizeText(total),
              fraction: Math.min(1, done / total),
            }
          : {},
      }),
    );
  }
  if (failed)
    return out(
      !online
        ? patch({ state: "waiting", reason: "network" })
        : // Never "Synced" after a failed save: without a way to retry, the line stays until the
          // next save succeeds.
          patch({ state: canRetry ? "transfer-failed" : "error" }),
    );
  // Left pending (Cancel keeps it): never "Synced" while a save waits for the person's choice.
  if (saves.conflicts().length > 0)
    return out(patch({ state: "conflict", canReview: true }));
  return out(input);
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const label = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** "Today, 9:41", "Yesterday, 9:41" or "12 Mar, 9:41", in the person's locale. */
export function whenText(ms: number, now = Date.now()): string {
  const t = new Date(ms);
  const day = (d: Date) => new Date(d).setHours(0, 0, 0, 0);
  const apart = Math.round((day(new Date(now)) - day(t)) / 86_400_000);
  const clock = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(t);
  const rel =
    typeof Intl.RelativeTimeFormat === "function" && apart >= 0 && apart <= 1
      ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
          -apart,
          "day",
        )
      : new Intl.DateTimeFormat(undefined, {
          day: "numeric",
          month: "short",
        }).format(t);
  return `${rel.charAt(0).toUpperCase()}${rel.slice(1)}, ${clock}`;
}

/** The cards' details from what every SDK writes with a save (`savedAt` in ms and `deviceLabel`,
 *  SAVES-META): each copy's time, the other device's name, and the later one as `newer`. */
export function describeFromMetadata(c: Conflict): ConflictDescription {
  const mine = num(c.local.metadata["savedAt"]);
  const theirs = c.remote ? num(c.remote.metadata["savedAt"]) : undefined;
  const device = c.remote ? label(c.remote.metadata["deviceLabel"]) : undefined;
  return {
    ...(mine !== undefined ? { local: { when: whenText(mine) } } : {}),
    ...(theirs !== undefined || device !== undefined
      ? {
          remote: {
            ...(theirs !== undefined ? { when: whenText(theirs) } : {}),
            ...(device !== undefined ? { device } : {}),
          },
        }
      : {}),
    ...(mine !== undefined && theirs !== undefined && mine !== theirs
      ? { newer: mine > theirs ? ("local" as const) : ("remote" as const) }
      : {}),
  };
}

/** What the app knows about the two copies of a conflict, display-ready. The saves hold the
 *  metadata and sizes, and every SDK records `savedAt` and `deviceLabel` with a save, so the
 *  cards fill in on their own; this overrides them. `newer` is from the app's own metadata,
 *  never from the `when` strings. */
export interface ConflictDescription {
  local?: { when?: string };
  remote?: { when?: string; device?: string };
  newer?: "local" | "remote";
}

export interface BoundConflict {
  /** The input to draw, or undefined when the host drives the screen or nothing is pending. */
  input: UiInput | undefined;
  /** The binding is on (a conflict is held and the host does not drive): hidden or shown. */
  on: boolean;
  onKeep: (keep: SaveKeep) => void;
  onRetry: () => void;
  onChooseAgain: () => void;
  onCancel: () => void;
  onDone: () => void;
}

let warnedBytes = false;

/**
 * The pending conflict as the SaveConflict screen's input, and the handlers that settle it. The
 * host's `input.saveConflict` is merged over it (its `local`, `remote` and `newer` fields), so a
 * host that adds a card's time does not switch the binding off; with no pending conflict, or
 * outside the provider, a host input is simply the plain part.
 */
export function useBoundConflict(
  hostInput: UiInput | undefined,
  bytes:
    | ((
        c: Conflict,
      ) => Uint8Array | RangedSource | Promise<Uint8Array | RangedSource>)
    | undefined,
  describe?: (c: Conflict) => ConflictDescription,
): BoundConflict {
  const saves = useBoundSaves();
  useSavesTick(saves);
  const [step, setStep] = useState<ConflictInput["step"]>("choose");
  const [keep, setKeep] = useState<SaveKeep | undefined>(undefined);
  // Cancel hides the screen and keeps the conflict pending (the strip says it needs review). It
  // hides that conflict, not the save: a later conflict on the same save shows again.
  const [hiddenFor, setHiddenFor] = useState<Conflict | null>(null);
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
  const driven =
    saves === null || (hostInput?.saveConflict !== undefined && !c);
  const visible = !driven && c !== null && hiddenFor !== c;
  useScreenOpen(saves, visible);
  useEffect(() => {
    // Once, in development, on any bundler (`developerError` is quiet in production builds).
    if (visible && bytes === undefined && !warnedBytes) {
      warnedBytes = true;
      developerError(
        "saves-conflict-bytes",
        "SaveConflict is bound to the saves without `bytes`: Keep this and Keep both cannot run. Pass bytes={(conflict) => localBytes}.",
      );
    }
  }, [visible, bytes]);

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
      if (out.state === "conflict") {
        // Another write landed meanwhile: choose again, on the new conflict (Try again would
        // repeat the stale one).
        held.current = out.conflict;
        setKeep(undefined);
        setStep("choose");
        return;
      }
      setStep(out.state === "done" ? "kept" : "failed");
    } catch {
      if (live.current) setStep("failed");
    }
  };
  const settle = (): void => {
    held.current = null;
    setHiddenFor(null);
    setStep("choose");
    setKeep(undefined);
  };
  const own = c ? describeFromMetadata(c) : undefined;
  const given = c && describe ? describe(c) : undefined;
  const d: ConflictDescription | undefined = c
    ? {
        local: { ...own?.local, ...given?.local },
        remote: { ...own?.remote, ...given?.remote },
        ...((given?.newer ?? own?.newer)
          ? { newer: (given?.newer ?? own?.newer)! }
          : {}),
      }
    : undefined;
  const host = hostInput?.saveConflict;
  const input: UiInput | undefined = !visible
    ? undefined
    : {
        ...hostInput,
        saveConflict: {
          local: { ...d?.local, ...host?.local },
          remote: c.remote === null ? null : { ...d?.remote, ...host?.remote },
          ...((host?.newer ?? d?.newer)
            ? { newer: (host?.newer ?? d?.newer)! }
            : {}),
          bothAvailable: c.bothAvailable,
          ...(keep ? { keep } : {}),
          step,
        },
      };
  return {
    input,
    on: !driven && c !== null,
    onKeep: (k) => void run(k),
    onRetry: () => keep && void run(keep),
    onChooseAgain: () => {
      setStep("choose");
      setKeep(undefined);
    },
    // Cancel (or Escape) leaves the conflict as it was; only Done settles it.
    onCancel: () => {
      if (c) setHiddenFor(c);
      setStep("choose");
      setKeep(undefined);
    },
    onDone: () => {
      if (c) saves?.dismissConflict(c.id);
      settle();
    },
  };
}
