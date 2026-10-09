extends RefCounted
# @pkey-feature ui.kit
# @pkey-feature ui.kit.manage
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
	await _layout(t, all)
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


# ── Layout ───────────────────────────────────────────────────────────────────────────────

## Owner requirement (2026-10-04): every panel is centred, at a comfortable width, from a phone in
## portrait to 4K, in the neutral look and in both Polaris Key looks (whose page panel pads the
## view). Each scene's first state, plus the states in LAYOUT_EXTRA, is laid out full-screen at
## each size; its centred node must sit in the middle of the view (horizontally, and vertically
## when it fits), no wider than its max width, and inside the viewport with the gutter.
const LAYOUT_SIZES := [Vector2i(1280, 720), Vector2i(1920, 1080), Vector2i(3840, 2160), Vector2i(720, 1280), Vector2i(480, 854)]
const LAYOUT_LOOKS := ["neutral", "brand-dark", "brand-light"]
## [scene, state]: boot's embedded gate, the tallest settings state, the gate after an error.
const LAYOUT_EXTRA := [["boot", "waiting needs-activation"], ["settings", "advanced shown"], ["gate", "needs-activation after an error"]]


static func _apply_look(look: String) -> void:
	PKeyUiTheme.reset()
	if look.begins_with("brand"):
		PKeyUiTheme.branding = PKeyUiTheme.BRANDING_POLARIS_KEY
		PKeyUiTheme.scheme = "light" if look == "brand-light" else "dark"
		PKeyUiTheme.powered_by = true


func _layout(t: PKeyTestContext, all: Array) -> void:
	var root := _tree().root
	var before := root.size
	var cases: Array = []
	var seen := {}
	for c in all:
		if seen.has(c[0]) or c[0] in ["badge", "banner"]:
			continue
		var probe: PKeyUiView = await _build(c)
		var visible := probe.visible and _centred(probe) != null and _centred(probe).is_visible_in_tree()
		_free(probe)
		if not visible:
			continue
		seen[c[0]] = true
		cases.append(c)
	for c in all:
		if LAYOUT_EXTRA.any(func(x): return x[0] == c[0] and x[1] == c[1]) and not cases.has(c):
			cases.append(c)
	var checked := 0
	for look in LAYOUT_LOOKS:
		for c in cases:
			for sz in LAYOUT_SIZES:
				root.size = sz
				var v: PKeyUiView = await _build(c)
				# A scenario configures a fake SDK (which applies its default ui_* options).
				_apply_look(look)
				v.refresh_view()
				v.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
				v.refresh_view()
				for i in 3:
					await _tree().process_frame
				var node := _centred(v)
				var r := node.get_global_rect()
				var vr := v.get_global_rect()
				var dx := absf(r.get_center().x - vr.get_center().x)
				# A banner floats at the top of whatever rect it is given; only its sides are centred.
				var fits_v: bool = r.size.y <= vr.size.y and not (v is PKeyUpdatePrompt and v.presentation() == "banner")
				var dy := absf(r.get_center().y - vr.get_center().y) if fits_v else 0.0
				# A two-column landscape card is as wide as a wide card (PKeyUiTheme.MEASURES).
				var maxw: float = maxf(v.max_content_width, float(PKeyUiTheme.MEASURES["card_width_wide"]))
				var ok: bool = dx <= 1.5 and dy <= 1.5 and r.size.x <= maxw + 1.0 and r.position.x >= PKeyUiView.GUTTER - 1.0 and r.end.x <= sz.x - PKeyUiView.GUTTER + 1.0
				# A phone's portrait screen is full-bleed for the scenes that bleed: the page fills it.
				if v.phone_screen() and node != null:
					# (a gate's card keeps the page margin to the edge; a dialog's is edge to edge)
					ok = r.size.x >= vr.size.x - 2.0 * v.role("page_margin") - 1.0
				if t.check("layout: %s / %s centred at %dx%d (%s)" % [c[0], c[1], sz.x, sz.y, look], ok, "rect %s in %s" % [r, vr]):
					checked += 1
				_free(v)
	PKeyUiTheme.reset()
	root.size = before
	# The strips: the badge's chips and the banner's lines are centred across the given width.
	for c in all:
		if c[0] == "badge" and c[1] == "two grants":
			var b: PKeyUiView = await _build(c)
			var chips := b.find_child("Chips", true, false)
			t.check("layout: badge chips centred", chips != null and int(chips.get("alignment")) == 1)
			_free(b)
		elif c[0] == "banner" and c[1] == "grace":
			var b: PKeyUiView = await _build(c)
			var line := b.find_child("Line0", true, false) as Label
			# The banner is a centred card; its glyph and lines read from the start.
			t.check("layout: banner lines start-aligned beside the glyph", line != null and line.horizontal_alignment == HORIZONTAL_ALIGNMENT_LEFT)
			_free(b)
	t.check("layout: coverage", seen.size() >= 8 and cases.size() == seen.size() + LAYOUT_EXTRA.size() and checked == cases.size() * LAYOUT_SIZES.size() * LAYOUT_LOOKS.size(), "%d checks over %s" % [checked, cases.map(func(x): return "%s / %s" % [x[0], x[1]])])


