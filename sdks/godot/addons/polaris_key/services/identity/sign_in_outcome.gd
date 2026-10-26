class_name PKeySignInOutcome
extends PKeyResult
## Where a device-code sign-in stands: what `PKeySignInSession.wait()` returns and the argument of
## its `outcome` signal. Branch on `kind`:
##
##   pending              not settled (a session that has not been waited on)
##   choose               the flow is held at the signed-in identity (`confirm_identity`): show
##                        `identity`, then `session.accept(attach)` and `wait()` again
##   signed_in            signed in: the device token is stored and the forced sync has run
##                        (`sync`); `identity` names who the device is now signed in as
##   cancelled            `session.cancel()`, or a new `sign_in.start()` replaced the session
##   expired              the code lapsed on this client, or the server no longer knows it
##   denied               the player pressed Deny, or the provider refused
##   device-mismatch      401: the poll's device id is not the one the flow was started for
##   rate-limited         the start was refused 429; try again later
##   service-unavailable  Identity is off for this product, or not set up (the start was a
##                        404, or no request was sent)
##   error                anything else (a transport failure, a malformed answer, a sign-in that
##                        failed after approval)
##
## `ok` is true for `pending`, `choose` and `signed_in`; every other kind carries its typed
## `code` (`sign-in-denied`, `sign-in-expired`, `cancelled`, `service-unavailable`, `unauthorized`,
## `rate_limited`, `sign-in-failed`, ...). Show `identity` after `signed_in`: when someone else
## confirmed the flow with the user code and signed in as themselves, this is how the player sees
## the device is now on a stranger's account.

const KIND_PENDING := &"pending"
const KIND_CHOOSE := &"choose"
const KIND_SIGNED_IN := &"signed_in"
const KIND_CANCELLED := &"cancelled"
const KIND_EXPIRED := &"expired"
const KIND_DENIED := &"denied"
const KIND_DEVICE_MISMATCH := &"device-mismatch"
const KIND_RATE_LIMITED := &"rate-limited"
const KIND_SERVICE_UNAVAILABLE := &"service-unavailable"
const KIND_ERROR := &"error"

var kind: StringName = KIND_ERROR
## On `signed_in` and `choose`: {name?, email?} as the server reported the signed-in identity
## (`email` only when the IdP verified it). Empty otherwise.
var identity: Dictionary = {}
## On `choose`: this device holds an anonymous licence the account could take over.
var attachable := false
## On `signed_in` after the player accepted attaching: `claimed` (the anonymous licence became the
## account's) or `migrated` (every device on it moved onto the account's licence). "" otherwise.
var attached := ""
## On `signed_in`: false when the store could not write the token (it is still held for this session).
var stored := false
## On `signed_in`: the forced sync that followed.
var sync: PKeySyncResult = null
## On `signed_in`: the account's pairwise subject when the Worker said, else "".
var subject := ""
## The HTTP status of the answer that ended the sign-in, or 0.
var status := 0


static func pending() -> PKeySignInOutcome:
	var r := PKeySignInOutcome.new(true)
	r.kind = KIND_PENDING
	return r


static func choose(p_identity: Dictionary, p_attachable: bool) -> PKeySignInOutcome:
	var r := PKeySignInOutcome.new(true)
	r.kind = KIND_CHOOSE
	r.identity = p_identity
	r.attachable = p_attachable
	r.status = 200
	return r


static func signed_in(p_identity: Dictionary, p_attached: String, p_stored: bool, p_sync: PKeySyncResult, p_subject := "") -> PKeySignInOutcome:
	var r := PKeySignInOutcome.new(true)
	r.kind = KIND_SIGNED_IN
	r.identity = p_identity
	r.attached = p_attached
	r.stored = p_stored
	r.sync = p_sync
	r.subject = p_subject
	r.status = 200
	return r


static func ended(p_kind: StringName, p_code: StringName, p_message: String, p_status := 0) -> PKeySignInOutcome:
	var r := PKeySignInOutcome.new(false, p_code, p_message)
	r.kind = p_kind
	r.status = p_status
	return r


func _to_string() -> String:
	if kind == KIND_SIGNED_IN:
		return "PKeySignInOutcome(signed_in, identity=%s%s)" % [JSON.stringify(identity), (", attached=" + attached) if attached != "" else ""]
	if ok:
		return "PKeySignInOutcome(%s)" % kind
	return "PKeySignInOutcome(%s, %s: %s)" % [kind, code, message]
