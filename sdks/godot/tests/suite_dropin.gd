extends RefCounted
# @pkey-feature ui.kit ui.boot
# The drop-in's flows end to end, on a live SDK against the loopback Worker (UK-50): what a player
# goes through with `await PolarisKey.boot()` and the kit's own screens, with no harness between.
#
#   retry       OFFLINE -> Try again -> READY resolves the awaited boot(), and the game's next line runs;
#               resolve_on_stop opts out; a second boot() while one runs joins it.
#   regate      sign_out() then boot() again shows key entry and Sign in; the persistent gate comes
#               back over the game on its own; every dialog opened from the live gate renders.
#   focus       a cold boot with no pointer focuses the first control and ui_down walks the chain.
#   activation  a wrong pin and a +2-day clock never say "Activated."; the right ones do.
#   misc        for_result reads like the panel, key entry follows effective capabilities, the settings
#               panel fetches its schema, a friendly device name, one update prompt, the expired banner.

const S := preload("res://tests/license/support.gd")
const SC := preload("res://tests/ui/scenarios.gd")
const KEY := "PKEY-TEST-KEY-0000"
const SERVICES := ["license", "config", "identity"]

var h: PKeyLicenseTestSupport


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	h = PKeyLicenseTestSupport.new()
	if not t.check("dropin: fixtures present", h.ready()):
		return true
	PKeyUiView.pointer_last = false
	PKeyUiView._pointer_known = true
	PKeyUiView.mobile_override = false
	PKeyUiView.pad_only_override = false
	await _retry(t)
	await _regate(t)
	await _sdk_setter(t)
	await _activation(t)
	await _misc(t)
	PKeyUiView.mobile_override = null
	PKeyUiView.pad_only_override = null
	h.free_server()
	return true


static func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


## Frames until `cond` is true (a hang guard, not a speed budget). True when it became so.
func _until(cond: Callable, seconds := 20.0) -> bool:
	var started := Time.get_ticks_msec()
	while not cond.call() and float(Time.get_ticks_msec() - started) < seconds * 1000.0:
		await _tree().process_frame
	return cond.call()


func _sdk(store: PKeyStore, tweak := Callable()) -> Node:
	return await h.sdk(store, PackedStringArray(SERVICES), func(o: PKeyOptions) -> void:
		o.request_timeout_seconds = 1.0
		if tweak.is_valid():
			tweak.call(o))


func _licensed_store() -> PKeyMemoryStore:
	return PKeyMemoryStore.new(h.F["device_id"], h.F["token"])


# ── Retry ────────────────────────────────────────────────────────────────────────────────

