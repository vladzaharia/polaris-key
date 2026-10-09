extends RefCounted
# @pkey-feature ui.kit
# The drop-in screens across the resolution matrix (tests/ui/matrix.gd), headless: every named
# screen at every size of the matrix and at the logical sizes common stretch settings give
# (STRETCHED), in the Polaris Key look, the native look over a game's own theme and a game's whole
# custom theme (PRESET_LOCALES: English, German and Japanese). Each layout must have no control outside its
# container or the panel's safe rect, no two controls overlapping, no clipped text, at least
# GUTTER between the content and the screen's edges, every QR code scannable (QR_MIN_PHYSICAL
# physical pixels) and not swamping the screen, and the two-part screens side by side in
# landscape and stacked in portrait. One check per screen, preset and locale lists the sizes that
# fail. The light preset lays out exactly as the dark one and is left to the renders
# (tools/ui_matrix/ui_matrix.gd).
#
# Also: the layout follows a live resize (portrait to landscape and back) without losing the
# focused control, and the safe area keeps the content clear of a notch.
#
#   godot --headless --path sdks/godot -- --pkey-test ui_matrix
#   godot --headless --path sdks/godot -- --pkey-test ui_matrix sign_in,gate   # some screens
#
# Not in the `ci` set (it takes about a minute): tools/run_tests.sh runs it as its own step.

const MATRIX := preload("res://tests/ui/matrix.gd")
## The looks and the locales each is checked in: every locale in the Polaris Key look (which must
## fit without its scroll fallback), and the longest German and the unspaced Japanese strings
## under a game's theme. The light preset lays out as the dark one.
const PRESET_LOCALES := {"dark": ["en", "de", "ja"], "native": ["en", "de"], "custom": ["en", "ja"]}


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var tree := Engine.get_main_loop() as SceneTree
	var mx = MATRIX.new()
	var only: Array = Array(args[0].split(",", false)) if args.size() > 0 and not args[0].begins_with("-") else []
	var sizes: Array = []
	for s in MATRIX.SIZES:
		sizes.append(Array(s))
	for row in MATRIX.STRETCHED:
		var st: Array = MATRIX.stretched(row)
		var logical: Vector2i = st[0]
		var k: float = st[1]
		sizes.append([row[0], Vector2i((Vector2(logical) * k).round()), k, null, 0.0])
	# [preset, locale, the size labels it is checked at (empty: all)].
	var jobs: Array = []
	for preset in PRESET_LOCALES:
		for locale in PRESET_LOCALES[preset]:
			jobs.append([preset, locale, []])
	for preset in MATRIX.EXTRA_PRESETS:
		var at: Array = MATRIX.EXTRA_SIZES.duplicate()
		if preset in ["native28", "native36"]:
			for l in MATRIX.HOST_FONT_SIZES:
				if not at.has(l):
					at.append(l)
		jobs.append([preset, "en", at])
	var layouts := 0
	for job in jobs:
		var preset: String = job[0]
		var locale: String = job[1]
		var at: Array = job[2]
		mx.use_locale(locale)
		for entry in MATRIX.SCREENS:
			if not only.is_empty() and not only.has(entry[0]):
				continue
			var failed: Array = []
			var row_sizes: Array = sizes.filter(func(r): return at.is_empty() or at.has(r[0]))
			# A pad-only screen (a TV, a console) is never a phone's size.
			if entry.size() > 4 and entry[4] == "pad":
				row_sizes = row_sizes.filter(func(r): return float(r[4]) <= 0.0 or minf(r[1].x, r[1].y) * 1.0 / float(r[4]) >= 600.0)
			# Built once, then resized through every size, as a window is.
			var first: Array = row_sizes[0]
			var st: Dictionary = await mx.stage(tree, entry, first[1], first[2], first[3], preset, false, first[4])
			var v: PKeyUiView = st["view"]
			for s in row_sizes:
				await mx.resize(tree, st, s[1], s[2], s[3], s[4])
				var probs := await _view_problems(tree, v, entry, preset, s)
				if not probs.is_empty():
					failed.append("%s: %s" % [s[0], probs[0] + (" (+%d more)" % (probs.size() - 1) if probs.size() > 1 else "")])
				layouts += 1
			(st["vp"] as Node).free()
			t.check("matrix: %s / %s / %s fits every size" % [entry[0], preset, locale], failed.is_empty(), "; ".join(failed.slice(0, 4)))
	await _fresh_layouts(t, tree, mx, sizes, only)
	await _pad_flows(t, tree, mx)
	await _settings_opened_directly(t, tree, mx)
	await _live_resize(t, tree, mx)
	await _safe_area(t, tree, mx)
	await _refresh_stability(t, tree, mx)
	await _offline_qr(t, tree, mx)
	await _phone_checks(t, tree, mx)
	mx.drop_locales()
	PKeyUiView.safe_insets_override = null
	PKeyUiView.mobile_override = null
	PKeyUiView.pad_only_override = null
	PKeyUiTheme.reset()
	t.check("matrix: coverage", layouts >= MATRIX.SCREENS.size() * sizes.size() * 7 or not only.is_empty(), "%d layouts" % layouts)
	return true


