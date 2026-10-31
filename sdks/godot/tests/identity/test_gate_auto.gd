extends RefCounted
# @pkey-feature identity.autosignin ui.gate
# The kit's automatic sign-in (I-48.9): the gate runs PolarisKey.identity.auto_sign_in() once when it
# shows the sign-in form, and draws the answer. The pure mapping (answer -> step, consent -> the step's
# lines), the runtime's providers, and the gate over a fake Worker: confirm (Continue sends the claims
# the step showed; Use another account gives the grant up), choose, device-limit, signed-in, the
# opt-out, and a ladder that finds nothing leaving the form alone.

const B := preload("res://tests/identity/support.gd")
const X := preload("res://tests/identity/test_exchange.gd")

const GRANT := X.GRANT


## A provider that answers a scripted token (rung 3), counting its calls.
class FakeProvider extends RefCounted:
	var kind := "google"
	var silent_calls := 0
	var row_calls := 0
	var row_answer: Dictionary = {"token": "platform.row.token.SECRET"}

	func has_silent() -> bool:
		return true

	func has_sheet() -> bool:
		return false

	func silent(_nonce: String, _audience: String) -> Dictionary:
		silent_calls += 1
		return {"token": "platform.id.token.SECRET"}

	func provider_row(_nonce: String, _audience: String) -> Dictionary:
		row_calls += 1
		return row_answer


func run(t: PKeyTestContext) -> void:
	_controller(t)
	_providers(t)
	await _gate(t)
	await _opt_out(t)
	await _row(t)


func _controller(t: PKeyTestContext) -> void:
	var ctl := PKeyGateController
	var confirm := PKeyAutoSignInResult.pending_answer(PKeyAutoSignInResult.KIND_CONFIRM, {"grant": GRANT, "consent": X.CONSENT}, "google")
	t.check(
		"gate auto: each answer maps to one action",
		ctl.auto_action(confirm) == "confirm"
		and ctl.auto_action(PKeyAutoSignInResult.pending_answer(PKeyAutoSignInResult.KIND_CHOOSE, {"grant": GRANT, "view": X.VIEW})) == "choose")
	t.check(
		"gate auto: signed in, device limit",
		ctl.auto_action(PKeyAutoSignInResult.signed_in("platform")) == "signed-in"
		and ctl.auto_action(PKeyAutoSignInResult.device_limit({}, "https://k/manage")) == "device-limit")
	t.check(
		"gate auto: needs_sign_in, unavailable and null leave the form",
		ctl.auto_action(PKeyAutoSignInResult.needs_sign_in("no_credential")) == "form"
		and ctl.auto_action(PKeyAutoSignInResult.unavailable(&"x")) == "form"
		and ctl.auto_action(null) == "form")
	var shown := ctl.consent_step(X.CONSENT)
	t.check("gate auto: the consent's email and first-time flag", shown["email"] == "a@example.com" and shown["also_gets"] == true and shown["license_line"] == "none")
	var rich := {"as": {"provider": "gamecenter", "email": null}, "firstTime": false, "changed": false, "items": [
		{"kind": "license", "anchor": {"name": "Pro"}, "more": 0}, {"kind": "cloudSync"}, {"kind": "profile", "claims": ["name", "email", "name"]}, "junk"]}
	shown = ctl.consent_step(rich)
	t.check(
		"gate auto: no email, an anchored licence is existing, claims are the profile's once each",
		shown["email"] == ""
		and shown["license_line"] == "existing"
		and shown["also_gets"] == false
		and shown["claims"] == ["name", "email"],
		str(shown))
	rich["items"][0] = {"kind": "license", "anchor": null, "more": 0}
	rich["changed"] = true
	shown = ctl.consent_step(rich)
	t.check("gate auto: no anchor is a new licence, a changed consent lists what the app also gets", shown["license_line"] == "new" and shown["also_gets"] == true)
	t.check("gate auto: a malformed consent is empty, not a crash", ctl.consent_step({})["claims"] == [] and ctl.consent_step({"items": 5, "as": 7})["email"] == "")
	t.check(
		"gate auto: only an https manage link is opened",
		ctl.manage_link(PKeyAutoSignInResult.device_limit({}, "https://k/manage")) == "https://k/manage"
		and ctl.manage_link(PKeyAutoSignInResult.device_limit({}, "http://k/manage")) == ""
		and ctl.manage_link(null) == "")


