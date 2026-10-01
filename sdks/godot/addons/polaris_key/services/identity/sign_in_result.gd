class_name PKeySignInResult
extends PKeyResult
## How a device-code sign-in ended: the argument of `PolarisKey.identity.sign_in_finished` and
## what `wait_for_sign_in()` returns. `kind` sorts every ending so a game can branch without
## knowing wire codes:
##
##   ok                   signed in: the device token is stored and the forced sync has run
##                        (`sync`); `identity` names who the device is now signed in as
##   timeout              the server no longer knows the code (it lapsed); begin again
##   expired              the code's lifetime passed on this client; no poll was sent after it
##   cancelled            `cancel()`, or a new `begin_sign_in()` replaced this one
##   denied               the server answered `error`: the sign-in failed or was refused
##                        (never says why, by design)
##   device-mismatch      401: the poll's device id is not the one the flow was started for
##   rate-limited         the start was refused 429; try again later
##   service-unavailable  Identity is off for this product, or not set up (no request was sent)
##   error                anything else (a transport failure on the start, a malformed answer)
##
## Show `identity` after `ok`: when someone else confirmed the flow with the user code and signed
## in as themselves, this is how the player sees the device is now on a stranger's account.

const KIND_OK := &"ok"
const KIND_TIMEOUT := &"timeout"
const KIND_EXPIRED := &"expired"
const KIND_CANCELLED := &"cancelled"
const KIND_DENIED := &"denied"
const KIND_DEVICE_MISMATCH := &"device-mismatch"
const KIND_RATE_LIMITED := &"rate-limited"
const KIND_SERVICE_UNAVAILABLE := &"service-unavailable"
const KIND_ERROR := &"error"

var kind: StringName = KIND_ERROR
## On `ok`: {name?, email?} as the server reported the signed-in identity (`email` only when
## the IdP verified it). Empty otherwise.
var identity: Dictionary = {}
## On `ok` after the player accepted attaching: `claimed` (the anonymous licence became the
## account's) or `migrated` (the device moved onto the account's licence). "" otherwise.
var attached := ""
## On `ok`: false when the store could not write the token (it is still held for this session).
var stored := false
## On `ok`: the forced sync that followed.
var sync: PKeySyncResult = null
## The HTTP status of the answer that ended the sign-in, or 0.
var status := 0


static func signed_in(p_identity: Dictionary, p_attached: String, p_stored: bool, p_sync: PKeySyncResult) -> PKeySignInResult:
	var r := PKeySignInResult.new(true)
	r.kind = KIND_OK
	r.identity = p_identity
	r.attached = p_attached
	r.stored = p_stored
	r.sync = p_sync
	r.status = 200
	return r


static func ended(p_kind: StringName, p_code: StringName, p_message: String, p_status := 0) -> PKeySignInResult:
	var r := PKeySignInResult.new(false, p_code, p_message)
	r.kind = p_kind
	r.status = p_status
	return r


func _to_string() -> String:
	if ok:
		return "PKeySignInResult(ok, identity=%s%s)" % [JSON.stringify(identity), (", attached=" + attached) if attached != "" else ""]
	return "PKeySignInResult(%s, %s: %s)" % [kind, code, message]