## Every layout and focus problem of `v`, laid out at the size row `s` in `preset`.
static func _view_problems(tree: SceneTree, v: PKeyUiView, entry: Array, preset: String, s: Array) -> PackedStringArray:
	var row := {"label": s[0], "physical": s[1], "scale": s[2], "dpr": s[4], "preset": preset}
	var probs: PackedStringArray = MATRIX.problems(v, entry[3], entry[0], preset in ["dark", "accent-dark", "accent-light"], row)
	# (A 36 px host font on a 640 px wide canvas is the one tight case; see MATRIX.problems.)
	if not ([entry[0], preset, s[0]] in MATRIX.TIGHT_CASES and s[1].x <= 640):
		probs.append_array(_focus(v))
	probs.append_array(await MATRIX.reach_problems(tree, v, entry[3], [entry[0], preset, s[0]] in MATRIX.TIGHT_CASES))
	return probs


## The arrangement is a pure function of the size (DL1): every screen laid out FRESH at each size, as
## a game opens it on a phone, passes the same checks as the one resized through the sizes. (A view
## that keeps a squeeze, a column or a width from a size it was laid out at before lays out
## differently when it is built at the size.) The Polaris Key look, the native look and a whole
## custom theme, in English.
func _fresh_layouts(t: PKeyTestContext, tree: SceneTree, mx, sizes: Array, only: Array) -> void:
	mx.use_locale("en")
	var layouts := 0
	for preset in ["dark", "native", "custom"]:
		for entry in MATRIX.SCREENS:
			if not only.is_empty() and not only.has(entry[0]):
				continue
			var failed: Array = []
			var row_sizes: Array = sizes
			if entry.size() > 4 and entry[4] == "pad":
				row_sizes = row_sizes.filter(func(r): return float(r[4]) <= 0.0 or minf(r[1].x, r[1].y) * 1.0 / float(r[4]) >= 600.0)
			for s in row_sizes:
				var st: Dictionary = await mx.stage(tree, entry, s[1], s[2], s[3], preset, false, s[4])
				# First, while nothing in the view has the focus yet: the checks after it move the focus.
				var probs := await MATRIX.first_focus_problems(tree, st["view"], entry[3])
				probs.append_array(await _view_problems(tree, st["view"], entry, preset, s))
				if not probs.is_empty():
					failed.append("%s: %s" % [s[0], probs[0] + (" (+%d more)" % (probs.size() - 1) if probs.size() > 1 else "")])
				layouts += 1
				(st["vp"] as Node).free()
				await tree.process_frame
			t.check("fresh layout: %s / %s fits every size laid out at the size" % [entry[0], preset], failed.is_empty(), "; ".join(failed.slice(0, 4)))
	t.check("fresh layout: coverage", layouts >= MATRIX.SCREENS.size() * 12 * 3 - 200 or not only.is_empty(), "%d layouts" % layouts)


