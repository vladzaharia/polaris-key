// The one error type the client core throws. Everything on the verification path fails
// CLOSED by returning `null` rather than throwing (see verify.ts / trust.ts); `PolarisError`
// is for the transport and orchestration layers built on top of this package, where the
// caller needs the server's machine-readable error code rather than a message to regex.

import type { PolarisErrorCode } from "@plrs/protocol/core";

export class PolarisError extends Error {
  /** The wire error code (`PolarisErrorBody.error.code`). Widened to `string` because the
   *  server may introduce a code this client predates — the caller still gets the raw value
   *  instead of an opaque "unknown". */
  readonly code: PolarisErrorCode | string;

  constructor(code: PolarisErrorCode | string, message: string) {
    super(message);
    this.name = "PolarisError";
    this.code = code;
  }
}
