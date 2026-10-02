extends RefCounted
# @pkey-feature update.driver update.bootguard
# The updater suite (P3-10): acting on the verified decision. Each group is a file under
# res://tests/updater/ with `func run(t: PKeyTestContext) -> void` (it may await):
#
#   adapters  every outlet kind × every decision action -> the adapter's behaviour (link opened,
#             hook called, sidecar staged, restart, reload or silent); capabilities only narrow
#   bridges   the Sparkle, Velopack, WinSparkle and AppImage hooks with and without their native
#             side; a missing plugin degrades `binary {native}` to the download link
#   download  PKeyDownload: Range resume, a 200 that restarts, 416, gzip off, the bearer dropped
#             on a cross-origin redirect, the size cap, local-only, the wall-clock deadline
#   swap      PKeySidecarSwap: the refused locations (MSIX on either separator, Program Files,
#             a macOS .app, Flatpak, Snap, AppImage, Velopack, no sidecar, not writable,
#             mobile and web), a verified stage and swap, a size or hash mismatch that changes
#             nothing, a locked rename that defers to the next launch, crash recovery
#   guard     the boot guard over launches: two failed boots roll back and skip the version, a
#             confirmed boot resets the counter (BOOT_OK_SECONDS, confirm_boot, waiting), staged
#             code dropped on a channel switch, an engine change and a binary at least as new;
#             stage-matrix.json's guardCases and confirmCases through the host's own counting
#   boot      PKeyBoot with the real PKeyBootHost: GUARD applies a staged pack and restarts
#             before guard.done, rolls back, reports `rolled-back`; DECIDE with no native plugin
#             degrades to the download link and the boot reaches READY; the dev-menu lock
#   grep      no SDK code passes --main-pack, --path, --scene or -s

const GROUPS := ["adapters", "bridges", "download", "swap", "guard", "boot", "grep"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var ran := 0
	for name in GROUPS:
		if not only.is_empty() and not only.has(name):
			continue
		var path := "res://tests/updater/test_%s.gd" % name
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
