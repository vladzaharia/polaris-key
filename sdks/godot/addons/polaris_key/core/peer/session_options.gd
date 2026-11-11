@tool
class_name PKeyPeerSessionOptions
extends RefCounted
## The checks of the options of a `PKeyPeerSession` (kept out of the session's file): `problem` names what is
## wrong with a Dictionary given to `PKeyPeerSession.create`, "" when nothing is. The contact, local-link and
## pairing options have their own checks (`PKeyPeerContactFlow`, `PKeyPeerLocalFlow`, `PKeyPeerLocalPairing`).

const MODES := ["a", "v", "p", "c", "q", "l"]


static func problem(options: Dictionary) -> String:
	var bad := _basics(options)
	if bad != "":
		return bad
	bad = _account(options)
	if bad != "":
		return bad
	var mode: String = options["mode"]
	var role: String = options["role"]
	if mode != "a" and mode != "q" and role == "responder" and not options.get("admission") is PKeyPeerLimiter:
		return "an approver needs an admission limiter"
	bad = PKeyPeerContactFlow.options_problem(mode, role, options)
	if bad == "":
		bad = PKeyPeerLocalFlow.options_problem(mode, role, options)
	return bad


static func _basics(options: Dictionary) -> String:
	var mode: Variant = options.get("mode")
	var role: Variant = options.get("role")
	if not (mode is String and MODES.has(mode)) or not (role is String and ["initiator", "responder"].has(role)):
		return "mode and role"
	if not options.get("slug") is String or options["slug"] == "":
		return "slug"
	if not options.get("send") is Callable or not (options["send"] as Callable).is_valid():
		return "send"
	if not options.get("on_event") is Callable or not (options["on_event"] as Callable).is_valid():
		return "on_event"
	if static_port(options.get("static_key")) == null and mode != "l":
		return "static_key"
	return _hello(options)


static func _hello(options: Dictionary) -> String:
	if options.get("hold_sas", false) != false and not (options["hold_sas"] == true and options["mode"] == "v" and options["role"] == "initiator"):
		return "hold_sas is for the mode v initiator"
	var hello: Variant = options.get("hello")
	if not hello is Dictionary or not (hello as Dictionary).get("platform") is String or not (hello as Dictionary).get("app") is String:
		return "hello"
	return ""


static func _account(options: Dictionary) -> String:
	var mode: String = options["mode"]
	if (mode == "a") != options.has("account") or (mode == "a" and not _account_ok(options["account"])):
		return "account"
	return ""


static func _account_ok(a: Variant) -> bool:
	if not a is Dictionary:
		return false
	var d: Dictionary = a
	for k in ["expected_aud", "cert_jws", "own_sub", "own_device_id"]:
		if not d.get(k) is String or d[k] == "":
			return false
	return d.get("trust") is Dictionary and d.get("held_ring") is Callable and (d["held_ring"] as Callable).is_valid() and d.get("disc_keys") is Array


## The static key as a port whose public half is read once, here, on the calling thread: the raw 32 bytes (a copy),
## a `PKeyPeerStaticPort` over a key port, or null.
static func static_port(key: Variant) -> Variant:
	if key is PackedByteArray:
		return (key as PackedByteArray).duplicate() if (key as PackedByteArray).size() == 32 else null
	if key is Object and (key as Object).has_method("public_key") and (key as Object).has_method("dh"):
		var pub: Variant = (key as Object).call("public_key")
		if pub is PackedByteArray and (pub as PackedByteArray).size() == 32:
			return PKeyPeerStaticPort.new(key, pub)
	return null
