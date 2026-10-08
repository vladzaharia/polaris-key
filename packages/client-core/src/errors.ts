// The one error type the client core throws. Everything on the verification path fails
// CLOSED by returning `null` rather than throwing (see verify.ts / trust.ts); `PolarisError`
// is for the transport and orchestration layers built on top of this package, where the
// caller needs the server's machine-readable error code rather than a message to regex.

import type { PolarisErrorCode } from "@polaris-key/protocol/core";

/** What a transport layer knows about a failed request beyond its code. Every field is optional:
 *  a refusal decided locally has none of them. */
export interface PolarisErrorDetails {
  /** The HTTP status the server answered with. Absent when no answer arrived. */
  status?: number;
  /** Whole seconds to wait before retrying, from the answer's `Retry-After` header. */
  retryAfterSeconds?: number;
  /** The server's own code when `code` is the SDK's class for the answer (a 5xx's
   *  `misconfigured` under `server-error`). Absent when the two are the same. */
  wireCode?: string;
  /** The underlying failure (a transport `TypeError`, a timeout), chained as `Error.cause`. */
  cause?: unknown;
}

export class PolarisError extends Error {
  /** The wire error code (`PolarisErrorBody.error.code`). Widened to `string` because the
   *  server may introduce a code this client predates — the caller still gets the raw value
   *  instead of an opaque "unknown". */
  readonly code: PolarisErrorCode | string;
  // `declare`: set only when given, so a local refusal carries no `status: undefined` key.
  declare readonly status?: number;
  declare readonly retryAfterSeconds?: number;
  declare readonly wireCode?: string;

  constructor(
    code: PolarisErrorCode | string,
    message: string,
    details: PolarisErrorDetails = {},
  ) {
    super(
      message,
      details.cause !== undefined ? { cause: details.cause } : undefined,
    );
    this.name = "PolarisError";
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterSeconds !== undefined)
      this.retryAfterSeconds = details.retryAfterSeconds;
    if (details.wireCode !== undefined) this.wireCode = details.wireCode;
  }
}
