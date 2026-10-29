class_name PKeyDeviceKeyStore
extends RefCounted
## The Godot device key store (CC-26.6; plans/CC-01.md R-5): custody of one device's Ed25519
## signing key and X25519 agreement key. Keys are made on first need and never leave the store:
## callers get public halves, signatures and shared secrets. Mirrors client-core's
## `DeviceKeyPort` and the Node, Python, Swift and Kotlin stores, in pure GDScript.
##
## GDScript has no exceptions, so every member answers a PKeyResult. What the other stores
## throw is a failure here, and the codes are the contract:
##
##   ok, detail = the value          success. `public_keys()` and `dh()` answer ok with a null
##                                   detail for "no keys yet" and "peer refused".
##   KEYS_UNREADABLE                 the record exists but cannot be used (wrong shape, wrong
##                                   length, public halves that do not match the private ones, or
##                                   a file the install key cannot open). NEVER replaced: only
##                                   `wipe()` resets it, so the device identity never changes
##                                   silently.
##   &"unsupported"                  this runtime cannot hold or use the keys (the curve code
##                                   fails its self-test, the engine cannot encrypt a file, a
##                                   memory-only store asked to register). Never reported for a
##                                   record that merely failed to parse.
##   STORE_FAULT                     an I/O fault, a lock that could not be taken, a refused
##                                   path. Nothing was changed, and nothing reads as "no keys".
##   NO_KEYS                         sign() before any keys exist.
##
## Rules this store keeps:
##
##  * `ensure`, `rotate` and `wipe` run under one process-wide mutex and, for the file store,
##    under a lock directory (`DirAccess.make_dir` is atomic: it fails if the directory exists),
##    so two stores in one process, and two game instances of one install, cannot both create a
##    pair or repeat a generation. A holder that died leaves its lock directory; one older than
##    LOCK_STALE_SECONDS (measured on the file system's own clock) is reclaimed by an atomic
##    rename-claim, and every lock carries a random token that is checked before the record is
##    replaced and before the lock is released. Residual limit: a holder frozen for longer than
##    the stale window can lose its lock; it then writes nothing (the token check) but a second
##    holder may have run meanwhile. Keep `user://` on a local disk.
##  * the record is replaced atomically (temporary file, owner-only permissions, rename), so a
##    reader sees the old record or the new one.
##  * `dh` refuses a low-order peer (every spelling) and an all-zero result.
##  * the private halves are held in PackedByteArrays for the length of one call and overwritten
##    afterwards. They are in no return value, `str()`, print or error text. GDScript cannot
##    wipe a String or promise that the allocator keeps no other copy: the record is binary, so
##    no secret is ever turned into a String here, but the overwrite is best effort and the
##    file is the protected place.
##  * randomness is `Crypto.generate_random_bytes`.
##
## Where the keys live (`protection()`):
##
##   "encrypted-file"  `user://pkey/<product>/device-keys`, written through the engine's
##                     `FileAccess.open_encrypted_with_pass`. The passphrase is derived from
##                     `OS.get_unique_id()`, the product and a random per-install salt kept beside
##                     the record. This keeps the keys out of a casual copy of the folder (a
##                     backup, a synced save directory, a support zip). It is OBFUSCATION, NOT
##                     protection: code running as the same user on the same machine can read the
##                     salt and the unique id too, so it can derive the passphrase and read the
##                     private keys. This is what Linux has (no native sealer); treat the keys as
##                     readable by anything that runs as the player. If the unique id changes (a new machine), the
##                     record no longer opens and reads as unreadable until `wipe()`.
##   "file"            what an encrypted store reports when `OS.get_unique_id()` is empty (some
##                     platforms have none): the passphrase then rests on the salt beside the
##                     record alone, which is obfuscation, so the store is `best_effort()` too.
##                     A store made with `for_tests` also reports "file": the record is a plain
##                     file with no encryption at all, for the test suites only.
##   "refused"         a store made with `encrypted = false` outside `for_tests`. The private keys
##                     are never written as a plain file: every member answers `invalid-options`
##                     (`public_keys()` and `sign()` included), and nothing is read, written or
##                     locked. The one exception is `wipe()`: it deletes a plain `device-keys`
##                     file an older build left in the directory (by name, never opened) and
##                     answers ok.
##   "memory"          process memory only. A memory store refuses to register keys unless the
##                     caller passes `allow_ephemeral`. A web build whose `user://` is not
##                     persistent is also "memory".
##
## On mobile and consoles the file store is BEST EFFORT (`best_effort()` is true): the app
## sandbox is the protection. The native lane replaces it there (CC-26.7, below).
##
## Native sealers (CC-26.7; plans/CC-01.md R-5 and Q12: software 25519 keys in hardware-wrapped
## storage). Where a native lane is present (PKeyRecordSealer: the Apple Keychain, the Android
## Keystore, Windows DPAPI) the store keeps making keys and signing in GDScript and uses the
## sealer in place of `open_encrypted_with_pass`: the record file is `"PKSL" || 0x01 || blob`,
## the blob sealed under a platform key that never leaves secure storage, bound to the product
## through the context `pkey-device-keys/1/<product>`. `protection()` is then
## `<sealer id>-sealed` ("keychain-sealed", "keystore-sealed", "dpapi-sealed"), `hardware_backed()`
## is true only where the key is known to be in secure hardware (iOS, and an Android key that reports it), and `best_effort()` is false. Linux has no sealer and keeps the
## engine-encrypted file. The rules above still hold, and these are added:
##
##  * a sealed record that cannot be opened (the platform key is gone or invalidated, the tag fails,
##    another Windows user) is KEYS_UNREADABLE and is never replaced; only `wipe()` resets it. A
##    fault that may pass (a locked Keychain, a Keystore provider error) is STORE_FAULT, never
##    "gone", and never leads to a new key.
##  * a sealed record read where the lane is missing (the plugin was removed) is `unsupported`,
##    never unreadable, and is left alone.
##  * with a sealer, a record that is not sealed (a CC-26.6 file written before the lane existed)
##    is unreadable too: it is not read through the weaker path, and `wipe()` clears it.
##  * `wipe()` removes the record and destroys the platform key (DPAPI has no per-product key).
##  * the sealer is chosen when the store is made: `sealer` is the one passed, else
##    PKeyRecordSealer.for_platform(product) for a file store with engine encryption on, unless
##    the environment sets PKEY_DESKTOP_KEYRING=0 (the test runner does, so no suite touches the
##    developer's Keychain). A sealer is never used by a memory store or a plain-file store.
## Raw keys are never written to `res://` or any path outside `user://`.

