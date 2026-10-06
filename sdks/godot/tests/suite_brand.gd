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
	t.check("every section has an accent", Brand.SERVICE_IDS.size() == 8 and Brand.SERVICE_IDS.has("sync") and Brand.has_section_bit("sync"))
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
	_accent(t)
	_kit(t)
	return true


# ── The accent resolver and the kit tokens (UI-KITS.md §2.1, §3.3) ───────────────────────────

const VECTORS_PATH := "res://tests/brand/accent-vectors.json"


func _accent(t: PKeyTestContext) -> void:
	var text := FileAccess.get_file_as_string(VECTORS_PATH)
	var vectors: Variant = JSON.parse_string(text)
	t.check("accent: the shared vectors load", vectors is Dictionary, VECTORS_PATH)
	if not vectors is Dictionary:
		return
	t.check("accent: surfaces (dark) are the palette's", PKeyAccent.surfaces(true) == vectors["surfaces"]["dark"], str(PKeyAccent.surfaces(true)))
	t.check("accent: surfaces (light) are the palette's", PKeyAccent.surfaces(false) == vectors["surfaces"]["light"], str(PKeyAccent.surfaces(false)))
	for v in vectors["derive"]:
		var bytes := PackedByteArray()
		for run in v["pixels"]:
			for _i in int(run[4]):
				bytes.append_array(PackedByteArray([int(run[0]), int(run[1]), int(run[2]), int(run[3])]))
		var want: String = v["expect"] if v["expect"] != null else ""
		var got := PKeyAccent.derive(bytes)
		t.check("accent: derive %s" % v["name"], got == want, "%s != %s" % [got, want])
	var ons := {}
	for v in vectors["resolve"]:
		var dark: bool = v["scheme"] == "dark"
		var got := PKeyAccent.resolve(v["input"], dark)
		var want: Dictionary = v["expect"]
		var same := true
		for key in ["solid", "on", "fg", "subtle", "focus"]:
			same = same and got.get(key, "") == want[key]
		t.check("accent: resolve %s (%s)" % [v["name"], v["scheme"]], same, "%s != %s" % [str(got), str(want)])
		var seen: Array = ons.get(v["name"], [])
		if not seen.has(got.get("on", "")):
			seen.append(got.get("on", ""))
		ons[v["name"]] = seen
	for name in ons:
		t.check("accent: on is the same in both schemes (%s)" % name, (ons[name] as Array).size() == 1)
	for v in vectors["danger"]:
		var got := PKeyAccent.solid(v["input"], v["scheme"] == "dark", true)
		t.check("accent: danger solid (%s)" % v["scheme"], got == v["expect"], got)
	t.check("accent: an invalid colour resolves to nothing", PKeyAccent.resolve("teal", true).is_empty())