func _retry(t: PKeyTestContext) -> void:
	# The Worker does not answer the first sync: the boot stops OFFLINE (allow_offline false), the
	# card offers Try again, and the awaited boot() is still waiting.
	h.serve_docs([h.F["token"]])
	h.plan["/license/document"] = [{"hang": true}]
	h.plan["/config/document"] = [{"hang": true}]
	var sdk := await _sdk(_licensed_store())
	var state := {"result": null, "scene": ""}
	var game := func() -> void:
		state["result"] = await sdk.boot({"allow_offline": false, "sync_timeout_seconds": 0.5})
		state["scene"] = "title"
	game.call()
	var stopped := await _until(func() -> bool: return sdk.boot_view != null and is_instance_valid(sdk.boot_view) and sdk.boot_view.state["outcome"] == PKeyBoot.OFFLINE)
	t.check("retry: the boot stops OFFLINE with its card on screen", stopped and sdk.boot_view._retry.is_visible_in_tree(), str(sdk.boot_view.state if sdk.boot_view != null else null))
	t.check("retry: the awaited boot() is still waiting at the stop", state["result"] == null and state["scene"] == "")
	# The Worker answers now (the stopped boot's own sync has ended: Try again starts a new one).
	await _until(func() -> bool: return not sdk._syncing)
	h.serve_docs([h.F["token"]])
	sdk.boot_view._retry.pressed.emit()
	var through := await _until(func() -> bool: return state["result"] != null)
	t.check("retry: Try again to READY resolves the awaited boot()", through and state["result"].outcome == PKeyBoot.READY, str(state["result"]))
	t.check("retry: ... and the game's next line (the scene change) runs", state["scene"] == "title")
	await _until(func() -> bool: return sdk.boot_view == null or not is_instance_valid(sdk.boot_view) or sdk.boot_view.is_queued_for_deletion())
	sdk.queue_free()
	await _tree().process_frame

	# resolve_on_stop: true resolves at the first stop.
	h.plan["/license/document"] = [{"hang": true}]
	h.plan["/config/document"] = [{"hang": true}]
	var sdk2 := await _sdk(_licensed_store())
	var r2: PKeyBootResult = await sdk2.boot({"allow_offline": false, "sync_timeout_seconds": 0.5, "resolve_on_stop": true})
	t.check("retry: resolve_on_stop resolves at the first stop", r2.outcome == PKeyBoot.OFFLINE, str(r2))
	await _until(func() -> bool: return not sdk2._syncing)
	sdk2.queue_free()
	await _tree().process_frame

	# A second boot() while one runs joins it: one boot view, one stage walk.
	h.serve_docs([h.F["token"]])
	var sdk3 := await _sdk(_licensed_store())
	var results: Array = []
	var ask := func() -> void:
		results.append(await sdk3.boot({"sync_timeout_seconds": 5}))
	ask.call()
	ask.call()
	var both := await _until(func() -> bool: return results.size() == 2)
	t.check("retry: two boot() calls at once both resolve at READY", both and results[0].outcome == PKeyBoot.READY and results[1].outcome == PKeyBoot.READY and results[0] == results[1], str(results))
	sdk3.queue_free()
	await _tree().process_frame

	# A boot() that arrives while a Retry is under way joins it: both awaits resolve.
	h.plan["/license/document"] = [{"hang": true}]
	h.plan["/config/document"] = [{"hang": true}]
	var sdk4 := await _sdk(_licensed_store())
	var late: Array = []
	var ask4 := func() -> void:
		late.append(await sdk4.boot({"allow_offline": false, "sync_timeout_seconds": 0.5}))
	ask4.call()
	await _until(func() -> bool: return sdk4.boot_view != null and sdk4.boot_view.state["outcome"] == PKeyBoot.OFFLINE)
	await _until(func() -> bool: return not sdk4._syncing)
	h.serve_docs([h.F["token"]])
	var restarts := [0]
	sdk4.boot_view.stage_changed.connect(func(stage: String, _p: String) -> void:
		if stage == "shell":
			restarts[0] += 1)
	sdk4.boot_view.retry()
	ask4.call()
	var joined := await _until(func() -> bool: return late.size() == 2)
	t.check("retry: a boot() during a Retry joins it, and both awaits resolve", joined and restarts[0] == 0 and late[0].outcome == PKeyBoot.READY and late[1].outcome == PKeyBoot.READY, "%s restarts %d" % [late, restarts[0]])
	sdk4.queue_free()
	await _tree().process_frame


# ── Re-gating ────────────────────────────────────────────────────────────────────────────