const KEYS_UNREADABLE := &"device-keys-unreadable"
const STORE_FAULT := &"device-keys-store-fault"
const NO_KEYS := &"device-keys-none"

const RECORD_FILE := "device-keys"
const SALT_FILE := "device-keys.salt"
const LOCK_DIR := "device-keys.lock"
const LOCK_STALE_SECONDS := 60
const _MAGIC := "PKDK"
const _SEALED_MAGIC := "PKSL"
const _SEALED_VERSION := 1
const _SEALED_MAX := 4096
const _VERSION := 1
const _RECORD_BYTES := 4 + 1 + 8 + 32 * 4
const _MAX_GENERATION := 9007199254740991
const _OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
const _OWNER_RWX := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER

static var _mutex := Mutex.new()
static var _curve_checked := false
static var _curve_ok := false

var product: String
var dir: String
## How long to wait for the file lock before answering STORE_FAULT (a test may shorten it).
var lock_wait_ms := 3000
## A lock older than this (by the file system's own clock) may be reclaimed. A test may shorten it.
var lock_stale_seconds := LOCK_STALE_SECONDS
## `OS.get_unique_id()`, read once. Empty on a platform that has none: the passphrase then rests on
## the salt alone, `protection()` says "file" and `best_effort()` is true. A test may set it.
var unique_id := OS.get_unique_id()
## The native sealer in use (null: the engine-encrypted file, CC-26.6).
var sealer: PKeyRecordSealer = null
var _memory: bool
## False when `root` is outside `user://`: raw keys are never written to a shared or exported path.
var _root_ok := true
## False when the product is not a canonical lower-case slug (the sealers accept no other): every member refuses with invalid-options.
var _slug_ok := true
var _encrypted: bool
## Set by `for_tests` alone: the record may rest in a plain file.
var _plain_ok := false
## The in-memory record of a memory store.
var _mem_record := PackedByteArray()
## SHA-256 of the last record whose public halves were checked against its private halves.
var _checked_digest := ""
## The token of the lock this store holds ("" when none).
var _lock_token := ""
## Set by _passphrase() when the salt cannot be read or made (a fault the caller reports).
var _salt_fault: PKeyResult = null


