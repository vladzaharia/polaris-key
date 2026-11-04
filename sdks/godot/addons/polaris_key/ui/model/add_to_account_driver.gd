extends RefCounted
## The AddToAccount driver over `PolarisKey.identity` (UK-43.12): the three calls the model
## (add_to_account.gd) runs on, over the SDK's primitives.
##
##   sign_in(hints)      `identity.sign_in.start` with channel "redirect" and NO redirect URI (the SDK
##                       picks the platform's: the desktop loopback), the hints, purpose "attach" and
##                       license_choice "app". Only where the SDK answers `redirect-unavailable`
##                       (mobile, web, a console, a headless host) it asks for a device code instead.
##                       Any other failure is a sign-in that could not start (null).
##   complete(grant, c)  `identity.choice.complete`: keep this device's license in the signed-in account.
##   attach(confirm)     `identity.attach`; false previews, nothing is written.
##
## The handle `sign_in` answers wraps the SDK's PKeySignInSession for the model.

var _identity: PKeyIdentity = null


func _init(identity: PKeyIdentity) -> void:
	_identity = identity


class Handle extends RefCounted:
	var user_code := ""
	var _session: PKeySignInSession = null

	func _init(session: PKeySignInSession) -> void:
		_session = session
		user_code = session.user_code

	## The model's wait: {outcome, grant?, email?}.
	func wait() -> Dictionary:
		var o: PKeySignInOutcome = await _session.wait()
		match o.kind:
			PKeySignInOutcome.KIND_SIGNED_IN:
				var email = o.identity.get("email")
				return {"outcome": "signedIn", "email": email if email is String else ""}
			PKeySignInOutcome.KIND_LICENSE_CHOICE:
				return {"outcome": "choose", "grant": o.grant}
			PKeySignInOutcome.KIND_CANCELLED:
				return {"outcome": "cancelled"}
			PKeySignInOutcome.KIND_PENDING:
				return {"outcome": "pending"}
		# Expired, denied, an error, or an outcome this model does not handle: a failed attempt.
		return {"outcome": "expired"}

	func reopen() -> void:
		_session.reopen()

	func cancel() -> void:
		_session.cancel()


## The handle of a running sign-in, or null when it could not start. A coroutine.
func sign_in(hints: Dictionary) -> Object:
	var opts := {
		"login_hint": hints["login_hint"],
		"name_hint": hints["name_hint"],
		"purpose": hints["purpose"],
		"license_choice": "app",
	}
	var start := opts.duplicate()
	start["channel"] = "redirect"
	var session: PKeySignInSession = await _identity.sign_in.start(start)
	if not session.ok and String(session.code) == PKeyConstants.ErrorCode.REDIRECT_UNAVAILABLE:
		# Headless, or no class applies: the person confirms a code instead (nothing was sent).
		var device := opts.duplicate()
		device["channel"] = "device-code"
		session = await _identity.sign_in.start(device)
	if not session.ok:
		return null
	return Handle.new(session)


## {outcome}: "signedIn" when the choice completed. A coroutine.
func complete(grant: String, choice: Dictionary) -> Dictionary:
	var r: PKeyChoiceResult = await _identity.choice.complete(grant, choice)
	return {"outcome": "signedIn" if r.ok and r.kind == PKeyChoiceResult.KIND_OK else "refused"}


## {kind: "ok"} (a preview or an attach), {kind: "refused", code} (the Worker's wire code) or
## {kind: "error"} (no answer, or the endpoint is not served). A coroutine.
func attach(confirm: bool) -> Dictionary:
	var r: PKeyResult = await _identity.attach(confirm)
	if r.ok:
		return {"kind": "ok"}
	if r.detail is Dictionary and r.detail.get("kind") == "refused":
		return {"kind": "refused", "code": String(r.code)}
	return {"kind": "error"}
