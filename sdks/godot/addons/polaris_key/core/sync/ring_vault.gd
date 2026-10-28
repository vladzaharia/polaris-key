@tool
class_name PKeySyncRingVault
extends RefCounted
## Where the Cloud Sync ring's pin and root live between launches (U-40.6; WIRE-CONTRACT-V5 §13.11).
## Two records beside the device keys, in `user://pkey/<product>/`:
##
##   `sync-ring-pin.json`  the pin `{product, ring_id, epoch, root_kid}`. No secret. Plain JSON,
##                         written owner-only, replaced atomically.
##   `sync-root`           the root `R`. With a native sealer (Keychain, Keystore, DPAPI) the file is
##                         `"PKSL" || 0x01 || blob`, sealed under the platform key with context
##                         `pkey-sync-root/1/<product>`. Without one it is the engine-encrypted file
##                         (key from `OS.get_unique_id()`, the product and a random salt kept
##                         beside it: obfuscation against a casual copy, not against code running as
##                         the same user), or a plain file when the engine cannot encrypt.
##   memory                both records in process memory only (web without a persistent `user://`,
##                         or a store made with `memory = true`).
##
## `persistence()` and `protection()` say which. Every call answers a PKeyResult. A stored root that
## cannot be opened is `device-keys-unreadable`, never replaced silently: only `clear()` removes it.
## `clear()` deletes the records and never destroys the platform key: the device keys share it.
## Nothing here puts a root in a result, message or `str()`.

const PIN_FILE := "sync-ring-pin.json"
const ROOT_FILE := "sync-root"
const SALT_FILE := "sync-root.salt"
const _MAGIC := "PKRT"
const _SEALED_MAGIC := "PKSL"
const _VERSION := 1
const _OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
const _OWNER_RWX := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER

var product: String
var dir: String
var sealer: PKeyRecordSealer = null
## `OS.get_unique_id()`; a test may set it.
var unique_id := OS.get_unique_id()
var _memory: bool
var _encrypted: bool
var _root_ok := true
var _mem_pin := PackedByteArray()
var _mem_root := PackedByteArray()


## `root_dir` must be under `user://` or the no-backup directory (PKeyBackupExclusion). `p_sealer` null picks the platform's when its lane is present
## (not in a memory store, a plain-file store, or when PKEY_DESKTOP_KEYRING=0).
func _init(p_product: String, root_dir := "user://pkey", memory := false, encrypted := true, p_sealer: PKeyRecordSealer = null) -> void:
	product = p_product
	dir = root_dir.path_join(p_product)
	_memory = memory
	_encrypted = encrypted
	var name_ok := RegEx.create_from_string("\\A[A-Za-z0-9][A-Za-z0-9@._-]{0,127}\\z").search(p_product) != null
	_root_ok = name_ok and not p_product.contains("..") and PKeyBackupExclusion.is_private_root(root_dir)
	if not memory and encrypted and _root_ok:
		sealer = p_sealer
		if sealer == null and OS.get_environment("PKEY_DESKTOP_KEYRING") != "0":
			sealer = PKeyRecordSealer.for_platform(p_product)


func _to_string() -> String:
	return "PKeySyncRingVault(%s)" % protection()


## "durable" survives a restart, "memory" dies with the process.
func persistence() -> String:
	if _memory or not _root_ok or _no_seal_possible():
		return "memory"
	if OS.has_feature("web") and not OS.is_userfs_persistent():
		return "memory"
	return "durable"


## No native sealer and no device id: the engine-encrypted file would be keyed by public inputs only
## (the product and a salt beside it), which is plaintext in effect. The root stays in memory (S-6).
func _no_seal_possible() -> bool:
	return sealer == null and _encrypted and unique_id == ""


func protection() -> String:
	if persistence() == "memory":
		return "memory"
	if sealer != null:
		return sealer.id() + "-sealed"
	if _encrypted and unique_id != "":
		return "encrypted-file"
	return "file"


# ── The pin ──────────────────────────────────────────────────────────────────────────────

## ok with the pin `{ring_id, epoch, root_kid}`, ok with a null detail for none, or a failure (a
## record that is not this product's pin).
func read_pin() -> PKeyResult:
	var raw := _read_plain(PIN_FILE, _mem_pin)
	if not raw.ok or raw.detail == null:
		return raw
	var parsed := PKeyJson.parse_bytes(raw.detail)
	var v: Variant = parsed.get("value") if parsed["ok"] else null
	if not (v is Dictionary):
		return _unreadable("the ring pin")
	var d: Dictionary = v
	if d.get("product") != product or not (d.get("ring_id") is String) or not (d.get("root_kid") is String) or not (d.get("epoch") is float or d.get("epoch") is int):
		return _unreadable("the ring pin")
	return PKeyResult.success({"ring_id": d["ring_id"], "epoch": int(d["epoch"]), "root_kid": d["root_kid"]})


