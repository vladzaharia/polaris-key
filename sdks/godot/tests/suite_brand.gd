extends RefCounted
# The generated brand tokens (packages/brand, `pnpm gen:brand`) load in the engine and agree with
# the launch kit: the kit primitives, the optical-cut thresholds, the section-bit rule (no bit on
# core, the accent in a service section, never below 48 px) and the per-section accents.
#
# Then the UI kit's Theme (PKeyUiTheme): the committed pkey_theme.tres and pkey_theme_light.tres are
# exactly what `PKeyUiTheme.build()` makes (regenerate with tools/gen_theme.gd), every colour in them
# is a brand token, nothing is gold, the bundled Rubik loads, every interactive control has the
# violet focus ring, the integrator overrides (scheme, override, an own Theme) reach a scene, and
# the "Powered by" size helper never goes below the kit minimums.
#
#   godot --headless --path sdks/godot -- --pkey-test brand

const Brand := preload("res://addons/polaris_key/ui/theme/brand_tokens_generated.gd")


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	t.check("kit violet (dark)", Brand.KIT_VIOLET_DARK.to_html(false) == "9a5cff", Brand.KIT_VIOLET_DARK.to_html(false))
	t.check("kit violet (light)", Brand.KIT_VIOLET_LIGHT.to_html(false) == "7a2fff")
	t.check("kit gold (dark)", Brand.KIT_GOLD_DARK.to_html(false) == "ffc24d")
	t.check("kit gold (light)", Brand.KIT_GOLD_LIGHT.to_html(false) == "d07a00")
	t.check("dark page is the kit ground", Brand.Dark.SURFACE_PAGE.to_html(false) == "060912")
	t.check("light page is the kit ground", Brand.Light.SURFACE_PAGE.to_html(false) == "f6f8ff")
	t.check("core accent is the kit violet", Brand.service_accent("core", true) == Brand.KIT_VIOLET_DARK)
	t.check("core has no bit", not Brand.has_section_bit("core"))
	t.check("core bit answers transparent", Brand.section_bit("core", true).a == 0.0 and Brand.section_bit("core", false).a == 0.0)
	t.check("unknown section has no bit", not Brand.has_section_bit("nope"))
	t.check("every service section has a bit", Brand.has_section_bit("license") and Brand.has_section_bit("identity"))
	t.check("a service bit is its accent", Brand.section_bit("config", true) == Brand.service_accent("config", true))
	t.check("distribution and update have distinct accents", Brand.service_accent("distribution", false) != Brand.service_accent("update", false))
	t.check("distribution keeps its green", Brand.service_accent("distribution", true).to_html(false) == "39d075")
	t.check("update is tangerine", Brand.service_accent("update", true).to_html(false) == "fe8001")
	t.check("unknown section falls back to core", Brand.service_accent("nope", true) == Brand.KIT_VIOLET_DARK)
	t.check("every section has an accent", Brand.SERVICE_IDS.size() == 7)
	t.check("16 px is the favicon cut", Brand.optical_cut(16) == "favicon")
	t.check("24 px is the service cut", Brand.optical_cut(24) == "service")
	t.check("32 px is the service cut", Brand.optical_cut(32) == "service")
	t.check("33 px is the display cut", Brand.optical_cut(33) == "display")
	t.check("no bit at 47 px", not Brand.bit_visible(47))
	t.check("bit at 48 px", Brand.bit_visible(48))
	t.check("badge minimum (compact)", Brand.BADGE_MIN_COMPACT == Vector2i(232, 88))
	t.check("phrase", Brand.POWERED_BY_PHRASE == "Powered by Polaris Key")
	_theme(t)
	await _overrides(t)
	return true


# ── The UI kit theme ─────────────────────────────────────────────────────────────────────

