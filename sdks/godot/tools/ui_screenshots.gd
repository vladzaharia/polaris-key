extends SceneTree
## Renders the UI kit for review (headless runs have no renderer, so the `ui` suite pins
## structure and layout, not pixels). Needs a display; run it from the editor binary, not
## headless:
##
##   godot --path sdks/godot --script tools/ui_screenshots.gd -- <dir> [look] [all]
##
## `look` is one of:
##   neutral        the default: no Polaris Key branding, the engine's default theme as the game's
##   neutral-light  the default inside a light game theme (a host Control with a light Theme)
##   brand-dark     ui_branding = "polaris-key" (with the Powered-by badge on)
##   brand-light    the same, ui_brand_scheme = "light"
##
## Every scene's first visible state is shot at each size in SIZES (the 4K one through the
## canvas_items stretch, as a game would run it); with `all`, every pinned state
## (tests/ui/scenarios.gd) is also shot at 1280x720. Output: <dir>/<look>/<size>/<scene>__<state>.png.

const SCENARIOS := preload("res://tests/ui/scenarios.gd")
## [label, viewport size, canvas_items scale]
const SIZES := [
	["1280x720", Vector2i(1280, 720), 1.0],
	["1920x1080", Vector2i(1920, 1080), 1.0],
	["3840x2160-canvas_items", Vector2i(3840, 2160), 2.0],
	["720x1280-portrait", Vector2i(720, 1280), 1.0],
	["480x854-portrait", Vector2i(480, 854), 1.0],
]


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var out := args[0] if args.size() > 0 else "user://pkey-ui-shots"
	var look := args[1] if args.size() > 1 else "neutral"
	var every := args.has("all")
	var sc = SCENARIOS.new()
	var all: Array = sc.all()
	var n := 0
	var done := {}
	# Representative states first, so each scene's multi-size set shows its main screen.
	var preferred := ["needs-activation", "pending", "catalog", "waiting needs-activation", "two grants"]
	all.sort_custom(func(a, b): return int(String(a[1]) in preferred) > int(String(b[1]) in preferred))
	for c in all:
		var first := not done.has(c[0])
		var sizes: Array = SIZES if first else ([SIZES[0]] if every else [])
		for s in sizes:
			var shot := await _shot(c, look, s[1], s[2])
			if shot == null:
				continue
			if first:
				done[c[0]] = true
			var dir := "%s/%s/%s" % [out, look, s[0]]
			DirAccess.make_dir_recursive_absolute(dir)
			shot.save_png("%s/%s__%s.png" % [dir, c[0], String(c[1]).validate_filename().replace(" ", "_")])
			n += 1
	print("ui_screenshots: %d PNGs in %s" % [n, ProjectSettings.globalize_path(out)])
	quit()


## One state in a SubViewport of `size`, as the game would place the scene; null when the
## scene shows nothing in this state.
func _shot(c: Array, look: String, size: Vector2i, scale: float) -> Image:
	var vp := SubViewport.new()
	vp.size = size
	vp.size_2d_override = Vector2i(Vector2(size) / scale)
	vp.size_2d_override_stretch = scale != 1.0
	vp.transparent_bg = false
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(vp)
	var host := Control.new()
	host.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var ground := ColorRect.new()
	ground.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	ground.color = _ground(look)
	host.add_child(ground)
	if look == "neutral-light":
		host.theme = _light_game_theme()
	vp.add_child(host)
	var v: Control = await c[2].call()
	if not v.visible:
		v.get_parent().remove_child(v)
		v.queue_free()
		vp.queue_free()
		return null
	v.get_parent().remove_child(v)
	# A scenario configures a fake SDK, and configure() applies its (default) ui_* options.
	_apply_look(look)
	v.theme = load(PKeyUiTheme.NEUTRAL_PATH)
	host.add_child(v)
	# The scene re-resolves its stock theme for its new place, as it would in a game.
	v._ready()
	match c[0]:
		"banner", "update_prompt":
			v.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
		"badge":
			v.set_anchors_and_offsets_preset(Control.PRESET_HCENTER_WIDE)
		_:
			v.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	v.refresh_view()
	for i in 2:
		await process_frame
	if c[0] in ["banner", "update_prompt", "badge"]:
		# A strip asks for its own height only.
		v.offset_bottom = v.offset_top + v.get_combined_minimum_size().y
	for i in 2:
		await process_frame
	await RenderingServer.frame_post_draw
	var img := vp.get_texture().get_image()
	vp.queue_free()
	return img


static func _apply_look(look: String) -> void:
	PKeyUiTheme.reset()
	if look.begins_with("brand"):
		PKeyUiTheme.branding = PKeyUiTheme.BRANDING_POLARIS_KEY
		PKeyUiTheme.scheme = "light" if look == "brand-light" else "dark"
		PKeyUiTheme.powered_by = true


static func _ground(look: String) -> Color:
	match look:
		"brand-dark":
			return PKeyBrand.Dark.SURFACE_PAGE
		"brand-light":
			return PKeyBrand.Light.SURFACE_PAGE
		"neutral-light":
			return Color("#eceff3")
	return Color("#2b2f36")


## A stand-in for a light game theme: light panels and controls, dark text, its own font size.
static func _light_game_theme() -> Theme:
	var t := Theme.new()
	t.default_font_size = 17
	var ink := Color("#1f2430")
	for type in ["Label", "Button", "LineEdit", "TextEdit", "CheckButton", "OptionButton", "CheckBox"]:
		t.set_color("font_color", type, ink)
		t.set_color("font_hover_color", type, ink)
		t.set_color("font_focus_color", type, ink)
		t.set_color("font_pressed_color", type, ink)
	t.set_color("font_placeholder_color", "LineEdit", Color("#6b7280"))
	t.set_stylebox("panel", "PanelContainer", _flat(Color("#ffffff"), Color("#d5d9e0"), 8))
	for type in ["Button", "OptionButton"]:
		t.set_stylebox("normal", type, _flat(Color("#f3f4f6"), Color("#c3c8d1"), 6))
		t.set_stylebox("hover", type, _flat(Color("#e5e7eb"), Color("#9aa1ad"), 6))
		t.set_stylebox("pressed", type, _flat(Color("#d1d5db"), Color("#9aa1ad"), 6))
	for type in ["LineEdit", "TextEdit"]:
		t.set_stylebox("normal", type, _flat(Color("#ffffff"), Color("#c3c8d1"), 6))
	return t


static func _flat(bg: Color, border: Color, radius: int) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.border_color = border
	s.set_border_width_all(1)
	s.set_corner_radius_all(radius)
	s.set_content_margin_all(8)
	return s
