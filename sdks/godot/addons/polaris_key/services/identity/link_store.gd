class_name PKeyLinkDeclinedStore
extends RefCounted
## The link offer's decline record (identity.link): which accounts said "not again" on this device.
## It holds `sha256(issuer || sub)` (base64url) for each, never the issuer, the subject or an email,
## newest last, at most 64. One file per product, `user://pkey/<product>/link.v1`, never in the clear:
##
##   sealed        with a native sealer (Keychain, Keystore, DPAPI) the file is `"PKSL" || 0x01 || blob`,
##                 sealed under the platform key with context `pkey-link/1 declined/<product>`.
##   encrypted     without one (Linux has none) it is the engine-encrypted file; that is OBFUSCATION,
##                 not protection (see PKeyConnectState, whose layout this follows).
##   memory        a store made with `memory = true`, a private root that is not private, or no sealer and
##                 no device id: the record dies with the process.
##
## A record that cannot be read answers `is_declined()` true: an offer nobody can account for is not
## made. `remember()` then replaces it. Every call that can fail answers a PKeyResult.

const FILE := "link.v1"
const SALT_FILE := "link.v1.salt"
const CAP := 64
const _SEALED_MAGIC := "PKSL"
const _SEALED_VERSION := 1
const _MAX_FILE_BYTES := 8192
const _OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
const _OWNER_RWX := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER

static var _hash_re: RegEx

var product: String
var dir: String
var sealer: PKeyRecordSealer = null
var unique_id := OS.get_unique_id()

var _memory: bool
var _root_ok := true
var _plain_ok := false
var _mem := PackedByteArray()


static func _static_init() -> void:
	_hash_re = PKeyClaims.whole("[A-Za-z0-9_-]{43}")


func _init(p_product: String, root := "user://pkey", memory := false, p_sealer: PKeyRecordSealer = null) -> void:
	product = p_product
	dir = root.path_join(p_product)
	_memory = memory
	var name_ok := PKeyClaims.whole("[A-Za-z0-9][A-Za-z0-9@._-]{0,127}").search(p_product) != null
	_root_ok = name_ok and not p_product.contains("..") and PKeyBackupExclusion.is_private_root(root)
	if not memory and _root_ok:
		sealer = p_sealer
		if sealer == null and not PKeyRecordSealer.switched_off():
			sealer = PKeyRecordSealer.for_platform(p_product)


## TEST ONLY: a store whose record rests in a plain file (no engine encryption, no sealer).
static func for_tests(p_product: String, root := "user://pkey", memory := false) -> PKeyLinkDeclinedStore:
	var s := PKeyLinkDeclinedStore.new(p_product, root, memory)
	s.sealer = null
	s.unique_id = ""
	s._plain_ok = true
	return s


func _to_string() -> String:
	return "PKeyLinkDeclinedStore(%s)" % protection()


func persistence() -> String:
	if _memory or not _root_ok or (sealer == null and unique_id == "" and not _plain_ok):
		return "memory"
	if OS.has_feature("web") and not OS.is_userfs_persistent():
		return "memory"
	return "durable"


## "keychain-sealed", "keystore-sealed" or "dpapi-sealed", "encrypted-file" (obfuscation), "memory", or
## "file" (tests only).
func protection() -> String:
	if persistence() == "memory":
		return "memory"
	if sealer != null:
		return sealer.id() + "-sealed"
	return "file" if _plain_ok else "encrypted-file"


## The held hashes, oldest first; null when the record exists and cannot be read.
func hashes() -> Variant:
	var raw := _read_bytes()
	if not raw.ok:
		return null
	if raw.detail == null:
		return []
	var bytes: PackedByteArray = raw.detail
	var out: Array = []
	for line in bytes.get_string_from_utf8().split("\n", false):
		if PKeyClaims.matches_whole_re(_hash_re, line) and not (line in out):
			out.append(line)
		else:
			return null
	return out


## True when `key` was declined here, or the record is unreadable (fail closed: no offer).
func is_declined(key: String) -> bool:
	var all: Variant = hashes()
	return all == null or key in all


## Add `key` (a base64url sha256). Oldest entries leave past the cap.
func remember(key: String) -> PKeyResult:
	if not PKeyClaims.matches_whole_re(_hash_re, key):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "link: the decline key is malformed")
	var all: Variant = hashes()
	if all == null:
		all = []
	if key in all:
		return PKeyResult.success()
	all.append(key)
	if all.size() > CAP:
		all = all.slice(all.size() - CAP)
	return _store_bytes("\n".join(PackedStringArray(all)).to_utf8_buffer())