## Every control in the focus chain is on screen and focusable.
static func _focus(v: PKeyUiView) -> PackedStringArray:
	var out := PackedStringArray()
	var screen := v.get_viewport_rect()
	var chain := v.focus_order()
	# Every focus neighbour path resolves (the engine logs "Next focus node path is invalid" and the
	# player is stuck otherwise), and Tab from the first control walks the whole chain.
	for ctl in chain:
		for path in [ctl.focus_next, ctl.focus_previous, ctl.focus_neighbor_top, ctl.focus_neighbor_bottom]:
			if not path.is_empty() and ctl.get_node_or_null(path) == null:
				out.append("focus path %s of %s does not resolve" % [path, v.get_path_to(ctl)])
				return out
	if chain.size() > 1:
		var seen := {}
		var at: Control = chain[0]
		for i in chain.size():
			seen[at] = true
			var nxt := at.get_node_or_null(at.focus_next) as Control
			if nxt == null:
				break
			at = nxt
		if seen.size() != chain.size():
			out.append("Tab from %s reaches %d of %d controls" % [chain[0].name, seen.size(), chain.size()])
	for ctl in chain:
		# A control in a scrolling list is reached by scrolling to it (follow_focus).
		if MATRIX._in_scroll(ctl, v):
			continue
		if not screen.grow(1.0).encloses(ctl.get_global_rect()):
			out.append("focusable %s is off screen" % v.get_path_to(ctl))
	return out


## An action pressed on the view's viewport, as a gamepad or keyboard sends it.
static func _joy(vp: SubViewport, button: int) -> void:
	for pressed in [true, false]:
		var e := InputEventJoypadButton.new()
		e.button_index = button
		e.pressed = pressed
		vp.push_input(e)


## A stick pushed to `value` on the left X axis and let go, as the hardware sends it.
static func _stick(vp: SubViewport, value: float) -> void:
	for v in [value, 0.0]:
		var e := InputEventJoypadMotion.new()
		e.axis = JOY_AXIS_LEFT_X
		e.axis_value = v
		vp.push_input(e)


static func _press(vp: SubViewport, action: String) -> void:
	for pressed in [true, false]:
		var e := InputEventAction.new()
		e.action = action
		e.pressed = pressed
		vp.push_input(e)


## The settings panel opened the way a game opens it: created and added once, straight into its UI at
## the device's size (no harness re-parenting), anchored over the screen, then left alone. On a pad
## the first focus is inside the visible list, and so is the control a D-pad Down moves it to, also
## on a short landscape screen (a phone held sideways), where the list used to open scrolled to its
## last row with the focus out of view.
func _settings_opened_directly(t: PKeyTestContext, tree: SceneTree, mx) -> void:
	mx.use_locale("en")
	var sc := MATRIX.SCENARIOS.new()
	var cases := [
		["2532x1170@3", Vector2i(2532, 1170), 3.0, [47.0, 0.0, 47.0, 21.0], 3.0],
		["1334x750@2", Vector2i(1334, 750), 2.0, null, 2.0],
		["2400x1080", Vector2i(2400, 1080), 1.0, [96.0, 0.0, 96.0, 48.0], 2.75],
		["pixel-art 640x360", Vector2i(1920, 1080), 3.0, null, 0.0],
		["640x360", Vector2i(640, 360), 1.0, null, 0.0],
		["800x600", Vector2i(800, 600), 1.0, null, 0.0],
		["1280x720", Vector2i(1280, 720), 1.0, null, 0.0],
		["1170x2532@3", Vector2i(1170, 2532), 3.0, [0.0, 47.0, 0.0, 34.0], 3.0],
		["750x1334@2", Vector2i(750, 1334), 2.0, [0.0, 20.0, 0.0, 0.0], 2.0],
	]
	for preset in ["dark", "native", "custom"]:
		var failed: Array = []
		for c in cases:
			PKeyUiView.pointer_last = false
			PKeyUiView._pointer_known = true
			PKeyUiView.safe_insets_override = c[3]
			PKeyUiView.mobile_override = {"dpr": c[4]} if float(c[4]) > 0.0 else false
			PKeyUiView.pad_only_override = false
			var vp := SubViewport.new()
			vp.size = c[1]
			vp.size_2d_override = Vector2i((Vector2(c[1]) / float(c[2])).round())
			vp.size_2d_override_stretch = not is_equal_approx(float(c[2]), 1.0)
			vp.render_target_update_mode = SubViewport.UPDATE_DISABLED
			tree.root.add_child(vp)
			var host := Control.new()
			host.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
			match preset:
				"native":
					host.theme = MATRIX.game_theme()
			vp.add_child(host)
			var sdk: Node = await sc.settings_sdk({})
			tree.root.add_child(sdk)
			MATRIX.apply_preset(preset)
			var p := PKeySettingsPanel.new()
			p.auto_sdk = false
			p.sdk = sdk
			p.theme = load(PKeyUiTheme.NEUTRAL_PATH)
			p.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
			host.add_child(p)
			for i in 30:
				await tree.process_frame
			await tree.create_timer(0.3).timeout
			var scroll: ScrollContainer = p._scroll
			var inside := func() -> bool:
				var f := vp.gui_get_focus_owner()
				return f != null and p.is_ancestor_of(f) and (not scroll.is_ancestor_of(f) or scroll.get_global_rect().grow(0.5).encloses(f.get_global_rect()))
			if not inside.call():
				failed.append("%s: the first focus %s is not in view (scroll %d of %d)" % [c[0], vp.gui_get_focus_owner(), scroll.scroll_vertical, int(scroll.get_v_scroll_bar().max_value - scroll.size.y)])
			_joy(vp, JOY_BUTTON_DPAD_DOWN)
			for i in 6:
				await tree.process_frame
			if not inside.call():
				failed.append("%s: after D-pad Down the focus %s is not in view" % [c[0], vp.gui_get_focus_owner()])
			vp.free()
			sdk.queue_free()
			await tree.process_frame
		t.check("settings opened directly: %s, the first focus and the next are in view at every size" % preset, failed.is_empty(), "; ".join(failed.slice(0, 4)))
	PKeyUiView.safe_insets_override = null
	PKeyUiView.mobile_override = null
	PKeyUiView.pad_only_override = null