func _regate(t: PKeyTestContext) -> void:
	h.serve_docs([h.F["token"]])
	h.plan["/license/deauthorize"] = [S.json(200, {"ok": true})]
	var sdk := await _sdk(_licensed_store())
	var first: PKeyBootResult = await sdk.boot({"persistent_gate": true, "confirm_identity": true, "sync_timeout_seconds": 5})
	t.check("regate: a licensed device boots to READY", first.outcome == PKeyBoot.READY, str(first))
	await _until(func() -> bool: return sdk.boot_view == null or not is_instance_valid(sdk.boot_view) or sdk.boot_view.is_queued_for_deletion())
	var gate = sdk.boot_gate
	t.check("regate: persistent_gate leaves a gate on the layer, out of the way while licensed", gate is PKeyGateView and not gate.visible, str(gate))
	t.check("regate: confirm_identity reaches the persistent gate's sign-in dialog", gate.confirm_identity and gate.activation.sign_in_dialog.confirm_identity)
	# The licence is lost: the persistent gate covers the game with key entry on its own.
	await sdk.identity.sign_out()
	await _until(func() -> bool: return gate.visible and gate.activation.visible)
	t.check("regate: after sign_out() the persistent gate shows key entry and Sign in", gate.visible and gate.activation._key.is_visible_in_tree() and gate.activation._sign_in.is_visible_in_tree(), "visible %s key %s signin %s" % [gate.visible, gate.activation._key.is_visible_in_tree(), gate.activation._sign_in.is_visible_in_tree()])
	var gate_theme_ok: bool = PKeyUiTheme.is_stock(gate.theme)
	var a11y: Control = gate.activation._key
	if "accessibility_name" in a11y:
		t.check("regate: the key field has an accessible name", String(a11y.get("accessibility_name")) != "", str(a11y.get("accessibility_name")))
	# A boot after the sign-out starts a new boot with a fresh gate (re-entrant boot()).
	var again := {"result": null}
	var ask := func() -> void:
		again["result"] = await sdk.boot({"sync_timeout_seconds": 5})
	ask.call()
	await _until(func() -> bool: return sdk.boot_view != null and is_instance_valid(sdk.boot_view) and sdk.boot_view.gate.visible and sdk.boot_view.gate.activation.visible)
	var view: PKeyBoot = sdk.boot_view
	t.check("regate: a re-boot after sign_out() shows key entry and Sign in", view != null and view.gate.activation._key.is_visible_in_tree() and view.gate.activation._sign_in.is_visible_in_tree() and again["result"] == null)
	t.check("regate: a boot without confirm_identity does not confirm", not view.gate.activation.sign_in_dialog.confirm_identity)
	t.check("regate: the persistent gate carried the kit's theme", gate_theme_ok)
	t.check("regate: the earlier persistent gate gave way to the new boot's", not is_instance_valid(gate) or gate.is_queued_for_deletion())
	# A cold boot with no pointer focuses the first control, and ui_down walks the chain.
	await _until(func() -> bool: return _tree().root.gui_get_focus_owner() != null and view.is_ancestor_of(_tree().root.gui_get_focus_owner()))
	var owner := _tree().root.gui_get_focus_owner()
	t.check("regate: a cold boot with no pointer puts the focus inside the gate", owner != null and view.is_ancestor_of(owner), str(owner))
	var walked: Array = []
	for i in 4:
		if owner != null:
			walked.append(owner)
		_press("ui_down")
		await _tree().process_frame
		await _tree().process_frame
		owner = _tree().root.gui_get_focus_owner()
	t.check("regate: ui_down walks the chain (each step lands on another control of the gate)", walked.size() == 4 and walked[0] != walked[1] and walked[1] != walked[2] and walked.all(func(c): return view.is_ancestor_of(c)), str(walked))
	# Every dialog opened from the live gate renders its content.
	var panel: PKeyActivationPanel = view.gate.activation
	panel.open_mode("offline")
	await _tree().process_frame
	var code: Label = panel.offline_dialog.find_child("RequestCode", true, false)
	t.check("regate: the offline dialog opened from the live gate shows its request code", code != null and code.is_visible_in_tree() and code.text == h.F["device_id"], str(code.text if code != null else null))
	panel.open_mode("sign-in")
	await _tree().process_frame
	t.check("regate: the sign-in dialog opened from the live gate has the SDK", panel.sign_in_dialog.sdk == sdk and panel.offline_dialog.sdk == sdk)
	panel.open_mode("main")
	await _focus_after_dialogs(t, view, panel)
	sdk.queue_free()
	await _tree().process_frame


