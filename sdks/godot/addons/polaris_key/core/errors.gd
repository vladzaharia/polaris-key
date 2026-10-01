class_name PKeyErrors
extends RefCounted
## Error codes. Wire codes are the server's own spellings (`PolarisErrorCode`,
## shared-protocol `core.ts`); client codes never cross the wire. Every value here must be
## registered in conformance/parity/errors.json (generated into `PKeyConstants.ErrorCode`);
## tests/core/test_errors.gd fails otherwise.

# ── Wire codes (PolarisErrorCode) ──────────────────────────────────────────────────────────
const UNAUTHORIZED := &"unauthorized"
const DEVICE_LIMIT := &"device_limit"
const LICENSE_DISABLED := &"license_disabled"
const LICENSE_EXPIRED := &"license_expired"
const VERSION_BLOCKED := &"version_blocked"
const CHANNEL_NOT_ALLOWED := &"channel_not_allowed"
const RATE_LIMITED := &"rate_limited"
const NOT_FOUND := &"not_found"
const BAD_REQUEST := &"bad_request"
const FORBIDDEN := &"forbidden"
const HARDWARE_MISMATCH := &"hardware_mismatch"
const FINGERPRINT_REQUIRED := &"fingerprint_required"
const ENROLL_DISABLED := &"enroll_disabled"
const REGISTRATION_CLOSED := &"registration_closed"

# ── Client codes ───────────────────────────────────────────────────────────────────────────
const INSECURE_BASE_URL := &"insecure-base-url"
const INVALID_OPTIONS := &"invalid-options"
const NOT_CONFIGURED := &"not-configured"
const LOCAL_ONLY := &"local-only"
const SERVICE_UNAVAILABLE := &"service-unavailable"
const UNSUPPORTED := &"unsupported"
const TIMEOUT := &"timeout"
const NETWORK := &"network-error"
const RESPONSE_TOO_LARGE := &"response-too-large"
const TOO_MANY_REDIRECTS := &"too-many-redirects"
const INSECURE_REDIRECT := &"insecure-redirect"
const HTTP_ERROR := &"http-error"
const INVALID_RESPONSE := &"invalid-response"
const STORE_FAILED := &"store-failed"
const NO_TOKEN := &"no-token"
## Edge-mint: discovery says the product has no approved recipe, so nothing was sent.
const MINT_UNAVAILABLE := &"mint-unavailable"
## Device management (rename, deauthorize) needs a device token this client does not hold.
const DEVICE_MANAGEMENT_UNSUPPORTED := &"device-management-unsupported"
## The four §7 bundle steps (PKeyBundle).
const BUNDLE_JWS_REJECTED := &"bundle-jws-rejected"
const BUNDLE_CLAIMS_REJECTED := &"bundle-claims-rejected"
const BUNDLE_TRUST_REJECTED := &"bundle-trust-rejected"
const INNER_DOC_REJECTED := &"inner-doc-rejected"
## Device-code sign-in (PolarisKey.identity): the wait was cancelled; the code expired (on this
## client or at the server); the poll answered the generic `error`; a poll answered 5xx
## (transient, retried at the same interval).
const CANCELLED := &"cancelled"
const SIGN_IN_EXPIRED := &"sign-in-expired"
const SIGN_IN_DENIED := &"sign-in-denied"
const SERVER_ERROR := &"server-error"


## Reads a JSON error body in either spelling the Worker uses (notes/A2 §1.13):
## nested `{"error": {"code": …, "reason"?: …}, …}` (v3 surfaces) and flat
## `{"error": "code", "message": …}` (moved v2 routes). Extra fields stay at the top level.
## Returns {code: String ("" when none), message: String, reason: String, body: Dictionary}.
static func read_body(body: PackedByteArray) -> Dictionary:
	var out := {"code": "", "message": "", "reason": "", "body": {}}
	var parsed := PKeyJson.parse_bytes(body)
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return out
	var b: Dictionary = parsed["value"]
	out["body"] = b
	var e = b.get("error")
	if e is Dictionary:
		if e.get("code") is String:
			out["code"] = e["code"]
		if e.get("reason") is String:
			out["reason"] = e["reason"]
		if e.get("message") is String:
			out["message"] = e["message"]
	elif e is String:
		out["code"] = e
	if out["reason"] == "" and b.get("reason") is String:
		out["reason"] = b["reason"]
	if out["message"] == "" and b.get("message") is String:
		out["message"] = b["message"]
	return out