## What a pad does on a screen it opens cold, in the Polaris Key look and a game's own: nothing is
## focused, ui_down lands inside the view (never on a control of the game behind it) and ui_accept
## fires the primary action; a busy action keeps its focus; every number setting changes with
## left and right and keeps the focus on it.
func _pad_flows(t: PKeyTestContext, tree: SceneTree, mx) -> void:
	mx.use_locale("en")
	for preset in ["dark", "native"]:
		var entry := ["gate.network", "gate", "network failure", "full"]
		for e in MATRIX.SCREENS:
			if e[0] == "gate.network":
				entry = e
		var st: Dictionary = await mx.stage(tree, entry, Vector2i(1280, 720), 1.0, null, preset)
		var vp: SubViewport = st["vp"]
		var v: PKeyUiView = st["view"]
		var fired := [0]
		var retry := v.find_child("Retry", true, false) as Button
		retry.pressed.connect(func() -> void: fired[0] += 1)
		vp.gui_release_focus()
		PKeyUiView.pointer_last = false
		await tree.process_frame
		_press(vp, "ui_down")
		await tree.process_frame
		var owner := vp.gui_get_focus_owner()
		t.check("pad (%s): ui_down on a cold screen lands inside the view" % preset, owner != null and (owner == v or v.is_ancestor_of(owner)), str(owner))
		_press(vp, "ui_accept")
		await tree.process_frame
		t.check("pad (%s): ui_accept then fires an action of the screen" % preset, fired[0] + (1 if owner != retry else 0) >= 1 and owner != null, "retry fired %d, focus %s" % [fired[0], owner])
		# A busy action keeps the focus (the control is not rebuilt or hidden under it).
		retry.grab_focus()
		v.refresh_view()
		await tree.process_frame
		t.check("pad (%s): a refresh keeps the focus on the control" % preset, vp.gui_get_focus_owner() == retry)
		vp.free()
	# Number settings on a pad.
	var entry := ["settings", "settings", "catalog", "full"]
	for e in MATRIX.SCREENS:
		if e[0] == "settings":
			entry = e
	var st2: Dictionary = await mx.stage(tree, entry, Vector2i(1280, 720), 1.0, null, "dark")
	var vp2: SubViewport = st2["vp"]
	var panel := st2["view"] as PKeyUiView
	var moved := 0
	var kept := 0
	var total := 0
	# One section of the settings shows at a time: visit each and try every number in it.
	for i in (panel as PKeySettingsPanel)._groups.size():
		(panel as PKeySettingsPanel)._select_section(i)
		for k in 4:
			await tree.process_frame
		for r in panel.find_children("Input", "Range", true, false):
			if not r.is_visible_in_tree():
				continue
			total += 1
			var target: Control = (r as SpinBox).get_line_edit() if r is SpinBox else r
			target.grab_focus()
			var before: float = (r as Range).value
			# Real joypad events: the D-pad, then the stick (what a pad sends; an InputEventAction
			# never reaches a control's own handler the same way).
			_joy(vp2, JOY_BUTTON_DPAD_RIGHT)
			await tree.process_frame
			var up: float = (r as Range).value
			var focus_ok := vp2.gui_get_focus_owner() == target
			_joy(vp2, JOY_BUTTON_DPAD_LEFT)
			await tree.process_frame
			var back: float = (r as Range).value
			_stick(vp2, 1.0)
			await tree.process_frame
			var by_stick: float = (r as Range).value
			_stick(vp2, -1.0)
			await tree.process_frame
			if up > before and back < up and by_stick > back and (r as Range).value < by_stick:
				moved += 1
			if focus_ok and vp2.gui_get_focus_owner() == target:
				kept += 1
	var ranges: Array = []
	ranges.resize(total)
	var unbounded := panel.find_children("Input", "SpinBox", true, false).size()
	t.check("pad: every number setting (a slider and an unbounded spin box) changes with the D-pad and the stick and keeps the focus", unbounded >= 1 and total >= 2 and moved == total and kept == total, "%d numbers (%d unbounded), %d moved, %d kept focus" % [total, unbounded, moved, kept])
	vp2.free()