## Dialogs opened from the boot's gate open with the focus inside them, and closing one leaves it in
## the form again (never on nothing).
func _focus_after_dialogs(t: PKeyTestContext, view: PKeyBoot, panel: PKeyActivationPanel) -> void:
	var inside := func(n: Node) -> bool:
		var f := _tree().root.gui_get_focus_owner()
		return f != null and n.is_ancestor_of(f) and f.is_visible_in_tree()
	for how in ["sign-in", "offline", "confirm"]:
		panel.open_mode("main")
		await _tree().create_timer(0.3).timeout
		if how == "confirm":
			panel.open_mode("sign-in")
			panel.sign_in_dialog.show_confirm({"identity": {"name": "Ada"}, "attachable": false})
		else:
			panel.open_mode(how)
		await _until(func() -> bool: return inside.call(panel), 3.0)
		var dialog: Node = panel.offline_dialog if how == "offline" else panel.sign_in_dialog
		t.check("dialog focus: the %s dialog opened from the boot's gate has the focus inside it" % how, inside.call(dialog), str(_tree().root.gui_get_focus_owner()))
		_press("ui_cancel")
		await _until(func() -> bool: return panel.mode == "main" and inside.call(panel), 3.0)
		t.check("dialog focus: Back from the %s dialog leaves the focus in the form" % how, panel.mode == "main" and inside.call(panel), "%s %s" % [panel.mode, _tree().root.gui_get_focus_owner()])


static func _press(action: String) -> void:
	for pressed in [true, false]:
		var e := InputEventAction.new()
		e.action = action
		e.pressed = pressed
		Input.parse_input_event(e)
		_tree().root.push_input(e)


# ── The sdk setter ───────────────────────────────────────────────────────────────────────

## `PKeyUiView.sdk` is a setter: a gate placed before the SDK was known, and given it later, hands
## it to the views nested in it and renders again.
func _sdk_setter(t: PKeyTestContext) -> void:
	h.serve_docs([h.F["token"]])
	var sdk := await _sdk(PKeyMemoryStore.new(h.F["device_id"]))
	var gate := PKeyGateView.new()
	gate.auto_sdk = false
	_tree().root.add_child(gate)
	await _tree().process_frame
	t.check("sdk setter: a gate placed with no SDK has none in its panel or dialogs", gate.activation.sdk == null and gate.activation.offline_dialog.sdk == null)
	gate.sdk = sdk
	t.check("sdk setter: giving the gate the SDK gives it to the activation panel and its dialogs", gate.activation.sdk == sdk and gate.activation.sign_in_dialog.sdk == sdk and gate.activation.offline_dialog.sdk == sdk)
	gate.show_state({"status": "needs-activation"})
	gate.activation.open_mode("offline")
	await _tree().process_frame
	var code: Label = gate.activation.offline_dialog.find_child("RequestCode", true, false)
	t.check("sdk setter: the offline dialog shows its request code", code != null and code.is_visible_in_tree() and code.text == h.F["device_id"], str(code.text if code != null else null))
	var other := await _sdk(PKeyMemoryStore.new(h.F["device_id"]))
	gate.sdk = other
	t.check("sdk setter: a replaced SDK replaces the nested views' too", gate.activation.sdk == other and gate.activation.offline_dialog.sdk == other)
	gate.queue_free()
	await _tree().process_frame
	sdk.queue_free()
	other.queue_free()
	await _tree().process_frame


# ── Activation ───────────────────────────────────────────────────────────────────────────

