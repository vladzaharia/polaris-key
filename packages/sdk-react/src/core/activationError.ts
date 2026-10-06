// The thrown form of a refused activation (SDK-PARITY-PASS §3.1), shared by every adapter.

import type { ActivationOutcome } from "./activation.js";
import { describeError } from "./copy.js";
import { PolarisError } from "./types.js";

/** The `sign-in-failed` a refused activation throws: `wireCode` the server's code, `activation`
 *  the §3.1 kind, and the message the copy catalog's sentence for it. */
export function activationError(outcome: ActivationOutcome): PolarisError {
  const code =
    outcome.kind === "error" && outcome.code === "network"
      ? "network"
      : "sign-in-failed";
  return new PolarisError(
    code,
    describeError({ activation: outcome }),
    outcome.code,
    undefined,
    {
      activation: outcome,
      ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    },
  );
}
