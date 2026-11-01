extends RefCounted
# @pkey-feature identity.autosignin ui.gate
# The kit's automatic sign-in (I-48.9): the gate runs PolarisKey.identity.auto_sign_in() once when it
# shows the sign-in form, and draws the answer. The pure mapping (answer -> step, consent -> the step's
# lines), the runtime's providers, and the gate over a fake Worker: confirm (Continue sends the claims
# the step showed; Use another account gives the grant up), choose, device-limit, signed-in, the
# opt-out, and a ladder that finds nothing leaving the form alone.

const B := preload("res://tests/identity/support.gd")
const X := preload("res://tests/identity/test_exchange.gd")
const SCEN := preload("res://tests/ui/scenarios.gd")

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
	await _steps(t)
	await _choose(t)
	await _continue_fails(t)
	await _race(t)
	await _limit(t)
	await _provider_row(t)


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
	t.check("gate auto: the consent's provider is the confirm kind", shown["kind"] == "gamecenter" and ctl.consent_step(X.CONSENT)["kind"] in ["", "apple", "google", "gamecenter", "pgs"])
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
	await dialog.begin_platform()
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
	await dialog.begin_platform()
	t.check("row: a token signs in: the dialog ends with a signed-in outcome", done.size() == 1 and done[0].ok and dialog.state == "ended", str(dialog.state))
	t.check("row: …and the device token is stored", bed.sdk.core.tokens.current() == X.TOKEN_NEW)

	bed.sdk.core.tokens.clear()
	provider.row_answer = {"cancelled": true}
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	closed.clear()
	await dialog.begin_platform()
	await B.until(func() -> bool: return not closed.is_empty(), 300)
	t.check("row: a dismissed sheet closes the dialog and starts no device code", closed.size() == 1 and bed.flow_requests.is_empty() and bed.sdk.core.tokens.current() == "")
	# B1: a person who signed out and then dismisses the sheet is still signed out, and the next boot stays quiet.
	bed.sdk.core.cache.set_explicit_sign_out(true)
	provider.row_answer = {"cancelled": true}
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	closed.clear()
	await dialog.begin_platform()
	await B.until(func() -> bool: return not closed.is_empty(), 300)
	t.check("row: a dismissed sheet after sign-out leaves the sign-out flag set", bed.sdk.core.cache.explicit_sign_out and bed.sdk.core.cache.record()["explicitSignOut"] == true)
	var silent_before := provider.silent_calls
	var boot = await bed.sdk.identity.auto_sign_in()
	t.check("row: …and the next boot does not sign in silently", boot.reason == PKeyAutoSignInResult.REASON_SIGNED_OUT and provider.silent_calls == silent_before and not bed.sdk.core.tokens.has_token())
	bed.sdk.core.cache.set_explicit_sign_out(false)

	provider.row_answer = {"unavailable": "no account"}
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	await dialog.begin_platform()
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
	await plain.begin_platform()
	t.check("row: desktop keeps the device code and never asks the platform", provider.row_calls == rows and not bed.flow_requests.is_empty())
	plain.queue_free()
	await tree.process_frame
	# begin() on iOS is Polaris Locker's device code: the platform is asked only through begin_platform().
	var locker := PKeySignInDialog.new()
	locker.auto_sdk = false
	locker.sdk = bed.sdk
	locker.platform_override = "ios"
	tree.root.add_child(locker)
	var asked := provider.row_calls
	bed.flow_requests.clear()
	await locker.begin()
	t.check("row: begin() is Polaris Locker's device code even on iOS", provider.row_calls == asked and not bed.flow_requests.is_empty())
	locker.queue_free()
	await tree.process_frame
	bed.free_all()


# ── The steps' words, the choice's ways out, Continue's failure, the race, the limit, the provider row ──



## Every visible label and button text under `n`.
func _texts(n: Node, out: Array = []) -> Array:
	for ch in n.get_children():
		if ch is Control and not (ch as Control).is_visible_in_tree():
			continue
		if ch is Label and (ch as Label).text != "":
			out.append((ch as Label).text)
		elif ch is Button and (ch as Button).text != "":
			out.append((ch as Button).text)
		_texts(ch, out)
	return out


func _no_placeholder(t: PKeyTestContext, what: String, texts: Array) -> void:
	var bad := texts.filter(func(x: String) -> bool: return x.contains("{") or x.contains("}") or x.contains("  "))
	t.check("steps: %s draws no raw placeholder or empty argument" % what, bad.is_empty(), str(bad))