func _theme(t: PKeyTestContext) -> void:
	var dark := load(PKeyUiTheme.DARK_PATH) as Theme
	var light := load(PKeyUiTheme.LIGHT_PATH) as Theme
	t.check("theme: dark .tres loads", dark != null)
	t.check("theme: light .tres loads", light != null)
	if dark == null or light == null:
		return
	var d1 := _diff(dark, PKeyUiTheme.build(true))
	t.check("theme: pkey_theme.tres is build(true) (run tools/gen_theme.gd)", d1.is_empty(), str(d1.slice(0, 5)))
	var d2 := _diff(light, PKeyUiTheme.build(false))
	t.check("theme: pkey_theme_light.tres is build(false) (run tools/gen_theme.gd)", d2.is_empty(), str(d2.slice(0, 5)))

	var regular := load(PKeyUiTheme.REGULAR_PATH) as FontFile
	var bold := load(PKeyUiTheme.BOLD_PATH) as FontFile
	t.check("font: Rubik Regular loads", regular != null and regular.get_font_name() == "Rubik" and regular.get_font_style() & TextServer.FONT_BOLD == 0)
	t.check("font: Rubik Bold loads", bold != null and bold.get_font_name() == "Rubik" and bold.get_font_style() & TextServer.FONT_BOLD != 0)
	t.check("font: Rubik measures text", regular != null and regular.get_string_size("Polaris Key", HORIZONTAL_ALIGNMENT_LEFT, -1, 18).x > 50.0)
	t.check("font: the theme's body face is Rubik Regular", dark.default_font == regular and light.default_font == regular)
	t.check("font: titles and codes are Rubik Bold", dark.get_font("font", "PKeyTitle") == bold and dark.get_font("font", "PKeyCode") == bold)
	if OS.has_feature("editor"):
		# Non-resource files are not in an exported pack; the addon zip carries them.
		var ofl := FileAccess.get_file_as_string("res://addons/polaris_key/ui/theme/fonts/OFL.txt")
		t.check("font: the OFL travels with the fonts", ofl.contains("SIL Open Font License") and ofl.contains("Rubik"))
	var plain := PKeyUiTheme.build_with(true, Color(0, 0, 0, 0), null, null)
	t.check("font: build_with(null fonts) keeps the engine default", plain.default_font == null and not plain.has_font("font", "PKeyTitle"))

	for pair in [[dark, true], [light, false]]:
		var th: Theme = pair[0]
		var which := "dark" if pair[1] else "light"
		var tokens := _tokens(pair[1])
		var stray := []
		for c in _colors(th):
			if not tokens.any(func(k): return k.is_equal_approx(c)):
				stray.append(c.to_html(false))
		t.check("theme (%s): every colour is a brand token" % which, stray.is_empty(), str(stray))
		var gold := []
		for c in _colors(th):
			for g in [Brand.KIT_GOLD_DARK, Brand.KIT_GOLD_LIGHT, Brand.Dark.SIGNED, Brand.Light.SIGNED, Brand.Light.SIGNED_MARK]:
				if c.is_equal_approx(g):
					gold.append(c.to_html(false))
		t.check("theme (%s): no gold (gold means signed)" % which, gold.is_empty(), str(gold))
		var page: Color = (th.get_stylebox("panel", "PanelContainer") as StyleBoxFlat).bg_color
		t.check("theme (%s): the ground is the kit page" % which, page.is_equal_approx(Brand.Dark.SURFACE_PAGE if pair[1] else Brand.Light.SURFACE_PAGE))
		var primary: Color = (th.get_stylebox("normal", "PKeyPrimary") as StyleBoxFlat).bg_color
		t.check("theme (%s): the primary action is the platform violet" % which, primary.is_equal_approx(Brand.service_accent("core", pair[1])))
		var focus := Brand.Dark.FOCUS if pair[1] else Brand.Light.FOCUS
		var unringed := []
		for type in ["Button", "CheckButton", "CheckBox", "OptionButton", "LineEdit", "TextEdit"]:
			var ring := th.get_stylebox("focus", type) as StyleBoxFlat
			if ring == null or ring.draw_center or not ring.border_color.is_equal_approx(focus) or ring.border_width_top != 2 or ring.expand_margin_top < 4.0:
				unringed.append(type)
		t.check("theme (%s): 2 px violet focus ring with a gap on every control" % which, unringed.is_empty(), str(unringed))
		var qr_dark := th.get_color("dark", "PKeyQrRect")
		t.check("theme (%s): QR stays black on white" % which, qr_dark == Color.BLACK and th.get_color("light", "PKeyQrRect") == Color.WHITE)
		var missing := []
		for v in PKeyUiTheme.VARIATIONS:
			if th.get_type_variation_base(v) != StringName(PKeyUiTheme.VARIATIONS[v]):
				missing.append(v)
		t.check("theme (%s): every type variation the scenes use" % which, missing.is_empty(), str(missing))

	var green := PKeyUiTheme.build(true, Brand.service_accent("distribution", true))
	var gp := green.get_stylebox("normal", "PKeyPrimary") as StyleBoxFlat
	t.check("theme: an integrator accent colours the primary action", gp.bg_color == Brand.service_accent("distribution", true))
	t.check("theme: text on a bright accent is the page ink", green.get_color("font_color", "PKeyPrimary") == Brand.Dark.TEXT_ON_ACCENT)
	var deep := PKeyUiTheme.build(false, Color("#05773b"))
	t.check("theme: text on a deep accent is white", deep.get_color("font_color", "PKeyPrimary") == Color.WHITE)

	t.check("powered by: compact minimum", PKeyUiTheme.powered_by_size("compact") == Vector2(232, 88))
	t.check("powered by: a smaller request is raised", PKeyUiTheme.powered_by_size("compact", Vector2(100, 40)) == Vector2(232, 88))
	t.check("powered by: horizontal minimum", PKeyUiTheme.powered_by_size("horizontal", Vector2(10, 10)) == Vector2(376, 144))
	t.check("powered by: stacked minimum", PKeyUiTheme.powered_by_size("stacked") == Vector2(288, 336))
	t.check("powered by: larger keeps the proportions", PKeyUiTheme.powered_by_size("compact", Vector2(464, 0)) == Vector2(464, 176))


