// The device exchange (D6, WIRE-CONTRACT-V5 §12.13.10), the client half every SDK shares:
// `identity.accessToken()` trades the device's own `pkeyt_` token for a 600 second access token
// (`at+jwt`) for the app's own backend.
//
//   1. `accessTokenRequest`  the form of `POST <identity token endpoint>`.
//   2. `readAccessToken`     the `200` answer, read for exactly what §12.13.10 rule 3 fixes.
//   3. `AccessTokenCache`    memory only, one request at a time, reused until `expires_in − 60`
//                            seconds have passed, dropped on sign-out.
//
// WHAT THE TOKEN IS: proof that this device holds a sign-in, for the developer's backend
// (`sub` is the device's pairwise subject, `client_id` the product slug). It is NOT a licence
// check: it carries no tier and no entitlement, and a signed-in device has it whether or not it
// holds a valid licence. A backend that sells a licensed feature checks the licence (the server
// drop-ins) as well.
//
// There is no verifier here. The app does not verify its own token: its backend does, against
// the issuer's key set, which discovery names. The module has no I/O; the caller sends the form
// and maps a refusal in its own error taxonomy (`invalid_grant`, `invalid_request`,
// `rate_limited` are the wire codes the Worker answers).

import {
  ACCESS_TOKEN_TYPE,
  DEVICE_SUBJECT_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  type AccessTokenExchangeParams,
} from "@polaris-key/protocol/identity";
import { PolarisError } from "./errors.js";
import { formBody, TOKEN_CONTENT_TYPE } from "./identityRedirect.js";

/** §12.13.10 rule 4: a cached token is reused until this many seconds before it expires. */
export const ACCESS_TOKEN_REUSE_MARGIN_SECONDS = 60;

/** What `identity.accessToken()` answers. */
export interface AccessToken {
  /** The compact `at+jwt`, for `Authorization: Bearer …` on the app's own backend. Kept in
   *  memory only: never stored, never logged. */
  accessToken: string;
  tokenType: "Bearer";
  /** Seconds left on the token when it was handed out. A fresh exchange answers 600. */
  expiresIn: number;
  /** Epoch seconds, by the SDK's clock. */
  expiresAt: number;
}

/** The request to send: `POST url` with `Content-Type` {@link TOKEN_CONTENT_TYPE}, the device's
 *  `X-PKey-Device` and no `Authorization` header. */
export interface AccessTokenRequest {
  url: string;
  contentType: typeof TOKEN_CONTENT_TYPE;
  /** The form body, ready to send. */
  body: string;
  /** The same parameters, as a record. */
  params: AccessTokenExchangeParams;
}

export interface AccessTokenRequestOptions {
  /** Discovery's `identity.endpoints.token`. */
  tokenEndpoint: string;
  /** The product slug: the product's own client. */
  clientId: string;
  /** The device's own `pkeyt_` token. */
  deviceToken: string;
}

/** Build the exchange form. Parameter order is fixed so every SDK sends the same bytes. */
export function accessTokenRequest(
  o: AccessTokenRequestOptions,
): AccessTokenRequest {
  if (!/^https?:\/\/[^\s]+$/.test(o.tokenEndpoint))
    throw new PolarisError(
      "bad_response",
      "the token endpoint is not an absolute URL.",
    );
  if (o.clientId === "" || o.deviceToken === "")
    throw new PolarisError(
      "invalid-argument",
      "an access token needs the product and the device token.",
    );
  const params: AccessTokenExchangeParams = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    client_id: o.clientId,
    subject_token: o.deviceToken,
    subject_token_type: DEVICE_SUBJECT_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
  };
  return {
    url: o.tokenEndpoint,
    contentType: TOKEN_CONTENT_TYPE,
    body: formBody(Object.entries(params)),
    params,
  };
}

/** What a `200` carries, as the cache holds it. */
export interface AccessTokenGrant {
  accessToken: string;
  /** Seconds the issuer gave the token (`expires_in`). */
  expiresIn: number;
}

/**
 * Read a `200` answer. It carries exactly an `access_token` (a compact JWS: three dot-separated
 * parts), `issued_token_type` the access-token type, `token_type` `Bearer`, a positive integer
 * `expires_in` and `scope` `""`; anything else is `bad_response`. Nothing is verified: the
 * token's signature is the backend's to check.
 */
export function readAccessToken(body: unknown): AccessTokenGrant {
  const b =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const token = b.access_token;
  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
    b.issued_token_type !== ACCESS_TOKEN_TYPE ||
    b.token_type !== "Bearer" ||
    typeof b.expires_in !== "number" ||
    !Number.isInteger(b.expires_in) ||
    b.expires_in <= 0
  )
    throw new PolarisError(
      "bad_response",
      "the access token exchange answered without a usable access token.",
    );
  return { accessToken: token, expiresIn: b.expires_in };
}

/**
 * The one in-memory access token of a client. `get` returns the held token while more than
 * {@link ACCESS_TOKEN_REUSE_MARGIN_SECONDS} seconds remain and otherwise runs `exchange` once:
 * callers that arrive while it runs share its answer. `refresh: true` skips the held token (an
 * app whose backend refused it asks for a new one); it still joins an exchange in flight. A refused or failed exchange is not
 * cached (the next call asks again, and the Worker's own limit applies). `clear` drops the
 * token and detaches any exchange in flight, so its answer is not kept after a sign-out.
 */
export class AccessTokenCache {
  #held: AccessToken | null = null;
  #pending: Promise<AccessToken> | null = null;
  #generation = 0;

  constructor(private readonly now: () => number) {}

  async get(
    exchange: () => Promise<AccessTokenGrant>,
    opts: { refresh?: boolean } = {},
  ): Promise<AccessToken> {
    const t = this.now();
    const held = this.#held;
    if (
      opts.refresh !== true &&
      held !== null &&
      held.expiresAt - ACCESS_TOKEN_REUSE_MARGIN_SECONDS > t
    )
      return { ...held, expiresIn: held.expiresAt - t };
    if (this.#pending !== null) return this.#pending;
    const generation = this.#generation;
    const run: Promise<AccessToken> = (async () => {
      const grant = await exchange();
      const at = this.now();
      const token: AccessToken = {
        accessToken: grant.accessToken,
        tokenType: "Bearer",
        expiresIn: grant.expiresIn,
        expiresAt: at + grant.expiresIn,
      };
      // A `clear()` while the exchange ran means the answer is not this client's to keep.
      if (this.#generation === generation) this.#held = token;
      return token;
    })();
    this.#pending = run;
    try {
      return await run;
    } finally {
      if (this.#pending === run) this.#pending = null;
    }
  }

  /** Drop the token and any exchange in flight (sign-out, deactivation). */
  clear(): void {
    this.#generation++;
    this.#held = null;
    this.#pending = null;
  }
}
