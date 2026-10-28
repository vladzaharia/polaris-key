extends RefCounted
# @pkey-feature core.devicekeys core.store
# Keeping the sensitive files out of OS backups (GODOT-BACKUP-EXCL; lead decision Q-6), headless over
# fake plugins: Android's no-backup directory is the store root when the plugin answers and the root
# is unchanged when it does not; the stores accept that directory and still refuse any other path
# outside user://; iOS's exclude-from-backup call is made once per directory after it exists and its
# failure never fails a write; off those platforms nothing is called.

const PRODUCT := "djdl"


## A stand-in for the PolarisKeyAndroid / PolarisKeyApple `cmd(json)` surface.
class FakeNative:
	extends RefCounted
	var requests: Array[Dictionary] = []
	var no_backup := ""
	var fail := false

	func cmd(json: String) -> String:
		var q: Dictionary = JSON.parse_string(json)
		requests.append(q)
		if fail:
			return JSON.stringify({"ok": false, "error": "exclude_failed"})
		match str(q.get("op", "")):
			"no_backup_dir":
				return JSON.stringify({"ok": true, "path": no_backup})
			"exclude_from_backup":
				return JSON.stringify({"ok": true})
		return JSON.stringify({"ok": false, "error": "unknown_op"})

	func count(op: String) -> int:
		var n := 0
		for r in requests:
			if r.get("op") == op:
				n += 1
		return n


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_android(t)
	_ios(t)
	_stores(t)
	PKeyBackupExclusion.reset_for_tests()
	return true


static func _android_with(native: FakeNative) -> PKeyAndroid:
	var a := PKeyAndroid.new()
	a.native = native
	PKeyBackupExclusion.android_override = a
	return a


func _android(t: PKeyTestContext) -> void:
	PKeyBackupExclusion.reset_for_tests()
	t.check("android: no plugin, the root is unchanged", PKeyBackupExclusion.root("user://pkey") == "user://pkey")
	var scratch := PKeyTestFixtures.scratch_dir("bx-nb")
	var native := FakeNative.new()
	native.no_backup = ProjectSettings.globalize_path(scratch).path_join("no_backup")
	var a := _android_with(native)
	var moved := PKeyBackupExclusion.root("user://pkey")
	t.check("android: the plugin's no-backup directory is the root", moved == native.no_backup.path_join("pkey"), moved)
	t.check("android: the answer is read once per process", PKeyBackupExclusion.root("user://pkey/x") == native.no_backup.path_join("pkey/x") and native.count("no_backup_dir") == 1)
	t.check("android: a root outside user:// is left alone", PKeyBackupExclusion.root("/tmp/x") == "/tmp/x")
	t.check("android: a dot-dot root is left alone", PKeyBackupExclusion.root("user://../x") == "user://../x")
	a.native = FakeNative.new()
	var empty := PKeyAndroid.new()
	empty.native = FakeNative.new()
	PKeyBackupExclusion.android_override = empty
	t.check("android: a plugin that answers no path leaves the root unchanged", PKeyBackupExclusion.root("user://pkey") == "user://pkey")
	PKeyBackupExclusion.reset_for_tests()
	PKeyTestFixtures.remove_tree(scratch)


func _ios(t: PKeyTestContext) -> void:
	PKeyBackupExclusion.reset_for_tests()
	var dir := PKeyTestFixtures.scratch_dir("bx-ios")
	t.check("ios: no plugin, nothing to do", PKeyBackupExclusion.exclude(dir))
	var native := FakeNative.new()
	var apple := PKeyApple.new()
	apple.native = native
	PKeyBackupExclusion.apple_override = apple
	t.check("ios: the directory is excluded", PKeyBackupExclusion.exclude(dir) and native.count("exclude_from_backup") == 1)
	t.check("ios: the call carries an absolute, globalized path", str(native.requests[0].get("path")) == ProjectSettings.globalize_path(dir) and str(native.requests[0].get("path")).begins_with("/"))
	PKeyBackupExclusion.exclude(dir)
	t.check("ios: asked once per directory", native.count("exclude_from_backup") == 1)
	native.fail = true
	t.check("ios: a failed call is reported, not thrown, and retried next time", not PKeyBackupExclusion.exclude(dir + "/b") and not PKeyBackupExclusion.exclude(dir + "/b") and native.count("exclude_from_backup") == 3)
	PKeyBackupExclusion.reset_for_tests()
	PKeyTestFixtures.remove_tree(dir)


func _stores(t: PKeyTestContext) -> void:
	PKeyBackupExclusion.reset_for_tests()
	var scratch := PKeyTestFixtures.scratch_dir("bx-st")
	var native := FakeNative.new()
	native.no_backup = ProjectSettings.globalize_path(scratch).path_join("no_backup")
	_android_with(native)
	var root := PKeyBackupExclusion.root("user://pkey")
	t.check("stores: the no-backup root is private, an unrelated absolute one is not",
			PKeyBackupExclusion.is_private_root(root) and PKeyBackupExclusion.is_private_root("user://pkey")
			and not PKeyBackupExclusion.is_private_root("/tmp/x") and not PKeyBackupExclusion.is_private_root(native.no_backup + "/../x"))
	var keys := PKeyDeviceKeyStore.new(PRODUCT, root, false, true, PKeyFakeSealer.new())
	var e := keys.ensure()
	t.check("stores: device keys are written under the no-backup directory", e.ok and FileAccess.file_exists(root.path_join(PRODUCT).path_join(PKeyDeviceKeyStore.RECORD_FILE)), str(e))
	var vault := PKeySyncRingVault.new(PRODUCT, root, false, true, PKeyFakeSealer.new())
	var w := vault.write_pin({"ring_id": "r", "epoch": 1, "root_kid": "k"})
	t.check("stores: the ring pin is written under the no-backup directory", w.ok and FileAccess.file_exists(root.path_join(PRODUCT).path_join("sync-ring-pin.json")), str(w))
	var state := preload("res://addons/polaris_key/services/cloud_sync/state.gd").new(root.path_join(PRODUCT), PRODUCT, PKeyFakeSealer.new())
	t.check("stores: the sync state file is written under the no-backup directory", state.save({"persisted": {}}) and FileAccess.file_exists(root.path_join(PRODUCT).path_join("cloud-sync")))
	PKeyBackupExclusion.reset_for_tests()
	var outside := PKeyDeviceKeyStore.new(PRODUCT, native.no_backup, false, true, PKeyFakeSealer.new())
	t.check("stores: without the plugin, that directory is refused again", not outside.ensure().ok)
	PKeyTestFixtures.remove_tree(scratch)
