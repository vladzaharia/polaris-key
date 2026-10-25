/**
 * The errors a request to the console API can end in, and the code a network error carries. A leaf
 * over `refusal.ts`, so `bundle.ts` (which makes the requests) and `account.ts` (which draws the
 * errors) share them without an import cycle.
 */

import type { Line } from "@polaris-key/node/terminal";
import { Refusal } from "./refusal.js";

/** A failure (exit 1): the sentence, the one fix, and the `--json` error code. */
export class Failure extends Error {
  constructor(
    message: string,
    readonly fix: string | undefined,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
    /** The lines as styled spans, when a URL in them must stay whole. */
    readonly lines?: Line[],
  ) {
    super(message);
    this.name = "Failure";
  }
}

/** The host did not answer (offline, refused, timed out). `cause` is the network error's code. */
export class Unreachable extends Failure {
  constructor(host: string, cause: string | null) {
    super(
      `Can't reach ${host}.`,
      "Check your network, or --base-url.",
      "network",
      cause ? { cause } : {},
    );
    this.name = "Unreachable";
  }
}

/** A 3xx: pkey sent nothing further. */
export class Redirected extends Refusal {
  constructor(host: string) {
    super(
      `${host} answered with a redirect, so pkey sent nothing further.`,
      "Check --base-url.",
      "redirect",
    );
    this.name = "Redirected";
  }
}

/** The code of a network error (`ECONNREFUSED`, `TIMEOUT`), or null. */
export function networkCode(e: unknown): string | null {
  if ((e as { name?: unknown } | null)?.name === "TimeoutError")
    return "TIMEOUT";
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
    ? code
    : null;
}
