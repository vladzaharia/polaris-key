extends RefCounted
## The resolution matrix of the drop-in screens (owner, 2026-10-07: "Our drop-in UIs should be
## responsive … you should test at multiple resolutions"). Every named screen is laid out in a
## SubViewport the way a game shows it: at every size, in every preset (the Polaris Key look dark
## and light, the native look over a game's own theme, a game's whole custom theme) and locale
## (English, and German and Japanese for the longest and the unspaced strings).
##
## tools/ui_matrix/ui_matrix.gd renders it to PNGs; the `ui_matrix` suite lays it out headless and
## fails on any control outside its container or the panel, two controls overlapping, clipped
## text, a margin under GUTTER, a QR code a phone cannot scan (or one that swamps the screen), and
## a landscape screen laid out in portrait (or the reverse).

const SCENARIOS := preload("res://tests/ui/scenarios.gd")
const LOCALE_TABLES := preload("res://tools/ui_matrix/locales.gd")

## [label, physical size, physical pixels per logical pixel, safe-area insets in logical pixels
## ([left, top, right, bottom]) or null, density-independent pixels per 160 dpi on a phone or tablet
## (0: not mobile)]. The phones carry a status bar or notch and a home indicator, as a safe area
## does. The first ten are the owner's matrix; the last three are the review's additions.
const SIZES := [
	["640x360", Vector2i(640, 360), 1.0, null, 0.0],
	["800x600", Vector2i(800, 600), 1.0, null, 0.0],
	["1280x720", Vector2i(1280, 720), 1.0, null, 0.0],
	["1280x800", Vector2i(1280, 800), 1.0, null, 0.0],
	["1920x1080", Vector2i(1920, 1080), 1.0, null, 0.0],
	["2560x1440", Vector2i(2560, 1440), 1.0, null, 0.0],
	["3840x2160@2", Vector2i(3840, 2160), 2.0, null, 0.0],
	["1080x2400", Vector2i(1080, 2400), 1.0, [0.0, 96.0, 0.0, 64.0], 2.75],
	["2400x1080", Vector2i(2400, 1080), 1.0, [96.0, 0.0, 96.0, 48.0], 2.75],
	["2048x1536", Vector2i(2048, 1536), 1.0, null, 2.0],
	["1170x2532@3", Vector2i(1170, 2532), 3.0, [0.0, 47.0, 0.0, 34.0], 3.0],
	["1536x2048", Vector2i(1536, 2048), 1.0, null, 2.0],
	["3440x1440", Vector2i(3440, 1440), 1.0, null, 0.0],
]

## A game's project stretch settings turn its window into a logical size and a scale; the checks
## also run at these (`stretched()`): [label, window, mode, base size, aspect].
const STRETCHED := [
	["deck canvas_items 1152x648 expand", Vector2i(1280, 800), "canvas_items", Vector2i(1152, 648), "expand"],
	["pixel-art canvas_items 640x360 keep", Vector2i(1920, 1080), "canvas_items", Vector2i(640, 360), "keep"],
	["phone viewport 1280x720 expand", Vector2i(1080, 2400), "viewport", Vector2i(1280, 720), "expand"],
	["portrait game 720x1280 keep_width", Vector2i(1080, 2400), "canvas_items", Vector2i(720, 1280), "keep_width"],
	["4K laptop disabled at 150 %", Vector2i(3840, 2400), "disabled", Vector2i(0, 0), "1.5"],
]

## The looks: the Polaris Key theme (dark, light), the native look over a game's own theme
## (`game_theme()`), and a game's whole custom theme through `ui_theme` (`custom_theme()`), both
## with a larger type and roomier controls than the kit's.
const PRESETS := ["dark", "light", "native", "custom"]
## More looks, checked and rendered at EXTRA_SIZES in English only: the out-of-box default (the
## engine theme under ui_branding "none"), a light game theme, a game with 28 and 36 px type, and
## an accent of #f5c518 in both schemes.
const EXTRA_PRESETS := ["default", "native-light", "native28", "native36", "accent-dark", "accent-light"]
const EXTRA_SIZES := ["640x360", "1280x720", "1080x2400"]
## Host-font looks also at these sizes (the review's rows).
const HOST_FONT_SIZES := ["1280x720", "1280x800", "640x360"]
const LOCALES := ["en", "de", "ja"]

