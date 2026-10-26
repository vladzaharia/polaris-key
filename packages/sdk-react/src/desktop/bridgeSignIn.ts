// The device-code session `signIn.start` hands back on the desktop (I-10a.10): the bridge's
// `beginSignIn` / `pollSignIn` verbs, unchanged. The host's Node client owns the poll credential
// and the real backoff (`wait({once: true})` in its main process); the renderer re-asks until a
// terminal answer. No new bridge verb.

import { ErrorCode } from "../constants.generated.js";
import { PolarisError } from "../core/index.js";
import {
  openUrl,
  type DeviceCodeSignInSession,
  type SignInOutcome,
} from "../core/signIn.js";
import type { BridgeOidcBegin, PolarisBridge } from "./bridge.js";

export interface BridgeSignInHooks {
  /** A person signed in: apply the host's fresh state, read the subject. */
  onSignedIn(identity?: {
    name?: string;
    email?: string;
  }): Promise<SignInOutcome>;
  onFailed(error: PolarisError): void;
  /** Cancelled, or the code expired. */
  onStopped(): void;
}

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const CANCELLED = Symbol("cancelled");

export class BridgeDeviceCodeSession implements DeviceCodeSignInSession {
  readonly channel = "device-code" as const;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly expiresAt: number;
  readonly deviceName: string | null;
  interval: number;
  readonly #bridge: PolarisBridge;
  readonly #flowId: string;
  readonly #hooks: BridgeSignInHooks;
  #cancelled = false;
  readonly #abort = new AbortController();

  constructor(
    bridge: PolarisBridge,
    begin: BridgeOidcBegin,
    deviceName: string | null,
    now: number,
    hooks: BridgeSignInHooks,
  ) {
    this.#bridge = bridge;
    this.#flowId = begin.flowId;
    this.#hooks = hooks;
    this.userCode = begin.userCode ?? "";
    this.verificationUri = begin.verificationUri ?? begin.verificationUrl ?? "";
    this.verificationUriComplete =
      begin.verificationUrl ?? begin.verificationUri ?? "";
    this.interval = begin.interval ?? 2;
    this.expiresAt = begin.expiresAt ?? now + 600;
    this.expiresIn = Math.max(0, Math.ceil(this.expiresAt - now));
    this.deviceName = deviceName;
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
    for (;;) {
      if (this.#cancelled) return { kind: "cancelled" };
      opts.signal?.throwIfAborted();
      const r = await this.#bridge.pollSignIn(this.#flowId);
      if (this.#cancelled) return { kind: "cancelled" };
      if (r.kind === "pending") {
        if (opts.once) return { kind: "pending", interval: this.interval };
        try {
          await delay(
            Math.max(1, this.interval) * 1000,
            this.#both(opts.signal),
          );
        } catch (e) {
          if (this.#cancelled) return { kind: "cancelled" };
          throw e;
        }
        continue;
      }
      if (r.kind === "ok") return this.#hooks.onSignedIn(r.identity);
      if (r.kind === "expired") {
        this.#hooks.onStopped();
        return { kind: "expired" };
      }
      const error = new PolarisError(
        r.kind === "denied" ? ErrorCode.signInDenied : ErrorCode.signInFailed,
        r.kind === "error" ? r.message : "device sign-in was refused.",
      );
      this.#hooks.onFailed(error);
      throw error;
    }
  }

  /** One signal for a single sleep: the session's cancel or the caller's abort. */
  #both(signal?: AbortSignal): AbortSignal {
    const c = new AbortController();
    const on = (s: AbortSignal) => () => c.abort(s.reason);
    this.#abort.signal.addEventListener("abort", on(this.#abort.signal), {
      once: true,
    });
    signal?.addEventListener("abort", on(signal), { once: true });
    return c.signal;
  }
}