func write_pin(pin: Dictionary) -> PKeyResult:
	var body := PKeyJson.stringify({"product": product, "ring_id": pin["ring_id"], "epoch": int(pin["epoch"]), "root_kid": pin["root_kid"]}).to_utf8_buffer()
	return _write_plain(PIN_FILE, body, true)


# ── The root ─────────────────────────────────────────────────────────────────────────────

## ok with `{ring_id, epoch, kid (hex), root (32 bytes)}`, ok with a null detail for none, or a
## failure (`device-keys-unreadable` for a record that can never open).
func read_root() -> PKeyResult:
	var raw := _read_root_bytes()
	if not raw.ok or raw.detail == null:
		return raw
	return _decode(raw.detail)


func write_root(ring_id: String, epoch: int, kid: PackedByteArray, root: PackedByteArray) -> PKeyResult:
	if ring_id.length() > 255 or kid.size() != 16 or root.size() != 32 or epoch < 0:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "sync root: bad record")
	var rec := _MAGIC.to_ascii_buffer()
	rec.append(_VERSION)
	rec.append_array(PackedByteArray([(epoch >> 24) & 0xFF, (epoch >> 16) & 0xFF, (epoch >> 8) & 0xFF, epoch & 0xFF, ring_id.length()]))
	rec.append_array(ring_id.to_ascii_buffer())
	rec.append_array(kid)
	rec.append_array(root)
	var r := _store_root(rec)
	rec.fill(0)
	return r


## Removes both records. A record that cannot be deleted is a failure, so a sign-out stops.
func clear() -> PKeyResult:
	_mem_pin = PackedByteArray()
	_mem_root = PackedByteArray()
	if _memory or not _root_ok:
		return PKeyResult.success()
	for f in [PIN_FILE, ROOT_FILE, SALT_FILE]:
		var p := dir.path_join(f)
		if FileAccess.file_exists(p):
			var err := DirAccess.remove_absolute(p)
			if err != OK:
				return PKeyResult.failure(PKeyDeviceKeyStore.STORE_FAULT, "sync ring: could not remove a record (%d)" % err)
	# A crash between write and rename leaves a temporary sibling; it holds the root too (S-5).
	var d := DirAccess.open(dir)
	if d != null:
		for name in d.get_files():
			for f in [PIN_FILE, ROOT_FILE, SALT_FILE]:
				if name.begins_with(f + ".tmp-"):
					var terr := DirAccess.remove_absolute(dir.path_join(name))
					if terr != OK:
						return PKeyResult.failure(PKeyDeviceKeyStore.STORE_FAULT, "sync ring: could not remove a record (%d)" % terr)
	return PKeyResult.success()


func _decode(b: PackedByteArray) -> PKeyResult:
	if b.size() < 4 + 1 + 5 + 16 + 32 or b.slice(0, 4).get_string_from_ascii() != _MAGIC or b[4] != _VERSION:
		return _unreadable("the sync root")
	var epoch := (b[5] << 24) | (b[6] << 16) | (b[7] << 8) | b[8]
	var n := b[9]
	if b.size() != 10 + n + 16 + 32:
		return _unreadable("the sync root")
	var ring_id := b.slice(10, 10 + n).get_string_from_ascii()
	var kid := b.slice(10 + n, 26 + n)
	var root := b.slice(26 + n)
	return PKeyResult.success({"ring_id": ring_id, "epoch": epoch, "kid": kid.hex_encode(), "root": root})


func _seal_context() -> PackedByteArray:
	return ("pkey-sync-root/1/%s" % product).to_utf8_buffer()


func _store_root(rec: PackedByteArray) -> PKeyResult:
	if _memory or not _root_ok or _no_seal_possible():
		_mem_root = rec.duplicate()
		return PKeyResult.success()
	var bytes := rec
	if sealer != null:
		var sealed := sealer.seal(rec, _seal_context())
		if not sealed.ok:
			return sealed
		bytes = _SEALED_MAGIC.to_ascii_buffer()
		bytes.append(_VERSION)
		bytes.append_array(sealed.detail)
	return _write_file(ROOT_FILE, bytes, _encrypted and sealer == null)