## The named screens: [id, scenario scene, scenario state, kind]. "full" fills the screen; "strip"
## is a strip across the top (or the middle, for the badge).
const SCREENS := [
	["sign_in", "sign_in", "pending", "full"],
	["sign_in.confirm", "sign_in", "confirm, attachable", "full"],
	["sign_in.expired", "sign_in", "expired", "full"],
	["gate", "gate", "needs-activation", "full"],
	["gate.sign_in", "gate", "sign-in pending", "full"],
	["gate.offline", "gate", "offline activation", "full"],
	["gate.device_limit", "gate", "device limit", "full"],
	["gate.device_limit_qr", "gate", "device limit, replace a device (QR)", "full"],
	["gate.error", "gate", "needs-activation after an error", "full"],
	["gate.expired", "gate", "expired", "full"],
	["gate.update", "gate", "version-too-old with a store action", "full"],
	["activation", "activation", "license on, identity on, enrolment on, native", "full"],
	["activation.device_limit", "activation", "device limit, replace a device (QR)", "full"],
	["offline", "offline", "native", "full"],
	["boot", "boot", "syncing", "full"],
	["boot.waiting", "boot", "waiting needs-activation", "full"],
	["boot.offline", "boot", "offline", "full"],
	["boot.consent", "boot", "consent metered", "full"],
	["update.modal", "update_prompt", "binary, modal", "full"],
	["update.banner", "update_prompt", "store", "strip"],
	["update.locked", "update_prompt", "binary mandatory (locked, modal asked)", "strip"],
	["banner", "banner", "grace", "strip"],
	["badge", "badge", "two grants", "badge"],
	["badge.wide", "badge", "two grants", "badge_wide"],
	["badge.many", "badge", "eight grants", "badge"],
	["update.locked_full", "update_prompt", "binary mandatory (locked, modal asked)", "full"],
	["gate.network", "gate", "network error", "full"],
	["gate.unavailable", "gate", "not available (version-too-new)", "full"],
	["settings", "settings", "catalog", "full"],
	["dev_menu", "dev_menu", "steam build", "full"],
]

## Screens whose landscape layout is two columns, and the two nodes that must sit side by side
## (the first left of the second) in landscape and stack (the first above the second) in portrait.
const COLUMNS := {
	"sign_in": ["QrCode", "UserCode"],
	"gate.sign_in": ["QrCode", "UserCode"],
	"gate": ["Aside", "Form"],
	"gate.error": ["Aside", "Form"],
	"activation": ["Intro", "Form"],
	"offline": ["Request", "Import"],
	"gate.offline": ["Request", "Import"],
}

## The screens that put an identity pane beside a form: two panes only at an aspect of 1.5 or more.
const WIDE_SCREENS := ["gate", "gate.error", "activation"]
const MOBILE_BODY_DP := 16
const MOBILE_CONTROL_DP := 48

var _sc = SCENARIOS.new()
var _translations := {}


## The scenario builder for a screen entry.
func builder(entry: Array) -> Callable:
	for c in _sc.all():
		if c[0] == entry[1] and c[1] == entry[2]:
			return c[2]
	return Callable()


## [logical size, scale] a window of `window` pixels gets from a stretch row (STRETCHED).
static func stretched(row: Array) -> Array:
	var window := Vector2(row[1])
	var mode: String = row[2]
	if mode == "disabled":
		var f := float(row[4])
		return [Vector2i((window / f).round()), f]
	var base := Vector2(row[3])
	var k := minf(window.x / base.x, window.y / base.y)
	var logical := base
	match row[4]:
		"expand":
			logical = window / k
		"keep_width":
			k = window.x / base.x
			logical = Vector2(base.x, window.y / k)
		"keep_height":
			k = window.y / base.y
			logical = Vector2(window.x / k, base.y)
	return [Vector2i(logical.round()), k]