func _activation(t: PKeyTestContext) -> void:
	var token: String = h.F["token"]
	# The right pins and clock: ok.
	h.plan = {"/license/activate": [S.json(200, {"token": token, "schemaVersion": 2})]}
	h.serve_docs([token])
	var sdk := await _sdk(PKeyMemoryStore.new(h.F["device_id"]))
	var r: PKeyActivationResult = await sdk.license.activate_with_key(KEY)
	t.check("activation: a verified licence is ok", r.ok and PKeyUiCopy.new().for_result(r) == "", str(r))
	sdk.queue_free()
	# A wrong pin: the key is accepted, the documents do not verify.
	for how in ["a wrong pin", "a clock two days ahead"]:
		h.plan = {"/license/activate": [S.json(200, {"token": token, "schemaVersion": 2})]}
		h.serve_docs([token])
		var store := PKeyMemoryStore.new(h.F["device_id"])
		var bad := await _sdk(store, func(o: PKeyOptions) -> void:
			if how == "a wrong pin":
				o.pinned_trust_keys = {"other-kid": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
			else:
				var ahead: float = float(h.F["now"]) + 2.0 * 86400.0
				o.now_source = func(): return ahead)
		var failed: PKeyActivationResult = await bad.license.activate_with_key(KEY)
		t.check("activation: %s never reports ok" % how, not failed.ok and failed.kind == PKeyActivationResult.KIND_ERROR, str(failed))
		var words := PKeyUiCopy.new().for_result(failed)
		t.check("activation: %s shows words that are not 'Activated.'" % how, words != "" and words != PKeyUiCopy.new().text("activation_ok") and not words.contains("Activated"), words)
		# The panel never says Activated, and never emits `activated`.
		var panel := PKeyActivationPanel.new()
		panel.sdk = bad
		panel.auto_sdk = false
		_tree().root.add_child(panel)
		var emitted := [0]
		panel.activated.connect(func() -> void: emitted[0] += 1)
		panel.show_result(failed, KEY)
		t.check("activation: %s, the panel shows an error, not 'Activated.'" % how, not panel.message_ok and panel.message != PKeyUiCopy.new().text("activation_ok") and emitted[0] == 0, panel.message)
		panel.queue_free()
		bad.queue_free()
		await _tree().process_frame


# ── Smaller fixes ────────────────────────────────────────────────────────────────────────

func _misc(t: PKeyTestContext) -> void:
	var c := PKeyUiCopy.new()
	# for_result goes through the panel's own message path, and is empty on ok.
	var ok := PKeyActivationResult.of(PKeyActivationResult.KIND_OK, &"", "", 200)
	t.check("copy: for_result on an ok result is empty", c.for_result(ok) == "" and c.for_result(PKeyResult.success()) == "")
	for kind in [PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyActivationResult.KIND_UNAUTHORIZED, PKeyActivationResult.KIND_RATE_LIMITED, PKeyActivationResult.KIND_LICENSE_EXPIRED]:
		var r := PKeyActivationResult.of(kind, &"x", "raw", 403)
		var m := PKeyActivationController.message_for(r)
		t.check("copy: for_result(%s) is the panel's message" % kind, c.for_result(r) == c.text(m[0], m[1]))
	var net := PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.NETWORK, "x")
	PKeyUiTheme.product_name = "Diceroll"
	t.check("copy: network copy names the product, never Polaris Key", c.for_result(net).begins_with("Diceroll couldn't connect") and not c.for_result(net).contains("Polaris Key"), c.for_result(net))
	t.check("copy: a timeout names the product too", c.for_result(PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.TIMEOUT, "x")).begins_with("Diceroll "))
	PKeyUiTheme.product_name = ""
	# No product screen shows the Pinned K: nothing in the kit's scenes reaches for the mark (the
	# product's name, icon and monogram lead; the Powered-by badge is the only brand node).
	var users: Array = []
	_scan_for_mark("res://addons/polaris_key/ui", users)
	t.check("brand: no kit scene uses the Pinned K mark", users.is_empty(), str(users))
	# A store build with no way to activate says where to get the game, not an empty form.
	PKeyUiTheme.product_name = "Diceroll"
	var storesdk := await _sdk(PKeyMemoryStore.new(h.F["device_id"]), func(o: PKeyOptions) -> void: o.update_outlet = "app-store")
	var storeonly := PKeyActivationPanel.new()
	storeonly.auto_sdk = false
	storeonly.sdk = storesdk
	_tree().root.add_child(storeonly)
	PKeyUiTheme.product_name = "Diceroll"
	storeonly.set_capabilities({"key_entry": false, "sign_in": false, "continue_free": false, "offline": false})
	t.check("activation: a store build with no way in says where to get the game", storeonly._store_note.visible and storeonly._store_note.text == "Get Diceroll from the App Store to play." and not storeonly._key_field.visible, storeonly._store_note.text)
	storeonly.set_capabilities({"key_entry": true, "sign_in": false, "continue_free": false, "offline": false})
	t.check("activation: ... and says nothing when there is a way in", not storeonly._store_note.visible)
	storeonly.queue_free()
	storesdk.queue_free()
	PKeyUiTheme.product_name = ""
	# The product header: a large host title is matched by the icon and the name, and the SDK's own
	# development project name is no product (the header is not drawn).
	var header := PKeyProductHeader.new()
	_tree().root.add_child(header)
	PKeyUiTheme.product_name = ""
	PKeyUiTheme.hide_dev_project_name = true
	header.refresh()
	t.check("product header: the dev project's name draws no header", not header.visible)
	PKeyUiTheme.hide_dev_project_name = false
	header.refresh()
	t.check("product header: ... other names do", header.visible and header.product_name() == PKeyUiTheme.DEV_PROJECT_NAME)
	PKeyUiTheme.product_name = "Diceroll"
	var big := Theme.new()
	big.set_font_size("font_size", "PKeyTitle", 36)
	big.set_font_size("font_size", "PKeyStrong", 16)
	header.theme = big
	header.refresh()
	t.check("product header: beside a 36 px title the icon is 36 px or more and the name 18 px or more", header._tile.custom_minimum_size.x >= 36.0 and header._name.get_theme_font_size("font_size") >= 18, "%s %d" % [header._tile.custom_minimum_size, header._name.get_theme_font_size("font_size")])
	header.queue_free()
	PKeyUiTheme.product_name = ""
	# The banner's expired state.
	var lines := PKeyBannerController.lines({"status": "expired"}, 0.0, false, false, c)
	t.check("banner: an expired licence earns a line", lines.size() == 1 and lines[0][0] == "banner_expired", str(lines))
	var banner := PKeyStatusBanner.new()
	banner.auto_sdk = false
	banner.now_source = func() -> float: return 0.0
	_tree().root.add_child(banner)
	banner.show_state({"status": "expired"})
	t.check("banner: the expired strip shows", banner.visible and (banner.find_child("Line0", true, false) as Label).text == c.text("banner_expired"))
	banner.queue_free()
	# Key entry follows the effective capabilities.
	for kind in PKeyDecision.CAPABILITY_DEFAULTS:
		var commerce: String = PKeyDecision.effective_capabilities(kind, {"platform": ""})["commerce"]
		t.check("activation: %s key entry follows commerce %s" % [kind, commerce], PKeyActivationController.store_hides_key_entry(kind) == (commerce == "store-iap"))
	# The device's name.
	var friendly := PKeyDeviceLabel.friendly_default()
	t.check("device name: the drop-in default is a name, not a bare OS name where the computer has one", friendly != "" and (PKeyDeviceLabel.computer_name() == "" or friendly == PKeyDeviceLabel.computer_name() or friendly == OS.get_model_name()), friendly)
	var opts := PKeyOptions.new()
	opts.product = "djdl"
	opts.version = "1.0.0"
	opts.base_url = "http://127.0.0.1:9"
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(opts)
	sdk.use_friendly_device_name()
	t.check("device name: the drop-in names the device once configured", opts.device_name == friendly, opts.device_name)
	var named := PKeyOptions.new()
	named.product = "djdl"
	named.version = "1.0.0"
	named.base_url = "http://127.0.0.1:9"
	named.device_name = "Living room TV"
	sdk.configure(named)
	sdk.use_friendly_device_name()
	t.check("device name: a game's own name stays", named.device_name == "Living room TV")
	sdk.queue_free()
	await _update_prompt(t)
	await _check_again(t)
	await _settings_schema(t)