func _step_in_tree(tree: SceneTree) -> PKeySignInStep:
	var step := PKeySignInStep.new()
	step.auto_sdk = false
	tree.root.add_child(step)
	return step


func _steps(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var step := _step_in_tree(tree)
	step.step = "confirm"
	step.email = "ada@mail.io"
	step.license_line = "existing"
	step.also_gets = true
	step.anchor = {"name": "Pro", "tierName": "Pro", "term": "perpetual", "position": 2, "limit": 3}
	await tree.process_frame
	await tree.process_frame
	var texts := _texts(step)
	var line := ""
	for x in texts:
		if String(x).contains("becomes device"):
			line = x
	t.check("steps: an existing licence's line names the licence, the term and the seat", line.contains("Pro") and line.contains("Lifetime") and line.contains("becomes device 2 of 3") and line.contains("this "), line)
	t.check("steps: …under its label, strong, with the account as the subtitle",
		texts.has("License for this device") and step._license_value.theme_type_variation == &"PKeyStrong" and String(step._lede.text).replace("\u200b", "").contains("ada@mail.io"))
	_no_placeholder(t, "an existing licence", texts)
	step.anchor = {"name": "Pro", "tierName": "Pro", "term": 1893456000, "position": 1, "limit": 1}
	await tree.process_frame
	t.check("steps: a dated term reads as its date", _texts(step).any(func(x): return String(x).contains("Until 2030-01-01")), str(_texts(step)))
	step.anchor = {"name": "Pro", "term": "perpetual", "position": 0, "limit": 0}
	await tree.process_frame
	texts = _texts(step)
	t.check("steps: a seat the answer does not know leaves the licence line and its label out", not step._license_group.visible and not texts.has("License for this device"), str(texts))
	_no_placeholder(t, "an existing licence with no seat", texts)
	step.license_line = "new"
	step.anchor = {}
	await tree.process_frame
	texts = _texts(step)
	t.check("steps: a new licence with no tier is the tier-less line", texts.has("Created when you continue") and texts.has("License for this device"), str(texts))
	_no_placeholder(t, "a new licence", texts)
	step.tier = "Pro"
	await tree.process_frame
	t.check("steps: …and with a tier it names it", _texts(step).any(func(x): return String(x).contains("Pro") and String(x).contains("license, created when you continue")), str(_texts(step)))
	_no_placeholder(t, "a new licence with a tier", _texts(step))
	step.email = ""
	await tree.process_frame
	t.check("steps: no email and no kind names no account", not _texts(step).has("with your Apple Account"), str(_texts(step)))
	step.exchange_kind = "apple"
	await tree.process_frame
	t.check("steps: no email, Apple is the provider line", _texts(step).has("with your Apple Account"), str(_texts(step)))
	step.exchange_kind = "gamecenter"
	await tree.process_frame
	t.check("steps: no email, Game Center is the provider line", _texts(step).has("with Game Center"), str(_texts(step)))
	step.exchange_kind = "pgs"
	await tree.process_frame
	t.check("steps: no email, Play Games is the provider line", _texts(step).has("with Google Play Games"), str(_texts(step)))
	step.step = "device-limit"
	step.manage_url = ""
	await tree.process_frame
	texts = _texts(step)
	var product := String(PKeyUiTheme.product_identity()["name"])
	t.check("steps: the limit with no link names the product and offers Try again", texts.any(func(x): return String(x).contains(product) and String(x).contains("Sign out of")) and texts.has("Try again"), str(texts))
	_no_placeholder(t, "the device limit with no link", texts)
	step.manage_url = "https://key.plrs.im/portal"
	await tree.process_frame
	texts = _texts(step)
	t.check("steps: the limit with a link offers Replace a device, with the new-window glyph", texts.has("Replace a device") and step._primary.icon != null, str(texts))
	_no_placeholder(t, "the device limit with a link", texts)
	for st in ["link-offer", "link-done", "link-conflict", "nearby-prompt", "nearby-wait", "nearby-done"]:
		step.step = st
		step.code = "42"
		await tree.process_frame
		_no_placeholder(t, "the %s step" % st, _texts(step))
	t.check("steps: a step nested in a card draws none of its own", true)
	step.queue_free()
	await tree.process_frame


func _confirm_gate(bed: B, tree: SceneTree, consent: Dictionary = X.CONSENT) -> PKeyGateView:
	bed.tokens = [B.json(200, {"status": "confirm", "grant": GRANT, "expiresIn": 300, "consent": consent})]
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	var gate := _stage(bed)
	await _wait(gate)
	await tree.process_frame
	return gate


func _choose(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await X.new()._bed(["google"])
	var provider := FakeProvider.new()
	bed.sdk.identity.install_platform_provider(provider)
	var many: Dictionary = SCEN.new().matrix_row("signIn", "LicenseChoice/many").get("input", {}).get("choices", X.VIEW)
	var full: Dictionary = SCEN.new().matrix_row("signIn", "LicenseChoice/all-full").get("input", {}).get("choices", X.VIEW)
	bed.choice_answers = {"complete": B.json(200, X.TOKEN_OK), "cancel": B.json(200, {}), "devices": B.json(200, {"licenseId": "lic_full", "devices": [{"id": "d1", "label": "Work laptop", "leastRecent": true}]})}
	for how in ["other", "key", "escape"]:
		bed.choice_requests.clear()
		bed.tokens = [B.json(200, {"status": "choose", "grant": GRANT, "expiresIn": 300, "choices": many})]
		bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
		var gate := _stage(bed)
		await _wait(gate)
		await tree.process_frame
		t.check("choose/%s: the choice is on screen with Use another account as its way out" % how,
			gate.license_choice.visible and gate._auto_state == "choose" and gate.license_choice._secondary.text == "Use another account", gate.license_choice._secondary.text)
		match how:
			"other":
				gate.license_choice.other_account_requested.emit()
			"key":
				gate.license_choice.key_requested.emit()
			"escape":
				t.check("choose/escape: Escape is handled", gate._cancel())
		await B.until(func() -> bool: return not bed.choice_requests.is_empty(), 300)
		await tree.process_frame
		t.check("choose/%s: the grant is cancelled and the form is back, no dead end" % how,
			bed.choice_requests.size() == 1 and String(bed.choice_requests[0]["path"]).ends_with("/choice/cancel")
			and gate.activation.visible and not gate.license_choice.visible and gate._auto_state == "", str(bed.choice_requests))
		t.check("choose/%s: the focus is on Polaris Locker's sign-in" % how, gate._initial_focus() == gate.activation.locker_sign_in_button())
		gate.queue_free()
		await tree.process_frame
	# Replace a device on a full licence: the devices, then complete with the device to replace.
	bed.choice_requests.clear()
	bed.tokens = [B.json(200, {"status": "choose", "grant": GRANT, "expiresIn": 300, "choices": full})]
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	var g := _stage(bed)
	await _wait(g)
	await tree.process_frame
	g.license_choice.replace_requested.emit("lic_full")
	await B.until(func() -> bool: return not g.license_choice.replace_view.is_empty(), 300)
	t.check("choose/replace: Replace a device opens the devices in place",
		bed.choice_requests.size() == 1 and String(bed.choice_requests[0]["path"]).ends_with("/choice/devices") and not g.license_choice.replace_view.is_empty())
	t.check("choose/replace: Escape goes back to the list first", g._cancel() and g.license_choice.replace_view.is_empty() and g._auto_state == "choose")
	g.license_choice.replace_confirmed.emit("lic_full", {"id": "d1", "label": "Work laptop"})
	await B.until(func() -> bool: return bed.choice_requests.size() >= 2, 300)
	var sent: Dictionary = bed.choice_requests[1]["body"] if bed.choice_requests.size() > 1 else {}
	t.check("choose/replace: Replace and continue completes with the device to replace", sent.get("choice") == {"kind": "license", "licenseId": "lic_full", "replaceDeviceId": "d1"}, str(sent))
	g.queue_free()
	await tree.process_frame
	bed.free_all()


func _continue_fails(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await X.new()._bed(["google"])
	bed.sdk.identity.install_platform_provider(FakeProvider.new())
	bed.choice_answers = {"complete": B.json(503, {}), "cancel": B.json(200, {})}
	var gate := await _confirm_gate(bed, tree)
	var completes := func() -> int: return bed.choice_requests.filter(func(r): return String(r["path"]).ends_with("/complete")).size()
	gate._on_auto_primary("confirm")
	gate._on_auto_primary("confirm")
	t.check("continue: a second press while one is in flight sends nothing more", completes.call() <= 1 and gate._completing)
	await B.until(func() -> bool: return not gate._completing, 300)
	await tree.process_frame
	t.check("continue: one request was sent for two presses", completes.call() == 1, str(completes.call()))
	t.check("continue: a failure keeps the step and shows the kit's network line", gate.auto_step.visible and _texts(gate.auto_step).has("Can't reach Polaris Locker. Check your connection and try again."), str(_texts(gate.auto_step)))
	t.check("continue: the grant is still good: nothing was cancelled", bed.choice_requests.filter(func(r): return String(r["path"]).ends_with("/cancel")).is_empty())
	t.check("continue: the step is not busy any more", not gate.auto_step.busy)
	bed.choice_answers = {"complete": B.json(200, X.TOKEN_OK), "cancel": B.json(200, {})}
	gate._on_auto_primary("confirm")
	await B.until(func() -> bool: return bed.sdk.core.tokens.current() == X.TOKEN_NEW, 300)
	t.check("continue: Continue is the retry", bed.sdk.core.tokens.current() == X.TOKEN_NEW and not gate.auto_step.visible)
	gate.queue_free()
	await tree.process_frame
	# An expired grant leaves for the form, says so, and gives the grant up.
	bed.sdk.core.tokens.clear()
	bed.choice_requests.clear()
	bed.choice_answers = {"complete": B.json(401, {"error": "invalid_grant"}), "cancel": B.json(200, {})}
	gate = await _confirm_gate(bed, tree)
	gate._on_auto_primary("confirm")
	await B.until(func() -> bool: return not gate._completing, 300)
	await tree.process_frame
	t.check("continue: an expired grant returns to the form with the kit's line",
		not gate.auto_step.visible and gate.activation.visible and gate.error.contains("expired"), gate.error)
	gate.queue_free()
	await tree.process_frame
	bed.free_all()


func _race(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await X.new()._bed(["google"])
	var slow := FakeProvider.new()
	bed.sdk.identity.install_platform_provider(slow)
	bed.tokens = [B.json(200, {"status": "confirm", "grant": GRANT, "expiresIn": 300, "consent": X.CONSENT})]
	bed.choice_answers = {"cancel": B.json(200, {})}
	var gate := _stage(bed)
	var box := []
	gate.auto_sign_in_finished.connect(func(r: PKeyAutoSignInResult) -> void: box.append(r))
	gate.show_state({"status": "needs-activation"})
	await tree.process_frame
	await tree.process_frame
	t.check("race: while the silent rungs run the gate holds a quiet busy state", gate._auto_running or not box.is_empty())
	# The person opens Sign in by hand before the answer lands.
	gate.activation.open_mode("sign-in")
	await B.until(func() -> bool: return not box.is_empty(), 900)
	await tree.process_frame
	t.check("race: a late confirm never replaces a manual sign-in", box[0].kind == PKeyAutoSignInResult.KIND_CONFIRM and not gate.auto_step.visible and gate._auto_state == "" and gate.activation.mode == "sign-in")
	await B.until(func() -> bool: return not bed.choice_requests.is_empty(), 300)
	t.check("race: …and its grant is given up", bed.choice_requests.size() == 1 and String(bed.choice_requests[0]["path"]).ends_with("/choice/cancel"))
	gate.queue_free()
	await tree.process_frame
	bed.free_all()


func _limit(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await X.new()._bed(["google"])
	var provider := FakeProvider.new()
	bed.sdk.identity.install_platform_provider(provider)
	# No link: Try again runs the sign-in once more.
	bed.tokens = [B.json(403, {"error": "device_limit"})]
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	var gate := _stage(bed)
	await _wait(gate)
	await tree.process_frame
	t.check("limit: with no link the step offers Try again", gate.auto_step.visible and gate.auto_step._primary.text == "Try again", gate.auto_step._primary.text)
	bed.tokens = [B.json(200, X.TOKEN_OK)]
	var before := provider.silent_calls
	gate._on_auto_primary("device-limit")
	await B.until(func() -> bool: return bed.sdk.core.tokens.current() == X.TOKEN_NEW and gate._auto_state == "", 600)
	await tree.process_frame
	t.check("limit: Try again signs in once more, and the step is gone", provider.silent_calls == before + 1 and not gate.auto_step.visible and gate._auto_state == "", "%d/%d vis=%s state=%s tok=%s" % [provider.silent_calls, before, gate.auto_step.visible, gate._auto_state, bed.sdk.core.tokens.current()])
	gate.queue_free()
	await tree.process_frame
	# With a link: coming back from the browser runs the sign-in again, and still full shows the step again.
	bed.sdk.core.tokens.clear()
	bed.tokens = [B.json(403, {"error": "device_limit", "manageUrl": "https://key.plrs.im/portal"})]
	gate = _stage(bed)
	await _wait(gate)
	await tree.process_frame
	gate._replacing = true
	before = provider.silent_calls
	gate._notification(MainLoop.NOTIFICATION_APPLICATION_FOCUS_IN)
	await B.until(func() -> bool: return provider.silent_calls > before and not gate._auto_running, 600)
	await tree.process_frame
	t.check("limit: back from Replace the sign-in runs again; still full is the same step", provider.silent_calls == before + 1 and gate._auto_state == "device-limit" and gate.auto_step.visible)
	# A pad-only device has no browser: the link is a QR code.
	PKeyUiView.pad_only_override = true
	gate.refresh_view()
	await tree.process_frame
	await tree.process_frame
	t.check("limit: a pad-only device shows the page as a QR code, with Try again", gate.auto_step._qr.visible and gate.auto_step._qr.text == "https://key.plrs.im/portal" and gate.auto_step._primary.text == "Try again")
	PKeyUiView.pad_only_override = null
	gate.queue_free()
	await tree.process_frame
	bed.free_all()


func _provider_row(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await X.new()._bed(["apple"])
	var apple := FakeProvider.new()
	apple.kind = "apple"
	apple.row_answer = {"cancelled": true}
	bed.sdk.identity.install_platform_provider(apple)
	for where in ["ios", "android", "linux"]:
		var gate := _stage(bed, false)
		gate.activation.sign_in_dialog.platform_override = where
		gate.activation.set_capabilities(PKeyActivationController.capabilities(true, true, false, false))
		gate.show_state({"status": "needs-activation"})
		await tree.process_frame
		await tree.process_frame
		var panel := gate.activation
		var kind := PKeyPlatformProviders.row_kind(where)
		if kind == "":
			t.check("provider row: desktop has one Sign in and no provider button", not panel._provider.visible and panel._sign_in.text == "Sign in")
			gate.queue_free()
			await tree.process_frame
			continue
		var label := "Continue with Apple" if where == "ios" else "Continue with Google"
		t.check("provider row (%s): the platform's button leads: %s" % [where, label], panel._provider.visible and panel._provider.text == label, panel._provider.text)
		t.check("provider row (%s): Polaris Locker's sign-in is the next row" % where, panel._sign_in.visible and panel._sign_in.text == "Continue with Polaris Locker", panel._sign_in.text)
		var colours := PKeyProviderButton.colours(kind, PKeyUiTheme.is_dark(gate))
		var fill := (panel._provider.get_theme_stylebox("normal") as StyleBoxFlat).bg_color
		t.check("provider row (%s): the provider keeps its own fill, never the accent" % where, fill == colours["fill"], str(fill))
		t.check("provider row (%s): …and its logo" % where, panel._provider.icon != null)
		if where == "android":
			t.check("provider row (android): Google's fill and G come from the generated tokens",
				PKeyProviderButton.colours("google", true)["fill"] == Color(PKeyKitIcons.GOOGLE_BUTTON["dark"]["fill"]) and PKeyProviderButton.colours("google", false)["fill"] == Color(PKeyKitIcons.GOOGLE_BUTTON["light"]["fill"]))
		if where == "ios":
			# A dismissed sheet returns to the form with the focus on the platform's button, and Polaris Locker is one press away.
			bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
			panel._provider.grab_focus()
			panel._provider.pressed.emit()
			await B.until(func() -> bool: return apple.row_calls > 0 and panel.mode == "main", 300)
			await tree.process_frame
			t.check("provider row: a dismissed sheet returns to the form, no device code started", panel.mode == "main" and panel.visible and bed.flow_requests.is_empty())
			bed.flow_requests.clear()
			bed.starts = [B.started()]
			panel._sign_in.pressed.emit()
			await B.until(func() -> bool: return not bed.flow_requests.is_empty(), 300)
			t.check("provider row: Continue with Polaris Locker starts the device code", not bed.flow_requests.is_empty() and panel.mode == "sign-in")
		gate.queue_free()
		await tree.process_frame
	bed.free_all()
