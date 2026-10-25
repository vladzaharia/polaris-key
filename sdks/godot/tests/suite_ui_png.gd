extends RefCounted
# @pkey-feature ui.kit
# The PNG baselines (UI-KITS.md §7.1): a representative screen per component, dark and light, at a
# TV/desktop size and a phone size, drawn and compared with the committed lossless PNGs under
# tests/ui/snapshots/png/. It needs a renderer, so it runs windowed, never headless (a headless run
# skips itself with one passing check):
#
#   godot --path sdks/godot -- --pkey-test ui_png            # compare
#   godot --path sdks/godot -- --pkey-test ui_png update     # record
#
# tools/run_tests.sh runs it as a step of its own with PKEY_TEST_PNG=1 (PKEY_TEST_PNG_UPDATE=1
# records). The shots always draw the scrim path (reduced transparency off). The shots wait for the entry fade to finish and never inherit reduced motion. The
# baselines were recorded on macOS arm64 with Godot 4.7.2; text and edges are anti-aliased by the
# platform's driver, so a different GPU, OS or engine differs by a few pixels: a shot passes when
# at most TOLERANCE of its pixels differ by more than CHANNEL_DELTA (and the size is equal). CI's Linux
# jobs run headless and do not compare; record Linux baselines before turning it on there.

const MATRIX := preload("res://tests/ui/matrix.gd")
const DIR := "res://tests/ui/snapshots/png"
## [screen id of MATRIX.SCREENS]: one representative state per component.
const SCREENS := ["sign_in", "sign_in.pad", "gate", "gate.device_limit", "activation", "offline", "settings", "update.notes", "update.banner", "devices", "license_choice", "account", "paywall", "device_limit", "boot.consent"]
## [label of MATRIX.SIZES, short name].
const SIZES := [["1280x720", "tv"], ["750x1334@2", "phone"]]
const THEMES := ["dark", "light"]
## A channel differs when it moves by more than this (of 255); a shot passes with at most this share of pixels differing.
const CHANNEL_DELTA := 24
const TOLERANCE := 0.004
## Another engine than the one that recorded them draws text and edges a little differently (4.4.1
## measured 6 % of a phone-size shot): there the share only catches a layout that moved.
const TOLERANCE_OTHER_ENGINE := 0.08
const RECORDED_ON := "4.7"


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	if DisplayServer.get_name() == "headless":
		t.check("png: no renderer here (headless), the comparison is skipped; run it windowed", true)
		return true
	var tree := Engine.get_main_loop() as SceneTree
	var update := args.has("update")
	PKeyUiTheme.hide_dev_project_name = false
	MATRIX.motion_mode = "off"
	PKeyUiTheme.reduce_transparency_override = false
	var mx = MATRIX.new()
	mx.use_locale("en")
	if update:
		DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(DIR))
	var n := 0
	var worst := 0.0
	for entry in MATRIX.SCREENS:
		if not SCREENS.has(entry[0]):
			continue
		for sz in SIZES:
			var size_row: Array = []
			for s in MATRIX.SIZES:
				if s[0] == sz[0]:
					size_row = s
			if size_row.is_empty() or not MATRIX.applies(size_row, entry[0]):
				continue
			if entry.size() > 4 and entry[4] == "pad" and sz[1] == "phone":
				continue
			for theme in THEMES:
				var st: Dictionary = await mx.stage(tree, entry, size_row[1], size_row[2], size_row[3], theme, true, size_row[4])
				var v: PKeyUiView = st["view"]
				# The designed look (the scrim and the glass card), whatever the machine reports.
				PKeyUiTheme.reduce_transparency_mode = "off"
				v.refresh_view()
				# A scene that configures the SDK late can put the options back: hold them for the shot.
				PKeyUiTheme.reduce_transparency_mode = "off"
				PKeyUiTheme.reduce_motion_mode = "off"
				v.refresh_view()
				# The entry fade, and whatever else eases in, is over before the shot.
				var waited := 0
				while waited < 120 and (waited < 20 or PKeyUiMotion.entering(v)):
					await tree.process_frame
					waited += 1
				await tree.create_timer(0.5, true, false, true).timeout
				# Options a scene applied late (an SDK it configured) are put back, and the view redrawn.
				PKeyUiTheme.reduce_transparency_mode = "off"
				PKeyUiTheme.reduce_motion_mode = "off"
				v.refresh_view()
				await tree.create_timer(0.3, true, false, true).timeout
				await _drawn(tree)
				var img: Image = (st["vp"] as SubViewport).get_texture().get_image()
				(st["vp"] as Node).queue_free()
				img.convert(Image.FORMAT_RGBA8)
				var file := "%s/%s-%s-%s.png" % [DIR, entry[0], sz[1], theme]
				if update:
					img.save_png(file)
					t.check("png: recorded %s" % file.get_file(), true)
					continue
				var want := Image.new()
				if want.load(ProjectSettings.globalize_path(file)) != OK:
					t.check("png: %s has a baseline (record with `update`)" % file.get_file(), false)
					continue
				want.convert(Image.FORMAT_RGBA8)
				var d := _diff(img, want)
				worst = maxf(worst, d)
				t.check("png: %s matches its baseline (%.3f %% differ)" % [file.get_file(), d * 100.0], d <= _tolerance(), "size %s want %s" % [img.get_size(), want.get_size()])
				n += 1
	mx.drop_locales()
	MATRIX.motion_mode = "on"
	PKeyUiTheme.reduce_transparency_override = null
	PKeyUiView.safe_insets_override = null
	PKeyUiView.mobile_override = null
	PKeyUiView.pad_only_override = null
	PKeyUiTheme.reset()
	if not update:
		t.check("png: compared %d shots, worst %.3f %%" % [n, worst * 100.0], n > 0)
	return true


static func _tolerance() -> float:
	var v := Engine.get_version_info()
	return TOLERANCE if "%d.%d" % [v["major"], v["minor"]] == RECORDED_ON else TOLERANCE_OTHER_ENGINE


## The share of pixels where a channel differs by more than CHANNEL_DELTA (1.0 for another size).
static func _diff(a: Image, b: Image) -> float:
	if a.get_size() != b.get_size():
		return 1.0
	var da := a.get_data()
	var db := b.get_data()
	var bad := 0
	var px := a.get_width() * a.get_height()
	for i in px:
		var o := i * 4
		if absi(da[o] - db[o]) > CHANNEL_DELTA or absi(da[o + 1] - db[o + 1]) > CHANNEL_DELTA or absi(da[o + 2] - db[o + 2]) > CHANNEL_DELTA:
			bad += 1
	return float(bad) / float(maxi(px, 1))


var _forcing := false


func _drawn(tree: SceneTree) -> void:
	if _forcing:
		RenderingServer.force_draw(false)
		return
	var done := [false]
	RenderingServer.frame_post_draw.connect(func() -> void: done[0] = true, CONNECT_ONE_SHOT)
	var started := Time.get_ticks_msec()
	while not done[0] and Time.get_ticks_msec() - started < 2000:
		await tree.process_frame
	if not done[0]:
		_forcing = true
		RenderingServer.force_draw(false)