class FakeUpdate:
	extends RefCounted
	signal update_available(r)
	var last_available = null
	var next: PKeyUpdateCheck = null

	func decide(_channel := "", _staged = null, _skip = null) -> PKeyUpdateCheck:
		await (Engine.get_main_loop() as SceneTree).create_timer(0.15).timeout
		return next


class FakeSdk:
	extends Node
	var update := FakeUpdate.new()


## "Check again" says what it is doing and what it found.
func _check_again(t: PKeyTestContext) -> void:
	var sc := SC.new()
	var sdk := FakeSdk.new()
	_tree().root.add_child(sdk)
	var blocked = sc.update_check({"action": "blocked", "reason": "version-below-floor", "discardStaged": false})
	var prompt := PKeyUpdatePrompt.new()
	prompt.auto_sdk = false
	prompt.sdk = sdk
	_tree().root.add_child(prompt)
	prompt.show_result(blocked)
	t.check("check again: a locked answer offers it", prompt._action.visible and prompt._action.text == PKeyUiCopy.new().text("update_check_again"))
	# Unchanged: it says so and keeps the answer.
	sdk.update.next = sc.update_check({"action": "blocked", "reason": "version-below-floor", "discardStaged": false})
	prompt._on_action()
	await _tree().process_frame
	t.check("check again: while asking it is disabled and reads Checking…", prompt._action.disabled and prompt._action.text == PKeyUiCopy.new().text("update_checking"), prompt._action.text)
	await _until(func() -> bool: return not prompt._checking)
	t.check("check again: an unchanged answer says 'No update yet.' and stays", prompt.visible and prompt._note.visible and prompt._note.text == PKeyUiCopy.new().text("update_no_update_yet") and not prompt._action.disabled, prompt._note.text)
	# A failed check keeps the answer and says so.
	sdk.update.next = PKeyUpdateCheck.new(false, &"network-error", "x")
	prompt._on_action()
	await _until(func() -> bool: return not prompt._checking)
	t.check("check again: a failed check keeps the old answer with a note", prompt.visible and prompt.result is PKeyUpdateCheck and prompt._note.text == PKeyUiCopy.new().text("update_check_failed"), prompt._note.text)
	# A different answer replaces it, without the note.
	sdk.update.next = sc.update_check({"action": "none", "reason": "up-to-date", "discardStaged": false})
	prompt._on_action()
	await _until(func() -> bool: return not prompt._checking)
	t.check("check again: a new answer replaces it (nothing to show now)", not prompt.visible and prompt._note.text == "", str(prompt.visible))
	prompt.queue_free()
	sdk.queue_free()
	await _tree().process_frame


