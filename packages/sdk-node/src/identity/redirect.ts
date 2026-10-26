// Redirect sign-in (I-08 WIRE-CONTRACT-V4 §12.4, §12.5; I-10a.7): `signIn.start({channel:
// "redirect", redirectUri})` builds the authorize URL for a browser the HOST opens (a system
// browser, a webview), and `complete(callbackUrl)` redeems the code the redirect brought back.
//
// The rules live in client-core's `identityRedirect.ts`, one implementation for Node and React:
// S256 PKCE only, `state` and the discovery `iss` checked before anything is sent, a form-encoded
// token request. This file is the Node half: discovery, the HTTP, the stored device token.
//
// The session is SINGLE USE. `complete` and `cancel` drop the PKCE verifier before their first
// await; a second `complete` (a replayed callback) is refused locally without a request. A
// refused or failed completion never wipes the device token, the cache or the stored identity:
// only a `signedIn` outcome changes state.
//
// The host supplies an `https:` redirect URI the product registered. Loopback, custom-scheme and
// claimed-HTTPS redirects are I-15's.

import {
  PolarisError,
  TOKEN_CONTENT_TYPE,
  checkCallback,
  parseTokenAnswer,
  startRedirect,
  tokenForm,
  type RedirectPending,
  type TokenAnswer,
} from "@polaris-key/client-core";
import type {
  AuthorizeLicenseChoice,
  AuthorizePurpose,
} from "@polaris-key/protocol/identity";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import type { ProductDiscoveryDocument } from "../discovery.js";
import { writeStoredSubject } from "./account.js";
import type { IdentityEvent } from "./signIn.js";

export interface RedirectSignInOptions {
  channel: "redirect";
  /** The `https:` URI the product registered; the browser lands there with the code. */
  redirectUri: string;
  /** Default `profile email`. */
  scope?: string | readonly string[];
  /** Prefills the card (§12.4). Verifies nothing. */
  loginHint?: string;
  nameHint?: string;
  purpose?: AuthorizePurpose;
  /** `"app"`: the app shows the licence choice itself. Honoured only when discovery has the
   *  `choice*` endpoints; otherwise the card chooses. */
  licenseChoice?: AuthorizeLicenseChoice;
  /** The device label the Worker stores (§12.7.1), else the client's default. */
  deviceName?: string;
}

/** How a redirect sign-in ended. A refusal is a thrown `PolarisError` (`invalid_grant`,
 *  `rate_limited`, `sign-in-failed`, …); the Cancel button is an outcome. */
export type RedirectOutcome =
  | {
      kind: "signedIn";
      /** The pairwise account subject (`ps_…`). */
      subject: string;
      /** The granted scope, space-delimited. */
      scope: string;
      /** The licence the device runs on, or null on a device with none. */
      licenseId: string | null;
      /** The activation the sign-in produced (the same as `licenseId`, in the session shape). */
      activation: { licenseId: string | null };
    }
  /** `license_choice=app` and a choice is due: show it, then `identity.choice.*` with `grant`
   *  (I-10a.8). No token was stored. */
  | {
      kind: "choose";
      grant: string;
      expiresIn: number;
      choices: Record<string, unknown>;
    }
  | { kind: "cancelled" };

/** What the session needs from the identity client. */
export interface RedirectDeps {
  ctx: CoreContext;
  tokens: TokenManager;
  /** Discovery, loading it first when this session has not. */
  discovery: () => Promise<ProductDiscoveryDocument | null>;
  /** The post-acquisition sync, as after a device-code `ready`. */
  onAcquired: () => Promise<void>;
  /** Forget the stored identity file (a redirect token answers no name or email). */
  forget: () => Promise<void>;
  /** Conformance replay only: the exact `state` and verifier of a recorded conversation. */
  entropy?: { state?: string; codeVerifier?: string };
  emit?: (e: IdentityEvent) => void;
}

export class RedirectSession {
  readonly channel = "redirect" as const;
  /** Open this in the browser. It carries the challenge and `state`, never the verifier. */
  readonly authorizeUrl: string;
  #pending: RedirectPending | null;
  readonly #deps: RedirectDeps;
  readonly #deviceName: string | null;

  constructor(
    pending: RedirectPending,
    deps: RedirectDeps,
    deviceName: string | null,
  ) {
    this.authorizeUrl = pending.authorizeUrl;
    this.#pending = pending;
    this.#deps = deps;
    this.#deviceName = deviceName;
  }

  /** Forget the pending request (the host closed the browser). `complete` then refuses. */
  cancel(): void {
    this.#pending = null;
  }