## A store for `product`. `root` is the parent directory, which must be under `user://` or the no-backup directory (PKeyBackupExclusion).
## `memory` keeps the keys in process memory only. `encrypted` turns the engine's file
## encryption on (the default) or off. `p_sealer` is a native sealer; null picks the platform's
## when its lane is present (see the header).
func _init(p_product: String, root := "user://pkey", memory := false, encrypted := true, p_sealer: PKeyRecordSealer = null) -> void:
	product = p_product
	dir = root.path_join(p_product)
	var name_ok := RegEx.create_from_string("\\A[A-Za-z0-9][A-Za-z0-9@._-]{0,127}\\z").search(p_product) != null
	_slug_ok = memory or RegEx.create_from_string("\\A[a-z0-9][a-z0-9._-]{0,63}(?:@[a-z0-9._-]{1,259})?\\z").search(p_product) != null
	_root_ok = name_ok and not p_product.contains("..") and PKeyBackupExclusion.is_private_root(root)
	_memory = memory
	_encrypted = encrypted
	if not memory and encrypted and _root_ok:
		sealer = p_sealer
		if sealer == null and OS.get_environment("PKEY_DESKTOP_KEYRING") != "0":
			sealer = PKeyRecordSealer.for_platform(p_product)


static func memory_only() -> PKeyDeviceKeyStore:
	return PKeyDeviceKeyStore.new("memory", "user://pkey", true)


## TEST ONLY: a store whose record rests in a plain file (no engine encryption, no sealer), so a suite
## can damage a record, read it back and restart a store over a scratch directory on a machine with
## no unique id. A shipped game builds a store with `new` (encrypted, the default) or takes the
## product's own; `new(..., false)` is refused.
static func for_tests(p_product: String, root := "user://pkey", memory := false) -> PKeyDeviceKeyStore:
	var s := PKeyDeviceKeyStore.new(p_product, root, memory, false)
	s._plain_ok = true
	return s


func _to_string() -> String:
	return "PKeyDeviceKeyStore(%s)" % protection()


## "durable" survives a restart, "memory" dies with the process; a memory store must not
## register keys.
func persistence() -> String:
	if _memory:
		return "memory"
	if OS.has_feature("web") and not OS.is_userfs_persistent():
		return "memory"
	return "durable"


func protection() -> String:
	if _plain_refused():
		return "refused"
	if _memory or persistence() == "memory":
		return "memory"
	if sealer != null:
		return sealer.id() + "-sealed"
	if _encrypted and unique_id != "":
		return "encrypted-file"
	return "file"


## A store made with `encrypted = false` that would put the private keys in a plain file, outside
## `for_tests`. It touches nothing.
func _plain_refused() -> bool:
	return not _memory and not _encrypted and not _plain_ok


func _refusal() -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "device keys: a store made with encrypted = false is refused; the private keys are never written as a plain file")


## True only when the sealer's key is known to be in secure hardware: the iOS data-protection
## keychain, or an Android Keystore key that reports secure hardware. The macOS login keychain and
## DPAPI are OS-protected but not reported as hardware.
func hardware_backed() -> bool:
	return sealer != null and sealer.hardware_backed()


## True on mobile and consoles, where this store is a fallback for the native lane (CC-26.7).
func best_effort() -> bool:
	if sealer != null and not _memory:
		return false
	if not _memory and _encrypted and unique_id == "":
		return true
	var os_name := OS.get_name()
	return os_name == "Android" or os_name == "iOS" or os_name == "visionOS" or OS.has_feature("mobile") \
			or OS.has_feature("console") or os_name == "Switch" or os_name == "PS5" or os_name == "Xbox"


# ── The port ─────────────────────────────────────────────────────────────────────────────

## The public keys, making the pair first if the store holds none. ok, detail
## {sign_key, agree_key, generation}.
func ensure() -> PKeyResult:
	return _locked(_ensure_locked)


## The public keys, or ok with a null detail when the store holds none. Never makes keys.
func public_keys() -> PKeyResult:
	if not _slug_ok:
		return _bad_slug()
	if _plain_refused():
		return _refusal()
	_mutex.lock()
	var r := _public_keys_locked()
	_mutex.unlock()
	return r


## The 64-byte Ed25519 signature by the signing key over `msg`. ok, detail PackedByteArray.
func sign(msg: PackedByteArray) -> PKeyResult:
	if not _slug_ok:
		return _bad_slug()
	if _plain_refused():
		return _refusal()
	_mutex.lock()
	var r := _sign_locked(msg)
	_mutex.unlock()
	return r


## X25519 with the agreement key and a peer's raw 32-byte public key. ok, detail the 32-byte
## shared secret; ok with a null detail when the peer key is refused (wrong length, low order,
## an all-zero result) or there are no keys.
func dh(peer_public: PackedByteArray) -> PKeyResult:
	if peer_public.size() != 32 or PKeyCurve25519.is_low_order(peer_public):
		return PKeyResult.success(null)
	if not _slug_ok:
		return _bad_slug()
	if _plain_refused():
		return _refusal()
	_mutex.lock()
	var r := _dh_locked(peer_public)
	_mutex.unlock()
	return r