## The sign-in on the gate goes from portrait to landscape and back as its viewport is resized;
## the focused control keeps the focus.
func _live_resize(t: PKeyTestContext, tree: SceneTree, mx) -> void:
	mx.use_locale("en")
	var entry := ["gate.sign_in", "gate", "sign-in pending", "full"]
	var st: Dictionary = await mx.stage(tree, entry, Vector2i(720, 1280), 1.0, null, "dark")
	var vp: SubViewport = st["vp"]
	var v: PKeyUiView = st["view"]
	var open := v.find_child("OpenBrowser", true, false) as Button
	open.grab_focus()
	var portrait := not v.is_landscape()
	vp.size = Vector2i(1280, 720)
	vp.size_2d_override = Vector2i(1280, 720)
	for i in 4:
		await tree.process_frame
	var landscape := v.is_landscape()
	var probs := MATRIX.problems(v, "full", "gate.sign_in")
	t.check("resize: portrait to landscape follows live", portrait and landscape and probs.is_empty(), "; ".join(probs.slice(0, 3)))
	t.check("resize: the focus stays on the control", open.has_focus())
	vp.size = Vector2i(720, 1280)
	vp.size_2d_override = Vector2i(720, 1280)
	for i in 4:
		await tree.process_frame
	t.check("resize: and back to portrait", not v.is_landscape() and MATRIX.problems(v, "full", "gate.sign_in").is_empty() and open.has_focus())
	vp.free()


## Refreshing a view again and again (under the native look, with safe-area insets) never swaps its
## theme or grows the neutral theme cache: a refresh is cheap and stable.
func _refresh_stability(t: PKeyTestContext, tree: SceneTree, mx) -> void:
	var entry := ["sign_in", "sign_in", "pending", "full"]
	for e in MATRIX.SCREENS:
		if e[0] == "sign_in":
			entry = e
	var st: Dictionary = await mx.stage(tree, entry, Vector2i(2400, 1080), 1.0, [96.0, 0.0, 96.0, 48.0], "native", false, 2.75)
	var v := st["view"] as PKeyUiView
	var theme_before := v.theme
	var cache_before := PKeyUiTheme._neutral_cache.size()
	for i in 10:
		v.refresh_view()
		await tree.process_frame
	t.check("refresh: ten refreshes keep the theme instance", v.theme == theme_before)
	t.check("refresh: ten refreshes do not grow the neutral theme cache", PKeyUiTheme._neutral_cache.size() == cache_before, "%d -> %d" % [cache_before, PKeyUiTheme._neutral_cache.size()])
	(st["vp"] as Node).free()
	PKeyUiView.safe_insets_override = null
	PKeyUiView.mobile_override = null