func _providers(t: PKeyTestContext) -> void:
	var prov := PKeyPlatformProviders
	t.check("providers: the form's own button is Apple on iOS and macOS", prov.row_kind("ios") == "apple" and prov.row_kind("macos") == "apple")
	t.check("providers: …and Google on Android", prov.row_kind("android") == "google")
	t.check("providers: …and nothing on the web or desktop (device code and redirect stay)", prov.row_kind("web") == "" and prov.row_kind("linux") == "" and prov.row_kind("windows") == "")
	var kinds := func(list: Array) -> Array: return list.map(func(p): return p.kind)
	t.check(
		"providers: iOS and macOS have Apple, and Game Center only when the extension is there",
		kinds.call(prov.for_platform("ios")) == ["apple"]
		and kinds.call(prov.for_platform("macos", {"gamecenter": true})) == ["apple", "gamecenter"])
	t.check("providers: Android has what the plugin carries", kinds.call(prov.for_platform("android", {"pgs": true, "google": true})) == ["pgs", "google"] and prov.for_platform("android", {}).is_empty())
	t.check(
		"providers: the web has FedCM, Linux and Windows have none",
		kinds.call(prov.for_platform("web")) == ["google"]
		and prov.for_platform("linux").is_empty()
		and prov.for_platform("windows").is_empty())
	var identity := PKeyIdentity.new()
	var mine := FakeProvider.new()
	mine.kind = "apple"
	identity.install_platform_provider(mine)
	var added := prov.install(identity, "ios")
	t.check("providers: install keeps a provider of the same kind and adds nothing else", added == 0 and identity.platform_providers() == [mine])
	t.check("providers: install adds this platform's, once", prov.install(identity, "web") == 1 and prov.install(identity, "web") == 0 and identity.platform_providers().size() == 2)
	t.check("providers: an unknown platform adds none", prov.install(PKeyIdentity.new(), "plan9") == 0)


func _stage(bed: B, auto := true) -> PKeyGateView:
	var gate := PKeyGateView.new()
	gate.auto_sdk = false
	gate.auto_sign_in = auto
	gate.sdk = bed.sdk
	(Engine.get_main_loop() as SceneTree).root.add_child(gate)
	return gate


func _wait(gate: PKeyGateView) -> PKeyAutoSignInResult:
	var box := []
	gate.auto_sign_in_finished.connect(func(r: PKeyAutoSignInResult) -> void: box.append(r))
	gate.show_state({"status": "needs-activation"})
	await B.until(func() -> bool: return not box.is_empty(), 900)
	return box[0] if not box.is_empty() else null


