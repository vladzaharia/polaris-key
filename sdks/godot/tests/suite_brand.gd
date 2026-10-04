extends RefCounted
# The generated brand tokens (packages/brand, `pnpm gen:brand`) load in the engine and agree with
# the launch kit: the kit primitives, the optical-cut thresholds, the section-bit rule (no bit on
# core, the accent in a service section, never below 48 px) and the per-section accents.
#
# Then the UI kit's look (PKeyUiTheme): the committed themes match their builders (regenerate
# with tools/gen_theme.gd); the default is neutral (no brand colour, font or mark, no built-in
# control restyled, sizes from the project's font); the opt-in Polaris Key theme uses only brand
# tokens, never gold, Rubik, one control radius and the violet focus ring; PKeyOptions' ui_*
# options reach a scene (branding, scheme, accent, an own Theme, the Powered-by badge, off by
# default); the Pinned K has no bit; the badge never goes below the kit minimums.
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
	PKeyUiTheme.reset()
	var neutral := load(PKeyUiTheme.NEUTRAL_PATH) as Theme
	var dark := load(PKeyUiTheme.DARK_PATH) as Theme
	var light := load(PKeyUiTheme.LIGHT_PATH) as Theme
	t.check("theme: neutral .tres loads", neutral != null)
	t.check("theme: brand dark .tres loads", dark != null)
	t.check("theme: brand light .tres loads", light != null)
	if neutral == null or dark == null or light == null:
		return
	var d0 := _diff(neutral, PKeyUiTheme.neutral_default())
	t.check("theme: pkey_theme.tres is neutral_default() (run tools/gen_theme.gd)", d0.is_empty(), str(d0.slice(0, 5)))
	var d1 := _diff(dark, PKeyUiTheme.build(true))
	t.check("theme: pkey_brand_dark.tres is build(true) (run tools/gen_theme.gd)", d1.is_empty(), str(d1.slice(0, 5)))
	var d2 := _diff(light, PKeyUiTheme.build(false))
	t.check("theme: pkey_brand_light.tres is build(false) (run tools/gen_theme.gd)", d2.is_empty(), str(d2.slice(0, 5)))
	t.check("theme: every kit theme is marked stock", PKeyUiTheme.is_stock(neutral) and PKeyUiTheme.is_stock(dark) and PKeyUiTheme.is_stock(light) and not PKeyUiTheme.is_stock(Theme.new()))

	# Neutral: no Polaris Key branding; the game's theme and font show through.
	var n := PKeyUiTheme.current()
	t.check("neutral: the default look is neutral", not PKeyUiTheme.branded() and n != dark and n != light)
	t.check("neutral: no font of its own (the project's font applies)", n.default_font == null and not n.has_default_font_size())
	var styled_base := []
	for type in ["Button", "Label", "LineEdit", "TextEdit", "PanelContainer", "OptionButton", "CheckButton", "ProgressBar"]:
		if n.get_color_list(type).size() + n.get_stylebox_list(type).size() + n.get_font_list(type).size() > 0:
			styled_base.append(type)
	t.check("neutral: no built-in control is restyled", styled_base.is_empty(), str(styled_base))
	var brand_colours := []
	for c in _colors(n):
		for k in [Brand.KIT_VIOLET_DARK, Brand.KIT_VIOLET_LIGHT, Brand.Dark.SURFACE_PAGE, Brand.Light.SURFACE_PAGE, Brand.KIT_GOLD_DARK]:
			if c.is_equal_approx(k):
				brand_colours.append(c.to_html(false))
	t.check("neutral: no brand colour", brand_colours.is_empty(), str(brand_colours))
	var base := ThemeDB.fallback_font_size
	t.check("neutral: a type hierarchy from the project's size", n.get_font_size("font_size", "PKeyTitle") > base and n.get_font_size("font_size", "PKeyCode") > n.get_font_size("font_size", "PKeyTitle") and n.get_font_size("font_size", "PKeyMuted") < base)
	t.check("neutral: titles in a bold face of the project's font", n.get_font("font", "PKeyTitle") is FontVariation)
	var big := PKeyUiTheme.neutral_with(24, Color.BLACK, null, null)
	t.check("neutral: sizes scale with the project's font size", big.get_font_size("font_size", "PKeyTitle") == 36)
	var card := n.get_stylebox("panel", "PKeyCard")
	t.check("neutral: cards are padded", card != null and card.get_margin(SIDE_LEFT) >= base)

	var regular := load(PKeyUiTheme.REGULAR_PATH) as FontFile
	var bold := load(PKeyUiTheme.BOLD_PATH) as FontFile
	t.check("font: Rubik Regular loads", regular != null and regular.get_font_name() == "Rubik" and regular.get_font_style() & TextServer.FONT_BOLD == 0)
	t.check("font: Rubik Bold loads", bold != null and bold.get_font_name() == "Rubik" and bold.get_font_style() & TextServer.FONT_BOLD != 0)
	t.check("font: Rubik measures text", regular != null and regular.get_string_size("Polaris Key", HORIZONTAL_ALIGNMENT_LEFT, -1, 18).x > 50.0)
	t.check("font: the brand's body face is Rubik Regular", dark.default_font == regular and light.default_font == regular)
	t.check("font: brand titles and codes are Rubik Bold", dark.get_font("font", "PKeyTitle") == bold and dark.get_font("font", "PKeyCode") == bold)
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
		t.check("brand (%s): every colour is a brand token" % which, stray.is_empty(), str(stray))
		var gold := []
		for c in _colors(th):
			for g in [Brand.KIT_GOLD_DARK, Brand.KIT_GOLD_LIGHT, Brand.Dark.SIGNED, Brand.Light.SIGNED, Brand.Light.SIGNED_MARK]:
				if c.is_equal_approx(g):
					gold.append(c.to_html(false))
		t.check("brand (%s): no gold (gold means signed)" % which, gold.is_empty(), str(gold))
		var page: Color = (th.get_stylebox("panel", "PanelContainer") as StyleBoxFlat).bg_color
		t.check("brand (%s): the ground is the kit page" % which, page.is_equal_approx(Brand.Dark.SURFACE_PAGE if pair[1] else Brand.Light.SURFACE_PAGE))
		var primary: Color = (th.get_stylebox("normal", "PKeyPrimary") as StyleBoxFlat).bg_color
		t.check("brand (%s): the primary action is the platform violet" % which, primary.is_equal_approx(Brand.service_accent("core", pair[1])))
		var focus := Brand.Dark.FOCUS if pair[1] else Brand.Light.FOCUS
		var unringed := []
		for type in ["Button", "CheckButton", "CheckBox", "OptionButton", "LineEdit", "TextEdit"]:
			var ring := th.get_stylebox("focus", type) as StyleBoxFlat
			if ring == null or ring.draw_center or not ring.border_color.is_equal_approx(focus) or ring.border_width_top != 2 or ring.expand_margin_top < 4.0:
				unringed.append(type)
		t.check("brand (%s): 2 px violet focus ring with a gap on every control" % which, unringed.is_empty(), str(unringed))
		var radii := []
		for type in ["Button", "OptionButton", "LineEdit", "TextEdit", "PKeyPrimary"]:
			var sb := th.get_stylebox("normal", type) as StyleBoxFlat
			if sb == null or sb.corner_radius_top_left != PKeyUiTheme.RADIUS_CONTROL:
				radii.append(type)
		t.check("brand (%s): controls share one corner radius" % which, radii.is_empty(), str(radii))
		t.check("brand (%s): QR stays black on white" % which, th.get_color("dark", "PKeyQrRect") == Color.BLACK and th.get_color("light", "PKeyQrRect") == Color.WHITE)

	for th in [neutral, dark, light]:
		var missing := []
		for v in PKeyUiTheme.VARIATIONS:
			if th.get_type_variation_base(v) != StringName(PKeyUiTheme.VARIATIONS[v]):
				missing.append(v)
		t.check("theme %s: every type variation the scenes use" % th.resource_path.get_file(), missing.is_empty(), str(missing))

	var green := PKeyUiTheme.build(true, Brand.service_accent("distribution", true))
	var gp := green.get_stylebox("normal", "PKeyPrimary") as StyleBoxFlat
	t.check("brand: an integrator accent colours the primary action", gp.bg_color == Brand.service_accent("distribution", true))
	t.check("brand: text on a bright accent is the page ink", green.get_color("font_color", "PKeyPrimary") == Brand.Dark.TEXT_ON_ACCENT)
	var deep := PKeyUiTheme.build(false, Color("#05773b"))
	t.check("brand: text on a deep accent is white", deep.get_color("font_color", "PKeyPrimary") == Color.WHITE)

	var mark := PKeyUiTheme.mark_texture(true)
	t.check("mark: the Pinned K rasterises", mark != null and mark.get_width() == 2 * PKeyUiTheme.MARK_SIZE)
	t.check("mark: the Pinned K carries no terminal bit", not PKeyBrandMarks.PINNED_K_DARK.to_lower().contains("#ffc24d") and not PKeyBrandMarks.PINNED_K_LIGHT.to_lower().contains("#d07a00"))
	var badge := PKeyUiTheme.powered_by_texture(false)
	t.check("powered by: the compact badge rasterises at 2x its minimum", badge != null and badge.get_width() == 2 * PKeyBrand.BADGE_MIN_COMPACT.x)
	t.check("powered by: compact minimum", PKeyUiTheme.powered_by_size("compact") == Vector2(232, 88))
	t.check("powered by: a smaller request is raised", PKeyUiTheme.powered_by_size("compact", Vector2(100, 40)) == Vector2(232, 88))
	t.check("powered by: horizontal minimum", PKeyUiTheme.powered_by_size("horizontal", Vector2(10, 10)) == Vector2(376, 144))
	t.check("powered by: stacked minimum", PKeyUiTheme.powered_by_size("stacked") == Vector2(288, 336))
	t.check("powered by: larger keeps the proportions", PKeyUiTheme.powered_by_size("compact", Vector2(464, 0)) == Vector2(464, 176))