## Replaces both keys with a new pair (`generation` + 1). ok, detail like ensure().
func rotate() -> PKeyResult:
	return _locked(_rotate_locked)


## Deletes both keys, whatever state the record is in. The next ensure() makes a new pair with
## `generation` starting again.
func wipe() -> PKeyResult:
	if _plain_refused():
		return _delete_plain_leftovers()
	return _locked(_wipe_locked)


## A refused store reads, writes and locks nothing, but an older build may have left a plain
## `device-keys` file (and its salt and temporary siblings) in this directory. `wipe()` deletes them:
## by name, never opened or read. Nothing exists and nothing is made when there is nothing to remove.
func _delete_plain_leftovers() -> PKeyResult:
	if not _slug_ok:
		return _bad_slug()
	if not _root_ok:
		return PKeyResult.failure(STORE_FAULT, "device keys: the store directory must be under user://")
	if not DirAccess.dir_exists_absolute(dir):
		return PKeyResult.success()
	var doomed: Array[String] = []
	for name in DirAccess.get_files_at(dir):
		if name == RECORD_FILE or name == SALT_FILE or name.begins_with(RECORD_FILE + ".tmp-"):
			doomed.append(name)
	for name in doomed:
		var err := DirAccess.remove_absolute(dir.path_join(name))
		if err != OK:
			return _fault("remove", err)
	return PKeyResult.success()


# ── Operations (the mutex, and the file lock where there is a file, are held) ────────────

func _ensure_locked() -> PKeyResult:
	var bad := _selftest()
	if bad != null:
		return bad
	var cur := _load()
	if not cur.ok:
		return cur
	if cur.detail != null:
		var rec: Dictionary = cur.detail
		var pub := _public_of(rec)
		_zero_record(rec)
		return PKeyResult.success(pub)
	return _write_new(1)


func _rotate_locked() -> PKeyResult:
	var bad := _selftest()
	if bad != null:
		return bad
	var cur := _load()
	if not cur.ok:
		return cur
	var gen := 1
	if cur.detail != null:
		var rec: Dictionary = cur.detail
		gen = int(rec["generation"]) + 1
		_zero_record(rec)
		if gen > _MAX_GENERATION:
			return PKeyResult.failure(KEYS_UNREADABLE, "device keys: the generation is exhausted")
	return _write_new(gen)


func _wipe_locked() -> PKeyResult:
	_checked_digest = ""
	if _memory:
		_mem_record.fill(0)
		_mem_record = PackedByteArray()
		return PKeyResult.success()
	var rec_path := dir.path_join(RECORD_FILE)
	for name in [RECORD_FILE, SALT_FILE]:
		var path := dir.path_join(name)
		if FileAccess.file_exists(path):
			if name == RECORD_FILE and not _encrypted:
				# A plain record: overwrite it before it is unlinked (best effort on a journaling disk).
				var z := FileAccess.open(path, FileAccess.READ_WRITE)
				if z != null:
					z.seek(0)
					var zeros := PackedByteArray()
					zeros.resize(_RECORD_BYTES)
					z.store_buffer(zeros)
					z.close()
			var err := DirAccess.remove_absolute(path)
			if err != OK:
				return _fault("remove", err)
	if FileAccess.file_exists(rec_path):
		return _fault("remove", ERR_FILE_CANT_WRITE)
	if sealer != null:
		# The record is gone; now the platform key. A failure leaves nothing readable, and a retry finishes.
		return sealer.destroy()
	return PKeyResult.success()


func _public_keys_locked() -> PKeyResult:
	var cur := _load()
	if not cur.ok or cur.detail == null:
		return cur
	var rec: Dictionary = cur.detail
	var pub := _public_of(rec)
	_zero_record(rec)
	return PKeyResult.success(pub)


func _sign_locked(msg: PackedByteArray) -> PKeyResult:
	var cur := _load()
	if not cur.ok:
		return cur
	if cur.detail == null:
		return PKeyResult.failure(NO_KEYS, "device keys: none yet")
	var rec: Dictionary = cur.detail
	var sig := PKeyCurve25519.ed25519_sign(rec["seed"], rec["sign_pub"], msg)
	_zero_record(rec)
	return PKeyResult.success(sig)


