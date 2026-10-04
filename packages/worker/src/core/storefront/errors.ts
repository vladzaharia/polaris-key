/**
 * The two failures every storefront adapter's Worker plane shares (A-18a; notes/S-15 §6.2, §6.3).
 *
 *   - `StoreWriteDenied`: the store-agnostic gate (`gate.ts`) refused a request. Thrown BEFORE any
 *     token is minted or byte sent, so it is never ambiguous: nothing reached the store.
 *   - `StoreVendorError`: the store answered with a failure. `status` is its HTTP status (0 for a
 *     network failure), `code` its error token when it sent an enum-like one (Apple's
 *     `errors[].code`), never free text. The ledger (`ledger.ts`) records both on the row
 *     (`vendor_status`, `vendor_code`) and treats a 5xx or 0 after a send as `ambiguous`.
 *
 * Each adapter's client throws its own subclass (`AscWriteDenied`, `AscError`), so a message names
 * the store, while the ledger and the conformance suite reason about the base classes only.
 */

import type { DenyReason } from "./gate.js";

/** A request the gate refused. Never carries a body value: the method, a target and a reason. */
export class StoreWriteDenied extends Error {
  constructor(
    /** The adapter whose gate refused (`app-store`). */
    readonly store: string,
    readonly method: string,
    /** The matched path template, or the request path when no rule matched. */
    readonly target: string,
    readonly reason: DenyReason,
    message = `${store} write gate refused ${method} ${target}: ${reason}`,
  ) {
    super(message);
    this.name = "StoreWriteDenied";
  }
}

/** A store's own failure answer (or a network failure, status 0). */
export class StoreVendorError extends Error {
  constructor(
    readonly status: number,
    /** The store's error token, never free text; null when it sent none. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StoreVendorError";
  }
}
