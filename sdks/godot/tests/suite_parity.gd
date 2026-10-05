extends RefCounted
# @pkey-feature release.download commerce.receipt ui.kit
# The SDK parity pass (notes/SDK-PARITY-PASS.md §5.6): the conveniences added on top of the wire
# each SDK shares — portal links, crash tags, the public download model, the commerce one-calls
# and the new UI-kit scenes. Each group is a file under res://tests/parity/ with
# `func run(t: PKeyTestContext) -> void` (it may await); the suite ends with a coverage check.

const GROUPS := ["links", "distribution", "commerce", "scenes"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/parity/test_%s.gd" % name
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
