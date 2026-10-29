@tool
class_name PKeyConnectState
extends RefCounted
## The Cloud Connect state record, `pkey.connect.v1` (CC-14.4, D-7; WIRE-CONTRACT-V5 sections 15.3
## and 15.4), ported from sdk-node `connect/state.ts` and Kotlin's `ConnectStateRecord`.
##
## The held roster and certificate as the compact JWSs the Worker signed, and K_disc, the discovery
## key(s), which is a secret of the same standing as the device keys. One record per product,
## `user://pkey/<product>/connect.v1`, never in the clear:
##
##   sealed        with a native sealer (Keychain, Keystore, DPAPI) the file is `"PKSL" || 0x01 ||
##                 blob`, sealed under the platform key with context `pkey-connect/1 state`.
##   encrypted     without one (Linux has none) it is the engine-encrypted file; that is OBFUSCATION,
##                 not protection (its key derives from `OS.get_unique_id()`, the product and a salt
##                 beside the file), as for the Sync root (`PKeySyncRingVault`).
##   memory        a store made with `memory = true`, a private root that is not private, or no
##                 sealer and no device id: the record dies with the process.
##
## A record that exists but cannot be used is `device-keys-unreadable`, never silently replaced
## (replacing it would forget the held roster); only `clear()` removes it, and it never destroys the
## platform key (the device keys share it, R-6a #1, #6). Every call answers a PKeyResult. Nothing
## here puts K_disc in a result, message or `str()`.

const SCHEMA := "pkey.connect.v1"
const FILE := "connect.v1"
const SALT_FILE := "connect.v1.salt"
const _SEALED_MAGIC := "PKSL"
const _SEALED_VERSION := 1
const _MAX_FILE_BYTES := 16384
const _OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
const _OWNER_RWX := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER \
		| FileAccess.UNIX_EXECUTE_OWNER

static var _key_re: RegEx

var product: String
var dir: String
var sealer: PKeyRecordSealer = null
var unique_id := OS.get_unique_id()

var _memory: bool
var _root_ok := true
var _plain_ok := false
var _mem := PackedByteArray()


static func _static_init() -> void:
	_key_re = PKeyClaims.whole("[A-Za-z0-9_-]{43}")


func _init(p_product: String, root := "user://pkey", memory := false,
		p_sealer: PKeyRecordSealer = null) -> void:
	product = p_product
	dir = root.path_join(p_product)
	_memory = memory
	var name_ok := PKeyClaims.whole("[A-Za-z0-9][A-Za-z0-9@._-]{0,127}").search(p_product) != null
	_root_ok = name_ok and not p_product.contains("..") and PKeyBackupExclusion.is_private_root(root)
	if not memory and _root_ok:
		sealer = p_sealer
		if sealer == null and OS.get_environment("PKEY_DESKTOP_KEYRING") != "0":
			sealer = PKeyRecordSealer.for_platform(p_product)


## TEST ONLY: a store whose record rests in a plain file (no engine encryption, no sealer), so a
## suite can restart a client over a scratch directory on a machine with no unique id.
static func for_tests(p_product: String, root := "user://pkey", memory := false) -> PKeyConnectState:
	var s := PKeyConnectState.new(p_product, root, memory)
	s.sealer = null
	s.unique_id = ""
	s._plain_ok = true
	return s


func _to_string() -> String:
	return "PKeyConnectState(%s)" % protection()


## "durable" survives a restart, "memory" dies with the process.
func persistence() -> String:
	if _memory or not _root_ok or _no_seal_possible():
		return "memory"
	if OS.has_feature("web") and not OS.is_userfs_persistent():
		return "memory"
	return "durable"


## "keychain-sealed", "keystore-sealed" or "dpapi-sealed" (protection), "encrypted-file"
## (OBFUSCATION, see the header), "memory", or "file" (tests only).
func protection() -> String:
	if persistence() == "memory":
		return "memory"
	if sealer != null:
		return sealer.id() + "-sealed"
	return "file" if _plain_ok else "encrypted-file"


## ok with the held Record, ok with a null detail for none, or a failure (a record that is unusable).
func read() -> PKeyResult:
	var raw := _read_bytes()
	if not raw.ok or raw.detail == null:
		return raw
	var bytes: PackedByteArray = raw.detail
	var rec := Record.parse(bytes)
	bytes.fill(0)
	if rec == null:
		return _unreadable()
	return PKeyResult.success(rec)


## Store `rec` in place of the held record.
func write(rec: Record) -> PKeyResult:
	var bytes := rec.encode()
	var r := _store_bytes(bytes)
	bytes.fill(0)
	return r


## Remove the record. One that cannot be deleted is a failure, so a sign-out stops (fail closed).
func clear() -> PKeyResult:
	_mem = PackedByteArray()
	if _memory or not _root_ok:
		return PKeyResult.success()
	for f in [FILE, SALT_FILE]:
		var p := dir.path_join(f)
		if FileAccess.file_exists(p) and DirAccess.remove_absolute(p) != OK:
			return _fault("remove")
	# A crash between write and rename leaves a temporary sibling; it holds K_disc too.
	var d := DirAccess.open(dir)
	if d != null:
		for name in d.get_files():
			if name.begins_with(FILE + ".tmp-") and DirAccess.remove_absolute(dir.path_join(name)) != OK:
				return _fault("remove")
	return PKeyResult.success()


