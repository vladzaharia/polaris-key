class_name PKeyBackupExclusion
extends RefCounted
## Keeps the SDK's sensitive files out of OS backups (GODOT-BACKUP-EXCL; lead decision Q-6): the
## Cloud Sync state file, the key ring's pin and root, the device keys.
##
## GDScript cannot set either platform's backup flag, so each platform's native lane does it:
##
##   Android   `root()` moves a `user://` store root into the app's no-backup directory
##             (`Context.noBackupFilesDir`, from the PolarisKeyAndroid plugin's `no_backup_dir`), which
##             Auto Backup and device-to-device transfer skip. Without the plugin the root is unchanged.
##   iOS       `exclude()` sets `isExcludedFromBackup` on the directory (PolarisKeyApple's
##             `exclude_from_backup`) once it exists; a directory's contents follow it.
##   elsewhere nothing: the desktops have no such flag here and the web has no backup.
##
## A store whose root moved is still app-private; the stores accept the plugin's no-backup directory as
## a root through `is_private_root()`, and nothing else outside `user://`. Existing files under the old
## `user://` root are not migrated: the sync stack that writes them is new in this release.

## Tests inject fakes here; null means the process-wide facades on their own platform only.
static var android_override: PKeyAndroid = null
static var apple_override: PKeyApple = null

static var _no_backup_dir := ""
static var _excluded := {}


## `root` itself, or on Android with the plugin the same path under the no-backup directory:
## `user://pkey` becomes `<noBackupFilesDir>/pkey`. A root outside `user://` is left alone.
static func root(p_root: String) -> String:
	if not p_root.begins_with("user://") or p_root.contains(".."):
		return p_root
	var android := _android()
	if android == null:
		return p_root
	var base := android.no_backup_dir()
	if base == "" or not base.begins_with("/") or base.contains(".."):
		return p_root
	_no_backup_dir = base
	var rest := p_root.trim_prefix("user://")
	return base if rest == "" else base.path_join(rest)


## True for a root a store may write sensitive files under: `user://`, or the no-backup directory this
## class handed out (and a subdirectory of it). No `..`.
static func is_private_root(p_root: String) -> bool:
	if p_root.contains(".."):
		return false
	if p_root.begins_with("user://"):
		return true
	return _no_backup_dir != "" and (p_root == _no_backup_dir or p_root.begins_with(_no_backup_dir + "/"))


## Marks `dir` (which must exist) as excluded from backups where the platform has the flag. True when
## it is excluded or the platform needs nothing; false when the native call failed (the caller keeps
## working: the file is sealed either way). Asks once per directory per process after a success.
static func exclude(dir: String) -> bool:
	var apple := _apple()
	if apple == null:
		return true
	if _excluded.has(dir):
		return true
	var path := ProjectSettings.globalize_path(dir) if dir.begins_with("user://") else dir
	var r := apple.call_sync({"op": "exclude_from_backup", "path": path}, PKeyConstants.Feature.CORE_STORE)
	var ok: bool = r.get("ok", false) == true
	if ok:
		_excluded[dir] = true
	return ok


static func reset_for_tests() -> void:
	android_override = null
	apple_override = null
	_no_backup_dir = ""
	_excluded = {}


static func _android() -> PKeyAndroid:
	if android_override != null:
		return android_override if android_override.is_available() else null
	if PKeyHeaders.update_platform() != PKeyConstants.Platform.ANDROID:
		return null
	var a := PKeyAndroid.shared()
	return a if a.is_available() else null


static func _apple() -> PKeyApple:
	if apple_override != null:
		return apple_override if apple_override.is_available() else null
	if PKeyHeaders.update_platform() != PKeyConstants.Platform.IOS:
		return null
	var a := PKeyApple.shared()
	return a if a.is_available() else null
