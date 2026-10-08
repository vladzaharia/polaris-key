// The words a kit screen shows for a failure, all from the copy catalogs (conformance/parity/
// copy.en.json through core/copy.ts). A code the catalog does not know is never shown raw: a
// refusal the catalog has no sentence for reads as the generic sentence, without the code.

import {
  activationTitle,
  copyMessage,
  copyTitle,
  describeError,
  hasCopy,
} from "../core/copy.js";

/** The fields of a `PolarisError` the copy reads. */
export interface ErrorLike {
  code?: string;
  wireCode?: string;
  manageUrl?: string;
  activation?: {
    kind: string;
    code: string;
    limit?: number;
    deviceCount?: number;
    retryAfterSeconds?: number;
  };
}

function known(err: ErrorLike): boolean {
  const a = err.activation;
  if (a && a.kind !== "ok") return a.kind !== "refused" || hasCopy(a.code);
  return (
    (err.wireCode !== undefined && hasCopy(err.wireCode)) ||
    (err.code !== undefined && hasCopy(err.code))
  );
}

/** The catalog sentence for a failure; the generic one when the catalog has none for it. */
export function errorSentence(err: ErrorLike | null | undefined): string {
  if (!err || !known(err)) return copyMessage("unknown");
  return describeError(err);
}

/** The catalog title for a failure ("Can't connect"), or `null` when it has none. */
export function errorTitle(err: ErrorLike | null | undefined): string | null {
  if (!err || !known(err)) return null;
  const a = err.activation;
  if (a && a.kind !== "ok" && a.kind !== "refused")
    return activationTitle(a.kind);
  if (err.wireCode && hasCopy(err.wireCode)) return copyTitle(err.wireCode);
  if (a?.kind === "refused" && hasCopy(a.code)) return copyTitle(a.code);
  return err.code && hasCopy(err.code) ? copyTitle(err.code) : null;
}

/** Whether a refusal means the key itself is wrong (as opposed to a valid key that cannot be
 *  used here: the device limit, a network failure). Only that marks the key field invalid. */
export function keyIsWrong(err: ErrorLike | null | undefined): boolean {
  return err?.activation?.kind === "unauthorized";
}

/** A device-limit refusal that carries the portal page to free a seat (PX-W8). */
export function deviceLimitOf(
  err: ErrorLike | null | undefined,
): (ErrorLike & { manageUrl: string }) | null {
  return err?.manageUrl ? (err as ErrorLike & { manageUrl: string }) : null;
}
