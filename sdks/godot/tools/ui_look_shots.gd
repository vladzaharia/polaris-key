extends SceneTree
## The game look for review (UK-11b): a kit dialog over a stand-in game frame, on the scrim path
## (glass card) and on the opaque path (`ui_reduce_transparency` on), dark and light, at a phone
## and a TV. Needs a display; run it from the editor binary, not headless:
##
##   godot --path sdks/godot --script tools/ui_look_shots.gd -- <dir> [scheme]
##
## Output: <dir>/<path>-<scheme>-<size>/<scene>__<state>.png, path being `scrim` or `opaque`.

const SCENARIOS := preload("res://tests/ui/scenarios.gd")
## [label, viewport size, canvas_items scale]
const SIZES := [["phone", Vector2i(1170, 2532), 3.0], ["tv", Vector2i(3840, 2160), 2.0]]
## [scene, state]: the dialogs that open over a running game.
const SHOTS := [["sign_in", "pending"], ["update_prompt", "binary, modal with release notes"], ["settings", "catalog"], ["offline", "native"]]


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var out := args[0] if args.size() > 0 else "user://pkey-look-shots"
	var schemes: Array = [args[1]] if args.size() > 1 else ["dark", "light"]
	var sc = SCENARIOS.new()
	var n := 0
	for path in ["scrim", "opaque"]:
		for scheme in schemes:
			for s in SIZES:
				for want in SHOTS:
					for c in sc.all():
						if c[0] != want[0] or c[1] != want[1]:
							continue
						var shot := await _shot(c, path, scheme, s[1], s[2])
						if shot == null:
							continue
						var dir := "%s/%s-%s-%s" % [out, path, scheme, s[0]]
						DirAccess.make_dir_recursive_absolute(dir)
						shot.save_png("%s/%s__%s.png" % [dir, c[0], String(c[1]).validate_filename().replace(" ", "_")])
						n += 1
	print("ui_look_shots: %d PNGs in %s" % [n, ProjectSettings.globalize_path(out)])
	quit()


func _shot(c: Array, path: String, scheme: String, size: Vector2i, scale: float) -> Image:
	var vp := SubViewport.new()
	vp.size = size
	vp.size_2d_override = Vector2i(Vector2(size) / scale)
	vp.size_2d_override_stretch = true
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(vp)
	var host := Control.new()
	host.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	vp.add_child(host)
	var v: Control = await c[2].call()
	v.get_parent().remove_child(v)
	PKeyUiTheme.reset()
	PKeyUiTheme.branding = PKeyUiTheme.BRANDING_POLARIS_KEY
	PKeyUiTheme.scheme = scheme
	PKeyUiTheme.product_name = "Tidewater Studio"
	PKeyUiTheme.reduce_transparency_mode = "on" if path == "opaque" else "off"
	PKeyUiTheme.reduce_motion_mode = "on"
	_game(host, vp.size_2d_override)
	v.theme = load(PKeyUiTheme.NEUTRAL_PATH)
	host.add_child(v)
	v._ready()
	v.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	v.refresh_view()
	for i in 4:
		await process_frame
	await RenderingServer.frame_post_draw
	var img := vp.get_texture().get_image()
	vp.queue_free()
	return img


## A stand-in game frame: a busy sky and ground with a few bright shapes, so a see-through card
## shows what the glass lets through.
func _game(host: Control, sz: Vector2i) -> void:
	var sky := ColorRect.new()
	sky.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	sky.color = Color("#f2994a")
	host.add_child(sky)
	var sea := ColorRect.new()
	sea.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	sea.anchor_top = 0.55
	sea.offset_top = 0
	sea.color = Color("#1b6ca8")
	host.add_child(sea)
	var rnd := RandomNumberGenerator.new()
	rnd.seed = 11
	for i in 18:
		var r := ColorRect.new()
		r.color = Color.from_hsv(rnd.randf(), 0.7, 1.0)
		r.size = Vector2(rnd.randf_range(40, 160), rnd.randf_range(24, 120))
		r.position = Vector2(rnd.randf() * sz.x, rnd.randf() * sz.y)
		host.add_child(r)
	var sun := ColorRect.new()
	sun.color = Color("#fff3b0")
	sun.size = Vector2(sz.y * 0.22, sz.y * 0.22)
	sun.position = Vector2(sz.x * 0.62, sz.y * 0.12)
	host.add_child(sun)
