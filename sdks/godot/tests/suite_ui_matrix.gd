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
		sizes.append([s[0], s[1], s[2], s[3]])
	for row in MATRIX.STRETCHED:
		var st: Array = MATRIX.stretched(row)
		var logical: Vector2i = st[0]
		var k: float = st[1]
		sizes.append([row[0], Vector2i((Vector2(logical) * k).round()), k, null])
	var layouts := 0
	for preset in PRESET_LOCALES:
		for locale in PRESET_LOCALES[preset]:
			mx.use_locale(locale)
			for entry in MATRIX.SCREENS:
				if not only.is_empty() and not only.has(entry[0]):
					continue
				var failed: Array = []
				# Built once, then resized through every size, as a window is.
				var st: Dictionary = await mx.stage(tree, entry, sizes[0][1], sizes[0][2], sizes[0][3], preset)
				var v: PKeyUiView = st["view"]
				for s in sizes:
					await mx.resize(tree, st, s[1], s[2], s[3])
					var probs: PackedStringArray = MATRIX.problems(v, entry[3], entry[0], preset == "dark")
					probs.append_array(_focus(v))
					if not probs.is_empty():
						failed.append("%s: %s" % [s[0], probs[0] + (" (+%d more)" % (probs.size() - 1) if probs.size() > 1 else "")])
					layouts += 1
				(st["vp"] as Node).free()
				t.check("matrix: %s / %s / %s fits every size" % [entry[0], preset, locale], failed.is_empty(), "; ".join(failed.slice(0, 4)))
	await _live_resize(t, tree, mx)
	await _safe_area(t, tree, mx)
	mx.drop_locales()
	PKeyUiView.safe_insets_override = null
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
