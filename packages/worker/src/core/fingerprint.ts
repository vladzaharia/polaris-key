/**
 * Device hardware identity, as Core exposes it to a service (design spec §5.1: the Device
 * principal owns "registration/tokens/list/fingerprints").
 *
 * A re-export of `../fingerprint.js` for the same reason `core/platform.ts` re-exports the
 * platform layer: the implementation has not physically moved under `core/` yet, and a service
 * must bind to Core's declaration rather than to the file's current address. See the header of
 * `core/platform.ts` for the full rationale.
 *
 * Only the license-facing surface is re-exported. The matcher, the hwid digest and the policy
 * parsers stay Core-internal — a service decides nothing about how hardware is compared.
 */

export type { PresentedFingerprint } from "../fingerprint.js";
export type { AutoIssuePolicy, FingerprintPolicy } from "../fingerprint.js";
export {
  allowsAnonymousEnroll,
  computeEnrollHwid,
  resolveFingerprintMode,
} from "../fingerprint.js";
