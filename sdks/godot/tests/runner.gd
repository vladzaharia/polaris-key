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
## How long the exit drain waits for pending worker tasks (a wall-clock bound on teardown only).
const DRAIN_MAX_MSEC := 10000

## Named suite sets. Later work packages append their suites to `ci`; `profile` stays outside, and
## so does `ui_matrix` (about a minute), which run_tests.sh runs as a step of its own. `dev_live`
## (SP-41) is in no set: CI runs it on one leg only, the 4.7.2 editor leg, which sets
## PKEY_TEST_DEV_LIVE=1 so run_tests.sh adds it to that leg's last parallel process. It skips itself
## where no `pkey dev` variable is set; a lane that sets all three runs it against that server
## (tests/suite_dev_live.gd).
## `ci` split in two for the 4.7.2 editor runners (run_tests.sh PKEY_TEST_PART=editor-a / editor-b), so
## neither nears the step watchdog. The two lists are disjoint and together are `ci`, as a set
## (tools/godotCiSplit.test.ts); a suite added to `ci` goes into one of them in the same change.
const SETS := {
	"ci_a": [
		"sha512", "ed25519", "nfc", "conformance", "core", "config", "license", "presentation",
		"devices", "devicekeys", "devicekeys_native", "backup_exclusion", "platform", "identity",
		"qr", "build_stamp", "update", "stage_matrix", "ui", "ui_components", "cloud_sync_ui",
		"updater", "packs", "provides", "brand", "native_apple", "native_android", "native_desktop",
		"keyring", "parity", "ui_lint", "exit_leaks", "dropin", "ui_core", "ui_add_to_account", "ui_holders", "ui_holders_flow", "ui_locales",
		"ui_local_models", "ui_paired_devices", "ui_local_screens", "api_surface",
	],
	"ci_b": [
		"transcripts", "boot", "sync_vectors", "sync_ring", "sync_host_codec", "sync_files",
		"cloud_sync_transfer", "cloud_sync_files", "cloud_sync_bulk", "cloud_sync_bulk_native",
		"cloud_sync_saves", "cloud_sync_export", "sync_scenarios", "cloud_sync_host", "cloud_sync_settings", "commerce",
		"backend", "transports", "connect",
	],
	## `ci` split in four, balanced by measured run time, for the parallel editor and template runs
	## (run_tests.sh PKEY_TEST_PARALLEL=1: one process per set, each with its own HOME). Disjoint and together `ci`
	## (tools/godotCiSplit.test.ts); a suite added to `ci` goes into one of them in the same change.
	"ci_p1": [
		"identity", "packs", "ui_holders", "ui_holders_flow",
	],
	"ci_p2": [
		"ui", "sync_files",
	],
	"ci_p3": [
		"nfc", "config", "presentation", "platform", "build_stamp", "stage_matrix",
		"cloud_sync_ui", "updater", "provides", "native_apple", "native_android",
		"native_desktop", "sync_ring", "sync_host_codec", "cloud_sync_transfer",
		"cloud_sync_bulk", "sync_scenarios", "cloud_sync_host", "commerce", "backend",
		"exit_leaks", "dropin", "connect",
	],
	"ci_p4": [
		"sha512", "ed25519", "conformance", "core", "license", "transcripts", "devices",
		"devicekeys", "devicekeys_native", "backup_exclusion", "qr", "update", "boot",
		"ui_components", "brand", "keyring", "sync_vectors", "cloud_sync_files",
		"cloud_sync_bulk_native", "cloud_sync_saves", "cloud_sync_export", "cloud_sync_settings", "transports",
		"parity", "ui_lint", "ui_core", "ui_add_to_account", "ui_locales",
		"ui_local_models", "ui_paired_devices", "ui_local_screens", "api_surface",
	],
	"ci": ["sha512", "ed25519", "nfc", "conformance", "core", "config", "license", "transcripts", "presentation", "devices", "devicekeys", "devicekeys_native", "backup_exclusion", "platform", "identity", "qr", "build_stamp", "update", "stage_matrix", "boot", "ui", "ui_components", "cloud_sync_ui", "updater", "packs", "provides", "brand", "native_apple", "native_android", "native_desktop", "keyring", "sync_vectors", "sync_ring", "sync_host_codec", "sync_files", "cloud_sync_transfer", "cloud_sync_files", "cloud_sync_bulk", "cloud_sync_bulk_native", "cloud_sync_saves", "cloud_sync_export", "sync_scenarios", "cloud_sync_host", "cloud_sync_settings", "commerce", "backend", "transports", "parity", "ui_lint", "exit_leaks", "dropin", "ui_core", "ui_add_to_account", "ui_holders", "ui_holders_flow", "ui_locales", "ui_local_models", "ui_paired_devices", "ui_local_screens", "api_surface", "connect"],
	## The brief spells the suite with a hyphen.
	"stage-matrix": ["stage_matrix"],
}


func _initialize() -> void:
	# The sign-in form draws the platform's own button on macOS, iOS and Android: pin the host's platform so
	# the snapshots and PNGs read the same on every machine (a test that wants a platform sets its own).
	PKeySignInDialog.default_platform = "linux"
	var args := OS.get_cmdline_user_args()
	var at := args.find("--pkey-test")
	if at < 0:
		return
	_run.call_deferred(args, at)


func _run(args: PackedStringArray, at: int) -> void:
	# This project's own name stands in for a product's in the screens the suites pin.
	PKeyUiTheme.hide_dev_project_name = false
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

	failed += await _drain()
	await _release_boot_hosts()
	if OS.get_environment("PKEY_TEST_SEED_LEAK") == "1":
		# The leak gate's self-test (run_tests.sh): a RefCounted that holds itself outlives the run, so the
		# engine reports it at exit and the step must fail.
		var seeded := SeededLeak.new()
		seeded.me = seeded
	print("PKEY-TEST SUMMARY suites=%d checks=%d failed=%d" % [names.size(), checks, failed])
	quit(1 if failed > 0 else 0)


## What `PKEY_TEST_SEED_LEAK=1` leaks.
class SeededLeak:
	extends RefCounted
	var me: SeededLeak


## Waits until nothing the SDK started is still running, so the engine quits with no worker task or
## suspended coroutine alive (a task alive at exit crashes the teardown of some builds, and a
## coroutine alive at exit is reported as a leaked object): every peer-pump offload and pack job
## has returned, then two frames let the freed nodes and closed sockets go. Returns the failures
## (1 when work is still pending after DRAIN_MAX_MSEC).
func _drain() -> int:
	var began := Time.get_ticks_msec()
	while PKeyPeerPump.pending_total + PKeyPackJob.pending > 0 and Time.get_ticks_msec() - began < DRAIN_MAX_MSEC:
		await process_frame
	await process_frame
	await process_frame
	var left := PKeyPeerPump.pending_total + PKeyPackJob.pending
	if left > 0:
		print("FAIL runner drain — %d worker tasks still pending after %d ms (pump %d, pack jobs %d)" % [left, DRAIN_MAX_MSEC, PKeyPeerPump.pending_total, PKeyPackJob.pending])
		return 1
	return 0


## A boot a suite left running waits on its fake host for ever, and some engines report that suspended coroutine
## as a leaked object: answer the waits until none is left.
func _release_boot_hosts() -> void:
	var path := "res://tests/support/fake_boot_host.gd"
	if not ResourceLoader.exists(path):
		return
	var host_script: GDScript = load(path)
	for i in 20:
		if not host_script.release_all():
			break
		await process_frame
		await process_frame


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
