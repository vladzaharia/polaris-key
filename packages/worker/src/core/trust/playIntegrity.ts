/**
 * Play Integrity verdict checks (P6-02): the pure half of Play Integrity verification. The I/O
 * half — `decodeIntegrityToken` with a Google access token — is `core/trust/attestation.ts`'s, because
 * only that module may reach an outlet credential's token helpers (outletCredentialReach.test.ts).
 *
 * A device reaches `attested` from a STANDARD integrity request (notes/E2 §E3) only when every
 * one of these holds in the decoded `tokenPayloadExternal`:
 *
 *   - `requestDetails.requestPackageName` and `appIntegrity.packageName` equal the product's Play
 *     package (the pinned one: the caller resolves it through Distribution's pin check);
 *   - `requestDetails.requestHash` equals the challenge binding the Worker issued for this device;
 *   - `requestDetails.timestampMillis` is within `MAX_VERDICT_AGE` of now (and not more than
 *     `MAX_CLOCK_SKEW` ahead of it);
 *   - `appIntegrity.appRecognitionVerdict` is `PLAY_RECOGNIZED`;
 *   - `deviceIntegrity.deviceRecognitionVerdict` contains `MEETS_DEVICE_INTEGRITY`.
 *
 * A response Google marks `testingDetails.isTestingResponse` (a license tester's configured
 * verdict) is refused unless the trust policy sets `playIntegrity.allowTestingResponses`.
 *
 * The licensing verdict (`accountDetails.appLicensingVerdict`) is RECORDED, not required: an
 * unlicensed account on a genuine device is a commerce question, not a device-trust one.
 */

export const PLAY_INTEGRITY_SCOPE =
  "https://www.googleapis.com/auth/playintegrity";

/** How old a verdict may be. A standard request is made right after the challenge is fetched. */
export const MAX_VERDICT_AGE = 5 * 60;
/** How far ahead of the Worker's clock a verdict's timestamp may be. */
export const MAX_CLOCK_SKEW = 60;

export type PlayVerdictFailure =
  | "malformed"
  | "package"
  | "request_hash"
  | "stale"
  | "app_unrecognized"
  | "device_integrity"
  | "testing_response";

export interface PlayVerdictSummary {
  appRecognitionVerdict: string;
  deviceRecognitionVerdict: string[];
  appLicensingVerdict: string | null;
  timestampMillis: number;
  versionCode: string | null;
  /** `testingDetails.isTestingResponse`: Google answered a license tester's configured verdict. */
  isTestingResponse: boolean;
}

export type PlayVerdictResult =
  | { ok: true; summary: PlayVerdictSummary }
  | { ok: false; reason: PlayVerdictFailure; summary?: PlayVerdictSummary };

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Check a decoded `decodeIntegrityToken` response body against the issued challenge. */
export function checkPlayVerdict(
  body: unknown,
  expected: {
    packageName: string;
    requestHash: string;
    now: number;
    /** Accept a testing response (the trust policy's `allowTestingResponses`). Default false. */
    allowTestingResponses?: boolean;
  },
): PlayVerdictResult {
  const payload = obj(obj(body)?.tokenPayloadExternal);
  const request = obj(payload?.requestDetails);
  const app = obj(payload?.appIntegrity);
  const device = obj(payload?.deviceIntegrity);
  const account = obj(payload?.accountDetails);
  if (!payload || !request || !app || !device)
    return { ok: false, reason: "malformed" };

  // `timestampMillis` is a decimal string in Google's JSON (int64); accept a number as well.
  const tsRaw = request.timestampMillis;
  const ts =
    typeof tsRaw === "string" && /^\d{1,16}$/.test(tsRaw)
      ? Number(tsRaw)
      : typeof tsRaw === "number" && Number.isSafeInteger(tsRaw)
        ? tsRaw
        : null;
  const deviceVerdicts = Array.isArray(device.deviceRecognitionVerdict)
    ? device.deviceRecognitionVerdict.filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  if (ts === null) return { ok: false, reason: "malformed" };
  const summary: PlayVerdictSummary = {
    appRecognitionVerdict: str(app.appRecognitionVerdict) ?? "UNEVALUATED",
    deviceRecognitionVerdict: deviceVerdicts,
    appLicensingVerdict: str(account?.appLicensingVerdict),
    timestampMillis: ts,
    versionCode: str(app.versionCode),
    isTestingResponse: obj(payload.testingDetails)?.isTestingResponse === true,
  };

  if (
    request.requestPackageName !== expected.packageName ||
    app.packageName !== expected.packageName
  )
    return { ok: false, reason: "package", summary };
  if (request.requestHash !== expected.requestHash)
    return { ok: false, reason: "request_hash", summary };
  const at = Math.floor(ts / 1000);
  if (at < expected.now - MAX_VERDICT_AGE || at > expected.now + MAX_CLOCK_SKEW)
    return { ok: false, reason: "stale", summary };
  if (summary.appRecognitionVerdict !== "PLAY_RECOGNIZED")
    return { ok: false, reason: "app_unrecognized", summary };
  if (!deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY"))
    return { ok: false, reason: "device_integrity", summary };
  // A testing response is whatever verdict a license tester configured in Play Console, not a
  // check of this device: never attested unless the operator allows it for internal testing.
  if (summary.isTestingResponse && expected.allowTestingResponses !== true)
    return { ok: false, reason: "testing_response", summary };
  return { ok: true, summary };
}
