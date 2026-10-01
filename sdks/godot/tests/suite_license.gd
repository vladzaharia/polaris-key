extends RefCounted
# @pkey-feature license.gate license.activate license.enroll license.deactivate
# @pkey-feature license.entitlements license.channels license.reregister
# The licence suite (P1-03): PolarisKey.license against PKeyFakeServer answering like the Worker
# (both error-body spellings), the §5 re-acquire on both routes with its one-attempt budget, the
# best-effort deactivation with its mandatory wipe, the grants read off the verified document,
# and the channel vocabulary this SDK sends (WIRE-CONTRACT-V3 §5.1). The gate-matrix rows run in
# the conformance suite. Each group is a file under res://tests/license/ with
# `func run(t: PKeyTestContext) -> void` (it may await); the suite ends with a coverage check
# that every group ran.

const GROUPS := ["channel", "activation", "reregister", "deactivate", "entitlements"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/license/test_%s.gd" % name
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
