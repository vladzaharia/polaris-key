extends SceneTree
## Renders the drop-in screens across the resolution matrix (tests/ui/matrix.gd) to PNGs for
## review. The `ui_matrix` suite checks the same layouts headless in CI; this draws them. It
## needs a renderer, so run it from the editor binary with a display (windowed), not headless:
##
##   godot --path sdks/godot --script tools/ui_matrix/ui_matrix.gd -- --out DIR \
##       [--screens sign_in,gate] [--sizes 1280x720,1920x1080] [--presets dark,light,native,custom] \
##       [--locales en,de,ja] [--sheets] [--progress]
##
## Defaults: every screen and size; the four presets in English plus German and Japanese in the
## dark preset; DIR user://ui_matrix. Output: DIR/godot.<screen>/<size>-<preset>.png (English) and
## <size>-<preset>-<locale>.png, and with --sheets one contact sheet per screen, preset and locale
## (DIR/godot.<screen>/sheet-<preset>[-<locale>].png: every size in matrix order, four a row).

const MATRIX := preload("res://tests/ui/matrix.gd")


func _initialize() -> void:
	_run.call_deferred()


func _arg(args: PackedStringArray, flag: String, fallback: String) -> String:
	var i := args.find(flag)
	return args[i + 1] if i >= 0 and i + 1 < args.size() else fallback


func _list(args: PackedStringArray, flag: String, all: Array) -> Array:
	var raw := _arg(args, flag, "")
	return all if raw == "" else Array(raw.split(",", false))


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var out := _arg(args, "--out", "user://ui_matrix")
	var mx = MATRIX.new()
	var screens: Array = _list(args, "--screens", MATRIX.SCREENS.map(func(e): return e[0]))
	var sizes: Array = _list(args, "--sizes", MATRIX.SIZES.map(func(s): return s[0]))
	var presets: Array = _list(args, "--presets", MATRIX.PRESETS)
	var locales_flag := _arg(args, "--locales", "")
	var sheets := args.has("--sheets")
	var progress := args.has("--progress")
	var started := Time.get_ticks_msec()
	var n := 0
	for entry in MATRIX.SCREENS:
		if not screens.has(entry[0]):
			continue
		var dir := "%s/godot.%s" % [out, entry[0]]
		DirAccess.make_dir_recursive_absolute(dir)
		for preset in presets:
			var locales: Array = Array(locales_flag.split(",", false)) if locales_flag != "" else (MATRIX.LOCALES if preset == "dark" else ["en"])
			for locale in locales:
				mx.use_locale(locale)
				var shots: Array = []
				for s in MATRIX.SIZES:
					if not sizes.has(s[0]):
						continue
					if progress:
						print("ui_matrix: %s %s %s %s" % [entry[0], s[0], preset, locale])
					var st: Dictionary = await mx.stage(self, entry, s[1], s[2], s[3], preset, true)
					await _drawn()
					var img: Image = st["vp"].get_texture().get_image()
					(st["vp"] as Node).queue_free()
					var suffix: String = "" if locale == "en" else "-" + locale
					img.save_png("%s/%s-%s%s.png" % [dir, s[0], preset, suffix])
					shots.append(img)
					n += 1
				if sheets and not shots.is_empty():
					_sheet(shots).save_png("%s/sheet-%s%s.png" % [dir, preset, "" if locale == "en" else "-" + locale])
	mx.drop_locales()
	PKeyUiView.safe_insets_override = null
	PKeyUiTheme.reset()
	print("ui_matrix: %d PNGs in %s (%.1f s)" % [n, ProjectSettings.globalize_path(out), (Time.get_ticks_msec() - started) / 1000.0])
	quit()


## Wait for the next drawn frame; force one when the window is not drawing (an occluded window
## on macOS draws nothing), and from then on force every frame instead of waiting.
var _forcing := false


func _drawn() -> void:
	if _forcing:
		RenderingServer.force_draw(false)
		return
	var done := [false]
	RenderingServer.frame_post_draw.connect(func() -> void: done[0] = true, CONNECT_ONE_SHOT)
	var started := Time.get_ticks_msec()
	while not done[0] and Time.get_ticks_msec() - started < 2000:
		await process_frame
	if not done[0]:
		_forcing = true
		RenderingServer.force_draw(false)


## Every shot scaled into a 480 × 480 cell (keeping its proportions), four a row, on a grey sheet.
static func _sheet(shots: Array) -> Image:
	var cell := 480
	var gap := 12
	var cols := mini(4, shots.size())
	var rows := int(ceil(shots.size() / float(cols)))
	var sheet := Image.create(cols * (cell + gap) + gap, rows * (cell + gap) + gap, false, Image.FORMAT_RGBA8)
	sheet.fill(Color("#55595f"))
	for i in shots.size():
		var img: Image = (shots[i] as Image).duplicate()
		img.convert(Image.FORMAT_RGBA8)
		var k := minf(float(cell) / img.get_width(), float(cell) / img.get_height())
		img.resize(maxi(1, roundi(img.get_width() * k)), maxi(1, roundi(img.get_height() * k)), Image.INTERPOLATE_LANCZOS)
		var x := gap + (i % cols) * (cell + gap) + (cell - img.get_width()) / 2
		var y := gap + (i / cols) * (cell + gap) + (cell - img.get_height()) / 2
		sheet.blit_rect(img, Rect2i(Vector2i.ZERO, img.get_size()), Vector2i(x, y))
	return sheet
