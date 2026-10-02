extends RefCounted
# @pkey-feature ui.kit
# The UI kit v1 (P1-10), headless. There is no renderer, so the scenes are pinned as structural
# text: every scene in every state of tests/ui/scenarios.gd against the committed fixtures in
# tests/ui/snapshots/<scene>.txt (visible controls, texts, disabled flags, focus order). Then, for
# the same states:
#
#   focus   from the first control, ui_down alone (and ui_accept on a disclosure such as the
#           settings panel's advanced toggle) reaches every visible, enabled control the tree
#           holds — found by walking the tree, not by asking the scene's own focus chain
#   copy    under a pseudo-locale that wraps every PKeyUiCopy default in ⟦…⟧, every visible
#           Label, Button and placeholder is translated copy, unless the node is marked as data
#
# and the behaviour the acceptance rows name: an enforced setting is a disabled control with
# "Set by …", editing a default setting writes the override store and get_source() becomes
# `local`, a locked update answer is a banner with no dismiss that never covers the game, every
# PKeyActivationResult kind and sign-in ending has its own copy, and COPY DIAGNOSTICS never holds a
# credential.
#
#   godot --headless --path sdks/godot -- --pkey-test ui           # check
#   godot --headless --path sdks/godot -- --pkey-test ui update    # rewrite the fixtures (editor)

const SCENARIOS := preload("res://tests/ui/scenarios.gd")
const SNAPSHOTS := "res://tests/ui/snapshots"
const PSEUDO_LOCALE := "eo"

var _sc


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	_sc = SCENARIOS.new()
	var update := args.has("update")
	TranslationServer.set_locale("en")
	var all: Array = _sc.all()
	await _snapshots(t, all, update)
	await _focus(t, all)
	await _copy(t, all)
	await _behaviour(t)
	t.check("coverage: states", all.size() >= 60, str(all.size()))
	return true


static func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _build(c: Array) -> Control:
	var v: Control = await c[2].call()
	await _tree().process_frame
	if v.has_method("refresh_view"):
		v.refresh_view()
	return v


func _free(v: Control) -> void:
	v.get_parent().remove_child(v)
	v.queue_free()


# ── Snapshots ────────────────────────────────────────────────────────────────────────────

func _snapshots(t: PKeyTestContext, all: Array, update: bool) -> void:
	var by_scene := {}
	for c in all:
		var v := await _build(c)
		var text := "== %s ==\n%s\n" % [c[1], PKeyUiSnapshot.take(v)]
		by_scene[c[0]] = String(by_scene.get(c[0], "")) + text
		_free(v)
	var matched := 0
	for scene in by_scene:
		var path := "%s/%s.txt" % [SNAPSHOTS, scene]
		var got: String = by_scene[scene]
		if update:
			DirAccess.make_dir_recursive_absolute(SNAPSHOTS)
			var f := FileAccess.open(path, FileAccess.WRITE)
			if f != null:
				f.store_string(got)
				f.close()
			t.info("wrote %s" % path)
		var want := FileAccess.get_file_as_string(path) if FileAccess.file_exists(path) else ""
		if t.check("snapshot: %s" % scene, got == want, _first_diff(want, got)):
			matched += 1
	t.check("snapshot: coverage", matched == by_scene.size() and by_scene.size() >= 10, "%d/%d scenes" % [matched, by_scene.size()])


static func _first_diff(want: String, got: String) -> String:
	if want == "":
		return "no fixture (run with `ui update` in the editor)"
	var a := want.split("\n")
	var b := got.split("\n")
	for i in maxi(a.size(), b.size()):
		var x := a[i] if i < a.size() else "<end>"
		var y := b[i] if i < b.size() else "<end>"
		if x != y:
			return "line %d: want [%s] got [%s]" % [i + 1, x, y]
	return ""


# ── Focus ────────────────────────────────────────────────────────────────────────────────

func _press(action: String) -> void:
	var down := InputEventAction.new()
	down.action = action
	down.pressed = true
	_tree().root.push_input(down)
	var up := InputEventAction.new()
	up.action = action
	up.pressed = false
	_tree().root.push_input(up)


