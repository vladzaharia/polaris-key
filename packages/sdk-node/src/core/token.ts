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
//
// ── WHICH ROUTE THE ONE ATTEMPT TAKES ───────────────────────────────────────────────────────
//
// §5's parenthesis: "Registered-without-license devices re-register instead; same
// single-attempt rule." `POST /<p>/license/token` needs a LICENSED device (and the route does
// not exist at all when License is off), so a config-only product's registered device would
// lose its credential for good on its first 401. `chooseReacquireRoute` picks
// `POST /<p>/devices/register` for such a device; the budget above is shared, so it is still
// one network call per pass whichever route is taken. A wrong guess is safe: register answers
// a licensed device `registration_closed`, license/token answers a licence-less one 401, and
// either way the single attempt is spent and the hard-401 path applies.

import { printAs, REDACTED } from "./redact.js";
import type { Store } from "@polaris-key/client-core";
import type { CoreContext } from "./context.js";

/** How the token was obtained, for the callers that care about the transition. */
export type TokenSource =
  | "activate"
  | "enroll"
  | "register"
  | "signin"
  | "reacquire";

/** The two routes the §5 single re-acquire can take. */
export type ReacquireRoute = "license-token" | "devices-register";

/** What `chooseReacquireRoute` decides from. Both inputs are local state; neither is a network
 *  read, so the decision costs nothing on the hot 401 path. */
export interface ReacquireInputs {
  /** `ctx.enabled("license")` — from discovery, `expectedServices` or the suite default. */
  licenseEnabled: boolean;
  /** How the CURRENT token was obtained in this process; null after a restart. */
  source: TokenSource | null;
}

/**
 * Pick the route for the §5 single re-acquire (P1b-06; the same rule in every SDK):
 *
 *   * License disabled for the product ⇒ `devices-register` (license/token does not exist);
 *   * the token was minted by `devices.register()` (or re-registered) in this process ⇒
 *     `devices-register`;
 *   * otherwise ⇒ `license-token`, as before.
 *
 * There is deliberately NO restart heuristic ("no verified licence document and no bundle ⇒
 * register"). After a restart a licensed device whose cache is empty is indistinguishable from
 * a licence-less one, and the recorded `sync-errors` transcript pins that state to
 * `POST /license/token`. Telling them apart needs the token source persisted, which is a
 * client-core store-contract (CacheRecordV3) change and therefore plan-mode.
 */
export function chooseReacquireRoute(i: ReacquireInputs): ReacquireRoute {
  if (!i.licenseEnabled) return "devices-register";
  if (i.source === "register") return "devices-register";
  return "license-token";
}

/** A re-acquired token and how it was obtained (which becomes the token's new source). */
export interface Reacquired {
  token: string;
  source: TokenSource;
}

/** Re-acquire the device token. Injected rather than imported so Core does not depend on the
 *  license or devices modules: the facade composes `chooseReacquireRoute` with the two mint
 *  routes, and the single-attempt rule here applies to whichever one it takes. */
export type ReacquireFn = (
  ctx: CoreContext,
  current: string,
  source: TokenSource | null,
) => Promise<Reacquired | null>;

export class TokenManager {
  private token: string | null = null;
  /** In memory only: persisting it would change client-core's store contract (CacheRecordV3),
   *  so after a restart the source is unknown and `chooseReacquireRoute` keys on License alone. */
  private tokenSource: TokenSource | null = null;
  private inFlight: Promise<boolean> | null = null;
  private attempted = false;

  constructor(
    private readonly ctx: CoreContext,
    private readonly store: Store,
    private readonly reacquireFn: ReacquireFn,
  ) {
    // `console.log(client)` reaches this object: it prints whether a token is held, never the
    // token (SP-46).
    printAs(this, () => ({
      token: this.token === null ? null : REDACTED,
      source: this.tokenSource,
    }));
  }

  async load(): Promise<void> {
    this.token = await this.store.getToken();
    this.tokenSource = null;
  }

  get current(): string | null {
    return this.token;
  }

  /** How the current token was obtained in this process; null when it was loaded from the
   *  store (a restart) or there is none. */
  get source(): TokenSource | null {
    return this.tokenSource;
  }

  async set(token: string, source: TokenSource): Promise<void> {
    this.token = token;
    this.tokenSource = source;
    await this.store.setToken(token);
  }

  async clear(): Promise<void> {
    this.token = null;
    this.tokenSource = null;
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
   *
   * It takes the SAME route a document fetch's 401 would (`chooseReacquireRoute`): §5's
   * single-attempt rule is about the device token, not about which call presented it, and a
   * licence-less device has no `license/token` route to take — sending it there would spend
   * the one attempt on a guaranteed 401.
   */
  async reacquire(): Promise<boolean> {
    const current = this.token;
    if (!current) return false;
    const next = await this.reacquireFn(
      this.ctx,
      current,
      this.tokenSource,
    ).catch(() => null);
    if (!next) return false;
    await this.set(next.token, next.source);
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
      const next = await this.reacquireFn(
        this.ctx,
        current,
        this.tokenSource,
      ).catch(() => null);
      if (!next) return false;
      await this.set(next.token, next.source);
      return true;
    })();
    return this.inFlight;
  }
}
