extends RefCounted
## The Cloud Sync host's state file: the machine's journal (`persist()`), the catalog last served by
## `/config/schema` (so a relaunch routes settings before the first fetch) and the names of the
## person's open settings (so a blinded tombstone can be mapped back). A port of Python `state.py`.
##
## The file holds the WHOLE opened snapshot of the signed-in person's settings, so it is sealed
## (H-6, Q-6; CC-26.7's record form):
##
##   with a native sealer   `"PKCS" || 0x01 || blob`, the blob sealed under a platform key bound to
##                          the product through the context `pkey-cloud-sync/1/<product>`. A file
##                          without that prefix is unreadable and is not read through a weaker path.
##   without one            the engine-encrypted file (`open_encrypted_with_pass`, passphrase from the
##                          unique id, the product and a random per-install salt kept beside it).
##
## Either way the bytes are useless in another install's backup: the platform key does not leave the
## device, and the passphrase rests on the device's unique id. The folder is kept out of OS
## backups by PKeyBackupExclusion: the caller roots `state_dir` in `PKeyBackupExclusion.root()` (Android's
## no-backup directory) and the first write marks it excluded on iOS. The file is
## owner-only (0600) where the OS has modes, written to a random temporary name and renamed over the
## target. GDScript has no O_EXCL or O_NOFOLLOW; the random name and the rename stand in. The root is
## never written: the key ring keeps it in memory. A purge deletes this file (`remove`) first.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")

const FILE := "cloud-sync"
const SALT_FILE := "cloud-sync.salt"
const IMPORTED_FILE := "cloud-sync-imported.json"
## Open-setting names kept for tombstone mapping; past this the oldest are dropped.
const OPEN_KEYS_MAX := 4096
const _MAGIC := "PKCS"
const _VERSION := 1
const _MAX_BYTES := 64 * 1024 * 1024
const _OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
const _OWNER_RWX := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER

var dir: String
var product: String
## The native sealer in use (null: the engine-encrypted file).
var sealer: PKeyRecordSealer = null
## `OS.get_unique_id()`; a test may set it.
var unique_id := OS.get_unique_id()


func _init(p_dir: String, p_product: String, p_sealer: PKeyRecordSealer = null) -> void:
	dir = p_dir
	product = p_product
	sealer = p_sealer


static func is_catalog_shape(v: Variant) -> bool:
	return v is Dictionary and typeof(v.get("schemaVersion")) in [TYPE_INT, TYPE_FLOAT] and v.get("entries") is Array


func path() -> String:
	return dir.path_join(FILE)


func _empty() -> Dictionary:
	return {"v": 1, "product": product, "persisted": null, "catalog": null, "openKeys": []}


func _context() -> PackedByteArray:
	return ("pkey-cloud-sync/%d/%s" % [_VERSION, product]).to_utf8_buffer()


## The saved file, or an empty one when it is missing, corrupt, unreadable or another product's.
func load_file() -> Dictionary:
	var bytes: Variant = _read_plain()
	if bytes == null:
		return _empty()
	var text := (bytes as PackedByteArray).get_string_from_utf8()
	var parsed := Types.load_json_text(text)
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return _empty()
	var raw: Dictionary = parsed["value"]
	if raw.get("v") != 1 or raw.get("product") != product:
		return _empty()
	var out := _empty()
	var p: Variant = raw.get("persisted")
	if p is Dictionary and p.get("partitions") is Dictionary and p.get("hlc") is Array and typeof(p.get("contacted")) == TYPE_BOOL:
		out["persisted"] = p
	if is_catalog_shape(raw.get("catalog")):
		out["catalog"] = raw["catalog"]
	var keys: Variant = raw.get("openKeys")
	var names: Array = []
	if keys is Array:
		for k in keys:
			if k is String:
				names.append(k)
	out["openKeys"] = names.slice(maxi(0, names.size() - OPEN_KEYS_MAX))
	return out