func _dh_locked(peer: PackedByteArray) -> PKeyResult:
	var cur := _load()
	if not cur.ok:
		return cur
	if cur.detail == null:
		return PKeyResult.success(null)
	var rec: Dictionary = cur.detail
	var secret := PKeyCurve25519.x25519(rec["agree_priv"], peer)
	_zero_record(rec)
	var any := 0
	for b in secret:
		any |= b
	if any == 0:
		return PKeyResult.success(null)
	return PKeyResult.success(secret)


# ── Records ──────────────────────────────────────────────────────────────────────────────

static func _public_of(rec: Dictionary) -> Dictionary:
	return {
		"sign_key": PKeyB64Url.encode(rec["sign_pub"]),
		"agree_key": PKeyB64Url.encode(rec["agree_pub"]),
		"generation": int(rec["generation"]),
	}


static func _zero_record(rec: Dictionary) -> void:
	# A typed variable shares the stored array; `(rec[k] as PackedByteArray).fill(0)` fills a copy.
	var seed: PackedByteArray = rec["seed"]
	seed.fill(0)
	var priv: PackedByteArray = rec["agree_priv"]
	priv.fill(0)


## Once per process: the curve code reproduces an RFC 7748 and an RFC 8032 vector, or this
## runtime is unsupported (never "the record is bad").
func _selftest() -> PKeyResult:  # null when the runtime is fine
	if not _curve_checked:
		var k := "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4".hex_decode()
		var u := "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c".hex_decode()
		var want := "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"
		var seed := "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60".hex_decode()
		var pub := "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
		_curve_ok = PKeyCurve25519.x25519(k, u).hex_encode() == want and PKeyCurve25519.ed25519_public(seed).hex_encode() == pub
		_curve_checked = true
	if not _curve_ok:
		return PKeyResult.unsupported("core.devicekeys", PKeyConstants.UnsupportedReason.RUNTIME, "device keys: the curve code failed its self-test")
	return null


func _write_new(generation: int) -> PKeyResult:
	var crypto := Crypto.new()
	var seed := crypto.generate_random_bytes(32)
	var agree_priv := crypto.generate_random_bytes(32)
	if seed.size() != 32 or agree_priv.size() != 32:
		return PKeyResult.unsupported("core.devicekeys", PKeyConstants.UnsupportedReason.RUNTIME, "device keys: no source of randomness")
	var rec := {
		"generation": generation,
		"seed": seed,
		"sign_pub": PKeyCurve25519.ed25519_public(seed),
		"agree_priv": agree_priv,
		"agree_pub": PKeyCurve25519.x25519_public(agree_priv),
	}
	if PKeyCurve25519.is_low_order(rec["agree_pub"]):
		_zero_record(rec)
		return PKeyResult.unsupported("core.devicekeys", PKeyConstants.UnsupportedReason.RUNTIME, "device keys: the curve code is inconsistent")
	var bytes := _encode(rec)
	var pub := _public_of(rec)
	_zero_record(rec)
	var w := _store(bytes)
	bytes.fill(0)
	if not w.ok:
		return w
	return PKeyResult.success(pub)


static func _encode(rec: Dictionary) -> PackedByteArray:
	var b := PackedByteArray()
	b.append_array(_MAGIC.to_ascii_buffer())
	b.append(_VERSION)
	var g: int = rec["generation"]
	for i in 8:
		b.append((g >> (56 - 8 * i)) & 0xff)
	b.append_array(rec["seed"])
	b.append_array(rec["sign_pub"])
	b.append_array(rec["agree_priv"])
	b.append_array(rec["agree_pub"])
	return b


## The record, or null when the bytes are not one of ours. The public halves are checked against
## the private ones once per distinct record (about 15 ms), so a damaged record is caught on its
## first use rather than signing garbage.
func _decode(bytes: PackedByteArray) -> Variant:
	if bytes.size() != _RECORD_BYTES or bytes.slice(0, 4).get_string_from_ascii() != _MAGIC or bytes[4] != _VERSION:
		return null
	var gen := 0
	for i in 8:
		gen = (gen << 8) | bytes[5 + i]
	if gen < 1 or gen > _MAX_GENERATION:
		return null
	var rec := {
		"generation": gen,
		"seed": bytes.slice(13, 45),
		"sign_pub": bytes.slice(45, 77),
		"agree_priv": bytes.slice(77, 109),
		"agree_pub": bytes.slice(109, 141),
	}
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	var digest := ctx.finish().hex_encode()
	if digest != _checked_digest:
		var ok: bool = PKeyCurve25519.ed25519_public(rec["seed"]) == rec["sign_pub"] \
				and PKeyCurve25519.x25519_public(rec["agree_priv"]) == rec["agree_pub"] \
				and not PKeyCurve25519.is_low_order(rec["agree_pub"])
		if not ok:
			_zero_record(rec)
			return null
		_checked_digest = digest
	return rec


