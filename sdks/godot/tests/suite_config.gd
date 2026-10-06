extends RefCounted
# @pkey-feature config.resolve config.list config.secret config.schema config.mint config.mirror config.local
# The Config unit suite (P1-04): client-core's precedence rules ported case for case, the client
# wiring (values, sources, the user list, secrets), the ConfigFile override store, the
# environment layer and `--pkey-config`, the catalog fetch and edge-mint against PKeyFakeServer,
# `config_changed` and bindings over real recorded documents, and the generated GDScript mirror
# (tests/config/catalog_generated.gd, written by `tools/gen-mirrors.ts --lang gdscript` from
# tests/config/catalog.json), and the `pkey sdk --lang godot` sample (tests/sdk_config/). Each
# group is tests/config/test_<name>.gd, like suite_core.
#
# Suite arguments: a comma list of groups, and `--pkey-config key=value` pairs, which the env
# group then checks are read from the real command line.

const GROUPS := ["resolve", "matrix", "client", "store", "local", "env", "fetch", "mint", "changed", "mirror", "sdk_config"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/config/test_%s.gd" % name
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
