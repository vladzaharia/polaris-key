// The device credential — wire contract v3 §6.
//
// A `pkeyt_` token is what a device authenticates every document fetch with. Core holds it
// because it is the DEVICE's credential, not the licence's: a config-only product's registered
// devices hold real tokens with no licence behind them (D-08), and the token survives a licence
// changing tier or expiring.
//
// ── THE ONE RE-ACQUIRE ──────────────────────────────────────────────────────────────────────
//
// §5: a 401 gets exactly ONE `POST /<p>/license/token` attempt, then one retry of the failed
// fetch. Not a loop — a device whose token has genuinely been revoked would otherwise hammer
// the control plane forever, and the recorded hard 401 is the offline revocation signal (§4.3)
// that a retry loop would keep postponing.
//
// v3 makes that rule harder to state than v2 did, because `sync()` now fetches license and
// config IN PARALLEL and both can 401 at the same instant. `reacquireOnce` collapses them:
// the first caller starts the attempt, every other caller in the same sync pass awaits THAT
// promise, and the result is one network call no matter how many documents were in flight.
// `beginPass()` (called once per `sync()`) is what re-arms it — without that the memo would
// make the second sync of a session unable to recover from a rotated token.

import type { Store } from "@polaris-key/client-core";
import type { CoreContext } from "./context.js";

/** How the token was obtained, for the callers that care about the transition. */
export type TokenSource = "activate" | "enroll" | "register" | "reacquire";

/** Re-acquire the device token. Injected rather than imported so Core does not depend on the
 *  license module: for a registered-without-licence device the mint path is
 *  `POST /devices/register`, and the same single-attempt rule applies to it. */
export type ReacquireFn = (
  ctx: CoreContext,
  current: string,
) => Promise<string | null>;

export class TokenManager {
  private token: string | null = null;
  private inFlight: Promise<boolean> | null = null;
  private attempted = false;

  constructor(
    private readonly ctx: CoreContext,
    private readonly store: Store,
    private readonly reacquireFn: ReacquireFn,
  ) {}

  async load(): Promise<void> {
    this.token = await this.store.getToken();
  }

  get current(): string | null {
    return this.token;
  }

  async set(token: string): Promise<void> {
    this.token = token;
    await this.store.setToken(token);
  }

  async clear(): Promise<void> {
    this.token = null;
    await this.store.clearToken();
  }

  /** Re-arm the single-attempt budget. Called once at the top of each `sync()`. */
  beginPass(): void {
    this.inFlight = null;
    this.attempted = false;
  }

  /**
   * The single re-acquire for an authenticated call made OUTSIDE a sync pass (an edge-mint).
   * One attempt per call, never a loop: the caller retries its request once when this returns
   * true and fails on a second 401. It does not touch the sync pass's budget.
   */
  async reacquire(): Promise<boolean> {
    const current = this.token;
    if (!current) return false;
    const next = await this.reacquireFn(this.ctx, current).catch(() => null);
    if (!next) return false;
    await this.set(next);
    return true;
  }

  /**
   * At most one re-acquire per sync pass, shared across every concurrent 401.
   *
   * Returns true when a NEW token is in hand and the caller should retry its fetch once;
   * false when the attempt already happened and failed, or is not available.
   */
  async reacquireOnce(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (this.attempted) return false;
    const current = this.token;
    if (!current) return false;
    this.attempted = true;
    this.inFlight = (async () => {
      const next = await this.reacquireFn(this.ctx, current).catch(() => null);
      if (!next) return false;
      await this.set(next);
      return true;
    })();
    return this.inFlight;
  }
}
