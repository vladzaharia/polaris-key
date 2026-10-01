// `@polaris-key/node/devices` — the Device principal's surface: registration, the roster, telemetry,
// and the two Node-only identity formulas.
//
// `deviceIdFromRaw` and `hashComponents` live together here because they are the same kind of
// thing — hashed hardware identity, computed on the device so raw serials never cross the wire
// — and because `conformance/corpus/v2/fingerprint.json` pins BOTH. This is the subpath the
// Node conformance runner imports.

export {
  DevicesClient,
  DeviceManagementUnsupportedError,
  type AccountDevice,
  type DevicesClientOptions,
  type RegisterResult,
} from "./client.js";

export { deriveDeviceId, deviceIdFromRaw } from "./deviceId.js";

export {
  collectFingerprint,
  hashComponents,
  linuxAnchorSource,
  parseWindowsCim,
  ramBucket,
  rawComponents,
  WINDOWS_CIM_COMMAND,
  type AnchorSource,
  type FingerprintIo,
  type RawComponentsOptions,
  type WindowsCimComponents,
} from "./fingerprint.js";

export { collectFacts, runProbes, type ProbeDeclaration } from "./facts.js";