## ok with the parsed record (a Dictionary), ok with null for "none", or the failure.
func _load() -> PKeyResult:
	var raw := _fetch()
	if not raw.ok or raw.detail == null:
		return raw
	var bytes: PackedByteArray = raw.detail
	var rec = _decode(bytes)
	bytes.fill(0)
	if rec == null:
		return PKeyResult.failure(KEYS_UNREADABLE, "device keys: the record is unreadable")
	return PKeyResult.success(rec)


# ── Storage ──────────────────────────────────────────────────────────────────────────────

func _bad_slug() -> PKeyResult:
	return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "device keys: the product must be a lower-case slug")


func _fault(what: String, err: int) -> PKeyResult:
	return PKeyResult.failure(STORE_FAULT, "device keys: could not %s the record (%s)" % [what, error_string(err)])




## The passphrase for the encrypted record: SHA-256 over the product, the engine's unique id and
## the per-install salt. Null when the salt cannot be read or made (see `_salt_fault`).
func _passphrase(create: bool) -> Variant:
	var salt_path := dir.path_join(SALT_FILE)
	var salt := PackedByteArray()
	if FileAccess.file_exists(salt_path):
		var f := FileAccess.open(salt_path, FileAccess.READ)
		if f == null:
			_salt_fault = _fault("open the salt of", FileAccess.get_open_error())
			return null
		salt = f.get_buffer(64)
		f.close()
		if salt.size() != 32:
			salt = PackedByteArray()
	if salt.is_empty():
		if not create:
			# A record exists but its salt does not: the record cannot be opened. Unreadable.
			return ""
		salt = Crypto.new().generate_random_bytes(32)
		var err := _write_file(SALT_FILE, salt, false)
		if err != OK:
			_salt_fault = _fault("write the salt of", err)
			return null
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(("pkey-device-keys/1\n%s\n%s\n" % [product, unique_id]).to_utf8_buffer())
	ctx.update(salt)
	return ctx.finish().hex_encode()


## ok with the raw record bytes, ok with null for none, or a failure.
func _fetch() -> PKeyResult:
	if _memory:
		if _mem_record.is_empty():
			return PKeyResult.success(null)
		return PKeyResult.success(_mem_record.duplicate())
	if not _root_ok:
		return PKeyResult.failure(STORE_FAULT, "device keys: the store directory must be under user://")
	var path := dir.path_join(RECORD_FILE)
	if not FileAccess.file_exists(path):
		return PKeyResult.success(null)
	return _fetch_file(path)


## The answer for a sealed record (or for a sealer that cannot read this file); null when the
## engine's own file path applies.
func _sealed_head(path: String) -> PKeyResult:
	var head := FileAccess.open(path, FileAccess.READ)
	if head == null:
		return _fault("open", FileAccess.get_open_error()) if sealer != null else null
	var raw := head.get_buffer(_SEALED_MAX + 1)
	head.close()
	if raw.size() >= 5 and raw.slice(0, 4).get_string_from_ascii() == _SEALED_MAGIC:
		return _fetch_sealed(raw)
	if sealer != null:
		# Not written by a sealer: not read through the weaker path, and never replaced.
		return PKeyResult.failure(KEYS_UNREADABLE, "device keys: the record is unreadable")
	return null


## The record file's bytes; the file exists.
func _fetch_file(path: String) -> PKeyResult:
	var sealed := _sealed_head(path)
	if sealed != null:
		return sealed
	var f: FileAccess = null
	if _encrypted:
		_salt_fault = null
		var passphrase = _passphrase(false)
		if passphrase == null:
			return _salt_fault
		if (passphrase as String) == "":
			return PKeyResult.failure(KEYS_UNREADABLE, "device keys: the record is unreadable")
		f = FileAccess.open_encrypted_with_pass(path, FileAccess.READ, passphrase)
	else:
		f = FileAccess.open(path, FileAccess.READ)
	if f == null:
		return _open_failure(FileAccess.get_open_error(), path)
	var bytes := f.get_buffer(_RECORD_BYTES + 1)
	var ferr := f.get_error()
	f.close()
	if ferr != OK and ferr != ERR_FILE_EOF:
		bytes.fill(0)
		return _fault("read", ferr)
	return PKeyResult.success(bytes)