func _overrides(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var gate_scene := load("res://addons/polaris_key/ui/gate/pkey_gate.tscn") as PackedScene
	var mount := func() -> Control:
		var v: Control = gate_scene.instantiate()
		v.set("auto_sdk", false)
		tree.root.add_child(v)
		v.call("show_state", {"status": "expired"})
		return v
	var unmount := func(v: Control) -> void:
		tree.root.remove_child(v)
		v.free()
	var shown := func(v: Control, n: String) -> bool:
		var r := v.find_child(n, true, false) as TextureRect
		return r != null and r.visible and r.texture != null

	PKeyUiTheme.reset()
	var v: Control = mount.call()
	t.check("default: a scene file starts on the neutral theme", PKeyUiTheme.is_stock(v.theme) and v.theme == PKeyUiTheme.for_view(v) and not PKeyUiTheme.branded())
	t.check("default: no Pinned K", not shown.call(v, "Mark"))
	t.check("default: no Powered by badge", not shown.call(v, "PoweredBy"))
	unmount.call(v)

	# Inside a game's own themed menu, the neutral look follows that menu's theme.
	var host := Control.new()
	var host_theme := Theme.new()
	host_theme.default_font_size = 24
	host_theme.set_color("font_color", "Label", Color(0.1, 0.2, 0.3))
	host.theme = host_theme
	tree.root.add_child(host)
	var hv: Control = gate_scene.instantiate()
	hv.set("auto_sdk", false)
	host.add_child(hv)
	t.check("neutral: follows an ancestor's font size", hv.theme.get_font_size("font_size", "PKeyTitle") == 36)
	var muted := hv.theme.get_color("font_color", "PKeyMuted")
	t.check("neutral: muted text derives from an ancestor's text colour", is_equal_approx(muted.r, 0.1) and is_equal_approx(muted.b, 0.3) and muted.a < 1.0)
	tree.root.remove_child(host)
	host.free()

	var opts := PKeyOptions.new()
	t.check("options: branding is off by default", opts.ui_branding == "none" and not opts.ui_powered_by and opts.ui_theme == null)
	opts.ui_branding = "polaris-key"
	PKeyUiTheme.apply_options(opts)
	v = mount.call()
	t.check("brand: one option gives the Polaris Key dark theme", v.theme != null and v.theme.resource_path == PKeyUiTheme.DARK_PATH)
	t.check("brand: the Pinned K is shown", shown.call(v, "Mark"))
	t.check("brand: still no Powered by badge unless asked", not shown.call(v, "PoweredBy"))
	unmount.call(v)

	opts.ui_brand_scheme = "light"
	opts.ui_powered_by = true
	PKeyUiTheme.apply_options(opts)
	v = mount.call()
	t.check("brand: ui_brand_scheme light gives the light theme", v.theme != null and v.theme.resource_path == PKeyUiTheme.LIGHT_PATH)
	t.check("powered by: shown when asked", shown.call(v, "PoweredBy"))
	var badge := v.find_child("PoweredBy", true, false) as Control
	t.check("powered by: never below the kit minimum", badge != null and badge.custom_minimum_size.x >= 232 and badge.custom_minimum_size.y >= 88)
	unmount.call(v)

	opts.ui_accent = Brand.service_accent("release", false)
	PKeyUiTheme.apply_options(opts)
	t.check("brand: ui_accent colours the primary action", (PKeyUiTheme.current().get_stylebox("normal", "PKeyPrimary") as StyleBoxFlat).bg_color == opts.ui_accent)

	var own := Theme.new()
	opts.ui_theme = own
	PKeyUiTheme.apply_options(opts)
	v = mount.call()
	t.check("override: ui_theme reaches a stock scene", v.theme == own)
	t.check("override: an own Theme drops the Pinned K", not shown.call(v, "Mark"))
	unmount.call(v)

	var mine := Theme.new()
	v = gate_scene.instantiate()
	v.set("auto_sdk", false)
	v.theme = mine
	tree.root.add_child(v)
	t.check("override: a scene given its own Theme keeps it", v.theme == mine)
	unmount.call(v)

	opts.ui_branding = "nonsense"
	opts.ui_theme = null
	PKeyUiTheme.apply_options(opts)
	t.check("options: an unknown branding is neutral", not PKeyUiTheme.branded())
	PKeyUiTheme.reset()
	t.check("reset: neutral, no badge", not PKeyUiTheme.branded() and not PKeyUiTheme.powered_by and PKeyUiTheme.override == null)


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
