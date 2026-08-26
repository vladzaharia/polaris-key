// @plrs/protocol/legacy — wire contract v2 surface kept alive while consumers migrate
// (worker in P1, Node SDK in P4, React/Python/Swift in P5). DELETED in P8: nothing may
// take a NEW dependency on this module. The v3 replacements live in ./core.js (envelope,
// headers, ISSUER) and ./license.js + ./config.js (the split documents).

import type { ManagedEntry } from "./core.js";
import type { DocProfile } from "./license.js";

/** v2 `iss` — the control-plane origin host. v3 is host-neutral: see `core.ISSUER`. */
export const ISSUER = "key.plrs.im";

/** The three v2 payload kinds, fused in one document. v3 splits them: config+secrets ride
 *  the config document; entitlements ride the license document. */
export interface ManagedPayload {
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedEntry>;
  entitlements: Record<string, ManagedEntry>;
}

/** The v2 fused JWS payload (license state + config + entitlements in one artifact).
 *  Superseded by `LicenseDoc` + `ConfigDoc` (wire contract v3 §2). */
export interface ManagedConfigDoc {
  schemaVersion: number;
  aud: string;
  iss: string;
  licenseId: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  graceUntil: number;
  profile: DocProfile;
  payload: ManagedPayload;
}

/** v2 client→Worker request headers. v3 renames these `X-Polaris-*`: see ./core.js. */
export const HEADER_DEVICE = "X-PKey-Device";
export const HEADER_VERSION = "X-PKey-Version";
export const HEADER_CHANNEL = "X-PKey-Channel";
export const HEADER_SDK_NAME = "X-PKey-SDK";
export const HEADER_SDK_VERSION = "X-PKey-SDK-Version";
export const HEADER_PLATFORM = "X-PKey-Platform";
export const HEADER_ARCH = "X-PKey-Arch";
