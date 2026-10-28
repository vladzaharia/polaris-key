// The redirect sign-in's request and token legs (WIRE-CONTRACT-V4 §12.4, §12.5), loaded on first
// use: the PKCE and token-form code is not needed until a page signs in by redirect or completes
// a licence choice, so the provider's first load leaves it out. `BearerSession` keeps the guards
// and the token storage; this file holds only the parts that read client-core's redirect module.

import {
  TOKEN_CONTENT_TYPE,
  checkCallback,
  parseTokenAnswer,
  startRedirect,
  tokenForm,
  type RedirectPending,
  type TokenAnswer,
} from "@polaris-key/client-core";
import { ERROR_CODE_VALUES, ErrorCode } from "../../constants.generated.js";
import { PolarisError, type PolarisErrorCode } from "../../core/types.js";
import type {
  RedirectEndpoints,
  RedirectSignInOptions,
  SignInOutcome,
} from "../../core/signIn.js";
import { parseRetryAfter } from "./session.js";

export { parseTokenAnswer };

/** What `BearerSession.startRedirect` hands over once its guards pass. */
export interface StartRedirectInput {
  endpoints: RedirectEndpoints;
  clientId: string;
  options: Omit<RedirectSignInOptions, "channel">;
  entropy: { state?: string; codeVerifier?: string };
}

export async function beginRedirect(
  input: StartRedirectInput,
): Promise<RedirectPending> {
  const { options: opts, entropy } = input;
  // client-core's own `PolarisError` (a bad redirect URI, state or verifier) becomes this
  // package's, with the same code.
  return await startRedirect({
    ...input.endpoints,
    clientId: input.clientId,
    redirectUri: opts.redirectUri,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.loginHint !== undefined ? { loginHint: opts.loginHint } : {}),
    ...(opts.nameHint !== undefined ? { nameHint: opts.nameHint } : {}),
    ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
    ...(opts.licenseChoice !== undefined
      ? { licenseChoice: opts.licenseChoice }
      : {}),
    ...(entropy.state !== undefined ? { state: entropy.state } : {}),
    ...(entropy.codeVerifier !== undefined
      ? { codeVerifier: entropy.codeVerifier }
      : {}),
  }).catch((e: unknown) => {
    const code = (e as { code?: unknown }).code;
    throw new PolarisError(
      typeof code === "string" &&
        (ERROR_CODE_VALUES as readonly string[]).includes(code)
        ? (code as PolarisErrorCode)
        : ErrorCode.signInUnavailable,
      (e as Error).message,
    );
  });
}

export interface RedeemInput {
  pending: RedirectPending;
  callbackUrl: string;
  deviceName: string | null | undefined;
  fetchImpl: typeof fetch;
  /** The request headers for the token POST, `content-type` not yet set. */
  headers: (extra: Record<string, string>) => Record<string, string>;
  now: number;
  /** The device's own token and the product's base: a device that holds its token presents it
   *  (V4 §12.5), so the sign-in keeps its licence and refreshes the step-up the link offer needs.
   *  Only to the Worker that issued it: an endpoint off the base gets none. */
  held?: { token: string | null; baseUrl: string };
}

/**
 * Checks the callback and POSTs the form to the token endpoint. Answers the outcome for a
 * cancelled callback or a licence choice, or the token answer for the caller to store; every
 * refusal is thrown under its own code.
 */
export async function redeemCallback(
  input: RedeemInput,
): Promise<SignInOutcome | Extract<TokenAnswer, { kind: "token" }>> {
  const { pending } = input;
  const checked = checkCallback(pending, input.callbackUrl);
  if (checked.kind === "cancelled") return { kind: "cancelled" };
  if (checked.kind === "failed")
    throw new PolarisError(
      ErrorCode.signInFailed,
      `the sign-in redirect was refused (${checked.reason}).`,
    );
  let res: Response;
  try {
    res = await input.fetchImpl(pending.tokenEndpoint, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: input.headers({
        "content-type": TOKEN_CONTENT_TYPE,
        ...(input.held?.token &&
          pending.tokenEndpoint.startsWith(`${input.held.baseUrl}/`) && {
            authorization: `Bearer ${input.held.token}`,
          }),
      }),
      body: tokenForm(pending, checked.code, input.deviceName ?? undefined),
    });
  } catch (e) {
    throw new PolarisError(ErrorCode.networkError, (e as Error).message);
  }
  const body: unknown = await res
    .text()
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);
  const answer = parseTokenAnswer(res.status, body);
  switch (answer.kind) {
    case "malformed":
      throw new PolarisError(
        ErrorCode.badResponse,
        "the token endpoint answered without a complete sign-in.",
        undefined,
        undefined,
        { status: res.status },
      );
    case "refused": {
      const retry = parseRetryAfter(res.headers.get("retry-after"), input.now);
      const retryAfterSeconds = answer.retryAfterSeconds ?? retry;
      const server = answer.status >= 500;
      const known = (ERROR_CODE_VALUES as readonly string[]).includes(
        answer.error,
      );
      throw new PolarisError(
        server
          ? ErrorCode.serverError
          : known
            ? (answer.error as PolarisErrorCode)
            : "http-error",
        `the token endpoint refused the sign-in (${answer.error}).`,
        answer.error,
        undefined,
        {
          status: answer.status,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
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
    case "token":
      return answer;
  }
}
