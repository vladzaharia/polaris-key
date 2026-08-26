// @plrs/protocol/config — Config service wire types (wire contract v3 §2.2).

import type { DocClaims, ManagedEntry } from "./core.js";

/**
 * The config document (`typ: "plrs-config+jws"`) — config + secrets only. Contains no
 * license fields; a product with `config` enabled and `license` disabled issues these to
 * any registered device, which is the wire-level guarantee of service independence (D-08).
 * Entitlements ride the LICENSE document, not this one.
 */
export interface ConfigDoc extends DocClaims {
  /** The product's active catalog version (NOT the wire protocol version). */
  schemaVersion: number;
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedEntry>;
}

/** How a catalog secret reaches a runtime. `edgeMint` is the Config-service capability
 *  that mints short-lived third-party tokens (D-19). */
export type SecretDelivery = "serverOnly" | "clientScoped" | "edgeMint";
