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
			# Built once, then resized through every size, as a window is.
			var first: Array = row_sizes[0]
			var st: Dictionary = await mx.stage(tree, entry, first[1], first[2], first[3], preset, false, first[4])
			var v: PKeyUiView = st["view"]
			for s in row_sizes:
				await mx.resize(tree, st, s[1], s[2], s[3], s[4])
				var row := {"label": s[0], "physical": s[1], "scale": s[2], "dpr": s[4], "preset": preset}
				var probs: PackedStringArray = MATRIX.problems(v, entry[3], entry[0], preset in ["dark", "accent-dark", "accent-light"], row)
				# (A 36 px host font on a 640 px wide canvas is the one tight case; see MATRIX.problems.)
				if not (preset == "native36" and s[1].x <= 640):
					probs.append_array(_focus(v))
				if not probs.is_empty():
					failed.append("%s: %s" % [s[0], probs[0] + (" (+%d more)" % (probs.size() - 1) if probs.size() > 1 else "")])
				layouts += 1
			(st["vp"] as Node).free()
			t.check("matrix: %s / %s / %s fits every size" % [entry[0], preset, locale], failed.is_empty(), "; ".join(failed.slice(0, 4)))
	await _pad_flows(t, tree, mx)
	await _live_resize(t, tree, mx)
	await _safe_area(t, tree, mx)
	mx.drop_locales()
	PKeyUiView.safe_insets_override = null
	PKeyUiView.mobile_override = null
	PKeyUiView.pad_only_override = null
	PKeyUiTheme.reset()
	t.check("matrix: coverage", layouts >= MATRIX.SCREENS.size() * sizes.size() * 7 or not only.is_empty(), "%d layouts" % layouts)
	return true


## Every control in the focus chain is on screen and focusable.
static func _focus(v: PKeyUiView) -> PackedStringArray:
	var out := PackedStringArray()
	var screen := v.get_viewport_rect()
	for ctl in v.focus_order():
		# A control in a scrolling list is reached by scrolling to it (follow_focus).
		if MATRIX._in_scroll(ctl, v):
			continue
		if not screen.grow(1.0).encloses(ctl.get_global_rect()):
			out.append("focusable %s is off screen" % v.get_path_to(ctl))
	return out


## An action pressed on the view's viewport, as a gamepad or keyboard sends it.
static func _press(vp: SubViewport, action: String) -> void:
	for pressed in [true, false]:
		var e := InputEventAction.new()
		e.action = action
		e.pressed = pressed
		vp.push_input(e)


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
			_press(vp2, "ui_right")
			await tree.process_frame
			var up: float = (r as Range).value
			var focus_ok := vp2.gui_get_focus_owner() == target
			_press(vp2, "ui_left")
			await tree.process_frame
			if up > before and (r as Range).value < up:
				moved += 1
			if focus_ok and vp2.gui_get_focus_owner() == target:
				kept += 1
	var ranges: Array = []
	ranges.resize(total)
	t.check("pad: every number setting changes with left and right and keeps the focus", not ranges.is_empty() and moved == ranges.size() and kept == ranges.size(), "%d numbers, %d moved, %d kept focus" % [ranges.size(), moved, kept])
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
