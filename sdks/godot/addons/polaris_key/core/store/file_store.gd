class_name PKeyFileStore
extends PKeyStore
## The default store: three files under `user://pkey/<product>/` (notes/A2 §12):
##
##   device        the 32-character device id, written ONCE
##   token         the `pkeyt_` bearer
##   managed.json  the CacheRecordV3 (signed artifacts, ETags, two unsigned hints)
##
## Every write goes to a temporary file in the same directory, is set to 0600 (macOS, Linux and
## the BSDs), and is renamed over the target, so a reader sees the old file or the new one and
## never half of one, and a symlink planted at the target is replaced rather than followed. The
## directory is 0700 there. Windows relies on the per-user profile ACL, mobile on the app
## sandbox.
##
## Web: `user://` is IndexedDB, persistent only when the browser allows it
## (`OS.is_userfs_persistent()`); `status()` reports `degraded: not-persistent` then. A cleared
## store means a new device id.
##
## Integrity comes entirely from re-verification at load (PKeyCache); no file here is trusted.

const DEVICE_FILE := "device"
const TOKEN_FILE := "token"
const CACHE_FILE := "managed.json"
const _OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
const _OWNER_RWX := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER

var product: String
var dir: String
var _device_id := ""
var _dir_ready := false


func _init(p_product: String, root := "user://pkey") -> void:
	product = p_product
	dir = root.path_join(p_product)


func path_of(file: String) -> String:
	return dir.path_join(file)


func get_token() -> String:
	var text = _read(TOKEN_FILE)
	return (text as String).strip_edges() if text is String else ""


func set_token(token: String) -> bool:
	return _write(TOKEN_FILE, token)


func clear_token() -> bool:
	return _remove(TOKEN_FILE)


func has_device_id() -> bool:
	return _device_id != "" or FileAccess.file_exists(path_of(DEVICE_FILE))


## Write-once: an existing well-formed id is returned as stored. Without one, an id is derived
## from PKeyDeviceId's raw source and written; a failed write is surfaced (`failed`) and the id
## is kept in memory for this session. A malformed stored id is surfaced and left in place.
func get_device_id() -> String:
	if _device_id != "":
		return _device_id
	var path := path_of(DEVICE_FILE)
	if FileAccess.file_exists(path):
		var text = _read(DEVICE_FILE)
		if text is String and PKeyDeviceId.is_well_formed((text as String).strip_edges()):
			_device_id = (text as String).strip_edges()
			return _device_id
		if text is String:
			_fail("read", path, ERR_FILE_CORRUPT, "the stored device id is malformed; it is left in place")
		_device_id = PKeyDeviceId.derive(product)
		return _device_id
	_device_id = PKeyDeviceId.derive(product)
	_write(DEVICE_FILE, _device_id)
	return _device_id


func read_cache() -> Variant:
	var text = _read(CACHE_FILE)
	if not (text is String):
		return null
	var parsed := PKeyJson.parse(text)
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return null
	return parsed["value"]


func write_cache(record: Dictionary) -> bool:
	return _write(CACHE_FILE, PKeyJson.stringify(record))


func clear_cache() -> bool:
	return _remove(CACHE_FILE)


func status() -> Dictionary:
	var s := {"backend": "indexeddb" if OS.has_feature("web") else "file"}
	if not OS.is_userfs_persistent():
		s["degraded"] = {"reason": "not-persistent", "detail": "user:// may not survive a restart in this browser"}
	return s


static func _unix() -> bool:
	return OS.has_feature("macos") or OS.has_feature("linuxbsd")


func _ensure_dir() -> bool:
	if _dir_ready:
		return true
	var err := DirAccess.make_dir_recursive_absolute(dir)
	if err != OK and not DirAccess.dir_exists_absolute(dir):
		_fail("mkdir", dir, err, "cannot create the store directory")
		return false
	if _unix():
		FileAccess.set_unix_permissions(dir, _OWNER_RWX)
	_dir_ready = true
	return true


## The file's text; null when it does not exist (not an error) or cannot be read (an error).
func _read(file: String) -> Variant:
	var path := path_of(file)
	if not FileAccess.file_exists(path):
		return null
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		_fail("read", path, FileAccess.get_open_error(), "cannot open %s" % file)
		return null
	var text := f.get_as_text()
	f.close()
	return text


## Temp file, 0600, rename over the target. False (and `failed`) on any step's failure.
func _write(file: String, text: String) -> bool:
	if not _ensure_dir():
		return false
	var path := path_of(file)
	var tmp_name := "%s.tmp-%s" % [file, Crypto.new().generate_random_bytes(6).hex_encode()]
	var tmp := path_of(tmp_name)
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		_fail("write", path, FileAccess.get_open_error(), "cannot create a temporary file for %s" % file)
		return false
	f.store_string(text)
	var werr := f.get_error()
	f.close()
	if werr != OK:
		DirAccess.remove_absolute(tmp)
		_fail("write", path, werr, "cannot write %s" % file)
		return false
	if _unix():
		var perr := FileAccess.set_unix_permissions(tmp, _OWNER_RW)
		if perr != OK:
			DirAccess.remove_absolute(tmp)
			_fail("chmod", path, perr, "cannot make %s owner-only" % file)
			return false
	var d := DirAccess.open(dir)
	var rerr := d.rename(tmp_name, file) if d != null else DirAccess.get_open_error()
	if rerr != OK:
		DirAccess.remove_absolute(tmp)
		_fail("rename", path, rerr, "cannot replace %s" % file)
		return false
	return true


func _remove(file: String) -> bool:
	var path := path_of(file)
	if not FileAccess.file_exists(path):
		return true
	var err := DirAccess.remove_absolute(path)
	if err != OK:
		_fail("remove", path, err, "cannot remove %s" % file)
		return false
	return true