## The node a scene centres: the card of a full-screen scene, else its `_content()`.
static func _centred(v: PKeyUiView) -> Control:
	if v is PKeyGateView:
		return v.find_child("Card", true, false) as Control
	if v is PKeyBoot:
		if (v as PKeyBoot).gate.is_visible_in_tree():
			return (v as PKeyBoot).gate.find_child("Card", true, false) as Control
		var shell := v.find_child("Shell", true, false) as Control
		if shell != null and shell.is_visible_in_tree():
			return shell
		return v.find_child("Card", true, false) as Control
	return v._content()


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
	await _dialogs_take_focus(t)
	await _never_covering(t)
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
	var kill_input: Control = kill.get("input")
	t.check("settings: an enforced setting is text, never a dimmed control", kill_input is Label and not (kill_input as Label).text.is_empty() and not kill_input is BaseButton, str(kill_input))
	t.check("settings: an enforced setting says who set it (the product's name) with a lock", (kill["set_by"] as Label).visible and (kill["set_by"] as Label).text == "Set by %s" % PKeySettingsController.product_name(sdk) and not PKeySettingsController.product_name(sdk).is_empty() and (kill["lock"] as Control).visible and (kill["lock_row"] as Control).visible)
	var before: StringName = sdk.config.get_source("audio.volume")
	var vol := _row_nodes(p, "audio.volume")
	var spin: Range = vol.get("input")
	spin.value = 35
	await _tree().process_frame
	var store: PKeyOverrideStore = sdk.config.get_override_store()
	t.check("settings: editing a default setting writes the override store", store.has_override("audio.volume") and store.get_override("audio.volume") == 35, str(store.values))
	t.check("settings: ... and get_source() becomes local", before == &"remote-default" and sdk.config.get_source("audio.volume") == &"local" and sdk.config.get_value("audio.volume") == 35, "%s -> %s" % [before, sdk.config.get_source("audio.volume")])
	vol = _row_nodes(p, "audio.volume")
	t.check("settings: a local row shows its badge and Reset to default", (vol["status"] as Label).text == "Changed by you" and (vol["reset"] as Button).visible)
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


static func _joy_button(button: int) -> void:
	for pressed in [true, false]:
		var e := InputEventJoypadButton.new()
		e.button_index = button
		e.pressed = pressed
		_tree().root.push_input(e)