## Put the UI options for `preset` in place (a scenario configures a fake SDK first, which applies
## its own defaults).
static func apply_preset(preset: String) -> void:
	PKeyUiTheme.reset()
	match preset:
		"dark", "light":
			PKeyUiTheme.branding = PKeyUiTheme.BRANDING_POLARIS_KEY
			PKeyUiTheme.scheme = preset
		"accent-dark", "accent-light":
			PKeyUiTheme.branding = PKeyUiTheme.BRANDING_POLARIS_KEY
			PKeyUiTheme.scheme = preset.trim_prefix("accent-")
			PKeyUiTheme.accent = Color("#f5c518")
		"native", "native-light", "native28", "native36", "default":
			PKeyUiTheme.branding = PKeyUiTheme.BRANDING_NONE
		"custom":
			PKeyUiTheme.override = custom_theme()
	PKeyUiTheme.product_name = "Diceroll"
	PKeyUiTheme.product_icon = sample_icon()


## Load the de and ja tables as Translations (once) and switch to `locale`.
func use_locale(locale: String) -> void:
	if _translations.is_empty():
		for pair in [["de", LOCALE_TABLES.DE], ["ja", LOCALE_TABLES.JA]]:
			var t := Translation.new()
			t.locale = pair[0]
			var table: Dictionary = pair[1]
			for k in table:
				t.add_message(k, table[k])
			TranslationServer.add_translation(t)
			_translations[pair[0]] = t
	TranslationServer.set_locale(locale)


## Remove the tables and go back to English.
func drop_locales() -> void:
	for t in _translations.values():
		TranslationServer.remove_translation(t)
	_translations.clear()
	TranslationServer.set_locale("en")


## Lay `entry` out in a SubViewport of `physical` pixels at `scale` physical pixels per logical one,
## with `insets` as the safe area and `dpr` the density-independent pixels per 160 dpi of a phone
## or tablet (0: a desktop or console). Returns {"vp", "view", "host"}; the caller frees "vp" (which
## holds the rest). A coroutine. `render`: keep the viewport drawing (for a screenshot).
func stage(tree: SceneTree, entry: Array, physical: Vector2i, scale: float, insets: Variant, preset: String, render := false, dpr := 0.0) -> Dictionary:
	PKeyUiView.safe_insets_override = insets
	PKeyUiView.mobile_override = {"dpr": dpr} if dpr > 0.0 else false
	PKeyUiView.pad_only_override = false
	var vp := SubViewport.new()
	vp.size = physical
	vp.size_2d_override = Vector2i((Vector2(physical) / scale).round())
	vp.size_2d_override_stretch = not is_equal_approx(scale, 1.0)
	vp.transparent_bg = false
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS if render else SubViewport.UPDATE_DISABLED
	tree.root.add_child(vp)
	var host := Control.new()
	host.name = "Game"
	host.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var ground := TextureRect.new()
	ground.name = "Backdrop"
	ground.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	ground.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	ground.stretch_mode = TextureRect.STRETCH_SCALE
	ground.texture = backdrop(preset)
	ground.mouse_filter = Control.MOUSE_FILTER_IGNORE
	host.add_child(ground)
	match preset:
		"native":
			host.theme = game_theme()
		"native-light":
			host.theme = game_theme(20, true)
		"native28":
			host.theme = game_theme(28)
		"native36":
			host.theme = game_theme(36)
	vp.add_child(host)
	var make := builder(entry)
	var v: PKeyUiView = await make.call()
	v.get_parent().remove_child(v)
	apply_preset(preset)
	# As the scene file has it: the stock theme, which then follows the options.
	v.theme = load(PKeyUiTheme.NEUTRAL_PATH)
	host.add_child(v)
	match entry[3]:
		"strip":
			v.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
		"badge":
			v.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
			# A centred control grows both ways as its content does (a game's own anchoring).
			v.grow_horizontal = Control.GROW_DIRECTION_BOTH
			v.grow_vertical = Control.GROW_DIRECTION_BOTH
		"badge_wide":
			v.set_anchors_and_offsets_preset(Control.PRESET_HCENTER_WIDE)
		_:
			v.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	v.refresh_view()
	var st := {"vp": vp, "view": v, "host": host, "kind": entry[3]}
	await settle(tree, st)
	return st


