extends RefCounted
# @pkey-feature license.activate license.refusals identity.devicecode core.sync core.discover update.decide release.record
# The dev_live suite (SP-41): the Godot SDK against a live `pkey dev` server, the Worker's own
# router on a seeded product, over the SDK's real HTTP transport. No fake server and no replay:
# what each group sees is what the deployed Worker answers.
#
#   quickstart   the file `pkey sdk --lang godot --dev --write` generated names this server's
#                product, origin and pins; PolarisKey.configure() accepts its options(); the
#                first activation with the `ok` key opens the gate on a verified document
#   refusals     all seven seeded keys through license.activate_with_key: ok and floating
#                activate, expired, disabled and revoked answer 401 `unauthorized` alike,
#                device-limit-full answers `device_limit` and key-entry-limit `key_entry_limit`
#   config       a config value changed on the server arrives with the next sync as one
#                `config_changed`, enforced
#   signin       device-code sign-in approved by the harness approver, through request_sign_in,
#                poll_sign_in and wait_for_sign_in, and through begin_sign_in's signals
#   update       update.decide(): a build current on the newest stable release is offered nothing,
#                and the same build is offered a release the server then publishes
#
# The server, the generated config (polaris_key.tres) and the approver come from the environment (tests/dev_live/
# support.gd): all three set runs the suite, none set skips it, anything else fails it. A lane
# that runs it starts `pkey dev --auto-approve`, writes the config with `pkey sdk --lang godot
# --dev --url <origin> --write --out <a file outside this tree>`, and has `node` on PATH:
#
#   PKEY_DEV_BASE_URL=http://127.0.0.1:8787 PKEY_DEV_CONFIG=/tmp/polaris_key.tres \
#   PKEY_DEV_APPROVE="$PWD/packages/cli/scripts/dev-approve.mjs" PKEY_TEST_SUITES=dev_live \
#   sdks/godot/tools/run_tests.sh
#
# Each group is a file under res://tests/dev_live/ with `func run(t: PKeyTestContext, bed:
# PKeyDevLive) -> void` (it may await). The groups run in order, one at a time, each as the fixed
# device of its role (support.gd): the server allows each test key three key entries, one for
# every seat the key claims, so a device that took a seat keeps it and a rerun on the same server
# (CI runs the suite from the editor and from the exported pack) activates the same device again.

const GROUPS := ["quickstart", "refusals", "config", "signin", "update"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var state := PKeyDevLive.env_state()
	if PKeyDevLive.is_skipped(state):
		t.info("skipped: none of %s is set; a pkey dev lane sets all three (see tests/dev_live/support.gd)" % ", ".join(PackedStringArray(PKeyDevLive.ENV_NAMES)))
		t.check("env: skipped, no pkey dev variable is set", true)
		return true
	if not PKeyDevLive.is_complete(state):
		t.check("env: %s are all set to a value" % ", ".join(PackedStringArray(PKeyDevLive.ENV_NAMES)), false, "unset: [%s], empty: [%s]" % [", ".join(PackedStringArray(state["unset"])), ", ".join(PackedStringArray(state["empty"]))])
		return true

	var bed := PKeyDevLive.new()
	if not await bed.open(t):
		bed.close()
		return true
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/dev_live/test_%s.gd" % name
		var script = load(path)
		if not t.check("group %s loads" % name, script is GDScript and script.can_instantiate(), path):
			continue
		var started := Time.get_ticks_msec()
		await script.new().run(t, bed)
		t.info("group %s finished in %d ms" % [name, Time.get_ticks_msec() - started])
		ran += 1
	var expected := GROUPS.size() if only.is_empty() else only.size()
	t.check("coverage", ran == expected, "%d/%d groups ran" % [ran, expected])
	bed.close()
	return true