## The bytes of a sealed record (`"PKSL" || version || blob`, read in full).
func _fetch_sealed(raw: PackedByteArray) -> PKeyResult:
	if sealer == null:
		return PKeyResult.unsupported("core.devicekeys", PKeyConstants.UnsupportedReason.DEPENDENCY, "device keys: this record is sealed by the platform lane, which is not in this build")
	if raw.size() > _SEALED_MAX or raw[4] != _SEALED_VERSION or raw.size() == 5:
		return PKeyResult.failure(KEYS_UNREADABLE, "device keys: the record is unreadable")
	return sealer.open(raw.slice(5), _seal_context())


func _seal_context() -> PackedByteArray:
	return ("pkey-device-keys/1/%s" % product).to_utf8_buffer()


## What a failed open means: a file this install key cannot open is unreadable (never replaced);
## an engine without encryption is unsupported; anything else is a fault.
func _open_failure(err: int, path: String) -> PKeyResult:
	var foreign := err == ERR_FILE_CORRUPT or err == ERR_FILE_UNRECOGNIZED or err == ERR_INVALID_DATA
	if _encrypted and (foreign or (err == ERR_FILE_CANT_OPEN and _looks_foreign(path))):
		return PKeyResult.failure(KEYS_UNREADABLE, "device keys: the record is unreadable")
	if err == ERR_UNAVAILABLE:
		return PKeyResult.unsupported("core.devicekeys", PKeyConstants.UnsupportedReason.RUNTIME, "device keys: this engine cannot read an encrypted file")
	return _fault("open", err)


## An encrypted record starts with the engine's "GDEC" magic; anything else was not written by
## this store.
static func _looks_foreign(path: String) -> bool:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return false
	var head := f.get_buffer(4)
	f.close()
	return head.get_string_from_ascii() != "GDEC"


func _ensure_dir() -> int:
	var err := DirAccess.make_dir_recursive_absolute(dir)
	if err != OK and not DirAccess.dir_exists_absolute(dir):
		return err
	if _unix():
		FileAccess.set_unix_permissions(dir, _OWNER_RWX)
	PKeyBackupExclusion.exclude(dir)
	return OK


static func _unix() -> bool:
	return OS.has_feature("macos") or OS.has_feature("linuxbsd")


## Temp file, owner-only, rename over the target. OK or the failing step's error.
func _write_file(file: String, bytes: PackedByteArray, encrypt: bool) -> int:
	var derr := _ensure_dir()
	if derr != OK:
		return derr
	var tmp_name := "%s.tmp-%s" % [file, Crypto.new().generate_random_bytes(6).hex_encode()]
	var tmp := dir.path_join(tmp_name)
	var f: FileAccess
	if encrypt:
		_salt_fault = null
		var passphrase = _passphrase(true)
		if passphrase == null:
			return ERR_FILE_CANT_WRITE
		f = FileAccess.open_encrypted_with_pass(tmp, FileAccess.WRITE, passphrase)
	else:
		f = FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return FileAccess.get_open_error()
	if _unix():
		FileAccess.set_unix_permissions(tmp, _OWNER_RW)
	f.store_buffer(bytes)
	var werr := f.get_error()
	f.close()
	if werr != OK:
		DirAccess.remove_absolute(tmp)
		return werr
	if _lock_token != "" and _read_token(dir.path_join(LOCK_DIR)) != _lock_token:
		# The lock was reclaimed under us (a holder frozen past the stale window): write nothing.
		DirAccess.remove_absolute(tmp)
		return ERR_LOCKED
	var d := DirAccess.open(dir)
	var rerr := d.rename(tmp_name, file) if d != null else DirAccess.get_open_error()
	if rerr != OK:
		DirAccess.remove_absolute(tmp)
	return rerr


func _store(bytes: PackedByteArray) -> PKeyResult:
	if _memory:
		_mem_record = bytes.duplicate()
		return PKeyResult.success()
	var file_bytes := bytes
	if sealer != null:
		var sealed := sealer.seal(bytes, _seal_context())
		if not sealed.ok:
			return sealed
		file_bytes = _SEALED_MAGIC.to_ascii_buffer()
		file_bytes.append(_SEALED_VERSION)
		file_bytes.append_array(sealed.detail)
	var err := _write_file(RECORD_FILE, file_bytes, _encrypted and sealer == null)
	if err == OK:
		return PKeyResult.success()
	if sealer == null and _salt_fault != null:
		return _salt_fault
	if err == ERR_UNAVAILABLE and _encrypted and sealer == null:
		return PKeyResult.unsupported("core.devicekeys", PKeyConstants.UnsupportedReason.RUNTIME, "device keys: this engine cannot write an encrypted file")
	return _fault("write", err)


# ── Locking ──────────────────────────────────────────────────────────────────────────────