## Resize a staged screen (from `stage()`) to `physical` pixels at `scale`, with `insets` as the
## safe area, as a window resize would, and let it settle. A coroutine.
func resize(tree: SceneTree, st: Dictionary, physical: Vector2i, scale: float, insets: Variant, dpr := 0.0) -> void:
	PKeyUiView.safe_insets_override = insets
	PKeyUiView.mobile_override = {"dpr": dpr} if dpr > 0.0 else false
	var vp: SubViewport = st["vp"]
	vp.size = physical
	vp.size_2d_override = Vector2i((Vector2(physical) / scale).round())
	vp.size_2d_override_stretch = not is_equal_approx(scale, 1.0)
	# State that depends on the device (a phone's layout) is rendered, not only laid out.
	(st["view"] as PKeyUiView).refresh_view()
	# A centred control keeps the size it grew to; a new screen starts from its minimum again.
	if st["kind"] == "badge":
		var bv := st["view"] as PKeyUiView
		bv.reset_size()
		bv.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	await settle(tree, st)


## Let a staged screen's layout settle: frames until every control's rect stops changing (at
## least three, the frames a view checks its own sorting after a layout pass; at most ten); a strip
## is trimmed to its own height.
static func settle(tree: SceneTree, st: Dictionary) -> void:
	var v: PKeyUiView = st["view"]
	v.layout_content()
	var last := ""
	for i in 10:
		await tree.process_frame
		if st["kind"] != "full" and not v.get("_covering"):
			# A strip asks for its own height only.
			v.offset_bottom = v.offset_top + v.get_combined_minimum_size().y
		var sig := _signature(v)
		if i >= 2 and sig == last and int(v.get("_checks_left")) <= 0:
			break
		last = sig


## A stand-in for a game's own project theme (the native look derives from it): its own font size
## (20, larger than the kit's 18), text colour, panel and roomy controls.
static func game_theme(font_size := 20, light := false) -> Theme:
	var t := Theme.new()
	t.default_font_size = font_size
	var ink := Color("#1f2430") if light else Color("#f3ead8")
	var page := Color("#f1f3f6") if light else Color("#1b2430")
	var raised := Color("#e3e7ee") if light else Color("#2b3747")
	var accent := Color("#b86b00") if light else Color("#e0a458")
	for type in ["Label", "Button", "LineEdit", "TextEdit", "CheckButton", "OptionButton", "CheckBox"]:
		t.set_color("font_color", type, ink)
		t.set_color("font_hover_color", type, ink)
		t.set_color("font_focus_color", type, ink)
		t.set_color("font_pressed_color", type, ink)
	t.set_color("font_placeholder_color", "LineEdit", Color("#6b7280") if light else Color("#a39a8a"))
	t.set_stylebox("panel", "PanelContainer", _flat(page, page, 0, 0))
	for type in ["Button", "OptionButton"]:
		t.set_stylebox("normal", type, _flat(raised, accent, 8, 14))
		t.set_stylebox("hover", type, _flat(raised.lightened(0.08), accent.lightened(0.15), 8, 14))
		t.set_stylebox("pressed", type, _flat(raised.darkened(0.1), accent.lightened(0.15), 8, 14))
		t.set_stylebox("focus", type, _ring(accent.lightened(0.15)))
	for type in ["LineEdit", "TextEdit"]:
		t.set_stylebox("normal", type, _flat(Color("#ffffff") if light else Color("#121a24"), Color("#9aa1ad") if light else Color("#4b5b70"), 8, 12))
		t.set_stylebox("focus", type, _ring(accent.lightened(0.15)))
	return t


