// The device exchange (D6, WIRE-CONTRACT-V5 §12.13.10), the client half every SDK shares:
// `identity.accessToken()` trades the device's own `pkeyt_` token for a 600 second access token
// (`at+jwt`) for the app's own backend.
//
//   1. `accessTokenRequest`  the form of `POST <identity token endpoint>`.
//   2. `readAccessToken`     the `200` answer, read for exactly what §12.13.10 rule 3 fixes.
//   3. `AccessTokenCache`    memory only, bound to the device token, one request at a time,
//                            reused until `expires_in − 60` seconds have passed, a 429's wait
//                            honoured, dropped on sign-out.
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

/** The longest `access_token` accepted (8 KiB): a larger one is `bad_response`. */
export const ACCESS_TOKEN_MAX_LENGTH = 8192;

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
    token.length > ACCESS_TOKEN_MAX_LENGTH ||
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
 * The one in-memory access token of a client, bound to the device token it was asked with (the
 * `key`: a replaced token, another account's sign-in or a re-activation is a different key, so
 * nobody is handed a token that belongs to another sign-in). `get` returns the held token while
 * it is for this key and more than {@link ACCESS_TOKEN_REUSE_MARGIN_SECONDS} seconds remain,
 * and otherwise runs `exchange` once: callers with the same key that arrive while it runs share
 * its answer, a caller with another key starts its own. `refresh: true` skips the held token
 * (an app whose backend refused it asks for a new one); it still joins an exchange in flight.
 * A refused or failed exchange is not cached, except that a `rate_limited` answer carrying
 * `retryAfterSeconds` is remembered: until that wait has passed `get` fails fast with
 * `rate_limited`, sending nothing, `refresh` included. `clear` drops all of it and detaches any
 * exchange in flight, so its answer is not kept after a sign-out.
 */
export class AccessTokenCache {
  #held: { key: string; token: AccessToken } | null = null;
  #pending: { key: string; run: Promise<AccessToken> } | null = null;
  #limited: { key: string; until: number } | null = null;

  /** `limited` builds the error of a fail-fast, for an SDK with its own error class; by default
   *  a client-core `PolarisError`. */
  constructor(
    private readonly now: () => number,
    private readonly limited: (retryAfterSeconds: number) => Error = (
      retryAfterSeconds,
    ) =>
      new PolarisError(
        "rate_limited",
        "the access token exchange is rate limited; wait before asking again.",
        { retryAfterSeconds },
      ),
  ) {}

  async get(
    key: string,
    exchange: () => Promise<AccessTokenGrant>,
    opts: { refresh?: boolean } = {},
  ): Promise<AccessToken> {
    const t = this.now();
    const held = this.#held;
    if (
      opts.refresh !== true &&
      held !== null &&
      held.key === key &&
      held.token.expiresAt - ACCESS_TOKEN_REUSE_MARGIN_SECONDS > t
    )
      return { ...held.token, expiresIn: held.token.expiresAt - t };
    if (this.#pending !== null && this.#pending.key === key)
      return this.#pending.run;
    const wait = this.#limited;
    if (wait !== null && wait.key === key) {
      if (wait.until > t) throw this.limited(wait.until - t);
      this.#limited = null;
    }
    // Assigned below, before anything in the body can run past its first await.
    let run!: Promise<AccessToken>;
    run = (async () => {
      let grant: AccessTokenGrant;
      try {
        grant = await exchange();
      } catch (e) {
        // Structural: an SDK with its own error class (the browser's) raises the same shape.
        const { code, retryAfterSeconds: wait } = (e ?? {}) as {
          code?: unknown;
          retryAfterSeconds?: unknown;
        };
        if (
          this.#pending?.run === run &&
          code === "rate_limited" &&
          typeof wait === "number" &&
          wait > 0
        )
          this.#limited = { key, until: this.now() + wait };
        throw e;
      }
      const at = this.now();
      const token: AccessToken = {
        accessToken: grant.accessToken,
        tokenType: "Bearer",
        expiresIn: grant.expiresIn,
        expiresAt: at + grant.expiresIn,
      };
      // Kept only while this is still the client's exchange: a `clear()` or a caller with
      // another key took it over.
      if (this.#pending?.run === run) this.#held = { key, token };
      return token;
    })();
    this.#pending = { key, run };
    try {
      return await run;
    } finally {
      if (this.#pending?.run === run) this.#pending = null;
    }
  }

  /** Drop the token, the rate-limit wait and any exchange in flight (sign-out, deactivation). */
  clear(): void {
    this.#held = null;
    this.#pending = null;
    this.#limited = null;
  }
}
