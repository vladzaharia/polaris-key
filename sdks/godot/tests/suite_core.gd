extends RefCounted
# @pkey-feature core.cache core.local core.sync core.discover core.verify core.errors core.caps core.copy
# The Core unit suite: strict JSON and base64url, the store, the verified cache, the transport,
# sync, local-only, the autoload, and verification off the main thread. Network tests run
# against PKeyFakeServer on 127.0.0.1. Each group is a file under res://tests/core/ with
# `func run(t: PKeyTestContext) -> void` (it may await); this suite runs them in order and
# ends with a coverage check that every group ran.

const GROUPS := ["load", "json", "errors", "semver", "store", "cache", "transport", "sync", "local", "autoload", "offload", "caps", "copy"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/core/test_%s.gd" % name
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
