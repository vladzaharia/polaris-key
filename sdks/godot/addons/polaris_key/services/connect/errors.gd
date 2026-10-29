@tool
class_name PKeyConnectErrors
extends RefCounted
## Cloud Connect's error taxonomy (CC-14.4; plans CC-01 G20), ported from sdk-node `connect/session.ts`
## (`LAN_CODE`) and `connect/relay.ts` (`RELAY_CODE`), with Kotlin's `permission_denied` (D-8).
##
## An error is a PKeyResult failure whose `code` is a REGISTERED code only (the tables below) and
## whose `detail` is {reason} plus, where they apply, `status` (the ticket route's HTTP status),
## `retry_after_seconds`, `scope` ("person" or "product") and `close_code`. A reason is the finer,
## host-facing name; the code is what a log, a wire answer or a transcript may show. The message is
## a fixed sentence: nothing here carries a key, ticket, certificate or payload (G19).

## The registered client code of each LAN reason.
const LAN_CODE := {
	"no_identity": PKeyConstants.ErrorCode.NOT_CONFIGURED,
	"no_keys": PKeyConstants.ErrorCode.NOT_CONFIGURED,
	"not_started": PKeyConstants.ErrorCode.NOT_CONFIGURED,
	"unknown_peer": PKeyConstants.ErrorCode.INVALID_ARGUMENT,
	"not_listening": PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE,
	"connect_failed": PKeyConstants.ErrorCode.NETWORK_ERROR,
	"handshake_failed": PKeyConstants.ErrorCode.PEER_CERT_INVALID,
	"wrong_peer": PKeyConstants.ErrorCode.PEER_CERT_INVALID,
	"closed": PKeyConstants.ErrorCode.NETWORK_ERROR,
	"too_large": PKeyConstants.ErrorCode.INVALID_ARGUMENT,
	"bad_type": PKeyConstants.ErrorCode.INVALID_ARGUMENT,
	"permission_denied": PKeyConstants.ErrorCode.NEARBY_PERMISSION_DENIED,
}

## The registered code of each relay reason: the Worker's own for the four it answers with.
const RELAY_CODE := {
	"disabled": PKeyConstants.ErrorCode.RELAY_DISABLED,
	"paused": PKeyConstants.ErrorCode.RELAY_PAUSED,
	"quota": PKeyConstants.ErrorCode.RELAY_QUOTA_EXCEEDED,
	"ticket_invalid": PKeyConstants.ErrorCode.RELAY_TICKET_INVALID,
	"rate_limited": PKeyConstants.ErrorCode.RATE_LIMITED,
	"busy": PKeyConstants.ErrorCode.RATE_LIMITED,
	"unavailable": PKeyConstants.ErrorCode.NETWORK_ERROR,
	"not_connected": PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE,
	"not_member": PKeyConstants.ErrorCode.PEER_CERT_INVALID,
	"handshake_failed": PKeyConstants.ErrorCode.PEER_CERT_INVALID,
	"wrong_peer": PKeyConstants.ErrorCode.PEER_CERT_INVALID,
	"unknown_peer": PKeyConstants.ErrorCode.INVALID_ARGUMENT,
	"mode_not_allowed": PKeyConstants.ErrorCode.INVALID_ARGUMENT,
	"replaced": PKeyConstants.ErrorCode.CANCELLED,
	"stopped": PKeyConstants.ErrorCode.CANCELLED,
}

const QUOTA_SCOPES := ["person", "product"]
## `Retry-After` is cut to an hour (G15).
const RETRY_AFTER_CAP_SECONDS := 3600


## The registered code of a LAN reason; `invalid-argument` for a reason that is not one.
static func lan_code(reason: String) -> StringName:
	return StringName(LAN_CODE.get(reason, PKeyConstants.ErrorCode.INVALID_ARGUMENT))


## The registered code of a relay reason; `invalid-argument` for a reason that is not one.
static func relay_code(reason: String) -> StringName:
	return StringName(RELAY_CODE.get(reason, PKeyConstants.ErrorCode.INVALID_ARGUMENT))


## A LAN failure. `extra` may carry `close_code`.
static func lan(reason: String, message: String, extra := {}) -> PKeyResult:
	return PKeyResult.failure(lan_code(reason), message, _detail(reason, extra))


## A relay failure. `extra` may carry `status`, `retry_after_seconds`, `scope` and `close_code`.
static func relay(reason: String, message: String, extra := {}) -> PKeyResult:
	return PKeyResult.failure(relay_code(reason), message, _detail(reason, extra))


## The reason of a failure built here; "" for any other result.
static func reason_of(r: PKeyResult) -> String:
	if r == null or r.ok or not r.detail is Dictionary:
		return ""
	return String((r.detail as Dictionary).get("reason", ""))


static func _detail(reason: String, extra: Dictionary) -> Dictionary:
	var out := {"reason": reason}
	for k in ["status", "retry_after_seconds", "close_code"]:
		if extra.has(k):
			out[k] = extra[k]
	if extra.get("scope") in QUOTA_SCOPES:
		out["scope"] = extra["scope"]
	return out