func _overrides(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var scene := load("res://addons/polaris_key/ui/banner/pkey_status_banner.tscn") as PackedScene
	var mount := func() -> Control:
		var v: Control = scene.instantiate()
		v.set("auto_sdk", false)
		tree.root.add_child(v)
		return v
	var unmount := func(v: Control) -> void:
		tree.root.remove_child(v)
		v.free()

	var v: Control = mount.call()
	t.check("override: a scene file starts on the dark kit theme", v.theme != null and v.theme.resource_path == PKeyUiTheme.DARK_PATH)
	unmount.call(v)

	PKeyUiTheme.scheme = "light"
	v = mount.call()
	t.check("override: scheme = light gives the light kit theme", v.theme != null and v.theme.resource_path == PKeyUiTheme.LIGHT_PATH)
	unmount.call(v)
	PKeyUiTheme.scheme = "dark"

	var own := PKeyUiTheme.build(true, Brand.service_accent("release", true))
	PKeyUiTheme.override = own
	v = mount.call()
	t.check("override: an override Theme reaches a stock scene", v.theme == own)
	unmount.call(v)

	var mine := Theme.new()
	v = scene.instantiate()
	v.set("auto_sdk", false)
	v.theme = mine
	tree.root.add_child(v)
	t.check("override: a scene given its own Theme keeps it", v.theme == mine)
	unmount.call(v)
	PKeyUiTheme.override = null
	t.check("override: current() is the dark kit theme by default", PKeyUiTheme.current().resource_path == PKeyUiTheme.DARK_PATH)


## Every brand colour a theme may use, for one theme (plus the QR's black and white).
static func _tokens(dark: bool) -> Array:
	var out: Array = [Color.BLACK, Color.WHITE]
	var p := PKeyUiTheme.palette(dark)
	for k in p:
		out.append(p[k])
	return out


## Every colour in a theme: its colour items and its StyleBoxFlat fills and borders.
static func _colors(th: Theme) -> Array:
	var out: Array = []
	for type in th.get_type_list():
		for n in th.get_color_list(type):
			out.append(th.get_color(n, type))
		for n in th.get_stylebox_list(type):
			var sb := th.get_stylebox(n, type) as StyleBoxFlat
			if sb != null:
				if sb.draw_center:
					out.append(sb.bg_color)
				if sb.border_width_top > 0:
					out.append(sb.border_color)
	return out


## The differences between a committed theme and a built one, as readable strings.
static func _diff(a: Theme, b: Theme) -> Array:
	var out: Array = []
	if a.default_font_size != b.default_font_size:
		out.append("default_font_size")
	if _font_path(a.default_font) != _font_path(b.default_font):
		out.append("default_font")
	var types := {}
	for type in a.get_type_list() + b.get_type_list():
		types[type] = true
	for type in types:
		if a.get_type_variation_base(type) != b.get_type_variation_base(type):
			out.append("%s base" % type)
		for kind in [Theme.DATA_TYPE_COLOR, Theme.DATA_TYPE_CONSTANT, Theme.DATA_TYPE_FONT, Theme.DATA_TYPE_FONT_SIZE, Theme.DATA_TYPE_STYLEBOX]:
			var names := {}
			for n in a.get_theme_item_list(kind, type) + b.get_theme_item_list(kind, type):
				names[n] = true
			for n in names:
				if not a.has_theme_item(kind, n, type) or not b.has_theme_item(kind, n, type):
					out.append("%s/%s missing" % [type, n])
					continue
				var x = a.get_theme_item(kind, n, type)
				var y = b.get_theme_item(kind, n, type)
				var same := true
				match kind:
					Theme.DATA_TYPE_COLOR:
						same = (x as Color).is_equal_approx(y)
					Theme.DATA_TYPE_FONT:
						same = _font_path(x) == _font_path(y)
					Theme.DATA_TYPE_STYLEBOX:
						same = _box_key(x) == _box_key(y)
					_:
						same = x == y
				if not same:
					out.append("%s/%s" % [type, n])
	return out


static func _font_path(f: Font) -> String:
	return "" if f == null else f.resource_path


static func _box_key(sb: StyleBox) -> String:
	var f := sb as StyleBoxFlat
	if f == null:
		return sb.get_class()
	var parts: Array = [f.draw_center, f.bg_color.to_html(), f.border_color.to_html()]
	for side in [SIDE_LEFT, SIDE_TOP, SIDE_RIGHT, SIDE_BOTTOM]:
		parts.append_array([f.get_border_width(side), f.get_content_margin(side), f.get_expand_margin(side)])
	for corner in [CORNER_TOP_LEFT, CORNER_TOP_RIGHT, CORNER_BOTTOM_RIGHT, CORNER_BOTTOM_LEFT]:
		parts.append(f.get_corner_radius(corner))
	return str(parts)