func _read_root_bytes() -> PKeyResult:
	if _memory or not _root_ok or _no_seal_possible():
		return PKeyResult.success(_mem_root.duplicate() if not _mem_root.is_empty() else null)
	var path := dir.path_join(ROOT_FILE)
	if not FileAccess.file_exists(path):
		return PKeyResult.success(null)
	if sealer != null:
		var f := FileAccess.open(path, FileAccess.READ)
		if f == null:
			return _fault("read", FileAccess.get_open_error())
		var raw := f.get_buffer(8192)
		f.close()
		if raw.size() <= 5 or raw.slice(0, 4).get_string_from_ascii() != _SEALED_MAGIC or raw[4] != _VERSION:
			return _unreadable("the sync root")
		return sealer.open(raw.slice(5), _seal_context())
	if _encrypted:
		var passphrase = _passphrase(false)
		if passphrase == null or passphrase == "":
			return _unreadable("the sync root")
		var f := FileAccess.open_encrypted_with_pass(path, FileAccess.READ, passphrase)
		if f == null:
			return _unreadable("the sync root")
		var raw := f.get_buffer(8192)
		f.close()
		return PKeyResult.success(raw)
	return _read_plain(ROOT_FILE, _mem_root)


func _read_plain(file: String, mem: PackedByteArray) -> PKeyResult:
	if _memory or not _root_ok:
		return PKeyResult.success(mem.duplicate() if not mem.is_empty() else null)
	var path := dir.path_join(file)
	if not FileAccess.file_exists(path):
		return PKeyResult.success(null)
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return _fault("read", FileAccess.get_open_error())
	var raw := f.get_buffer(8192)
	f.close()
	return PKeyResult.success(raw)


func _write_plain(file: String, bytes: PackedByteArray, _is_pin: bool) -> PKeyResult:
	if _memory or not _root_ok:
		_mem_pin = bytes.duplicate()
		return PKeyResult.success()
	return _write_file(file, bytes, false)


func _write_file(file: String, bytes: PackedByteArray, encrypt: bool) -> PKeyResult:
	var derr := DirAccess.make_dir_recursive_absolute(dir)
	if derr != OK and not DirAccess.dir_exists_absolute(dir):
		return _fault("write", derr)
	var unix := OS.has_feature("macos") or OS.has_feature("linuxbsd")
	if unix:
		FileAccess.set_unix_permissions(dir, _OWNER_RWX)
	PKeyBackupExclusion.exclude(dir)
	var tmp_name := "%s.tmp-%s" % [file, Crypto.new().generate_random_bytes(6).hex_encode()]
	var tmp := dir.path_join(tmp_name)
	var f: FileAccess
	if encrypt:
		var passphrase = _passphrase(true)
		if passphrase == null:
			return _fault("write the salt of", ERR_FILE_CANT_WRITE)
		f = FileAccess.open_encrypted_with_pass(tmp, FileAccess.WRITE, passphrase)
	else:
		f = FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return _fault("write", FileAccess.get_open_error())
	if unix:
		FileAccess.set_unix_permissions(tmp, _OWNER_RW)
	f.store_buffer(bytes)
	var werr := f.get_error()
	f.close()
	if werr != OK:
		DirAccess.remove_absolute(tmp)
		return _fault("write", werr)
	var d := DirAccess.open(dir)
	var rerr := d.rename(tmp_name, file) if d != null else DirAccess.get_open_error()
	if rerr != OK:
		DirAccess.remove_absolute(tmp)
		return _fault("write", rerr)
	return PKeyResult.success()


## The file passphrase, or null on a salt fault, or "" when no salt exists and `create` is false.
func _passphrase(create: bool) -> Variant:
	var salt_path := dir.path_join(SALT_FILE)
	var salt := PackedByteArray()
	if FileAccess.file_exists(salt_path):
		var f := FileAccess.open(salt_path, FileAccess.READ)
		if f == null:
			return null
		salt = f.get_buffer(64)
		f.close()
		if salt.size() != 32:
			salt = PackedByteArray()
	if salt.is_empty():
		if not create:
			return ""
		salt = Crypto.new().generate_random_bytes(32)
		var w := _write_file(SALT_FILE, salt, false)
		if not w.ok:
			return null
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(("pkey-sync-root/1\n%s\n%s\n" % [product, unique_id]).to_utf8_buffer())
	ctx.update(salt)
	return ctx.finish().hex_encode()


func _unreadable(what: String) -> PKeyResult:
	return PKeyResult.failure(PKeyDeviceKeyStore.KEYS_UNREADABLE, "sync ring: %s is unreadable" % what)


func _fault(what: String, err: int) -> PKeyResult:
	return PKeyResult.failure(PKeyDeviceKeyStore.STORE_FAULT, "sync ring: could not %s a record (%d)" % [what, err])