func _no_seal_possible() -> bool:
	return sealer == null and unique_id == "" and not _plain_ok


func _seal_context() -> PackedByteArray:
	return "pkey-connect/1 state".to_utf8_buffer()


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
	if raw.size() <= 5 or raw.slice(0, 4).get_string_from_ascii() != _SEALED_MAGIC \
			or raw[4] != _SEALED_VERSION:
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
	ctx.update(("pkey-connect/1\n%s\n%s\n" % [product, unique_id]).to_utf8_buffer())
	ctx.update(salt)
	return ctx.finish().hex_encode()


func _unreadable() -> PKeyResult:
	return PKeyResult.failure(PKeyDeviceKeyStore.KEYS_UNREADABLE, "connect: the state record is unreadable")


func _fault(what: String) -> PKeyResult:
	return PKeyResult.failure(PKeyDeviceKeyStore.STORE_FAULT, "connect: could not %s the state record" % what)


## What is held for one device and one product. Never printed.
class Record extends RefCounted:
	var product := ""
	var device_id := ""
	## The `pkey-ring+jws` held (verified when it was stored, and again when it is used).
	var ring := ""
	## This device's `pkey-peer+jws`.
	var certificate := ""
	## K_disc, newest first: the current key, then at most one previous key (canonical base64url).
	var disc_keys: Array[String] = []
	## The latest instant (seconds) the previous key may be used; -1 when there is none.
	var prev_until := -1
	## The epoch of the roster the keys belong to.
	var epoch := 0
	## The keys this device registered with the Worker ("" when unknown), so an unchanged pair is not
	## re-sent.
	var registered_sign := ""
	var registered_agree := ""
	var stored_at := 0
	## A pushed roster removed a device, so K_disc was replaced at the Worker and this copy is stale
	## until the next identity fetch brings the new one (G11, G12).
	var keys_stale := false

	func _to_string() -> String:
		return "PKeyConnectState.Record(redacted)"

	func duplicate_record() -> Record:
		var r := Record.new()
		r.product = product
		r.device_id = device_id
		r.ring = ring
		r.certificate = certificate
		r.disc_keys = disc_keys.duplicate()
		r.prev_until = prev_until
		r.epoch = epoch
		r.registered_sign = registered_sign
		r.registered_agree = registered_agree
		r.stored_at = stored_at
		r.keys_stale = keys_stale
		return r

	func encode() -> PackedByteArray:
		var o := {
			"schema": SCHEMA,
			"product": product,
			"deviceId": device_id,
			"ring": ring,
			"certificate": certificate,
			"discKeys": disc_keys.duplicate(),
			"prevUntil": null if prev_until < 0 else prev_until,
			"epoch": epoch,
			"registered": null,
			"storedAt": stored_at,
		}
		if registered_sign != "" and registered_agree != "":
			o["registered"] = {"signKey": registered_sign, "agreeKey": registered_agree}
		if keys_stale:
			o["keysStale"] = true
		return PKeyJson.stringify(o).to_utf8_buffer()

	## Strict parse; null when the bytes are not a record of this schema.
	static func parse(raw: PackedByteArray) -> Record:
		var parsed := PKeyJson.parse_bytes(raw)
		if not parsed["ok"] or not parsed["value"] is Dictionary:
			return null
		var v: Dictionary = parsed["value"]
		var nw: PKeyJson.PointerSet = parsed["non_wire_integers"]
		if v.get("schema") != SCHEMA:
			return null
		for k in ["product", "deviceId", "ring", "certificate"]:
			if not v.get(k) is String:
				return null
		var keys: Variant = v.get("discKeys")
		if not keys is Array or (keys as Array).size() < 1 or (keys as Array).size() > 2:
			return null
		for k in keys:
			if not k is String or not PKeyClaims.matches_whole_re(PKeyConnectState._key_re, k):
				return null
		var prev: Variant = v.get("prevUntil")
		if prev != null and not PKeyClaims.is_wire_integer(prev, "/prevUntil", 0, nw):
			return null
		if not PKeyClaims.is_wire_integer(v.get("epoch"), "/epoch", 0, nw) \
				or not PKeyClaims.is_wire_integer(v.get("storedAt"), "/storedAt", 0, nw):
			return null
		var rec := Record.new()
		var reg: Variant = v.get("registered")
		if reg != null:
			if not reg is Dictionary or not (reg as Dictionary).get("signKey") is String \
					or not (reg as Dictionary).get("agreeKey") is String:
				return null
			rec.registered_sign = reg["signKey"]
			rec.registered_agree = reg["agreeKey"]
		rec.product = v["product"]
		rec.device_id = v["deviceId"]
		rec.ring = v["ring"]
		rec.certificate = v["certificate"]
		for k in keys:
			rec.disc_keys.append(k)
		rec.prev_until = -1 if prev == null else int(prev)
		rec.epoch = int(v["epoch"])
		rec.stored_at = int(v["storedAt"])
		rec.keys_stale = v.get("keysStale") == true
		return rec
