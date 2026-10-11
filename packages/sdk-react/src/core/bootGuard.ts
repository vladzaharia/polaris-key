// The app boot guard for a page (SDK parity pass §3.15, feature `update.bootguard`): count the
// launches of a new build that never reached health, and roll back after `MAX_FAILED_BOOTS` of
// them. `@polaris-key/node`'s `BootGuard` (packages/sdk-node/src/update/bootguard.ts), rule for
// rule; the decision itself is client-core's `bootGuardAction`, which every SDK runs against
// `stage-matrix.json`'s `guardCases`.
//
//   markBootAttempt()   at startup, before the app does anything that could crash. The first
//                       launch of a new version moves the slots (previous ← current ← this
//                       version) and resets the count; then `bootGuardAction` decides; then this
//                       launch is counted as unconfirmed.
//   confirmBoot()       once the app is healthy (the boot reached `ready` for BOOT_OK_SECONDS,
//                       or `waiting`/`blocked`/`offline`, per `bootConfirmation`). Resets the
//                       count and reports `update_confirmed` for the first confirmed launch of
//                       a new version.
//
// The slots live in browser storage under one key per product (`localStorage` by default, every
// access in try/catch; a store that cannot be read or written falls back to memory, and
// `persistent()` says so). The guard owns the DECISION and the bookkeeping; the actual rollback
// is the host's: it passes `rollback(previousVersion)` when it can serve the previous build
// (a page cannot, by itself: a service worker only moves forward). Without one, a rollback is
// reported as `boot_rolled_back` with code `no-previous` and the failed version is remembered
// as `skipVersion`, so `decideUpdate({ skipVersion })` never re-offers it automatically.
//
// A "staged" update on a page is a waiting service worker: `staged()` answers it, so the guard
// cases that carry `staged: true` (apply-staged, and a rollback taking precedence over it) mean
// the same thing here as on a desktop host. The guard reports `apply-staged`; applying it is
// `installUpdate()`, never a side effect of counting a launch.
//
// Tabs of one origin share the slots: a second tab is a second launch. A version that was
// confirmed once is never rolled back for later unconfirmed launches, which is what keeps a
// second tab's launch from undoing a good update.

import {
  bootGuardAction,
  MAX_FAILED_BOOTS,
  type BootGuardResult,
} from "@polaris-key/client-core";
import { UpdateEvent } from "../constants.generated.js";
import type { ConfigStorage } from "./localConfig.js";
import type { UpdateEventInput } from "./updateEvents.js";

export { MAX_FAILED_BOOTS };

/** What the guard persists. */
export interface BootSlots {
  /** The version this install last launched. */
  current: string | null;
  /** The version it launched before `current`, when `current` was an update. */
  previous: string | null;
  /** Unconfirmed launches of `current`. */
  failedBoots: number;
  /** Whether a launch of `current` was ever confirmed. */
  confirmed: boolean;
  /** A version the guard rolled back from: never re-offered automatically. */
  skipVersion: string | null;
}

/** `markBootAttempt()`'s answer. */
export interface BootAttempt {
  /** What the stage machine's `guard.done` carries. */
  result: BootGuardResult;
  /** The action `bootGuardAction` chose. */
  action: "none" | "apply-staged" | "roll-back";
  /** Unconfirmed launches of this version, this one included. */
  failedBoots: number;
  version: string;
  previous: string | null;
  /** On `roll-back` without a rollback that could act: why nothing was rolled back. */
  reason?: "no-previous" | "rollback-failed";
}

/** Where the slots live. Synchronous: the browser's storage is. */
export interface BootSlotStore {
  /** The stored value as it was written (unvalidated), or null. */
  read(): unknown;
  write(slots: BootSlots): void;
  /** False when the slots live in memory only (no usable browser storage): a reload loses them,
   *  and with them the count. */
  persistent(): boolean;
}

export interface BootGuardOptions {
  /** The running build's version (the page's `version`). */
  version: string;
  store: BootSlotStore;
  /** Journal an update-health event (`adapter.recordUpdateEvent`). A failure is the journal's. */
  record?: (event: UpdateEvent, input: UpdateEventInput) => Promise<unknown>;
  /** Re-install `previousVersion`. True when it did. */
  rollback?: (previousVersion: string) => Promise<boolean>;
  /** Whether an update is staged (a waiting service worker). Default: none is. */
  staged?: () => boolean | Promise<boolean>;
}

const EMPTY: BootSlots = {
  current: null,
  previous: null,
  failedBoots: 0,
  confirmed: false,
  skipVersion: null,
};

/** The `localStorage` key one product's slots live under. */
export function bootGuardStorageKey(product: string): string {
  return `pkey:${product}:boot-guard`;
}

/**
 * The browser's slot store: one JSON object per product in `localStorage` (or the injected
 * storage), every access in try/catch. `null` storage, or one that throws, keeps the slots in
 * memory and reports `persistent() === false`.
 */