## A dialog opened over a focused game control takes the focus (a pad's A answers the dialog, never
## the game's button), a pad's B closes it, and the game's control has its focus back (the pad's
## real button events, and the engine's default input map without a joypad binding).
func _dialogs_take_focus(t: PKeyTestContext) -> void:
	PKeyUiView.pointer_last = false
	PKeyUiView._pointer_known = true
	PKeyUiView.mobile_override = false
	PKeyUiView.pad_only_override = false
	# The pad bindings: a joypad A and B on ui_accept and ui_cancel, once, the game's own kept.
	PKeyUiView.ensure_pad_bindings()
	for pair in [["ui_accept", JOY_BUTTON_A], ["ui_cancel", JOY_BUTTON_B]]:
		var pads := InputMap.action_get_events(pair[0]).filter(func(e): return e is InputEventJoypadButton and (e as InputEventJoypadButton).button_index == pair[1])
		t.check("dialog focus: %s has the pad's joypad binding exactly once" % pair[0], pads.size() == 1, str(pads.size()))
	var cases := {
		"update modal": func() -> Control:
			var p := PKeyUpdatePrompt.new()
			p.outlet = "direct"
			p.modal = true
			p.show_when_current = true
			p.auto_sdk = false
			_tree().root.add_child(p)
			p.show_result(_sc.update_check({"action": "binary", "method": "download", "release": {"version": "1.5.0", "seq": 15, "sha256": "ab"}, "build": "macos-dmg", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}))
			return p,
		"standalone sign-in": func() -> Control:
			var d := PKeySignInDialog.new()
			d.now_source = func(): return SCENARIOS.NOW
			d.auto_sdk = false
			_tree().root.add_child(d)
			d.show_prompt(_sc.prompt_fixture())
			d.closed.connect(func() -> void: d.visible = false)
			return d,
		"standalone offline": func() -> Control:
			var d := PKeyOfflineDialog.new()
			d.web_override = 0
			d.product = "djdl"
			d.device_id = "Q2hYlBg0Zx9uR7m1VvC4tKpE8sWnJ3aD"
			d.auto_sdk = false
			_tree().root.add_child(d)
			d.refresh_view()
			d.closed.connect(func() -> void: d.visible = false)
			return d,
	}
	for name in cases:
		var game := Button.new()
		game.text = "Game menu"
		var pressed := [0]
		game.pressed.connect(func() -> void: pressed[0] += 1)
		_tree().root.add_child(game)
		game.grab_focus()
		await _tree().process_frame
		var dialog: Control = cases[name].call()
		await _tree().create_timer(0.35).timeout
		var owner := _tree().root.gui_get_focus_owner()
		t.check("dialog focus: %s takes the focus from the game's control" % name, owner != null and dialog.is_ancestor_of(owner), str(owner))
		_joy_button(JOY_BUTTON_A)
		await _tree().process_frame
		t.check("dialog focus: %s, a pad's A never presses the game's button" % name, pressed[0] == 0, str(pressed[0]))
		_joy_button(JOY_BUTTON_B)
		await _tree().process_frame
		await _tree().process_frame
		t.check("dialog focus: %s, a pad's B closes it and the game's control has the focus again" % name, not dialog.is_visible_in_tree() and _tree().root.gui_get_focus_owner() == game, "%s visible %s focus %s" % [name, dialog.is_visible_in_tree(), _tree().root.gui_get_focus_owner()])
		_free(dialog)
		_free(game)


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
	var dismiss := p.find_child("Dismiss", true, false) as Button
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
	# The v3 `url` is unsigned: only an https link is ever offered to OS.shell_open.
	for bad in ["file:///etc/passwd", "myapp://run", "http://example.com/r", "https://"]:
		m = PKeyUpdatePromptController.model(PKeyVersionCheck.of("2.0.0", "", bad, true), "direct")
		t.check("update: a v3 url %s offers no action" % bad, m["action"] == "" and m["action_url"] == "" and m["visible"])
	t.check("update: update_url drops a non-https release_url", PKeyUpdatePromptController.update_url(null, "direct", "file:///x") == "")
	# plans/P4-13.md §2.6: `packs` shows nothing (the boot's FETCH applies it); a content floor is a
	# locked banner with its own body; revoked REQUIRED content is the hard stop's copy, with the
	# offer's action for an offer and none for blocked.
	var packs_answer = _sc.update_check({"action": "packs", "install": [], "revoke": ["djdl.levels"], "set": [], "discardStaged": false})
	m = PKeyUpdatePromptController.model(packs_answer, "direct")
	t.check("update: a packs answer shows nothing", not m["visible"] and not m["required"])
	m = PKeyUpdatePromptController.model(_sc.update_check({"action": "blocked", "reason": "content-floor", "discardStaged": false}), "direct")
	t.check("update: a content floor is a locked banner with the content-floor body", m["visible"] and m["locked"] and not m["required"] and m["body"] == "update_content_floor_body")
	m = PKeyUpdatePromptController.model(_sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false, "contentBlock": "content-floor"}), "direct", "https://example.com/dl")
	t.check("update: an offer made mandatory by a content floor keeps its action", m["locked"] and not m["required"] and m["body"] == "update_content_floor_body" and m["action"] != "")
	m = PKeyUpdatePromptController.model(_sc.update_check({"action": "blocked", "reason": "revoked-content", "discardStaged": false}), "direct", "https://example.com/dl")
	t.check("update: revoked content blocked is the hard stop's copy with no action", m["visible"] and m["required"] and m["locked"] and m["title"] == "update_revoked_title" and m["body"] == "update_revoked_body" and m["action"] == "" and m["action_url"] == "")
	m = PKeyUpdatePromptController.model(_sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false, "contentBlock": "revoked-content"}), "direct", "https://example.com/dl")
	t.check("update: a revoked-content offer keeps the offer's action under the hard stop's copy", m["required"] and m["title"] == "update_revoked_title" and m["action"] != "")


