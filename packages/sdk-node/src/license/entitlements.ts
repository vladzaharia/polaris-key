// The `entitlements` namespace (SP-35.16): a thin view over the licence gate. It holds no state of
// its own; every read goes through the same `LicenseClient` the app already has.

import type { JSONValue } from "@polaris-key/protocol/core";
import { nowSec } from "../core/context.js";
import type { LicenseClient } from "./client.js";

export class EntitlementsClient {
  constructor(private readonly license: LicenseClient) {}

  /**
   * Whether the license grants the boolean entitlement `name`. FALSE whenever the gate is not
   * usable (S-19 G11): a revoked, expired or blocked device holds a signed document that still
   * lists its grants, and reading them past the gate would keep paid features on after a
   * revocation.
   */
  has(name: string, now = nowSec()): boolean {
    if (!this.license.isLicensed(now)) return false;
    return this.license.documentEntitlements()[name] === true;
  }

  /** The raw value of entitlement `name` (a number, string, list or object), or null when the
   *  license does not carry it or the gate is not usable (G11). */
  value(name: string, now = nowSec()): JSONValue | null {
    if (!this.license.isLicensed(now)) return null;
    const v = this.license.documentEntitlements()[name];
    return v === undefined ? null : v;
  }

  /** Every entitlement's value off the held document; empty when no license is held. */
  all(): Record<string, JSONValue> {
    return this.license.documentEntitlements();
  }
}