## A stand-in for a game's whole Theme given as `ui_theme`: larger type (22) and larger margins
## than the kit's, its own card, and nothing of the kit's spacing (the kit's layered structure
## supplies it).
static func custom_theme() -> Theme:
	var t := Theme.new()
	t.default_font_size = 22
	var ink := Color("#e8f1ff")
	for type in ["Label", "Button", "LineEdit", "TextEdit", "CheckButton", "OptionButton", "CheckBox"]:
		t.set_color("font_color", type, ink)
	t.set_stylebox("panel", "PanelContainer", _flat(Color("#0c1a2b"), Color("#0c1a2b"), 0, 12))
	t.set_stylebox("panel", "PKeyCard", _flat(Color("#132a45"), Color("#3d6aa3"), 18, 48))
	for type in ["Button", "OptionButton"]:
		t.set_stylebox("normal", type, _flat(Color("#1d3a5e"), Color("#5d8fd1"), 18, 18))
		t.set_stylebox("hover", type, _flat(Color("#25476f"), Color("#8db6ee"), 18, 18))
		t.set_stylebox("focus", type, _ring(Color("#8db6ee")))
	t.set_stylebox("normal", "LineEdit", _flat(Color("#081322"), Color("#3d6aa3"), 18, 16))
	return t


static func _flat(bg: Color, border: Color, radius: int, pad: int) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.border_color = border
	s.set_border_width_all(1 if bg != border else 0)
	s.set_corner_radius_all(radius)
	s.set_content_margin_all(pad)
	return s


static func _ring(c: Color) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.draw_center = false
	s.border_color = c
	s.set_border_width_all(2)
	s.set_corner_radius_all(10)
	s.set_expand_margin_all(3)
	return s


static var _icon: Texture2D = null
static var _grounds := {}


## The sample product's icon: a die on a rounded tile (Diceroll), drawn here so the matrix needs
## no image file.
static func sample_icon() -> Texture2D:
	if _icon != null:
		return _icon
	var n := 256
	var img := Image.create(n, n, false, Image.FORMAT_RGBA8)
	var tile := Color("#e4572e")
	var pip := Color("#fff7ee")
	var r := 56.0
	for y in n:
		for x in n:
			# A rounded square: inside unless in a corner beyond the radius.
			var cx := clampf(x, r, n - 1 - r)
			var cy := clampf(y, r, n - 1 - r)
			if Vector2(x, y).distance_to(Vector2(cx, cy)) <= r:
				var shade := 1.0 - 0.18 * float(y) / n
				img.set_pixel(x, y, Color(tile.r * shade, tile.g * shade, tile.b * shade))
	for c in [Vector2(76, 76), Vector2(128, 128), Vector2(180, 180), Vector2(180, 76), Vector2(76, 180)]:
		for y in range(int(c.y) - 22, int(c.y) + 23):
			for x in range(int(c.x) - 22, int(c.x) + 23):
				if Vector2(x, y).distance_to(c) <= 21.0:
					img.set_pixel(x, y, pip)
	_icon = ImageTexture.create_from_image(img)
	return _icon


## The game behind the kit: a dusk gradient (light in the light preset), so a strip or a
## translucent panel reads as over a game.
static func backdrop(preset: String) -> Texture2D:
	if _grounds.has(preset):
		return _grounds[preset]
	var g := Gradient.new()
	if preset == "light":
		g.colors = PackedColorArray([Color("#cfe3f5"), Color("#f4e6d4")])
	else:
		g.colors = PackedColorArray([Color("#141b33"), Color("#3b2440")])
	var tex := GradientTexture2D.new()
	tex.gradient = g
	tex.fill_from = Vector2(0, 0)
	tex.fill_to = Vector2(0, 1)
	tex.width = 64
	tex.height = 64
	_grounds[preset] = tex
	return tex


## Every visible control's rect under `n`, as one string (a layout has settled when it repeats).
static func _signature(n: Node) -> String:
	var parts := PackedStringArray()
	for ch in n.get_children():
		if ch is Control and (ch as Control).visible:
			parts.append(str((ch as Control).get_rect()))
			parts.append(_signature(ch))
	return "|".join(parts)


# ── Checks ───────────────────────────────────────────────────────────────────────────────