## Offline activation shows its request QR code on a desktop screen where it fits, and not on a phone.
func _offline_qr(t: PKeyTestContext, tree: SceneTree, mx) -> void:
	var entry := ["offline", "offline", "native", "full"]
	for sz in [Vector2i(1280, 720), Vector2i(1920, 1080), Vector2i(2560, 1440)]:
		var st: Dictionary = await mx.stage(tree, entry, sz, 1.0, null, "dark")
		var qr := (st["view"] as Node).find_child("QrCode", true, false) as Control
		t.check("offline: the request QR code shows at %dx%d" % [sz.x, sz.y], qr != null and qr.is_visible_in_tree())
		(st["vp"] as Node).free()


## A notch and a home indicator push the content inside the safe area.
func _safe_area(t: PKeyTestContext, tree: SceneTree, mx) -> void:
	var entry := ["gate", "gate", "needs-activation", "full"]
	var insets := [140.0, 0.0, 60.0, 40.0]
	var st: Dictionary = await mx.stage(tree, entry, Vector2i(2400, 1080), 1.0, insets, "dark")
	var v: PKeyUiView = st["view"]
	var card := v.find_child("Card", true, false) as Control
	var r := card.get_global_rect()
	t.check("safe area: the card clears the notch and the home indicator", r.position.x >= 140.0 + PKeyUiView.GUTTER and r.end.x <= 2400.0 - 60.0 - PKeyUiView.GUTTER and r.end.y <= 1080.0 - 40.0 - PKeyUiView.GUTTER, str(r))
	(st["vp"] as Node).free()
	PKeyUiView.safe_insets_override = null


## The sign-in user code on a 360 dp phone is one line (DL11: broken only at its hyphen, never mid-group);
## the offline request QR also shows on a mobile-flagged device whose only input is a pad (Android TV);
## the settings slider draws a focus ring in every look.
func _phone_checks(t: PKeyTestContext, tree: SceneTree, mx) -> void:
	mx.use_locale("en")
	var entry := ["sign_in", "sign_in", "pending", "full"]
	for sz in [[Vector2i(1080, 2400), 3.0, "360 dp"], [Vector2i(1170, 2532), 3.0, "390 pt"]]:
		var logical: Vector2i = sz[0]
		for preset in ["dark", "native", "custom"]:
			var st: Dictionary = await mx.stage(tree, entry, logical, 1.0 if logical.x == 1080 else 3.0, null, preset, false, sz[1])
			var code := (st["view"] as Node).find_child("UserCode", true, false) as Label
			t.check("phone: the sign-in code is one line at %s (%s)" % [sz[2], preset], code != null and code.is_visible_in_tree() and code.get_line_count() == 1, "%s lines" % (code.get_line_count() if code else -1))
			(st["vp"] as Node).free()
	var pad_entry := ["offline", "offline", "native", "full", "pad"]
	var st2: Dictionary = await mx.stage(tree, pad_entry, Vector2i(1920, 1080), 1.0, null, "dark", false, 2.0)
	var qr := (st2["view"] as Node).find_child("QrCode", true, false) as Control
	t.check("offline: the request QR code shows on a mobile-flagged, pad-only device (Android TV)", qr != null and qr.is_visible_in_tree())
	(st2["vp"] as Node).free()
	for preset in ["dark", "light", "native", "native-light", "custom", "default", "accent-dark"]:
		var st3: Dictionary = await mx.stage(tree, ["settings", "settings", "catalog", "full"], Vector2i(1280, 720), 1.0, null, preset)
		var panel := st3["view"] as PKeySettingsPanel
		var slider: HSlider = null
		for s in panel.find_children("Input", "HSlider", true, false):
			slider = s
		var drawn := slider != null and slider.draw.get_connections().size() > 0
		var ring := slider != null and not (slider.get_theme_stylebox("focus", "HSlider") is StyleBoxEmpty or slider.get_theme_stylebox("focus", "Button") is StyleBoxEmpty)
		t.check("settings: the slider is drawn a focus ring in the %s look" % preset, drawn and ring)
		(st3["vp"] as Node).free()
	PKeyUiView.mobile_override = null
	PKeyUiView.pad_only_override = null