func _scan_for_mark(dir: String, found: Array) -> void:
	for f in DirAccess.get_files_at(dir):
		if f.ends_with(".gd") and not f.ends_with("_generated.gd") and FileAccess.get_file_as_string(dir.path_join(f)).contains("PINNED_K"):
			found.append(dir.path_join(f))
	for d in DirAccess.get_directories_at(dir):
		_scan_for_mark(dir.path_join(d), found)


func _update_prompt(t: PKeyTestContext) -> void:
	var sc := SC.new()
	var sdk := PKeyTestFixtures.new_sdk()
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab"}
	var blocked = sc.update_check({"action": "blocked", "reason": "version-below-floor", "discardStaged": false})
	var kept := PKeyUpdatePrompt.new()
	kept.auto_sdk = false
	kept.managed = true
	kept.set_meta(&"pkey_kept", true)
	kept.sdk = sdk
	_tree().root.add_child(kept)
	kept.follow_updates()
	kept.show_result(blocked)
	t.check("update prompt: a locked answer has an action even with nothing to open (Check again)", kept.visible and kept._action.visible and kept._action.text != "", "%s %s" % [kept.model, kept._action.text])
	var own := PKeyUpdatePrompt.new()
	own.auto_sdk = false
	own.sdk = sdk
	_tree().root.add_child(own)
	own.follow_updates()
	await _tree().process_frame
	await _tree().process_frame
	t.check("update prompt: the kept prompt is gone once the game places its own", not is_instance_valid(kept) or kept.is_queued_for_deletion())
	var boots := PKeyUpdatePrompt.new()
	boots.auto_sdk = false
	boots.managed = true
	boots.sdk = sdk
	_tree().root.add_child(boots)
	boots.follow_updates()
	t.check("update prompt: the kit's own prompt never replaces the game's", boots.superseded and not boots.visible)
	boots.queue_free()
	own.queue_free()
	sdk.queue_free()
	await _tree().process_frame


