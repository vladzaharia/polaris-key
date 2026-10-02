class_name PKeySignInController
extends RefCounted
## PKeySignInDialog's headless logic over P1-07's device-code sign-in (PolarisKey.identity): the
## dialog's state and the copy for how a sign-in ended.
##
## States: `starting` (the request is in flight), `pending` (show the user code, the QR code of
## `verification_uri_complete`, open/copy link and the countdown), `confirm` (the player signed
## in and the flow holds for acceptance on the device), and `ended` with a PKeySignInResult kind
## (ok, expired, cancelled, denied, device-mismatch, rate-limited, service-unavailable, timeout,
## error).


## The copy key for an ended sign-in.
static func message_for(kind: StringName) -> String:
	match kind:
		PKeySignInResult.KIND_OK:
			return "sign_in_ok"
		PKeySignInResult.KIND_EXPIRED, PKeySignInResult.KIND_TIMEOUT:
			return "sign_in_expired"
		PKeySignInResult.KIND_CANCELLED:
			return "sign_in_cancelled"
		PKeySignInResult.KIND_DENIED:
			return "sign_in_denied"
		PKeySignInResult.KIND_DEVICE_MISMATCH:
			return "sign_in_device_mismatch"
		PKeySignInResult.KIND_RATE_LIMITED:
			return "sign_in_rate_limited"
		PKeySignInResult.KIND_SERVICE_UNAVAILABLE:
			return "sign_in_unavailable"
	return "sign_in_error"


## Seconds left on the code, never negative.
static func remaining(prompt: PKeySignInPrompt, now: float) -> float:
	if prompt == null:
		return 0.0
	return maxf(prompt.expires_at - now, 0.0)


## "m:ss" for the countdown (data: digits, not copy).
static func clock(seconds: float) -> String:
	var s := int(ceil(seconds))
	return "%d:%02d" % [s / 60, s % 60]


## The address the player types, without the scheme ("key.plrs.im/device").
static func short_uri(uri: String) -> String:
	for p in ["https://", "http://"]:
		if uri.begins_with(p):
			return uri.substr(p.length())
	return uri


## The signed-in identity as one line: "Name (email)", the name or the e-mail alone, or "".
static func identity_line(identity: Dictionary) -> String:
	var name := String(identity.get("name", "")) if identity.get("name") is String else ""
	var email := String(identity.get("email", "")) if identity.get("email") is String else ""
	if name != "" and email != "":
		return "%s (%s)" % [name, email]
	return name if name != "" else email
