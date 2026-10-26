extends RefCounted
# @pkey-feature identity.devicecode
# Device-code sign-in (RFC 8628) against the live server and its fake identity provider, with the
# harness approver standing in for the person on the other device: it opens the verification page
# with the user code and confirms it, and the provider approves Iris Calder.
#
#   pieces   sign_in.start() starts the flow, one poll is `pending` before anyone approves, the
#            approver confirms, wait() ends `signed_in` with the person, the token stored and the
#            forced sync run, and sign_out() releases the seat
#   begin    wait() running in the background while the approver confirms: the `outcome` signal
#            carries the same `signed_in`
#
# The server's `interval` (about two seconds) is the pace the SDK polls at, so each flow takes a
# few seconds; the checks never read how many.


func run(t: PKeyTestContext, bed: PKeyDevLive) -> void:
	await _pieces(t, bed)
	await _begin(t, bed)


func _pieces(t: PKeyTestContext, bed: PKeyDevLive) -> void:
	var sdk: Node = await bed.sdk("signin")
	if not t.check("pieces: the SDK is configured from the quickstart", bed.last_configure.ok, str(bed.last_configure)):
		bed.drop(sdk)
		return
	t.check("pieces: identity is available on the services the quickstart expects", sdk.identity.is_available())

	var prompt: PKeySignInSession = await sdk.identity.sign_in.start({"device_name": "Godot live suite"})
	if not t.check("pieces: the start answers a prompt", prompt.ok, str(prompt)):
		bed.drop(sdk)
		return
	_shape(t, bed, prompt, "pieces")

	# No poll before the server's interval has passed, as the SDK's own wait paces them.
	await PKeyDevLive.pause(float(prompt.interval) + 0.2)
	var waiting: Dictionary = await prompt._poll_once()
	t.check("pieces: before anyone approves, the poll is pending", waiting.get("status") == "pending", str(waiting))

	var approved := bed.approve(prompt)
	t.check("pieces: the approver confirms the code (exit 0)", approved["code"] == 0, "exit %d: %s" % [approved["code"], approved["output"]])
	if approved["code"] != 0:
		prompt.cancel()
		bed.drop(sdk)
		return

	var result: PKeySignInOutcome = await PKeyDevLive.wait_for_sign_in(prompt)
	t.check("pieces: wait() ends signed_in after the approval", result.ok and result.kind == PKeySignInOutcome.KIND_SIGNED_IN, str(result))
	if result.ok:
		_signed_in(t, bed, sdk, result, "pieces")
	var out: PKeyResult = await sdk.identity.sign_out()
	t.check("pieces: sign_out() releases the seat and the gate closes", out.ok and not sdk.is_licensed() and not sdk.core.tokens.has_token(), str(out))
	bed.drop(sdk)


func _begin(t: PKeyTestContext, bed: PKeyDevLive) -> void:
	var sdk: Node = await bed.sdk("signin")
	if not t.check("begin: the SDK is configured from the quickstart", bed.last_configure.ok, str(bed.last_configure)):
		bed.drop(sdk)
		return
	var prompt: PKeySignInSession = await sdk.identity.sign_in.start({"device_name": "Godot live suite"})
	if not t.check("begin: sign_in.start answers a session", prompt.ok, str(prompt)):
		bed.drop(sdk)
		return
	var finished := []
	prompt.outcome.connect(func(r: PKeySignInOutcome) -> void: finished.append(r))
	prompt.wait()
	t.check("begin: the session is waiting", prompt.is_waiting())
	_shape(t, bed, prompt, "begin")

	var approved := bed.approve(prompt)
	t.check("begin: the approver confirms the code (exit 0)", approved["code"] == 0, "exit %d: %s" % [approved["code"], approved["output"]])
	if approved["code"] != 0:
		prompt.cancel()
		bed.drop(sdk)
		return

	var came := await PKeyDevLive.until_filled(finished)
	if not t.check("begin: the outcome signal fires once with signed_in", came and finished.size() == 1 and finished[0].ok and finished[0].kind == PKeySignInOutcome.KIND_SIGNED_IN, str(finished)):
		prompt.cancel()
		bed.drop(sdk)
		return
	t.check("begin: the session is no longer waiting", not prompt.is_waiting())
	_signed_in(t, bed, sdk, finished[0], "begin")
	var out: PKeyResult = await sdk.identity.sign_out()
	t.check("begin: sign_out() releases the seat and the gate closes", out.ok and not sdk.is_licensed() and not sdk.core.tokens.has_token(), str(out))
	bed.drop(sdk)


## The prompt's shape: a code, both links on the server's own origin (a sign-in never leaves the
## server the SDK was configured for), a lifetime and a poll interval.
func _shape(t: PKeyTestContext, bed: PKeyDevLive, prompt: PKeySignInSession, group: String) -> void:
	t.check("%s: the prompt has a user code, both links on the server's origin and the code in the complete one" % group, prompt.user_code != "" and prompt.verification_uri.begins_with(bed.base_url + "/") \
			and prompt.verification_uri_complete.begins_with(bed.base_url + "/") and prompt.verification_uri_complete.contains(prompt.user_code), str(prompt))
	t.check("%s: the prompt has a lifetime and a poll interval" % group, prompt.expires_in > 0 and prompt.interval >= 1 and prompt.device_code != "" and not str(prompt).contains(prompt.device_code), "expires %d, interval %d" % [prompt.expires_in, prompt.interval])


## What a finished sign-in leaves: the person the fake provider approved (name and e-mail, which
## it vouches for), a token that opened the gate on a verified document, and the forced sync's
## result.
func _signed_in(t: PKeyTestContext, bed: PKeyDevLive, sdk: Node, result: PKeySignInOutcome, group: String) -> void:
	var person: Dictionary = bed.info.get("idp", {}).get("person", {})
	var named := String(person.get("name", "")) != "" and String(person.get("email", "")) != ""
	t.check("%s: the result names the person the provider approved, by name and e-mail" % group, named and result.identity.get("name") == person.get("name") and result.identity.get("email") == person.get("email"), "%s vs %s" % [result.identity, person])
	t.check("%s: the token is stored and the forced sync ran" % group, result.stored and result.sync != null and result.sync.ok and sdk.license.activation() == &"token", str(result.sync))
	t.check("%s: the verified license document opens the gate" % group, sdk.is_licensed() and sdk.status().get("status") == "ok", str(sdk.status()))
	var now: Variant = sdk.identity.current()
	t.check("%s: identity.current() reads the same person off that document" % group, now is Dictionary and now.get("name") == person.get("name") and now.get("email") == person.get("email"), str(now))