# A locked update answer and grace's banner are strips, measured: a Container parent ignores a
# child's anchors, so `anchor_bottom == 0` proves nothing once the view sits in PKeyBoot, the
# gate or a game's own layout. Each check compares rendered heights after a layout pass.
func _never_covering(t: PKeyTestContext) -> void:
	# The headless runner's window is tiny; measure on a game-sized screen.
	var saved_size := _tree().root.size
	_tree().root.size = Vector2i(1152, 900)
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab"}
	var answers := {
		"mandatory": _sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false}),
		"blocked": _sc.update_check({"action": "blocked", "reason": "app-floor", "discardStaged": false}),
	}
	for kind in answers:
		var boot := PKeyBoot.new()
		_sc.add(boot)
		boot.prompt.modal = true
		boot.prompt.show_result(answers[kind])
		boot.refresh_view()
		await _tree().process_frame
		await _tree().process_frame
		var pr := boot.prompt.get_global_rect()
		var br := boot.get_global_rect()
		var dismiss := boot.prompt.find_child("Dismiss", true, false) as Button
		t.check("never covering: a %s answer in PKeyBoot is a strip at the top" % kind, boot.prompt.is_visible_in_tree() and boot.prompt.presentation() == "banner" and pr.size.y > 0.0 and pr.size.y < br.size.y * 0.25 and is_equal_approx(pr.position.y, br.position.y), "prompt %s in boot %s" % [pr, br])
		t.check("never covering: a %s answer in PKeyBoot has no dismiss" % kind, not dismiss.visible)
		t.check("never covering: PKeyBoot's prompt overlay takes no input", boot.get_node("Overlay").mouse_filter == Control.MOUSE_FILTER_IGNORE)
		_free(boot)
	# A game's own layout: the prompt inside a container still asks only for its own height.
	var frame := PanelContainer.new()
	frame.size = Vector2(900, 1400)
	_tree().root.add_child(frame)
	var p := PKeyUpdatePrompt.new()
	p.auto_sdk = false
	p.modal = true
	frame.add_child(p)
	p.show_result(answers["blocked"])
	await _tree().process_frame
	await _tree().process_frame
	t.check("never covering: a locked answer inside a game's container is a strip", p.size.y > 0.0 and p.size.y < frame.size.y * 0.25, str(p.get_rect()))
	frame.get_parent().remove_child(frame)
	frame.queue_free()
	# Grace: the gate shows only the banner strip and lets the game take its input.
	var g := PKeyGateView.new()
	_sc.add(g)
	g.show_state({"status": "grace", "grace_until": 0})
	await _tree().process_frame
	await _tree().process_frame
	var slot := g.get_node("BannerSlot") as Control
	var gr := g.get_global_rect()
	var sr := slot.get_global_rect()
	t.check("never covering: grace's banner is a strip at the top of the gate", slot.is_visible_in_tree() and sr.size.y > 0.0 and sr.size.y < gr.size.y * 0.25 and is_equal_approx(sr.position.y, gr.position.y), "banner %s in gate %s" % [sr, gr])
	t.check("never covering: in grace no full-rect control catches the game's clicks", g.mouse_filter == Control.MOUSE_FILTER_IGNORE and (g.get_node("Center") as Control).mouse_filter == Control.MOUSE_FILTER_IGNORE and slot.mouse_filter == Control.MOUSE_FILTER_IGNORE)
	_free(g)
	_tree().root.size = saved_size


