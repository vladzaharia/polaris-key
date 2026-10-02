class_name PKeyActivationResult
extends PKeyResult
## What `PolarisKey.license.activate_with_key(key)` and `enroll()` return (sdk-node
## `ActivationResult`): a PKeyResult whose `kind` sorts every outcome, so a game (and P1-10's
## activation panel) can branch without knowing wire codes. Error bodies are read in both
## spellings the Worker uses, flat `{"error": "code", …}` and nested `{"error": {"code": …}}`,
## with the extra fields read at the top level first and inside `error` second.
##
##   ok                    200: the token is stored (source activate or enroll) and a sync ran
##   device-limit          403 device_limit: every seat is taken (`limit`, `device_count`)
##   unauthorized          401: the key is unknown or revoked
##   fingerprint-required  403 fingerprint_required: the tier (or keyless enrolment, always)
##                         needs a hardware fingerprint this host did not send
##   enroll-disabled       404: the product offers no keyless enrolment
##   enroll-claimed        403 enroll_claimed: this machine's free licence belongs to an identity
##                         now; sign in to use it
##   license-disabled      403 license_disabled: the operator disabled the licence
##   hardware-mismatch     409: the hardware drifted past the tier's tolerance and the binding was
##                         retired (`drift`, `changed`); activating again re-binds and takes a seat
##   rate-limited          429: too many attempts; try later (there is no Retry-After)
##   unsupported           nothing was sent: enrol on web (no machine anchor), `code`
##                         `unsupported`, `detail` {feature, reason: "runtime", detail}
##   error                 anything else: no answer (`code` is the transport's: `network-error`,
##                         `timeout`, `local-only`, …), another status, or a 200 without a token
##
## The token itself is never on the result: the licence client stores it.

const KIND_OK := &"ok"
const KIND_DEVICE_LIMIT := &"device-limit"
const KIND_UNAUTHORIZED := &"unauthorized"
const KIND_FINGERPRINT_REQUIRED := &"fingerprint-required"
const KIND_ENROLL_DISABLED := &"enroll-disabled"
const KIND_ENROLL_CLAIMED := &"enroll-claimed"
const KIND_LICENSE_DISABLED := &"license-disabled"
const KIND_HARDWARE_MISMATCH := &"hardware-mismatch"
const KIND_RATE_LIMITED := &"rate-limited"
const KIND_UNSUPPORTED := &"unsupported"
const KIND_ERROR := &"error"

var kind: StringName = KIND_ERROR
## The HTTP status of the answer, or 0 when nothing was answered.
var status := 0
## ok: the product's schema version from the 200 body (0 when absent).
var schema_version := 0
## device-limit: the seat limit and the devices holding one, or null when the body omits them.
var limit: Variant = null
var device_count: Variant = null
## hardware-mismatch: how many stored components drifted and which, or null when omitted.
var drift: Variant = null
var changed: Variant = null
## ok: false when the store could not write the token (it is still held for this session, and
## `store_error` fired).
var stored := true


static func of(p_kind: StringName, p_code: StringName, p_message: String, p_status := 0) -> PKeyActivationResult:
	var r := PKeyActivationResult.new(p_kind == KIND_OK, p_code, p_message)
	r.kind = p_kind
	r.status = p_status
	return r


static func unsupported_here(feature: String, reason: String, p_detail := "") -> PKeyActivationResult:
	var text := p_detail if p_detail != "" else "%s is not supported here (%s)." % [feature, reason]
	var r := PKeyActivationResult.new(false, PKeyErrors.UNSUPPORTED, text, {"feature": feature, "reason": reason, "detail": text})
	r.kind = KIND_UNSUPPORTED
	return r


## The same refusal from a PKeyCaps answer (`r.code == &"unsupported"`).
static func from_unsupported(r: PKeyResult) -> PKeyActivationResult:
	return unsupported_here(r.detail["feature"], r.detail["reason"], r.detail["detail"])


func _to_string() -> String:
	if ok:
		return "PKeyActivationResult(ok)"
	return "PKeyActivationResult(%s, %s: %s)" % [kind, code, message]
