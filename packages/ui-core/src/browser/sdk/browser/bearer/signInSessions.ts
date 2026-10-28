// The sessions `signIn.start` hands back in bearer mode (I-10a.10): a device-code session over
// `BearerSession`'s poll engine, and a single-use redirect session over its redeem. The adapter
// supplies `onSettled`, which applies the state a sign-in changed and fetches the subject.

import type { RedirectPending } from "@polaris-key/client-core";
import { ErrorCode } from "../../constants.generated.js";
import { PolarisError } from "../../core/types.js";
import {
  openUrl,
  type DeviceCodeSignInSession,
  type RedirectSignInSession,
  type SignInOutcome,
} from "../../core/signIn.js";
import type { BearerSession, SignInPrompt } from "./session.js";

/** What the adapter does once a sign-in ended: apply the state, fetch the subject. `signedIn`
 *  outcomes come back with the subject filled in; every other outcome is a notification. */
export interface SettleHooks {
  onSettled(outcome: SignInOutcome): Promise<SignInOutcome>;
  /** The sign-in failed or was refused (thrown to the caller too). */
  onFailed(error: PolarisError): void;
  /** The sign-in was cancelled or expired before it finished. */
  onStopped(): void;
}

/** The loop's per-wait cancel reason. */
const CANCELLED = Symbol("cancelled");

export class BearerDeviceCodeSession implements DeviceCodeSignInSession {
  readonly channel = "device-code" as const;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly expiresAt: number;
  readonly deviceName: string | null;
  interval: number;
  readonly #prompt: SignInPrompt;
  readonly #session: BearerSession;
  readonly #hooks: SettleHooks;
  #cancelled = false;
  readonly #abort = new AbortController();

  constructor(
    session: BearerSession,
    prompt: SignInPrompt,
    hooks: SettleHooks,
  ) {
    this.#session = session;
    this.#prompt = prompt;
    this.#hooks = hooks;
    this.userCode = prompt.userCode;
    this.verificationUri = prompt.verificationUri;
    this.verificationUriComplete = prompt.verificationUriComplete;
    this.expiresIn = prompt.expiresIn;
    this.expiresAt = prompt.expiresAt;
    this.deviceName = prompt.deviceName;
    this.interval = prompt.interval;
  }

  reopen(): Promise<boolean> {
    return openUrl(this.verificationUriComplete);
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#abort.abort(CANCELLED);
    this.#hooks.onStopped();
  }

  async wait(
    opts: { signal?: AbortSignal; once?: boolean } = {},
  ): Promise<SignInOutcome> {
    if (this.#cancelled) return { kind: "cancelled" };
    opts.signal?.throwIfAborted();
    if (opts.once) return this.#once();
    // One controller per wait: the session's cancel and the caller's signal both end it.
    const wait = new AbortController();
    const forward = (s: AbortSignal) => () => wait.abort(s.reason);
    const fromCancel = forward(this.#abort.signal);
    const fromCaller = opts.signal ? forward(opts.signal) : null;
    this.#abort.signal.addEventListener("abort", fromCancel, { once: true });
    if (opts.signal && fromCaller)
      opts.signal.addEventListener("abort", fromCaller, { once: true });
    try {
      const done = await this.#session.waitForSignIn(this.#prompt, {
        signal: wait.signal,
      });
      return await this.#settle(done);
    } catch (e) {
      if (this.#cancelled) return { kind: "cancelled" };
      throw e;
    } finally {
      this.#abort.signal.removeEventListener("abort", fromCancel);
      if (opts.signal && fromCaller)
        opts.signal.removeEventListener("abort", fromCaller);
    }
  }

  async #once(): Promise<SignInOutcome> {
    const poll = await this.#session.pollSignIn(this.#prompt, this.interval);
    if (this.#cancelled) return { kind: "cancelled" };
    if (poll.status === "pending")
      return { kind: "pending", interval: this.interval };
    if (poll.status === "slow-down") {
      this.interval = Math.max(this.interval, poll.interval);
      return { kind: "pending", interval: this.interval, slowDown: true };
    }
    return this.#settle(poll);
  }

  async #settle(
    done: Awaited<ReturnType<BearerSession["waitForSignIn"]>>,
  ): Promise<SignInOutcome> {
    if (done.status === "ready")
      return this.#hooks.onSettled({
        kind: "signedIn",
        subject: null,
        activation: { licenseId: null },
        ...(done.identity ? { identity: done.identity } : {}),
      });
    if (done.status === "expired") {
      this.#hooks.onStopped();
      return { kind: "expired" };
    }
    const error = new PolarisError(
      done.code ?? ErrorCode.signInFailed,
      done.message,
    );
    this.#hooks.onFailed(error);
    throw error;
  }
}

export class BearerRedirectSession implements RedirectSignInSession {
  readonly channel = "redirect" as const;
  readonly authorizeUrl: string;
  #pending: RedirectPending | null;
  readonly #session: BearerSession;
  readonly #deviceName: string | null;
  readonly #hooks: SettleHooks;
  readonly #forget: (state: string) => void;

  constructor(
    session: BearerSession,
    pending: RedirectPending,
    deviceName: string | null,
    hooks: SettleHooks,
    forget: (state: string) => void,
  ) {
    this.#session = session;
    this.#pending = pending;
    this.authorizeUrl = pending.authorizeUrl;
    this.#deviceName = deviceName;
    this.#hooks = hooks;
    this.#forget = forget;
  }

  cancel(): void {
    const p = this.#pending;
    this.#pending = null;
    if (p) {
      this.#forget(p.state);
      this.#hooks.onStopped();
    }
  }

  async complete(callbackUrl: string): Promise<SignInOutcome> {
    const pending = this.#pending;
    // One use, whatever happens next: a replayed callback never reaches the token endpoint.
    this.#pending = null;
    if (pending === null)
      throw new PolarisError(
        ErrorCode.signInFailed,
        "this sign-in is already finished or was cancelled; start a new one.",
      );
    this.#forget(pending.state);
    return completeRedirect(
      this.#session,
      pending,
      callbackUrl,
      this.#deviceName,
      this.#hooks,
    );
  }
}

/** Redeem a callback for a pending redirect (the session's `complete` and the namespace's). */
export async function completeRedirect(
  session: BearerSession,
  pending: RedirectPending,
  callbackUrl: string,
  deviceName: string | null,
  hooks: SettleHooks,
): Promise<SignInOutcome> {
  let outcome: SignInOutcome;
  try {
    outcome = await session.redeemRedirect(pending, callbackUrl, deviceName);
  } catch (e) {
    const error =
      e instanceof PolarisError
        ? e
        : new PolarisError(ErrorCode.signInFailed, (e as Error).message);
    hooks.onFailed(error);
    throw error;
  }
  if (outcome.kind === "signedIn") return hooks.onSettled(outcome);
  hooks.onStopped();
  return outcome;
}