func _focus(t: PKeyTestContext, all: Array) -> void:
	var walked := 0
	for c in all:
		var v := await _build(c)
		var want: Array = PKeyUiSnapshot.interactive(v)
		var seen := {}
		var accepted := {}
		var chain: Array = v.focus_order()
		if not chain.is_empty():
			chain[0].grab_focus()
			await _tree().process_frame
			var steps := 0
			var limit := (want.size() + 2) * 4 + 8
			while steps < limit:
				var f := _tree().root.gui_get_focus_owner()
				if f != null:
					seen[f] = true
					if f.has_meta(PKeyUiView.DISCLOSURE_META) and not accepted.has(f):
						accepted[f] = true
						_press("ui_accept")
						await _tree().process_frame
						want = PKeyUiSnapshot.interactive(v)
				_press("ui_down")
				await _tree().process_frame
				steps += 1
		var missing: Array = want.filter(func(x): return not seen.has(x))
		var names: Array = missing.map(func(x): return String(v.get_path_to(x)))
		if t.check("focus: %s / %s reaches every control with ui_down" % [c[0], c[1]], missing.is_empty() and (want.is_empty() or not seen.is_empty()), "missing %s" % [names]):
			walked += 1
		_free(v)
	t.check("focus: coverage", walked == all.size(), "%d/%d" % [walked, all.size()])


# ── Copy ─────────────────────────────────────────────────────────────────────────────────

func _copy(t: PKeyTestContext, all: Array) -> void:
	var pseudo := Translation.new()
	pseudo.locale = PSEUDO_LOCALE
	for k in PKeyUiCopy.DEFAULTS:
		var s: String = PKeyUiCopy.DEFAULTS[k]
		pseudo.add_message(s, "⟦%s⟧" % s)
	TranslationServer.add_translation(pseudo)
	TranslationServer.set_locale(PSEUDO_LOCALE)
	var clean := 0
	var walked := 0
	for c in all:
		var v := await _build(c)
		var bad: Array = []
		for pair in PKeyUiSnapshot.texts(v):
			var n: Node = pair[0]
			var text: String = pair[1]
			if n.has_meta(PKeyUiView.DATA_META):
				continue
			if not text.begins_with("⟦"):
				bad.append("%s \"%s\"" % [v.get_path_to(n), text])
		walked += 1
		if t.check("copy: %s / %s shows only PKeyUiCopy text" % [c[0], c[1]], bad.is_empty(), str(bad)):
			clean += 1
		_free(v)
	TranslationServer.set_locale("en")
	TranslationServer.remove_translation(pseudo)
	t.check("copy: coverage", clean == walked and walked == all.size(), "%d/%d" % [clean, walked])
	# Overrides replace a default before translation.
	var copy := PKeyUiCopy.new()
	copy.overrides = {"activation_title": "Unlock Diceroll"}
	t.check("copy: an override replaces the default", copy.text("activation_title") == "Unlock Diceroll" and copy.text("key_submit") == "Activate")
	t.check("copy: arguments are formatted after translation", copy.text("settings_set_by", "djdl") == "Set by djdl")


# ── Behaviour ────────────────────────────────────────────────────────────────────────────

func _behaviour(t: PKeyTestContext) -> void:
	await _settings(t)
	await _update_prompt(t)
	_activation_copy(t)
	_sign_in_copy(t)
	await _gate(t)
	_dev_menu(t)
	_controllers(t)


func _row_nodes(p: PKeySettingsPanel, key: String) -> Dictionary:
	return p._controls.get(key, {})


func _settings(t: PKeyTestContext) -> void:
	var sdk: Node = await _sc.settings_sdk({})
	var p := PKeySettingsPanel.new()
	p.sdk = sdk
	_sc.add(p)
	await _tree().process_frame
	var keys: Array = p.rows.map(func(r): return r["key"])
	t.check("settings: hidden keys are never rows (document hidden, catalog hidden, secrets, flags)", not keys.has("game.tuning") and not keys.has("debug.overlay") and not keys.has("leaderboard.key") and not keys.has("extras.skins"), str(keys))
	t.check("settings: grouped by category, sorted by ui.order", keys == ["game.killSwitch", "audio.volume", "audio.muted", "ui.theme", "ui.reducedMotion", "net.proxyUrl", "net.proxyPassword", "notes.motd"], str(keys))
	var kill := _row_nodes(p, "game.killSwitch")
	var kill_input: CheckButton = kill.get("input")
	t.check("settings: an enforced setting is a disabled control", kill_input != null and kill_input.disabled and kill_input.button_pressed, str(kill_input))
	t.check("settings: an enforced setting says \"Set by djdl\" with a lock", (kill["set_by"] as Label).visible and (kill["set_by"] as Label).text == "Set by djdl" and (kill["badge"] as Label).text == "Locked")
	var before: StringName = sdk.config.get_source("audio.volume")
	var vol := _row_nodes(p, "audio.volume")
	var spin: SpinBox = vol.get("input")
	spin.value = 35
	await _tree().process_frame
	var store: PKeyOverrideStore = sdk.config.get_override_store()
	t.check("settings: editing a default setting writes the override store", store.has_override("audio.volume") and store.get_override("audio.volume") == 35, str(store.values))
	t.check("settings: ... and get_source() becomes local", before == &"remote-default" and sdk.config.get_source("audio.volume") == &"local" and sdk.config.get_value("audio.volume") == 35, "%s -> %s" % [before, sdk.config.get_source("audio.volume")])
	vol = _row_nodes(p, "audio.volume")
	t.check("settings: a local row shows its badge and Reset to default", (vol["badge"] as Label).text == "Changed by you" and (vol["reset"] as Button).visible)
	(vol["reset"] as Button).pressed.emit()
	await _tree().process_frame
	t.check("settings: Reset to default clears the override", not store.has_override("audio.volume") and sdk.config.get_source("audio.volume") == &"remote-default")
	# An enforced key ignores an attempted write and keeps the saved player value untouched.
	p._write("game.killSwitch", false)
	t.check("settings: an enforced key is never written", not store.has_override("game.killSwitch"))
	# dependsOn follows the value it depends on.
	var theme_row := _row_nodes(p, "ui.theme")
	(theme_row["input"] as OptionButton).select(1)
	(theme_row["input"] as OptionButton).item_selected.emit(1)
	await _tree().process_frame
	t.check("settings: dependsOn hides a row when its condition fails", not p._controls.has("ui.reducedMotion") and sdk.config.get_value("ui.theme") == "light")
	_free(p)
	sdk.queue_free()