## Runs `op` (an `() -> PKeyResult`) under the process mutex and, for the file store, the lock
## directory. A lock that cannot be taken is a store fault: nothing was changed.
func _locked(op: Callable) -> PKeyResult:
	if not _slug_ok:
		return _bad_slug()
	if _plain_refused():
		return _refusal()
	if not _memory and not _root_ok:
		return PKeyResult.failure(STORE_FAULT, "device keys: the store directory must be under user://")
	_mutex.lock()
	var r: PKeyResult
	if _memory:
		r = op.call()
	else:
		var got := _acquire()
		if got != OK:
			r = _fault("lock", got)
		else:
			_sweep_temporaries()
			r = op.call()
			_release()
	_mutex.unlock()
	return r


static func _token_path(lock: String) -> String:
	return lock.path_join("token")


static func _read_token(lock: String) -> String:
	var f := FileAccess.open(_token_path(lock), FileAccess.READ)
	if f == null:
		return ""
	var t := f.get_as_text()
	f.close()
	return t


static func _remove_tree(path: String) -> void:
	for name in DirAccess.get_files_at(path):
		DirAccess.remove_absolute(path.path_join(name))
	DirAccess.remove_absolute(path)


## The file system's own "now": the mtime of a fresh probe file, so a step of the wall clock can
## never make a live lock look old. 0 when it cannot be read.
func _fs_now() -> int:
	var probe := dir.path_join("%s.probe-%s" % [RECORD_FILE, Crypto.new().generate_random_bytes(6).hex_encode()])
	var f := FileAccess.open(probe, FileAccess.WRITE)
	if f == null:
		return 0
	f.store_8(0)
	f.close()
	var t := FileAccess.get_modified_time(probe)
	DirAccess.remove_absolute(probe)
	return t


## Take the lock directory. A stale one is reclaimed by an atomic claim: the directory is renamed
## to a unique name, and only the racer whose rename succeeds removes it and retries `make_dir`.
## An unreadable mtime (0, a failed stat) or probe is "retry", never "stale".
func _acquire() -> int:
	var derr := _ensure_dir()
	if derr != OK:
		return derr
	var lock := dir.path_join(LOCK_DIR)
	var token := Crypto.new().generate_random_bytes(16).hex_encode()
	var deadline := Time.get_ticks_msec() + lock_wait_ms
	while true:
		var err := DirAccess.make_dir_absolute(lock)
		if err == OK:
			var f := FileAccess.open(_token_path(lock), FileAccess.WRITE)
			if f == null:
				var ferr := FileAccess.get_open_error()
				DirAccess.remove_absolute(lock)
				return ferr
			f.store_string(token)
			f.close()
			_lock_token = token
			return OK
		if err != ERR_ALREADY_EXISTS:
			return err
		var mtime := FileAccess.get_modified_time(lock)
		var now := _fs_now()
		if mtime > 0 and now > 0 and now - mtime > lock_stale_seconds:
			var claimed := "%s.stale-%s" % [lock, Crypto.new().generate_random_bytes(6).hex_encode()]
			if DirAccess.rename_absolute(lock, claimed) == OK:
				_remove_tree(claimed)
			continue
		if Time.get_ticks_msec() > deadline:
			return ERR_BUSY
		OS.delay_msec(25)
	return ERR_BUSY


## Give the lock back only if it is still ours: check the token, rename the directory aside,
## check again, then remove it (renamed back if it turned out to be someone else's).
func _release() -> void:
	var lock := dir.path_join(LOCK_DIR)
	var mine := _lock_token
	_lock_token = ""
	if _read_token(lock) != mine:
		return
	var aside := "%s.release-%s" % [lock, Crypto.new().generate_random_bytes(6).hex_encode()]
	if DirAccess.rename_absolute(lock, aside) != OK:
		return
	if _read_token(aside) == mine:
		_remove_tree(aside)
	else:
		DirAccess.rename_absolute(aside, lock)


## Under the lock: remove temporary files an interrupted writer left. A plaintext one is
## overwritten with zeros first.
func _sweep_temporaries() -> void:
	for name in DirAccess.get_files_at(dir):
		if name.contains(".tmp-") or name.contains(".probe-"):
			var path := dir.path_join(name)
			if not _encrypted and name.begins_with(RECORD_FILE + ".tmp-"):
				var z := FileAccess.open(path, FileAccess.READ_WRITE)
				if z != null:
					var zeros := PackedByteArray()
					zeros.resize(maxi(int(z.get_length()), 1))
					z.store_buffer(zeros)
					z.close()
			DirAccess.remove_absolute(path)