func _activation_copy(t: PKeyTestContext) -> void:
	var kinds := [
		PKeyActivationResult.KIND_OK, PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyActivationResult.KIND_UNAUTHORIZED,
		PKeyActivationResult.KIND_FINGERPRINT_REQUIRED, PKeyActivationResult.KIND_ENROLL_DISABLED, PKeyActivationResult.KIND_ENROLL_CLAIMED,
		PKeyActivationResult.KIND_LICENSE_DISABLED, PKeyActivationResult.KIND_HARDWARE_MISMATCH, PKeyActivationResult.KIND_RATE_LIMITED,
		PKeyActivationResult.KIND_UNSUPPORTED, PKeyActivationResult.KIND_ERROR,
		PKeyActivationResult.KIND_LICENSE_EXPIRED, PKeyActivationResult.KIND_ATTESTATION_REQUIRED, PKeyActivationResult.KIND_REFUSED,
	]
	var keys := {}
	for k in kinds:
		var m := PKeyActivationController.message_for(PKeyActivationResult.of(k, &"x", ""))
		keys[m[0]] = true
		t.check("activation: %s has its own copy" % k, PKeyUiCopy.DEFAULTS.has(m[0]), m[0])
	t.check("activation: every kind reads differently", keys.size() == kinds.size())
	# SDK parity §3.2: a refusal reads by its code, a missing code falls back to a generic line
	# with the code, never the raw body.
	var c := PKeyUiCopy.new()
	var refused := PKeyActivationController.message_for(PKeyActivationResult.of(PKeyActivationResult.KIND_REFUSED, &"registration_closed", "raw body", 403))
	t.check("copy: refused registration_closed reads its own copy", refused[0] == "error_registration_closed")
	var unknown := PKeyActivationController.message_for(PKeyActivationResult.of(PKeyActivationResult.KIND_REFUSED, &"brand_new_code", "raw body", 403))
	t.check("copy: an unknown code falls back to the generic line with the code", unknown == ["error_generic", "brand_new_code"] and c.text(unknown[0], unknown[1]).contains("brand_new_code") and not c.text(unknown[0], unknown[1]).contains("raw body"))
	for code in ["registration_closed", "attestation_required", "attestation_rejected", "attestation_unavailable", "managed_by_admin", "not_entitled", "license_expired", "catalog_unavailable", "value_not_representable", "document_not_representable", "mint-unavailable", "unavailable", "pack-not-entitled", "pack-not-pinned", "pack-revoked", "pack-type-unsupported", "pack-no-variant", "plan-insufficient-disk", "network-error", "timeout", "no-token"]:
		t.check("copy: %s has its own message" % code, PKeyUiCopy.code_key(code)[0] == "error_" + code)
	for code in PKeyConstants.ERROR_CODE_VALUES:
		if PKeyUiCopy.DEFAULTS.has("error_" + code):
			continue
		t.check("copy: %s still reads as words" % code, c.for_code(code) != "" and c.for_code(code) != code)
	for reason in ["no_license", "binding_mismatch", "bound_elsewhere", "unbound", "not_owned", "test_purchase", "invalid_ticket"]:
		t.check("copy: commerce reason %s wins over its code" % reason, PKeyUiCopy.code_key("forbidden", reason)[0] == "reason_" + reason)
	var body := PKeyErrors.read_body('{"error":{"code":"forbidden","reason":"bound_elsewhere"}}'.to_utf8_buffer())
	var fr := PKeyResult.failure(&"forbidden", "x", {"status": 403, "error": body})
	t.check("copy: for_result reads the server's reason", c.for_result(fr) == c.text("reason_bound_elsewhere"))
	var empty := PKeyUiCopy.DEFAULTS.keys().filter(func(k): return String(PKeyUiCopy.DEFAULTS[k]).strip_edges() == "")
	t.check("copy: no template is empty", empty.is_empty(), str(empty))


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
	(g.find_child("Retry", true, false) as Button).pressed.emit()
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
	# PX-W8: "Replace a device" — a button where a browser is at hand, a QR code where a joypad is
	# the only input; the link carries the key fragment (on /activate only) and the game's return.
	t.check("manage: desktop, web and touch phones get a button", PKeyActivationController.manage_presentation("Windows", false, 1) == "button" and PKeyActivationController.manage_presentation("Web", false, 0) == "button" and PKeyActivationController.manage_presentation("Android", true, 1) == "button")
	t.check("manage: a TV or console gets a QR code", PKeyActivationController.manage_presentation("Android", false, 1) == "qr" and PKeyActivationController.manage_presentation("Switch", false, 1) == "qr")
	var limited := PKeyActivationResult.of(PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyErrors.DEVICE_LIMIT, "", 403)
	limited.manage_url = "https://key.plrs.im/activate?product=djdl&next=free-device"
	var link := PKeyActivationController.manage_link(limited, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", "mygame://done")
	t.check("manage: the offered link", link == "https://key.plrs.im/activate?product=djdl&next=free-device&return=mygame%3A%2F%2Fdone#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", link)
	t.check("manage: a QR link never carries the key", PKeyActivationController.manage_link(limited, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", "mygame://done", true) == "https://key.plrs.im/activate?product=djdl&next=free-device&return=mygame%3A%2F%2Fdone")
	limited.manage_url = "https://key.plrs.im/#/p/djdl/free-device?license=lic_1"
	t.check("manage: the key never rides on a free-device link", PKeyActivationController.manage_link(limited, "pkey_x") == "https://key.plrs.im/#/p/djdl/free-device?license=lic_1")
	limited.manage_url = null
	t.check("manage: no link, no offer", PKeyActivationController.manage_link(limited, "k") == "" and PKeyActivationController.manage_link(PKeyActivationResult.of(PKeyActivationResult.KIND_UNAUTHORIZED, &"x", ""), "k") == "")
	var copy := PKeyUiCopy.DEFAULTS
	t.check("manage: copy", copy.get("free_device") == "Replace a device" and copy.has("free_device_scan"))
	var caps := PKeyActivationController.capabilities(true, true, true, true)
	t.check("activation: Continue free is never offered on web", not caps["continue_free"] and caps["key_entry"] and caps["sign_in"] and caps["offline"])
	t.check("activation: without License there is no key entry, no enrolment, no offline file", PKeyActivationController.capabilities(false, false, true, false) == {"key_entry": false, "sign_in": false, "continue_free": false, "offline": false})
	# SDK parity §3.18: key entry is hidden on store outlets automatically (App Store 3.1.1, Play).
	var store := PKeyActivationController.capabilities(true, true, true, false, true)
	t.check("activation: a store outlet hides key entry and the offline file, keeps sign-in and enrolment", not store["key_entry"] and not store["offline"] and store["sign_in"] and store["continue_free"], str(store))
	for kind in ["app-store", "testflight", "play", "play-testing"]:
		t.check("activation: %s hides key entry" % kind, PKeyActivationController.store_hides_key_entry(kind))
	for kind in ["direct", "steam", "itch", "ms-store", ""]:
		t.check("activation: %s keeps key entry" % kind, not PKeyActivationController.store_hides_key_entry(kind))
	var panel := PKeyActivationPanel.new()
	panel.auto_sdk = false
	_sc.add(panel)
	panel.show_result(PKeyActivationResult.of(PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyErrors.DEVICE_LIMIT, "", 403))
	t.check("activation: device-limit without a served link offers no Replace a device", panel.last_kind == PKeyActivationResult.KIND_DEVICE_LIMIT and not panel._manage.visible)
	_free(panel)
	var screens := {}
	for st in ["ok", "grace", "expired", "revoked", "needs-activation", "version-too-old", "version-too-new", "channel-not-entitled", "not-applicable"]:
		screens[st] = PKeyGateController.screen_for(st)
	t.check("gate: screenFor", screens == {"ok": "usable", "grace": "grace", "expired": "expired", "revoked": "revoked", "needs-activation": "activation", "version-too-old": "update-required", "version-too-new": "not-available", "channel-not-entitled": "not-available", "not-applicable": "usable"}, str(screens))
	t.check("gate: not-applicable precedes an error", PKeyGateController.screen_for("not-applicable", false, "boom") == "usable" and PKeyGateController.screen_for("needs-activation", false, "boom") == "error")
	var lines := PKeyBannerController.lines({"status": "grace", "grace_until": 1000.0 + 3 * 86400, "last_verified_at": 1000.0 - 7200}, 1000.0)
	t.check("banner: grace days and last checked", lines == [["banner_grace", "3 days"], ["banner_checked", "2 hours"]], str(lines))