func _update_prompt(t: PKeyTestContext) -> void:
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab"}
	var locked: PKeyUpdateCheck = _sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false})
	var p := PKeyUpdatePrompt.new()
	p.modal = true
	p.outlet = "direct"
	p.release_url = "https://example.com/dl"
	_sc.add(p)
	p.show_result(_sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}))
	t.check("update: a dismissable answer may be modal", p.presentation() == "modal")
	p.show_result(locked)
	var dismiss := p.get_node("Body/Actions/Dismiss") as Button
	t.check("update: a mandatory answer is a banner even when modal is asked", p.presentation() == "banner" and p.anchor_bottom == 0.0, "%s anchor_bottom=%s" % [p.presentation(), p.anchor_bottom])
	t.check("update: a locked answer has no dismiss", not dismiss.visible)
	p._on_dismiss()
	t.check("update: a locked answer cannot be dismissed", p.visible)
	p.show_result(_sc.update_check({"action": "blocked", "reason": "app-floor", "discardStaged": false}))
	t.check("update: a blocked answer is locked, never covering", p.presentation() == "banner" and p.model["locked"] and not dismiss.visible and p.anchor_bottom == 0.0)
	p.show_result(_sc.update_check({"action": "none", "reason": "up-to-date", "behind": false, "discardStaged": false}))
	p.show_when_current = false
	p.refresh_view()
	t.check("update: none shows nothing", not p.visible)
	_free(p)
	# Per build: a store, Steam or itch build never opens a download page.
	var m := PKeyUpdatePromptController.model(PKeyVersionCheck.of("2.0.0", "", "https://example.com/r", true), "steam")
	t.check("update: a v3 answer on a Steam build offers no download page", m["action"] == "" and m["visible"])
	m = PKeyUpdatePromptController.model(PKeyVersionCheck.of("2.0.0", "", "https://example.com/r", true), "direct")
	t.check("update: a v3 answer on a direct build opens its release page", m["action_url"] == "https://example.com/r")


func _activation_copy(t: PKeyTestContext) -> void:
	var kinds := [
		PKeyActivationResult.KIND_OK, PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyActivationResult.KIND_UNAUTHORIZED,
		PKeyActivationResult.KIND_FINGERPRINT_REQUIRED, PKeyActivationResult.KIND_ENROLL_DISABLED, PKeyActivationResult.KIND_ENROLL_CLAIMED,
		PKeyActivationResult.KIND_LICENSE_DISABLED, PKeyActivationResult.KIND_HARDWARE_MISMATCH, PKeyActivationResult.KIND_RATE_LIMITED,
		PKeyActivationResult.KIND_UNSUPPORTED, PKeyActivationResult.KIND_ERROR,
	]
	var keys := {}
	for k in kinds:
		var m := PKeyActivationController.message_for(PKeyActivationResult.of(k, &"x", ""))
		keys[m[0]] = true
		t.check("activation: %s has its own copy" % k, PKeyUiCopy.DEFAULTS.has(m[0]), m[0])
	t.check("activation: every kind reads differently", keys.size() == kinds.size())