export function browserBootSlotStore(
  product: string,
  storage?: ConfigStorage | null,
): BootSlotStore {
  const key = bootGuardStorageKey(product);
  let store: ConfigStorage | null = null;
  try {
    store =
      storage === undefined
        ? typeof globalThis.localStorage === "undefined"
          ? null
          : globalThis.localStorage
        : storage;
  } catch {
    store = null; // the accessor itself throws where site data is blocked
  }
  let memory: BootSlots | null = null;
  return {
    persistent: () => store !== null,
    read() {
      if (store) {
        try {
          const raw = store.getItem(key);
          return raw === null ? null : (JSON.parse(raw) as unknown);
        } catch (e) {
          // A corrupt value is simply no slots; an unreadable store is memory-only.
          if (e instanceof SyntaxError) return null;
          store = null;
        }
      }
      return memory;
    },
    write(slots) {
      memory = slots;
      if (!store) return;
      try {
        store.setItem(key, JSON.stringify(slots));
      } catch {
        // Quota or blocked storage mid-session: keep going in memory, and say so.
        store = null;
      }
    },
  };
}

function normalise(raw: unknown): BootSlots {
  const r: Partial<Record<keyof BootSlots, unknown>> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    current: typeof r.current === "string" ? r.current : null,
    previous: typeof r.previous === "string" ? r.previous : null,
    failedBoots:
      typeof r.failedBoots === "number" &&
      Number.isSafeInteger(r.failedBoots) &&
      r.failedBoots >= 0
        ? r.failedBoots
        : 0,
    confirmed: r.confirmed === true,
    skipVersion: typeof r.skipVersion === "string" ? r.skipVersion : null,
  };
}

export class BootGuard {
  constructor(private readonly o: BootGuardOptions) {}

  /** The persisted slots. */
  slots(): BootSlots {
    return normalise(this.o.store.read());
  }

  /** The version the guard rolled back from, for `decideUpdate({ skipVersion })`. */
  skipVersion(): string | null {
    return this.slots().skipVersion;
  }

  /** Whether the slots survive a reload. */
  persistent(): boolean {
    return this.o.store.persistent();
  }

  private async emit(
    event: UpdateEvent,
    input: UpdateEventInput,
  ): Promise<void> {
    const record = this.o.record;
    if (!record) return;
    try {
      await record(event, input);
    } catch {
      // A journal that cannot take the event (a cookie page holds none) never fails a launch.
    }
  }

  /** Count this launch and decide (see the file header). */
  async markBootAttempt(): Promise<BootAttempt> {
    const version = this.o.version;
    let s = this.slots();
    let applied = false;
    if (s.current !== version) {
      // The first launch of this version: an update landed (or this is the first launch ever).
      applied = s.current !== null;
      s = {
        ...EMPTY,
        current: version,
        previous: s.current,
        skipVersion: s.skipVersion === version ? null : s.skipVersion,
      };
    }
    let staged = false;
    try {
      staged = (await this.o.staged?.()) === true;
    } catch {
      // A page that cannot look at its service worker has nothing staged.
    }
    const action = bootGuardAction({ staged, failedBoots: s.failedBoots });
    if (action === "roll-back" && !s.confirmed) {
      const failedBoots = s.failedBoots;
      let rolled = false;
      if (s.previous !== null && this.o.rollback) {
        try {
          rolled = await this.o.rollback(s.previous);
        } catch {
          rolled = false;
        }
      }
      const reason = rolled
        ? undefined
        : s.previous === null || !this.o.rollback
          ? ("no-previous" as const)
          : ("rollback-failed" as const);
      await this.emit(
        rolled ? UpdateEvent.updateReverted : UpdateEvent.bootRolledBack,
        {
          release: version,
          ...(s.previous ? { fromRelease: s.previous } : {}),
          ...(reason ? { code: reason } : {}),
        },
      );
      if (rolled)
        await this.emit(UpdateEvent.bootRolledBack, {
          release: version,
          ...(s.previous ? { fromRelease: s.previous } : {}),
        });
      // The failed build is never re-offered automatically, and the count starts over.
      this.o.store.write({ ...s, failedBoots: 1, skipVersion: version });
      return {
        result: "rolled-back",
        action,
        failedBoots,
        version,
        previous: s.previous,
        ...(reason ? { reason } : {}),
      };
    }
    // A version that was confirmed once is never rolled back for later crashes: the guard
    // protects the first launches of an update, not a build that has proven itself.
    const failedBoots = s.failedBoots + 1;
    this.o.store.write({ ...s, failedBoots });
    return {
      result: applied ? "applied" : "ok",
      action: action === "roll-back" ? "none" : action,
      failedBoots,
      version,
      previous: s.previous,
    };
  }

  /** Mark this launch healthy. Idempotent. */
  async confirmBoot(): Promise<void> {
    const version = this.o.version;
    const s = this.slots();
    if (s.current !== version) return;
    if (!s.confirmed && s.previous !== null && s.previous !== version)
      await this.emit(UpdateEvent.updateConfirmed, {
        release: version,
        fromRelease: s.previous,
      });
    this.o.store.write({ ...s, failedBoots: 0, confirmed: true });
  }
}