func _gate(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await X.new()._bed(["google"])
	var provider := FakeProvider.new()
	bed.sdk.identity.install_platform_provider(provider)
	bed.tokens = [B.json(200, {"status": "confirm", "grant": GRANT, "expiresIn": 300, "consent": X.CONSENT})]
	bed.choice_answers = {"complete": B.json(200, X.TOKEN_OK), "cancel": B.json(200, {})}
	var gate := _stage(bed)
	# Not installed twice by the gate: the game's own provider of the kind stays.
	var result := await _wait(gate)
	await tree.process_frame
	t.check("gate auto: needs-activation ran the ladder once (silent) and got a confirm", result != null and result.kind == PKeyAutoSignInResult.KIND_CONFIRM and provider.silent_calls == 1, str(result))
	t.check("gate auto: the consent step replaces the form", gate.auto_step.visible and not gate.activation.visible and gate.auto_step.email == "a@example.com")
	t.check(
		"gate auto: the step says who and offers Continue and Use another account",
		gate.auto_step.model.get("decisions", {}).get("primary") == "signin.auto.confirm.primary",
		str(gate.auto_step.model.get("decisions")))
	gate.show_state({"status": "needs-activation"})
	await tree.process_frame
	t.check("gate auto: showing the form again does not run the ladder again", provider.silent_calls == 1)
	gate._on_auto_primary("confirm")
	await B.until(func() -> bool: return bed.sdk.core.tokens.current() == X.TOKEN_NEW, 600)
	var sent: Dictionary = bed.choice_requests[0]["body"] if not bed.choice_requests.is_empty() else {}
	t.check("gate auto: Continue completes the grant with the claims the step showed", sent.get("grant") == GRANT and sent.get("consent") == {"claims": []} and not sent.has("choice"), str(sent))
	t.check("gate auto: the device token is stored and the step is gone", bed.sdk.core.tokens.current() == X.TOKEN_NEW and not gate.auto_step.visible)
	gate.queue_free()
	await tree.process_frame

	# Use another account gives the grant up and shows the form.
	bed.sdk.core.tokens.clear()
	bed.choice_requests.clear()
	bed.tokens = [B.json(200, {"status": "confirm", "grant": GRANT, "expiresIn": 300, "consent": X.CONSENT})]
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	gate = _stage(bed)
	await _wait(gate)
	gate._on_auto_secondary("confirm")
	await B.until(func() -> bool: return not bed.choice_requests.is_empty(), 300)
	t.check(
		"gate auto: Use another account cancels the grant",
		not bed.choice_requests.is_empty()
		and bed.choice_requests[0]["path"].ends_with("/choice/cancel")
		and bed.choice_requests[0]["body"] == {"grant": GRANT})
	await tree.process_frame
	t.check("gate auto: …and the regular form is back", not gate.auto_step.visible and gate.activation.visible)
	gate.queue_free()
	await tree.process_frame

	# A licence choice: the choice screen; the person's pick completes the grant.
	bed.choice_requests.clear()
	bed.tokens = [B.json(200, {"status": "choose", "grant": GRANT, "expiresIn": 300, "choices": X.VIEW})]
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	gate = _stage(bed)
	var chosen := await _wait(gate)
	await tree.process_frame
	t.check(
		"gate auto: a choose answer shows the licence choice",
		chosen != null
		and chosen.kind == PKeyAutoSignInResult.KIND_CHOOSE
		and gate.license_choice.visible
		and not gate.auto_step.visible,
		str(chosen))
	gate._on_auto_license_chosen({"kind": "license", "id": "lic_a"})
	await B.until(func() -> bool: return not bed.choice_requests.is_empty(), 300)
	var pick: Dictionary = bed.choice_requests[0]["body"] if not bed.choice_requests.is_empty() else {}
	t.check("gate auto: the pick is the grant's choice", pick.get("choice") == {"kind": "license", "licenseId": "lic_a"} and pick.get("grant") == GRANT, str(pick))
	gate.queue_free()
	await tree.process_frame

	# The device limit has its own step, with the manage page when the refusal names one.
	bed.tokens = [B.json(403, {"error": "device_limit", "manageUrl": "https://key.plrs.im/portal"})]
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	gate = _stage(bed)
	var limited := await _wait(gate)
	await tree.process_frame
	t.check(
		"gate auto: a full licence shows the device-limit step with Replace",
		limited != null
		and limited.kind == PKeyAutoSignInResult.KIND_DEVICE_LIMIT
		and gate.auto_step.visible
		and gate.auto_step.manage_url == "https://key.plrs.im/portal"
		and gate.auto_step.model["decisions"]["primary"] == "signin.deviceLimit.replace",
		str(gate.auto_step.model.get("decisions")))
	gate._on_auto_secondary("device-limit")
	await tree.process_frame
	t.check("gate auto: Use another account leaves the step", not gate.auto_step.visible and gate.activation.visible)
	gate.queue_free()
	await tree.process_frame

	# A ladder with nothing to offer leaves the form alone.
	bed.tokens = [B.json(401, {"error": "invalid_grant"})]
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	gate = _stage(bed)
	var none := await _wait(gate)
	await tree.process_frame
	t.check("gate auto: a refused platform token leaves the form as it is", none != null and gate.activation.visible and not gate.auto_step.visible and not gate.license_choice.visible, str(none))
	gate.queue_free()
	await tree.process_frame
	bed.free_all()


func _opt_out(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await X.new()._bed(["google"])
	var provider := FakeProvider.new()
	bed.sdk.identity.install_platform_provider(provider)
	var gate := _stage(bed, false)
	gate.show_state({"status": "needs-activation"})
	for i in 8:
		await tree.process_frame
	t.check("gate auto: auto_sign_in = false never runs the ladder", provider.silent_calls == 0 and gate.activation.visible and not gate.auto_step.visible)
	var box := []
	gate.auto_sign_in_finished.connect(func(r: PKeyAutoSignInResult) -> void: box.append(r))
	bed.tokens = [B.json(401, {"error": "invalid_grant"})]
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	gate.start_auto_sign_in()
	await B.until(func() -> bool: return not box.is_empty(), 600)
	t.check("gate auto: start_auto_sign_in() runs it by hand", provider.silent_calls == 1 and box.size() == 1)
	gate.queue_free()
	await tree.process_frame
	# A gate whose licence is fine, or whose screen is not the form, never starts it.
	var other := await X.new()._bed(["google"])
	var quiet := FakeProvider.new()
	other.sdk.identity.install_platform_provider(quiet)
	# (The gate reads the SDK's own status when it enters the tree: stage it with the ladder off first.)
	var g2 := _stage(other, false)
	await tree.process_frame
	g2.auto_sign_in = true
	g2.show_state({"status": "ok"})
	for i in 8:
		await tree.process_frame
	t.check("gate auto: a usable licence never runs the ladder", quiet.silent_calls == 0)
	g2.queue_free()
	await tree.process_frame
	bed.free_all()
	other.free_all()


## The sign-in dialog's button on a platform with its own sign-in: the provider's row, then the exchange.
func _row(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await X.new()._bed(["apple"])
	var provider := FakeProvider.new()
	provider.kind = "apple"
	bed.sdk.identity.install_platform_provider(provider)
	var dialog := PKeySignInDialog.new()
	dialog.auto_sdk = false
	dialog.sdk = bed.sdk
	dialog.platform_override = "ios"
	tree.root.add_child(dialog)
	var answers := []
	dialog.platform_answer.connect(func(r: PKeyAutoSignInResult) -> void: answers.append(r))
	var closed := []
	dialog.closed.connect(func() -> void: closed.append(true))
	bed.tokens = [B.json(200, {"status": "confirm", "grant": GRANT, "expiresIn": 300, "consent": X.CONSENT})]
	await dialog.begin()
	t.check(
		"row: a confirm is handed to the gate and the dialog closes",
		answers.size() == 1
		and answers[0].kind == PKeyAutoSignInResult.KIND_CONFIRM
		and closed.size() == 1
		and provider.row_calls == 1
		and provider.silent_calls == 0)
	t.check("row: …through the account sheet, not the silent call, with no device code started", bed.flow_requests.is_empty())

	bed.tokens = [B.json(200, X.TOKEN_OK)]
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	var done := []
	dialog.finished.connect(func(r: PKeySignInOutcome) -> void: done.append(r))
	await dialog.begin()
	t.check("row: a token signs in: the dialog ends with a signed-in outcome", done.size() == 1 and done[0].ok and dialog.state == "ended", str(dialog.state))
	t.check("row: …and the device token is stored", bed.sdk.core.tokens.current() == X.TOKEN_NEW)

	bed.sdk.core.tokens.clear()
	provider.row_answer = {"cancelled": true}
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	closed.clear()
	await dialog.begin()
	await B.until(func() -> bool: return not closed.is_empty(), 300)
	t.check("row: a dismissed sheet closes the dialog and starts no device code", closed.size() == 1 and bed.flow_requests.is_empty() and bed.sdk.core.tokens.current() == "")

	provider.row_answer = {"unavailable": "no account"}
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	await dialog.begin()
	await tree.process_frame
	t.check("row: a platform with nothing to offer falls back to the device code", not bed.flow_requests.is_empty(), str(dialog.state))
	dialog.queue_free()
	await tree.process_frame

	var plain := PKeySignInDialog.new()
	plain.auto_sdk = false
	plain.sdk = bed.sdk
	plain.platform_override = "linux"
	tree.root.add_child(plain)
	var rows := provider.row_calls
	bed.flow_requests.clear()
	await plain.begin()
	t.check("row: desktop keeps the device code and never asks the platform", provider.row_calls == rows and not bed.flow_requests.is_empty())
	plain.queue_free()
	await tree.process_frame
	bed.free_all()