## Every layout problem in `view` (laid out in its viewport), as lines of text; empty when clean.
## `kind` is the screen entry's kind; `screen` its id (for the column checks).
static func problems(view: PKeyUiView, kind: String, screen: String, strict := false, row := {}) -> PackedStringArray:
	var out := PackedStringArray()
	# On the kit's own looks a player's card never needs its scroll fallback (a list may scroll,
	# and so may the developer menu's section, which lives in the game's own dev menu).
	if strict and not (view is PKeyDevMenuSection) and not (view is PKeySettingsPanel):
		for sc in view.find_children("*", "ScrollContainer", true, false):
			var s := sc as ScrollContainer
			if not s.is_visible_in_tree():
				continue
			var content := s.get_child(0) as Control if s.get_child_count() > 0 else null
			if s.vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED and content != null and content.get_combined_minimum_size().y > s.size.y + 1.0:
				out.append("%s needs its scroll fallback (%.0f > %.0f)" % [_path(view, s), content.get_combined_minimum_size().y, s.size.y])
	var m := view.layout_metrics()
	var ins: Array = m["insets"]
	var r := view.get_global_rect()
	var screen_rect := view.get_viewport_rect()
	# A tight case: a game's own theme at a type size or on a canvas the kit cannot make room for
	# (a 28 or 36 px host font, or 18-20 px type on a 360 px tall canvas). The screen then keeps
	# its primary action reachable through its scroll fallback, and does not promise two columns.
	var preset: String = row.get("preset", "")
	var tight := not strict and (preset in ["native28", "native36"] or screen_rect.size.y <= 380.0 or (preset == "custom" and (view as PKeyUiView).is_phone_device()))
	# The margins are held to the screen's safe area (a strip or a badge is placed within it).
	var safe := Rect2(screen_rect.position + Vector2(ins[0], ins[1]), screen_rect.size - Vector2(ins[0] + ins[2], ins[1] + ins[3]))
	if kind == "full" and not screen_rect.grow(1.0).encloses(r) and not (tight and preset == "native36" and screen_rect.size.x <= 640.0):
		out.append("the view %s is outside the screen %s" % [r, screen_rect])
	var leaves: Array = []
	_walk(view, view, safe, kind, out, leaves)
	# No two leaves overlap.
	for i in leaves.size():
		for j in range(i + 1, leaves.size()):
			var a: Control = leaves[i]
			var b: Control = leaves[j]
			if a.is_ancestor_of(b) or b.is_ancestor_of(a):
				continue
			var x := a.get_global_rect().intersection(b.get_global_rect())
			if x.size.x > 1.0 and x.size.y > 1.0:
				out.append("%s overlaps %s" % [_path(view, a), _path(view, b)])
	# Side by side or stacked, from the shape of the screen (not from the view's own verdict).
	if COLUMNS.has(screen):
		var pair: Array = COLUMNS[screen]
		var first := view.find_child(pair[0], true, false) as Control
		var second := view.find_child(pair[1], true, false) as Control
		if first != null and second != null and first.is_visible_in_tree() and second.is_visible_in_tree():
			var fa := first.get_global_rect()
			var sb := second.get_global_rect()
			var expect := expected_columns(screen, screen_rect.size)
			if expect > 0 and not tight and not fa.end.x <= sb.position.x + 1.0:
				out.append("a %s screen, but %s is not beside %s (%s, %s)" % [screen_rect.size, pair[0], pair[1], fa, sb])
			if expect < 0 and not (fa.position.y >= sb.end.y - 1.0 or fa.end.y <= sb.position.y + 1.0):
				out.append("a %s screen, but %s and %s are side by side (%s, %s)" % [screen_rect.size, pair[0], pair[1], fa, sb])
	# The primary action and the user code are on screen without scrolling, in every look.
	if not (view is PKeySettingsPanel) and not (view is PKeyDevMenuSection) and kind == "full":
		for ctl in view.find_children("*", "Control", true, false):
			if not ctl.is_visible_in_tree():
				continue
			var primary: bool = ctl is Button and ctl.theme_type_variation == &"PKeyPrimary"
			var code: bool = ctl is Label and ctl.name == "UserCode"
			if (primary or code) and not _visible_unscrolled(ctl, view, screen_rect) and not (tight and _reachable(ctl, view)):
				out.append("%s is not on screen without scrolling: %s" % [_path(view, ctl), ctl.get_global_rect()])

	# Every visible card and banner has a panel of its own (never an empty one).
	for p in view.find_children("*", "PanelContainer", true, false):
		var pc := p as PanelContainer
		if not pc.is_visible_in_tree() or pc.has_theme_stylebox_override("panel"):
			continue
		if pc.theme_type_variation in [&"PKeyCard", &"PKeyBanner"] and pc.get_theme_stylebox("panel") is StyleBoxEmpty:
			out.append("%s (%s) has an empty panel" % [_path(view, pc), pc.theme_type_variation])
	# On a phone or tablet: body text at 16 dp or more and controls 48 dp tall or more.
	if float(row.get("dpr", 0.0)) > 0.0:
		var dpr: float = row["dpr"]
		var phys: float = float(m["physical"])
		var body := float(view.get_theme_font_size("font_size", "Label")) * phys
		if body < MOBILE_BODY_DP * dpr - 0.6:
			out.append("body text is %.1f dp, under %d" % [body / dpr, MOBILE_BODY_DP])
		var ch := view.role("control_height") * phys
		if ch < MOBILE_CONTROL_DP * dpr - 0.6:
			out.append("controls are %.1f dp tall, under %d" % [ch / dpr, MOBILE_CONTROL_DP])
	# A 36 px host font on a 640 px wide canvas: the card cannot be narrower than its widest word.
	if tight and preset == "native36" and screen_rect.size.x <= 640.0:
		var kept := PackedStringArray()
		for line in out:
			if not (" is outside the panel's safe rect" in line or " is within " in line or " overflows its container" in line or " breaks the word" in line):
				kept.append(line)
		out = kept
	return out


