extends RefCounted
# @pkey-feature update.driver
# The desktop update plugins' GDScript side (P5-07), headless and with no native library: the
# facades' unsupported answers (`runtime` on the wrong OS, `dependency` without the GDExtension
# or its updater library), their behaviour over stand-in native objects, and the wiring into
# P3-10's bridges, PKeyUpdater and PKeyMsStoreAdapter. The native code itself is exercised by the
# `native-desktop` CI workflow's end-to-end runs (sdks/godot/native/). Each group is a file under
# res://tests/native/ with `func run(t: PKeyTestContext) -> void`:
#
#   facades  the four facades: unsupported matrix, Sparkle, Velopack, WinSparkle, StoreContext
#   wiring   bridges -> facades, the updater's bridge config, the Microsoft Store hook, options
#   export   the macOS export plugin's Sparkle switches (PKeyNativeExport)

const GROUPS := ["facades", "wiring", "export"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/native/test_%s.gd" % name
		var script = load(path)
		if not t.check("group %s loads" % name, script is GDScript and script.can_instantiate(), path):
			continue
		var started := Time.get_ticks_msec()
		await script.new().run(t)
		t.info("group %s finished in %d ms" % [name, Time.get_ticks_msec() - started])
		ran += 1
	var expected := GROUPS.size() if only.is_empty() else only.size()
	t.check("coverage", ran == expected, "%d/%d groups ran" % [ran, expected])
	return true
