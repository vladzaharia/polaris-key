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
const ENROLL_CLAIMED := &"enroll_claimed"
const ATTESTATION_REQUIRED := &"attestation_required"
const MANAGED_BY_ADMIN := &"managed_by_admin"
const NOT_ENTITLED := &"not_entitled"

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
## A native platform plugin (PKeyApple over the PolarisKeyApple GDExtension, P5-05; PKeyAndroid
## over the PolarisKeyAndroid plugin, P5-06) answered an error or an unreadable reply; `detail`
## carries its fields.
const PLATFORM_ERROR := &"platform-error"
const NO_TOKEN := &"no-token"
## Edge-mint: discovery says the product has no approved recipe, so nothing was sent.
const MINT_UNAVAILABLE := &"mint-unavailable"
## Wire v4 update decision (PolarisKey.update.decide, plans/P3-01.md §2.5's error map).
const FEED_REJECTED := &"feed-rejected"
const FEED_ROLLBACK := &"feed-rollback"
const RECORD_REJECTED := &"record-rejected"
const RECORD_MISMATCH := &"record-mismatch"
## Acting on a decision (P3-10): downloaded or staged bytes differ from the record's payload; this
## install cannot take a sidecar-PCK swap (`detail.reason`); a verified swap could not be made.
const PAYLOAD_MISMATCH := &"payload-mismatch"
const SWAP_REFUSED := &"swap-refused"
const SWAP_FAILED := &"swap-failed"
## Packs (P4-08, PolarisKey.update.packs): the codes PKeyPackEngine raises beyond the appliers',
## planner's and files index's (PKeyConstants.ErrorCode carries those): the pack state could not
## be read; the content stamp is invalid; a pack is not pinned, not entitled, of a type or
## variant this SDK cannot hold; the `godot.pck` device-side directory and header checks.
const PACK_STATE_UNREADABLE := &"pack-state-unreadable"
const CONTENT_STAMP_INVALID := &"content-stamp-invalid"
const PACK_NOT_PINNED := &"pack-not-pinned"
const PACK_NOT_ENTITLED := &"pack-not-entitled"
const PACK_TYPE_UNSUPPORTED := &"pack-type-unsupported"
const PACK_NO_VARIANT := &"pack-no-variant"
const PACK_ROLLED_BACK := &"pack-rolled-back"
const PCK_DIRECTORY_REFUSED := &"pck-directory-refused"
const PCK_ENGINE_MISMATCH := &"pck-engine-mismatch"
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