## 1 when a screen of `size` (logical pixels) should lay `screen`'s two parts side by side, -1 when
## it should stack them, 0 when either is fine. Independent of the view's own measurements: a
## portrait screen stacks, a landscape one is side by side; the identity-plus-form screens (the
## gate, the activation panel) only on a wide shape (aspect 1.5 or more; the Steam Deck's 1.6 and
## 16:9 do, 4:3 gets one centred column).
static func expected_columns(screen: String, size: Vector2) -> int:
	if size.y >= size.x * 1.1:
		return -1
	if size.x < size.y * 1.2:
		return 0
	if WIDE_SCREENS.has(screen):
		return 1 if size.x >= size.y * 1.5 else -1
	return 1


## The rect of `ctl` lies on the screen at the scroll position 0 and within any scroll area that is
## actually scrolling.
static func _visible_unscrolled(ctl: Control, view: Control, screen_rect: Rect2) -> bool:
	var r := ctl.get_global_rect()
	if not screen_rect.grow(1.0).encloses(r):
		return false
	var n := ctl.get_parent()
	while n != null and n != view.get_parent():
		if n is ScrollContainer and (n as ScrollContainer).vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED:
			if not (n as ScrollContainer).get_global_rect().grow(1.0).encloses(r):
				return false
		n = n.get_parent()
	return true


## `ctl` sits in a scroll area that scrolls (a focus on it brings it into view).
static func _reachable(ctl: Control, view: Control) -> bool:
	var n := ctl.get_parent()
	while n != null and n != view.get_parent():
		if n is ScrollContainer and (n as ScrollContainer).vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED and (n as ScrollContainer).follow_focus:
			return true
		n = n.get_parent()
	return false


static func _walk(node: Node, view: Control, safe: Rect2, kind: String, out: PackedStringArray, leaves: Array) -> void:
	for ch in node.get_children():
		if not (ch is Control) or not (ch as Control).visible:
			continue
		var c := ch as Control
		var cr := c.get_global_rect()
		var parent := c.get_parent() as Control
		var scrolled := _in_scroll(c, view)
		if parent != null and not scrolled and not parent.get_global_rect().grow(1.0).encloses(cr):
			out.append("%s overflows its container %s: %s in %s" % [_path(view, c), _path(view, parent), cr, parent.get_global_rect()])
		if not scrolled and not safe.grow(1.0).encloses(cr):
			out.append("%s is outside the panel's safe rect: %s in %s" % [_path(view, c), cr, safe])
		if _is_leaf(c) and not scrolled:
			leaves.append(c)
			_leaf(c, view, safe, kind, out)
		_walk(c, view, safe, kind, out, leaves)


