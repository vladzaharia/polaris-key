class_name PKeyTestRunner
extends SceneTree
## The headless test runner. It is the project's main loop (`application/run/main_loop_type`),
## so the editor and an exported release template run it the same way. Official 4.6+ templates
## ignore `--path`, `--script` and `--main-pack`, so nothing here may depend on them:
##
##   godot --headless --path sdks/godot -- --pkey-test ci
##   build/pkey_conformance.x86_64 --headless -- --pkey-test ci
##
## `--pkey-test <suite>[,<suite>]` selects suites (`ci` expands to the CI set); anything after the
## list is passed to every suite (`--pkey-test ed25519 bench 20`). Without `--pkey-test` this is a
## plain SceneTree and the project runs its main scene.
##
## A suite is `res://tests/suite_<name>.gd`, `extends RefCounted`, with
## `func run(t: PKeyTestContext, args: PackedStringArray) -> bool` (it may be a coroutine). It
## fails if it does not load, returns anything but `true`, or reports zero checks.
##
## Output: one `PKEY-TEST …` header, then `PASS|FAIL <suite> <name>` and `INFO` lines, then
## `PKEY-TEST SUMMARY suites=N checks=N failed=N`. The exit code is 1 on any failure.
##
## The runner depends only on polaris_key.gd (for the version) and the test context, so a broken
## addon file fails one suite cleanly instead of the runner.

const SDK := preload("res://addons/polaris_key/polaris_key.gd")
const Context := preload("res://tests/support/test_context.gd")

## Named suite sets. Later work packages append their suites to `ci`; `profile` stays outside.
const SETS := {
	"ci": ["sha512", "ed25519", "conformance", "core", "config", "license", "transcripts", "devices", "platform", "identity", "qr", "build_stamp", "update", "stage_matrix", "boot", "ui", "updater", "packs", "provides", "brand", "native_apple", "native_android", "commerce"],
	## The brief spells the suite with a hyphen.
	"stage-matrix": ["stage_matrix"],
}


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var at := args.find("--pkey-test")
	if at < 0:
		return
	_run.call_deferred(args, at)


func _run(args: PackedStringArray, at: int) -> void:
	var names: Array[String] = []
	var bad_selection := at + 1 >= args.size() or args[at + 1].begins_with("--")
	if not bad_selection:
		for raw in args[at + 1].split(",", false):
			var name := raw.strip_edges()
			if SETS.has(name):
				for s in SETS[name]:
					if not names.has(s):
						names.append(s)
			elif not names.has(name):
				names.append(name)
	var extra: PackedStringArray = args.slice(at + 2) if not bad_selection else PackedStringArray()

	print("PKEY-TEST engine=%s build=%s target=%s os=%s arch=%s sdk=%s suites=%s" % [
		Engine.get_version_info().string,
		"debug" if OS.is_debug_build() else "release",
		"editor" if OS.has_feature("editor") else "template",
		OS.get_name(),
		Engine.get_architecture_name(),
		SDK.SDK_VERSION,
		",".join(names),
	])

	var checks := 0
	var failed := 0
	if bad_selection or names.is_empty():
		print("FAIL runner selection — usage: -- --pkey-test <suite>[,<suite>] [args...]")
		failed += 1
	for name in names:
		var t: PKeyTestContext = Context.new(name)
		var ok := await _run_suite(t, name, extra)
		checks += t.checks
		failed += t.failed
		if not ok:
			failed += 1

	print("PKEY-TEST SUMMARY suites=%d checks=%d failed=%d" % [names.size(), checks, failed])
	quit(1 if failed > 0 else 0)


func _run_suite(t: PKeyTestContext, name: String, extra: PackedStringArray) -> bool:
	var path := "res://tests/suite_%s.gd" % name
	if not ResourceLoader.exists(path):
		print("FAIL %s load — no suite at %s" % [name, path])
		return false
	var script = load(path)
	if script == null or not (script is GDScript) or not script.can_instantiate():
		print("FAIL %s load — %s did not load" % [name, path])
		return false
	var suite = script.new()
	if suite == null or not suite.has_method("run"):
		print("FAIL %s load — %s has no run(t, args)" % [name, path])
		return false
	var started := Time.get_ticks_msec()
	var result = await suite.run(t, extra)
	t.info("finished in %d ms" % (Time.get_ticks_msec() - started))
	if not (result is bool and result == true):
		print("FAIL %s run — returned %s, not true" % [name, str(result)])
		return false
	if t.checks == 0:
		print("FAIL %s run — reported zero checks" % name)
		return false
	return true
