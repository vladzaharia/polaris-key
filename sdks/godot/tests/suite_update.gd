extends RefCounted
# @pkey-feature update.check release.changelog release.download update.feed release.record update.decide outlet.detect
# The update suite (P1-08, P3-08): PolarisKey.update (the wire v4 decision, feed and release
# record; the version check, its update_available signal, the appcast URL) and PolarisKey.release (the changelog, the install and download URLs) against
# PKeyFakeServer, and the URL builders against the vectors sdk-node is held to. Each group is a
# file under res://tests/update/ with `func run(t: PKeyTestContext) -> void` (it may await); the
# suite ends with a coverage check that every group ran. The release-changelog transcripts run in
# the transcripts suite.

const GROUPS := ["check", "release", "urls", "decide", "outlet"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/update/test_%s.gd" % name
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