static func _leaf(c: Control, view: Control, safe: Rect2, kind: String, out: PackedStringArray) -> void:
	var cr := c.get_global_rect()
	# Comfortable margins: never within GUTTER of the safe edges (a strip's panel spans the width,
	# so only its sides are held to it).
	var g := PKeyUiView.GUTTER - 1.0
	var tight := cr.position.x - safe.position.x < g or safe.end.x - cr.end.x < g
	if kind == "full":
		tight = tight or cr.position.y - safe.position.y < g or safe.end.y - cr.end.y < g
	if tight:
		out.append("%s is within %d px of the edge: %s in %s" % [_path(view, c), PKeyUiView.GUTTER, cr, safe])
	if c is Label:
		var l := c as Label
		if l.text != "" and l.get_visible_line_count() < l.get_line_count():
			out.append("%s clips its text (%d of %d lines)" % [_path(view, c), l.get_visible_line_count(), l.get_line_count()])
		# A word never breaks across lines (a label squeezed to a sliver wraps a letter per line).
		if l.text != "" and l.autowrap_mode == TextServer.AUTOWRAP_WORD_SMART and l.size.x > 0.0:
			for word in l.text.split(" ", false):
				# (Unspaced Japanese and Chinese break between any two characters, by design.)
				if word.unicode_at(word.length() - 1) >= 0x2E80 or word.unicode_at(0) >= 0x2E80:
					continue
				if PKeyUiView.text_width(l, word) > l.size.x + 1.0:
					out.append("%s breaks the word \"%s\" across lines (%.0f px wide)" % [_path(view, c), word, l.size.x])
					break
		if l.text != "" and l.autowrap_mode == TextServer.AUTOWRAP_OFF:
			var w := PKeyUiView.text_width(l, l.text)
			if w > l.size.x + 1.0:
				out.append("%s is wider than its rect (%.0f > %.0f)" % [_path(view, c), w, l.size.x])
	if c is PKeyQrRect and (c as PKeyQrRect).texture != null:
		var m := (view as PKeyUiView).layout_metrics()
		# Never on a phone (it opens the browser itself): only where the device cannot browse, or
		# the player holds another one.
		if (view as PKeyUiView).is_phone_device():
			out.append("%s shows a QR code on a phone" % _path(view, c))
		var side := minf(c.size.x, c.size.y)
		var phys := side * float(m["physical"])
		if phys < PKeyUiView.QR_MIN_PHYSICAL - 0.5:
			out.append("%s is %.0f physical px, under %d" % [_path(view, c), phys, PKeyUiView.QR_MIN_PHYSICAL])
		var screen: Vector2 = m["screen"]
		var most := maxf(PKeyUiView.QR_MAX_SHARE * minf(screen.x, screen.y), PKeyUiView.QR_MIN_PHYSICAL / float(m["physical"]))
		if side > most + 1.0:
			out.append("%s is %.0f px, over %.0f (%d%% of the screen's shorter side)" % [_path(view, c), side, most, roundi(PKeyUiView.QR_MAX_SHARE * 100)])


static func _is_leaf(c: Control) -> bool:
	return c is Label or c is BaseButton or c is LineEdit or c is TextEdit or c is TextureRect or c is Range


static func _in_scroll(c: Node, view: Node) -> bool:
	var n := c.get_parent()
	while n != null and n != view.get_parent():
		# A scroll area that passes its content through holds it to every check.
		if n is ScrollContainer and (n as ScrollContainer).vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED:
			return true
		n = n.get_parent()
	return false


static func _path(view: Node, n: Node) -> String:
	return String(view.get_path_to(n))
