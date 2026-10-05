// The app boot guard (SDK parity pass §3.15, `update.bootguard`): count the launches of a new
// build that never reached health, and roll back after `MAX_FAILED_BOOTS` of them.
//
//   markBootAttempt()   at startup, before the app does anything that could crash. A first launch
//                       of a new version moves the slots (previous ← current ← this version) and
//                       resets the count; then client-core's `bootGuardAction` decides; then this
//                       launch is counted as unconfirmed.
//   confirmBoot()       once the app is healthy (the boot reached `ready` for BOOT_OK_SECONDS, or
//                       the host says so). Resets the count and reports `update_confirmed` for the
//                       first confirmed launch of a new version.
//
// The slots live in `<stateDir>/boot-guard.json`, beside the token store's state. The guard owns
// the DECISION and the bookkeeping; the actual rollback is the install driver's (§3.16): a host
// passes `rollback(previousVersion)` when its updater can re-install the previous build (Velopack,
// a kept previous executable). Without one, a rollback is reported as `boot_rolled_back` with
// code `no-previous` and the failed version is remembered as `skipVersion`, so `decide()` never
// re-offers it automatically.

import { join } from "node:path";
import { bootGuardAction, MAX_FAILED_BOOTS } from "@polaris-key/client-core";
import type { BootGuardResult } from "@polaris-key/client-core";
import { readJson, writeJson } from "../core/jsonFile.js";
import type { UpdateJournal } from "./journal.js";

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
  /** On `roll-back` without a driver that could act: why nothing was rolled back. */
  reason?: "no-previous" | "rollback-failed";
}

export interface BootGuardOptions {
  /** Re-install `previousVersion` (an install driver's rollback). True when it did. */
  rollback?: (previousVersion: string) => Promise<boolean>;
}

const EMPTY: BootSlots = {
  current: null,
  previous: null,
  failedBoots: 0,
  confirmed: false,
  skipVersion: null,
};

export class BootGuard {
  private readonly file: string;

  constructor(
    stateDir: string,
    private readonly version: string,
    private readonly journal: UpdateJournal | null,
    /** The install driver's rollback; a driver installs it (`update.install` drivers). */
    public opts: BootGuardOptions = {},
  ) {
    this.file = join(stateDir, "boot-guard.json");
  }

  /** The persisted slots. */
  async slots(): Promise<BootSlots> {
    const raw = await readJson<Partial<BootSlots>>(this.file, {});
    return {
      current: typeof raw.current === "string" ? raw.current : null,
      previous: typeof raw.previous === "string" ? raw.previous : null,
      failedBoots:
        Number.isSafeInteger(raw.failedBoots) && raw.failedBoots! >= 0
          ? raw.failedBoots!
          : 0,
      confirmed: raw.confirmed === true,
      skipVersion: typeof raw.skipVersion === "string" ? raw.skipVersion : null,
    };
  }

  /** The version the guard rolled back from, for `update.decide({ skipVersion })`. */
  async skipVersion(): Promise<string | null> {
    return (await this.slots()).skipVersion;
  }

  /** Count this launch and decide (see the file header). */
  async markBootAttempt(): Promise<BootAttempt> {
    let s = await this.slots();
    let applied = false;
    if (s.current !== this.version) {
      // The first launch of this version: an update landed (or this is the first launch ever).
      applied = s.current !== null;
      s = {
        ...EMPTY,
        current: this.version,
        previous: s.current,
        skipVersion: s.skipVersion === this.version ? null : s.skipVersion,
      };
    }
    const action = bootGuardAction({
      staged: false,
      failedBoots: s.failedBoots,
    });
    if (action === "roll-back" && !s.confirmed) {
      const failedBoots = s.failedBoots;
      let rolled = false;
      if (s.previous !== null && this.opts.rollback)
        rolled = await this.opts.rollback(s.previous).catch(() => false);
      const reason = rolled
        ? undefined
        : s.previous === null || !this.opts.rollback
          ? ("no-previous" as const)
          : ("rollback-failed" as const);
      await this.journal
        ?.record(rolled ? "update_reverted" : "boot_rolled_back", {
          release: this.version,
          ...(s.previous ? { fromRelease: s.previous } : {}),
          ...(reason ? { code: reason } : {}),
        })
        .catch(() => null);
      if (rolled)
        await this.journal
          ?.record("boot_rolled_back", {
            release: this.version,
            ...(s.previous ? { fromRelease: s.previous } : {}),
          })
          .catch(() => null);
      // The failed build is never re-offered automatically, and the count starts over.
      await writeJson(this.file, {
        ...s,
        failedBoots: 1,
        skipVersion: this.version,
      });
      return {
        result: "rolled-back",
        action,
        failedBoots,
        version: this.version,
        previous: s.previous,
        ...(reason ? { reason } : {}),
      };
    }
    // A version that was confirmed once is never rolled back for later crashes: the guard
    // protects the first launches of an update, not a build that has proven itself.
    const failedBoots = s.failedBoots + 1;
    await writeJson(this.file, { ...s, failedBoots });
    return {
      result: applied ? "applied" : "ok",
      action: action === "roll-back" ? "none" : action,
      failedBoots,
      version: this.version,
      previous: s.previous,
    };
  }

  /** Mark this launch healthy. Idempotent. */
  async confirmBoot(): Promise<void> {
    const s = await this.slots();
    if (s.current !== this.version) return;
    if (!s.confirmed && s.previous !== null && s.previous !== this.version)
      await this.journal
        ?.record("update_confirmed", {
          release: this.version,
          fromRelease: s.previous,
        })
        .catch(() => null);
    await writeJson(this.file, { ...s, failedBoots: 0, confirmed: true });
  }
}

export { MAX_FAILED_BOOTS };