## Remove the record (a failure when it cannot be deleted).
func clear() -> PKeyResult:
	_mem = PackedByteArray()
	if _memory or not _root_ok:
		return PKeyResult.success()
	for f in [FILE, SALT_FILE]:
		var p := dir.path_join(f)
		if FileAccess.file_exists(p) and DirAccess.remove_absolute(p) != OK:
			return _fault("remove")
	var d := DirAccess.open(dir)
	if d != null:
		for name in d.get_files():
			if name.begins_with(FILE + ".tmp-") and DirAccess.remove_absolute(dir.path_join(name)) != OK:
				return _fault("remove")
	return PKeyResult.success()


func _seal_context() -> PackedByteArray:
	return ("pkey-link/1 declined/%s" % product).to_utf8_buffer()


func _store_bytes(rec: PackedByteArray) -> PKeyResult:
	if persistence() == "memory":
		_mem = rec.duplicate()
		return PKeyResult.success()
	var bytes := rec
	if sealer != null:
		var sealed := sealer.seal(rec, _seal_context())
		if not sealed.ok:
			return sealed
		bytes = _SEALED_MAGIC.to_ascii_buffer()
		bytes.append(_SEALED_VERSION)
		bytes.append_array(sealed.detail)
	return _write_file(FILE, bytes, sealer == null and not _plain_ok)


func _read_bytes() -> PKeyResult:
	if persistence() == "memory":
		return PKeyResult.success(_mem.duplicate() if not _mem.is_empty() else null)
	var path := dir.path_join(FILE)
	if not FileAccess.file_exists(path):
		return PKeyResult.success(null)
	if sealer != null:
		return _read_sealed(path)
	if _plain_ok:
		return PKeyResult.success(FileAccess.get_file_as_bytes(path))
	return _read_encrypted(path)


func _read_sealed(path: String) -> PKeyResult:
	var raw := FileAccess.get_file_as_bytes(path)
	if raw.size() <= 5 or raw.slice(0, 4).get_string_from_ascii() != _SEALED_MAGIC or raw[4] != _SEALED_VERSION:
		return _unreadable()
	return sealer.open(raw.slice(5), _seal_context())


func _read_encrypted(path: String) -> PKeyResult:
	var passphrase: Variant = _passphrase(false)
	var f: FileAccess = null
	if passphrase != null and passphrase != "":
		f = FileAccess.open_encrypted_with_pass(path, FileAccess.READ, passphrase)
	if f == null:
		return _unreadable()
	var bytes := f.get_buffer(_MAX_FILE_BYTES)
	f.close()
	return PKeyResult.success(bytes)


func _write_file(file: String, bytes: PackedByteArray, encrypt: bool) -> PKeyResult:
	var derr := DirAccess.make_dir_recursive_absolute(dir)
	if derr != OK and not DirAccess.dir_exists_absolute(dir):
		return _fault("write")
	var unix := OS.has_feature("macos") or OS.has_feature("linuxbsd")
	if unix:
		FileAccess.set_unix_permissions(dir, _OWNER_RWX)
	PKeyBackupExclusion.exclude(dir)
	var tmp_name := "%s.tmp-%s" % [file, Crypto.new().generate_random_bytes(6).hex_encode()]
	var tmp := dir.path_join(tmp_name)
	var f: FileAccess
	if encrypt:
		var passphrase: Variant = _passphrase(true)
		if passphrase == null:
			return _fault("write")
		f = FileAccess.open_encrypted_with_pass(tmp, FileAccess.WRITE, passphrase)
	else:
		f = FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return _fault("write")
	if unix:
		FileAccess.set_unix_permissions(tmp, _OWNER_RW)
	f.store_buffer(bytes)
	var werr := f.get_error()
	f.close()
	if werr != OK:
		DirAccess.remove_absolute(tmp)
		return _fault("write")
	var d := DirAccess.open(dir)
	if d == null or d.rename(tmp_name, file) != OK:
		DirAccess.remove_absolute(tmp)
		return _fault("write")
	return PKeyResult.success()


## The file passphrase, or null on a salt fault, or "" when no salt exists and `create` is false.
func _passphrase(create: bool) -> Variant:
	var salt_path := dir.path_join(SALT_FILE)
	var salt := PackedByteArray()
	if FileAccess.file_exists(salt_path):
		salt = FileAccess.get_file_as_bytes(salt_path)
		if salt.size() != 32:
			salt = PackedByteArray()
	if salt.is_empty():
		if not create:
			return ""
		salt = Crypto.new().generate_random_bytes(32)
		if not _write_file(SALT_FILE, salt, false).ok:
			return null
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(("pkey-link/1\n%s\n%s\n" % [product, unique_id]).to_utf8_buffer())
	ctx.update(salt)
	return ctx.finish().hex_encode()


func _unreadable() -> PKeyResult:
	return PKeyResult.failure(PKeyDeviceKeyStore.KEYS_UNREADABLE, "link: the decline record is unreadable")


func _fault(what: String) -> PKeyResult:
	return PKeyResult.failure(PKeyDeviceKeyStore.STORE_FAULT, "link: could not %s the decline record" % what)