func _kit(t: PKeyTestContext) -> void:
	t.check("kit: control height", PKeyKitTokens.CONTROL_HEIGHT == 60.0)
	t.check("kit: control radius", PKeyKitTokens.RADIUS_CONTROL == 16.0)
	t.check("kit: panel radius", PKeyKitTokens.RADIUS_PANEL == 28.0)
	t.check("kit: card padding", PKeyKitTokens.CARD_PAD == 44.0)
	t.check("kit: focus ring with glow", PKeyKitTokens.FOCUS_WIDTH == 3.0 and PKeyKitTokens.FOCUS_OFFSET == 2.0 and PKeyKitTokens.FOCUS_GLOW > 0.0)
	t.check("kit: code type", PKeyKitTokens.TYPE_CODE["size"] == 52.0 and PKeyKitTokens.TYPE_CODE["weight"] == 600 and PKeyKitTokens.TYPE_CODE["mono"])
	for role in [PKeyKitTokens.TYPE_DISPLAY, PKeyKitTokens.TYPE_TITLE, PKeyKitTokens.TYPE_BODY, PKeyKitTokens.TYPE_LABEL, PKeyKitTokens.TYPE_META]:
		t.check("kit: weights are 400, 500 or 600", [400, 500, 600].has(role["weight"]))
	t.check("kit: concentric rule", PKeyKitTokens.concentric_radius(28.0, 8.0) == 20.0 and PKeyKitTokens.concentric_radius(10.0, 6.0) == 8.0)
	t.check("kit: danger solid keeps white", PKeyAccent.contrast("#" + PKeyKitTokens.DANGER_SOLID_DARK.to_html(false), "#ffffff") >= 4.5)
	t.check("kit: step motion", PKeyKitTokens.MOTION_STEP_MS == 220)
	# The engine control icons rasterise.
	for name in PKeyKitIcons.names():
		var img := Image.new()
		var err := img.load_svg_from_string(PKeyKitIcons.svg(name, Color.WHITE, Color("#ff6a3d"), Color("#333333")), 2.0)
		t.check("kit: icon %s rasterises" % name, err == OK and img.get_width() > 0, error_string(err))
	t.check("kit: icon placeholders are all filled", not PKeyKitIcons.svg("toggle_on", Color.WHITE).contains("{"))
	# The variable fonts load as MSDF FontFiles with a weight axis.
	for path in [PKeyKitTokens.RUBIK_VARIABLE_PATH, PKeyKitTokens.JETBRAINS_MONO_VARIABLE_PATH]:
		var font := load(path) as FontFile
		t.check("kit: %s loads" % path.get_file(), font != null)
		if font == null:
			continue
		t.check("kit: %s is MSDF" % path.get_file(), font.multichannel_signed_distance_field)
		var axes := font.get_supported_variation_list()
		t.check("kit: %s has a weight axis" % path.get_file(), axes.has(TextServerManager.get_primary_interface().name_to_tag("weight")), str(axes))
	# Each font's licence travels with it (SIL OFL 1.1): PKeyExportPlugin adds the .txt files to an
	# export that carries the fonts, so these pass from the exported pack as well as the editor.
	t.check("kit: the JetBrains Mono licence travels with it", FileAccess.get_file_as_string("res://addons/polaris_key/ui/theme/fonts/OFL-JetBrainsMono.txt").contains("JetBrains Mono"))
	t.check("kit: the Rubik licence travels with it", FileAccess.get_file_as_string("res://addons/polaris_key/ui/theme/fonts/OFL.txt").contains("Rubik"))
	t.check("kit: the Rubik notice travels with it", FileAccess.get_file_as_string("res://addons/polaris_key/ui/theme/fonts/FONT-NOTICE.txt").contains("Rubik"))
	for path in [PKeyUiTheme.REGULAR_PATH, PKeyUiTheme.BOLD_PATH, PKeyKitTokens.RUBIK_VARIABLE_PATH, PKeyKitTokens.JETBRAINS_MONO_VARIABLE_PATH]:
		var licences := PKeyUiTheme.font_licences(path)
		t.check("kit: %s names its licence files" % path.get_file(), not licences.is_empty())
		for licence in licences:
			t.check("kit: %s ships beside %s" % [licence.get_file(), path.get_file()], PKeyUiTheme.is_font_licence(licence) and FileAccess.file_exists(licence))
	_kit_matches_generator(t)


