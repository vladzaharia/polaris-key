// One version check per source, shared by every component that asks (UK-47): the gate's
// "Update required" screen and an `<UpdatePrompt>` on the same page read the same answer from the
// same request instead of each fetching `update/version`. A source is the host's `fetcher` when it
// gave one, else the adapter; the channel keeps two channels apart.

import type { VersionCheck } from "../core/index.js";

/** What the last check left behind. A new object per change, so a subscriber can compare. */
export interface CheckSnapshot {
  /** The newest build, once a check has succeeded. Kept across a later failure: it is still the
   *  last real answer. */
  latest: VersionCheck | null;
  /** The last check's failure, cleared by the next success. */
  error: Error | null;
  /** True while a check is in flight. */
  busy: boolean;
}

const IDLE: CheckSnapshot = { latest: null, error: null, busy: false };

/** A successful answer this young is reused by a component that mounts and asks again. */
export const FRESH_MS = 30_000;

export class SharedCheck {
  private snap: CheckSnapshot = IDLE;
  private inflight: Promise<VersionCheck | null> | null = null;
  private okAt = 0;
  private readonly subs = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  };

  get = (): CheckSnapshot => this.snap;

  private set(next: Partial<CheckSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const cb of [...this.subs]) cb();
  }

  /**
   * Run `ask`, or join the check already running. Without `force`, a fresh success is returned
   * as it is (a second component mounting must not re-fetch what the first just learned).
   * Resolves to `null` on a failure, which is in the snapshot's `error`.
   */
  run(
    ask: () => Promise<VersionCheck>,
    opts: { force?: boolean; freshMs?: number; now?: () => number } = {},
  ): Promise<VersionCheck | null> {
    if (this.inflight) return this.inflight;
    const now = opts.now ?? Date.now;
    if (
      opts.force !== true &&
      this.snap.latest &&
      !this.snap.error &&
      now() - this.okAt < (opts.freshMs ?? FRESH_MS)
    )
      return Promise.resolve(this.snap.latest);
    this.set({ busy: true });
    // `inflight` is assigned before anything can settle: a synchronous throw from `ask` is a
    // rejection of this promise like any other, and its cleanup finds `run` already stored.
    const run: Promise<VersionCheck | null> = Promise.resolve()
      .then(ask)
      .then(
        (latest) => {
          this.okAt = now();
          this.set({ latest, error: null, busy: false });
          return latest;
        },
        (e: unknown) => {
          this.set({ error: e as Error, busy: false });
          return null;
        },
      )
      .finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    this.inflight = run;
    return run;
  }
}

const registry = new WeakMap<object, Map<string, SharedCheck>>();

/** The shared check for a source and channel. */
export function sharedCheckFor(
  source: object,
  channel: string | undefined,
): SharedCheck {
  let byChannel = registry.get(source);
  if (!byChannel) {
    byChannel = new Map();
    registry.set(source, byChannel);
  }
  const key = channel ?? "";
  let check = byChannel.get(key);
  if (!check) {
    check = new SharedCheck();
    byChannel.set(key, check);
  }
  return check;
}
