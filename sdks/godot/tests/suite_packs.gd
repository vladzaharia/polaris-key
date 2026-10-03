extends RefCounted
# @pkey-feature packs.record packs.plan packs.index.files packs.apply.full packs.apply.file packs.apply.delta packs.state packs.handlers packs.revoke
# The packs suite (P4-08): the content corpus and plan-matrix.json through the addon's pack core
# (content, plan, records), the device-side PCK checks over P4-03's fixture PCKs (pck), the
# engine's GDDL decoder and the trailer bake over a mounted base (bake), the install state and
# its storage (state), the pipeline against PKeyFakeServer (engine), PKeyBoot's pack stages
# (boot), the shared boot guard's pack rollback (guard), the f_uid mount case (uid) and P4-24's
# revocations: the sibling revocations.json, pack-revoked and the update check's content steps
# (revocations). Each group
# is a file under res://tests/packs/ with `func run(t: PKeyTestContext) -> void` (it may await);
# the suite ends with a coverage check that every group ran.

const GROUPS := ["content", "plan", "records", "pck", "bake", "engine", "state", "http", "boot", "guard", "uid", "revocations"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	PKeyPackClaims.warm()
	PKeyPck.warm()
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/packs/test_%s.gd" % name
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
