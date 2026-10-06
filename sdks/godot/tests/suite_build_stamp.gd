extends RefCounted
# The build_stamp suite (P1-11): PKeyBuildStamp's export-side checks and its reader, the core
# taking X-PKey-Channel and the report's outlet from the stamp, PolarisKey.build_info() on this
# target (the editor fallback, or the stamp run_tests.sh exported with PKEY_BUILD_OUTLET=steam,
# PKEY_BUILD_CHANNEL=beta, PKEY_BUILD_NUMBER=42), and the setup dock's pin check. Each group is a
# file under res://tests/build_stamp/ with `func run(t: PKeyTestContext) -> void` (it may await).
# The export plugin's own end-to-end checks are the export_stamps suite, which run_tests.sh feeds.

const GROUPS := ["stamp", "runtime", "dock", "tools"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/build_stamp/test_%s.gd" % name
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