## The committed kit tokens are the generator's: they agree with packages/brand/tokens.json when
## the addon sits in the monorepo (skipped in an exported pack or a standalone copy).
func _kit_matches_generator(t: PKeyTestContext) -> void:
	var json_path := ProjectSettings.globalize_path("res://").path_join("../../packages/brand/tokens.json")
	if not FileAccess.file_exists(json_path):
		return
	var root: Variant = JSON.parse_string(FileAccess.get_file_as_string(json_path))
	t.check("kit: tokens.json parses", root is Dictionary)
	if not root is Dictionary:
		return
	var godot: Dictionary = root["kit"]["components"]["godot"]
	t.check("kit: control height is the generator's", PKeyKitTokens.CONTROL_HEIGHT == float(godot["controlHeight"]["default"]))
	t.check("kit: panel radius is the generator's", PKeyKitTokens.RADIUS_PANEL == float(godot["radiusSurface"]["panel"]))
	var danger: Dictionary = root["kit"]["danger"]
	t.check("kit: danger solid is the generator's", "#" + PKeyKitTokens.DANGER_SOLID_DARK.to_html(false) == danger["dark"]["solid"])
	t.check("kit: title type is the generator's", PKeyKitTokens.TYPE_TITLE["size"] == float(root["kit"]["typeScale"]["godot"]["title"]["size"]))


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
	# Errors stay readable (WCAG AA, 4.5:1) on the ground the text colour implies.
	var on_light := PKeyUiTheme.neutral_with(16, Color.BLACK, null, null).get_color("font_color", "PKeyError")
	var on_dark := PKeyUiTheme.neutral_with(16, Color.WHITE, null, null).get_color("font_color", "PKeyError")
	t.check("neutral: error text is 4.5:1 on a light ground", _contrast(on_light, Color.WHITE) >= 4.5, "%.2f:1" % _contrast(on_light, Color.WHITE))
	t.check("neutral: error text is 4.5:1 on a dark ground", _contrast(on_dark, Color("#121212")) >= 4.5, "%.2f:1" % _contrast(on_dark, Color("#121212")))

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

	# PolarisKey.boot() mounts its view first and configures from polaris_key.tres after: the
	# options must still re-theme the mounted view (and its nested gate), not just add the mark.
	PKeyUiTheme.reset()
	var boot: Control = (load("res://addons/polaris_key/ui/boot/pkey_boot.tscn") as PackedScene).instantiate()
	boot.set("auto_sdk", false)
	tree.root.add_child(boot)
	t.check("boot flow: the view starts neutral", PKeyUiTheme.is_stock(boot.theme) and boot.theme.resource_path != PKeyUiTheme.DARK_PATH)
	var late := PKeyOptions.new()
	late.ui_branding = "polaris-key"
	PKeyUiTheme.apply_options(late)
	await tree.process_frame
	t.check("boot flow: apply_options re-themes a mounted view", boot.theme != null and boot.theme.resource_path == PKeyUiTheme.DARK_PATH, str(boot.theme.resource_path if boot.theme else "null"))
	boot.call("refresh_view")
	var bgate: Control = boot.get("gate")
	bgate.call("show_state", {"status": "needs-activation"})
	var title := bgate.find_child("Title", true, false) as Label
	t.check("boot flow: the gate title is in the brand face", title != null and title.get_theme_font("font") == load(PKeyUiTheme.BOLD_PATH))
	t.check("boot flow: the Pinned K on the brand theme", shown.call(bgate, "Mark"))
	PKeyUiTheme.apply_options(PKeyOptions.new())
	await tree.process_frame
	t.check("boot flow: back to neutral when the options say so", PKeyUiTheme.is_stock(boot.theme) and not boot.theme.has_default_font_size() and not shown.call(bgate, "Mark"))
	unmount.call(boot)

	opts.ui_branding = "nonsense"
	opts.ui_theme = null
	PKeyUiTheme.apply_options(opts)
	t.check("options: an unknown branding is neutral", not PKeyUiTheme.branded())
	PKeyUiTheme.reset()
	t.check("reset: neutral, no badge", not PKeyUiTheme.branded() and not PKeyUiTheme.powered_by and PKeyUiTheme.override == null)


## The WCAG contrast ratio of two opaque colours.
static func _contrast(a: Color, b: Color) -> float:
	var la := _rel_luminance(a)
	var lb := _rel_luminance(b)
	return (maxf(la, lb) + 0.05) / (minf(la, lb) + 0.05)


static func _rel_luminance(c: Color) -> float:
	var ch := func(v: float) -> float: return v / 12.92 if v <= 0.04045 else pow((v + 0.055) / 1.055, 2.4)
	return 0.2126 * ch.call(c.r) + 0.7152 * ch.call(c.g) + 0.0722 * ch.call(c.b)


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