  /**
   * Redeem the callback the browser was sent to. Checks `state` and `iss` first (a mismatch is
   * `sign-in-failed`, nothing sent), then POSTs the form body to discovery's `token` endpoint.
   * `error=access_denied` resolves `{kind: "cancelled"}`; any other callback error is
   * `sign-in-failed`. The Worker's refusal is thrown under its own code (`invalid_grant`,
   * `invalid_client`, `rate_limited` with `retryAfterSeconds`, …).
   */
  async complete(callbackUrl: string): Promise<RedirectOutcome> {
    const pending = this.#pending;
    // One use, whatever happens next: a replayed callback never reaches the token endpoint.
    this.#pending = null;
    if (pending === null)
      throw new PolarisError(
        ErrorCode.signInFailed,
        "this sign-in is already finished or was cancelled; start a new one.",
      );
    const checked = checkCallback(pending, callbackUrl);
    if (checked.kind === "cancelled") return { kind: "cancelled" };
    if (checked.kind === "failed")
      throw new PolarisError(
        ErrorCode.signInFailed,
        `the sign-in redirect was refused (${checked.reason}).`,
      );
    const { ctx, tokens } = this.#deps;
    const res = await ctx.request(
      pending.tokenEndpoint,
      {
        method: "POST",
        headers: ctx.headers({ "content-type": TOKEN_CONTENT_TYPE }),
        body: tokenForm(pending, checked.code, this.#deviceName ?? undefined),
      },
      "redirect sign-in token",
    );
    const body: unknown = await res
      .text()
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => null);
    const answer: TokenAnswer = parseTokenAnswer(res.status, body);
    switch (answer.kind) {
      case "malformed":
        throw new PolarisError(
          ErrorCode.badResponse,
          "the token endpoint answered without a complete sign-in.",
          { status: res.status },
        );
      case "refused": {
        const retry = res.headers.get("retry-after");
        const retryAfterSeconds =
          answer.retryAfterSeconds ??
          (retry !== null && /^\d+$/.test(retry.trim())
            ? Number(retry)
            : undefined);
        throw new PolarisError(
          answer.status >= 500 ? ErrorCode.serverError : answer.error,
          `the token endpoint refused the sign-in (${answer.error}).`,
          {
            status: answer.status,
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
            ...(answer.status >= 500 ? { wireCode: answer.error } : {}),
          },
        );
      }
      case "choose":
        return {
          kind: "choose",
          grant: answer.grant,
          expiresIn: answer.expiresIn,
          choices: answer.choices,
        };
      case "token": {
        await tokens.set(answer.accessToken, "signin");
        await this.#deps.forget();
        await writeStoredSubject(ctx.dirs.state, answer.subject);
        await this.#deps.onAcquired();
        this.#deps.emit?.({ kind: "signedIn", subject: answer.subject });
        const licenseId =
          answer.license && typeof answer.license.id === "string"
            ? answer.license.id
            : null;
        return {
          kind: "signedIn",
          subject: answer.subject,
          scope: answer.scope,
          licenseId,
          activation: { licenseId },
        };
      }
    }
  }
}

/**
 * Begin a redirect sign-in. Refuses before any request when the product does not run Identity
 * (`service-unavailable`) or its discovery serves no `authorize`, `token` or `issuer`
 * (`sign-in-unavailable`): an endpoint is used only when discovery names it, never built.
 */
export async function startRedirectSignIn(
  deps: RedirectDeps,
  opts: RedirectSignInOptions,
): Promise<RedirectSession> {
  const { ctx } = deps;
  ctx.requireService("identity", Feature.identityRedirectWeb);
  const doc = await deps.discovery();
  const fragment = doc?.services?.identity;
  const endpoints = (fragment?.endpoints ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;
  const authorizeEndpoint = str(endpoints.authorize);
  const tokenEndpoint = str(endpoints.token);
  const issuer = str((fragment as { issuer?: unknown } | undefined)?.issuer);
  if (!authorizeEndpoint || !tokenEndpoint || !issuer)
    throw new PolarisError(
      ErrorCode.signInUnavailable,
      "this product's discovery serves no redirect sign-in.",
    );
  const choiceAvailable = [
    "choiceLicenses",
    "choiceDevices",
    "choiceComplete",
    "choiceCancel",
  ].every((k) => str(endpoints[k]) !== undefined);
  const pending = await startRedirect({
    authorizeEndpoint,
    tokenEndpoint,
    issuer,
    clientId: ctx.product,
    redirectUri: opts.redirectUri,
    choiceAvailable,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.loginHint !== undefined ? { loginHint: opts.loginHint } : {}),
    ...(opts.nameHint !== undefined ? { nameHint: opts.nameHint } : {}),
    ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
    ...(opts.licenseChoice !== undefined
      ? { licenseChoice: opts.licenseChoice }
      : {}),
    ...(deps.entropy?.state !== undefined ? { state: deps.entropy.state } : {}),
    ...(deps.entropy?.codeVerifier !== undefined
      ? { codeVerifier: deps.entropy.codeVerifier }
      : {}),
  });
  return new RedirectSession(pending, deps, ctx.deviceLabel(opts.deviceName));
}