func _sign_in_copy(t: PKeyTestContext) -> void:
	for k in [PKeySignInResult.KIND_OK, PKeySignInResult.KIND_EXPIRED, PKeySignInResult.KIND_CANCELLED, PKeySignInResult.KIND_DENIED, PKeySignInResult.KIND_DEVICE_MISMATCH, PKeySignInResult.KIND_RATE_LIMITED, PKeySignInResult.KIND_SERVICE_UNAVAILABLE, PKeySignInResult.KIND_TIMEOUT, PKeySignInResult.KIND_ERROR]:
		t.check("sign-in: %s has copy" % k, PKeyUiCopy.DEFAULTS.has(PKeySignInController.message_for(k)))


func _gate(t: PKeyTestContext) -> void:
	var g := PKeyGateView.new()
	_sc.add(g)
	var usable := [0]
	var retried := [0]
	g.usable.connect(func(): usable[0] += 1)
	g.retry_requested.connect(func(): retried[0] += 1)
	g.managed_retry = true
	g.show_state({"status": "ok"})
	await _tree().process_frame
	t.check("gate: ok hides the gate and emits usable", not g.visible and usable[0] == 1)
	g.show_state({"status": "not-applicable"})
	await _tree().process_frame
	t.check("gate: not-applicable stays usable without a second emit", not g.visible and usable[0] == 1)
	g.show_state({"status": "grace", "grace_until": 0})
	await _tree().process_frame
	t.check("gate: grace is usable, shows only the banner and lets input through", g.visible and g.screen == "grace" and g.mouse_filter == Control.MOUSE_FILTER_IGNORE and not g.get_node("Center/Card").visible)
	g.allow_grace = false
	g.show_state({"status": "grace", "grace_until": 0})
	t.check("gate: grace with allow_grace false blocks", g.screen == "grace-blocked" and g.get_node("Center/Card").visible)
	g.show_state({"status": "expired"})
	(g.get_node("Center/Card/Body/Actions/Retry") as Button).pressed.emit()
	t.check("gate: expired's Retry asks the owner to retry", retried[0] == 1)
	_free(g)


func _dev_menu(t: PKeyTestContext) -> void:
	var f: Dictionary = _sc.dev_facts("steam")
	f["token"] = "pkeyt_SECRETSECRETSECRETSECRETSECRETSECRET00"
	var text := PKeyDevMenuController.diagnostics(f)
	t.check("dev menu: diagnostics carry the eight facts", text.split("\n").size() == 8 and text.contains("device: Q2hY") and text.contains("outlet: steam") and text.contains("build: 1.2.0 (42)"), text)
	t.check("dev menu: diagnostics never carry a token", not text.contains("pkeyt_"))
	t.check("dev menu: a Steam build's channel is locked; direct and the editor are not", PKeyDevMenuController.channel_lock("steam") == "steam" and PKeyDevMenuController.channel_lock("direct") == "" and PKeyDevMenuController.channel_lock("") == "")
	var d := PKeyDevMenuSection.new()
	d.facts_override = _sc.dev_facts("")
	d.entitled_override = ["beta"]
	var ids: Array = d.rows().map(func(r): return r["id"])
	t.check("dev menu: rows() offers the same section as data", ids == ["channel", "build", "outlet", "sdk", "engine", "device", "gate", "last_sync", "copy_diagnostics", "force_check"], str(ids))
	d.free()


func _controllers(t: PKeyTestContext) -> void:
	var caps := PKeyActivationController.capabilities(true, true, true, true)
	t.check("activation: Continue free is never offered on web", not caps["continue_free"] and caps["key_entry"] and caps["sign_in"] and caps["offline"])
	t.check("activation: without License there is no key entry, no enrolment, no offline file", PKeyActivationController.capabilities(false, false, true, false) == {"key_entry": false, "sign_in": false, "continue_free": false, "offline": false})
	var screens := {}
	for st in ["ok", "grace", "expired", "revoked", "needs-activation", "version-too-old", "version-too-new", "channel-not-entitled", "not-applicable"]:
		screens[st] = PKeyGateController.screen_for(st)
	t.check("gate: screenFor", screens == {"ok": "usable", "grace": "grace", "expired": "expired", "revoked": "revoked", "needs-activation": "activation", "version-too-old": "update-required", "version-too-new": "not-available", "channel-not-entitled": "not-available", "not-applicable": "usable"}, str(screens))
	t.check("gate: not-applicable precedes an error", PKeyGateController.screen_for("not-applicable", false, "boom") == "usable" and PKeyGateController.screen_for("needs-activation", false, "boom") == "error")
	var lines := PKeyBannerController.lines({"status": "grace", "grace_until": 1000.0 + 3 * 86400, "last_verified_at": 1000.0 - 7200}, 1000.0)
	t.check("banner: grace days and last checked", lines == [["banner_grace", "3 days"], ["banner_checked", "2 hours"]], str(lines))