func _settings_schema(t: PKeyTestContext) -> void:
	# The panel asks the Worker for the live catalog once, shows no raw key while it waits, renders it,
	# and takes the focus from the game behind when its first rows arrive.
	var asked := [0]
	var release := [false]
	h.serve_docs([h.F["token"]])
	h.plan["/config/schema"] = [func(_req: Dictionary) -> Dictionary:
		asked[0] += 1
		if not release[0]:
			return {"hang": true}
		return S.json(200, {"schemaVersion": 3, "entries": [
			{"key": "audio.volume", "kind": "config", "label": "Master volume", "ui": {"widget": "stepper", "order": 1}, "schema": {"type": "number", "minimum": 0, "maximum": 100}},
			{"key": "ui.theme", "kind": "config", "category": "Look", "label": "Theme", "ui": {"order": 2}, "schema": {"type": "string", "enum": ["dark", "light"]}}]})]
	var sdk := await _sdk(_licensed_store())
	await sdk.sync(true)
	var game := Button.new()
	_tree().root.add_child(game)
	game.grab_focus()
	var panel := PKeySettingsPanel.new()
	panel.sdk = sdk
	panel.auto_sdk = false
	_tree().root.add_child(panel)
	await _until(func() -> bool: return asked[0] > 0)
	var raw: Array = panel._controls.keys()
	t.check("settings: no raw key shows while the schema loads", raw.is_empty() and panel._empty.visible and panel._empty.text == PKeyUiCopy.new().text("settings_loading"), str(raw))
	release[0] = true
	panel.refresh_view()
	sdk.config.fetch_schema()
	await _until(func() -> bool: return panel._controls.has("audio.volume"), 5.0)
	t.check("settings: the panel fetches the product's schema", asked[0] >= 1 and panel._controls.has("audio.volume") and panel._controls.has("ui.theme"), str(panel._controls.keys()))
	var labels: Array = panel._controls.values().map(func(n): return (n["label"] as Label).text)
	t.check("settings: rows read their catalog labels, never their keys", labels.has("Master volume") and labels.has("Theme") and not labels.has("ui.theme"), str(labels))
	var names: Array = panel._rail_buttons.map(func(b): return (b as Button).text)
	t.check("settings: an uncategorised group is named General", names.has("General") and names.has("Look") and not names.has("settings_title"), str(names))
	await _until(func() -> bool: return panel.is_ancestor_of(_tree().root.gui_get_focus_owner()) if _tree().root.gui_get_focus_owner() != null else false, 3.0)
	t.check("settings: the focus left the game for the panel", panel.is_ancestor_of(_tree().root.gui_get_focus_owner()) if _tree().root.gui_get_focus_owner() != null else false)
	game.queue_free()
	panel.queue_free()
	sdk.queue_free()
	await _tree().process_frame
