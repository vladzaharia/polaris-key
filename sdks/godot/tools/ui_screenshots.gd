extends SceneTree
## Renders every UI kit state the `ui` suite pins (tests/ui/scenarios.gd) with the kit theme
## (PKeyUiTheme: dark by default, `light` for the light theme) and saves one PNG per state, for
## review (headless runs have no renderer, so the suite pins structure, not pixels). Needs a
## display; run it from the editor binary, not headless:
##
##   godot --path sdks/godot --script tools/ui_screenshots.gd -- /tmp/pkey-ui-shots [light]
##
## Output: <dir>/<scene>__<state>.png at 1152x900.

const SCENARIOS := preload("res://tests/ui/scenarios.gd")


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var out := args[0] if args.size() > 0 else "user://pkey-ui-shots"
	var dark := not args.has("light")
	PKeyUiTheme.scheme = "dark" if dark else "light"
	var theme := PKeyUiTheme.current()
	DirAccess.make_dir_recursive_absolute(out)
	root.size = Vector2i(1152, 900)
	RenderingServer.set_default_clear_color(PKeyUiTheme.palette(dark)["page"])
	var sc = SCENARIOS.new()
	var n := 0
	for c in sc.all():
		var v: Control = await c[2].call()
		v.theme = theme
		if v.anchor_right == v.anchor_left:
			v.position = Vector2(24, 24)
			v.size = Vector2(720, 0)
		v.refresh_view()
		for i in 3:
			await process_frame
		await RenderingServer.frame_post_draw
		var img := root.get_texture().get_image()
		var file := "%s/%s__%s.png" % [out, c[0], String(c[1]).validate_filename().replace(" ", "_")]
		img.save_png(file)
		n += 1
		v.get_parent().remove_child(v)
		v.queue_free()
	print("ui_screenshots: %d PNGs in %s" % [n, ProjectSettings.globalize_path(out)])
	quit()