## Seal and write the file. False on any failure (failing to persist never fails the call that
## produced it; the host logs a static string).
func save(file: Dictionary) -> bool:
	if sealer == null and unique_id == "":
		return false  # nothing to seal with: no journal is written (S-6)
	if not _ensure_dir():
		return false
	var plain := JSON.stringify(file, "", false).to_utf8_buffer()
	var tmp_name := "%s.tmp-%s" % [FILE, Crypto.new().generate_random_bytes(8).hex_encode()]
	var tmp := dir.path_join(tmp_name)
	if sealer != null:
		var sealed: PKeyResult = sealer.seal(plain, _context())
		if not sealed.ok:
			return false
		var record := (_MAGIC + char(_VERSION)).to_utf8_buffer()
		record.append_array(sealed.detail)
		var f := FileAccess.open(tmp, FileAccess.WRITE)
		if f == null:
			return false
		f.store_buffer(record)
		f.flush()
		var err := f.get_error()
		f.close()
		if err != OK:
			DirAccess.remove_absolute(tmp)
			return false
	else:
		var pass_ = _passphrase(true)
		if pass_ == null:
			return false
		var f := FileAccess.open_encrypted_with_pass(tmp, FileAccess.WRITE, pass_)
		if f == null:
			return false
		f.store_buffer(plain)
		f.flush()
		f.close()
	if _unix():
		FileAccess.set_unix_permissions(tmp, _OWNER_RW)
	var d := DirAccess.open(dir)
	if d == null or d.rename(tmp_name, FILE) != OK:
		DirAccess.remove_absolute(tmp)
		return false
	return true


## Delete the file and any temporary sibling. False if the file stays.
func remove() -> bool:
	var p := path()
	var ok := true
	if FileAccess.file_exists(p):
		ok = DirAccess.remove_absolute(p) == OK
	var d := DirAccess.open(dir)
	if d != null:
		for name in d.get_files():
			if name.begins_with(FILE + ".tmp-"):
				DirAccess.remove_absolute(dir.path_join(name))
	return ok


## "sealed" (a native sealer), "encrypted-file" (the engine's, keyed to this device) or "none" (no
## sealer and no device id: the journal is not written).
func protection() -> String:
	if sealer != null:
		return "sealed"
	return "encrypted-file" if unique_id != "" else "none"


func imported() -> bool:
	return FileAccess.file_exists(dir.path_join(IMPORTED_FILE))


func mark_imported() -> bool:
	if not _ensure_dir():
		return false
	var f := FileAccess.open(dir.path_join(IMPORTED_FILE), FileAccess.WRITE)
	if f == null:
		return false
	f.store_string("{\"v\":1}")
	f.close()
	return true


## The decrypted bytes, or null (missing, unreadable, a bad prefix, an oversized file).
func _read_plain() -> Variant:
	var p := path()
	if not FileAccess.file_exists(p):
		return null
	if sealer != null:
		var f := FileAccess.open(p, FileAccess.READ)
		if f == null or f.get_length() > _MAX_BYTES:
			return null
		var bytes := f.get_buffer(f.get_length())
		f.close()
		if bytes.size() < 6 or bytes.slice(0, 4).get_string_from_utf8() != _MAGIC or bytes[4] != _VERSION:
			return null
		var opened: PKeyResult = sealer.open(bytes.slice(5), _context())
		return opened.detail if opened.ok else null
	var pass_ = _passphrase(false)
	if pass_ == null:
		return null
	var f2 := FileAccess.open_encrypted_with_pass(p, FileAccess.READ, pass_)
	if f2 == null or f2.get_length() > _MAX_BYTES:
		return null
	var out := f2.get_buffer(f2.get_length())
	f2.close()
	return out


func _passphrase(create: bool) -> Variant:
	var sp := dir.path_join(SALT_FILE)
	var salt := PackedByteArray()
	if FileAccess.file_exists(sp):
		var f := FileAccess.open(sp, FileAccess.READ)
		if f == null:
			return null
		salt = f.get_buffer(f.get_length())
		f.close()
	if salt.size() != 16:
		if not create or not _ensure_dir():
			return null
		salt = Crypto.new().generate_random_bytes(16)
		var w := FileAccess.open(sp, FileAccess.WRITE)
		if w == null:
			return null
		w.store_buffer(salt)
		w.close()
		if _unix():
			FileAccess.set_unix_permissions(sp, _OWNER_RW)
	return ("pkey-cloud-sync/%s/%s/%s" % [product, unique_id, salt.hex_encode()]).sha256_text()


func _ensure_dir() -> bool:
	if not DirAccess.dir_exists_absolute(dir):
		var err := DirAccess.make_dir_recursive_absolute(dir)
		if err != OK and not DirAccess.dir_exists_absolute(dir):
			return false
		if _unix():
			FileAccess.set_unix_permissions(dir, _OWNER_RWX)
	# Every time (it asks the platform once per directory): the directory usually exists already.
	PKeyBackupExclusion.exclude(dir)
	return true


static func _unix() -> bool:
	return OS.has_feature("macos") or OS.has_feature("linuxbsd")
