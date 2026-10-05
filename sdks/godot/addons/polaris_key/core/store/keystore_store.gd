class_name PKeyKeystoreStore
extends PKeyStore
## The Android store (P5-06): the device id and the `pkeyt_` token wrapped by an AndroidKeyStore
## AES-256-GCM key, through the Android platform plugin (PKeyAndroid), and the verified cache in
## the file store under `user://pkey/<product>/` (it is re-verified at every load, so it needs no
## secrecy).
##
## polaris-key-platform keeps one key per product (alias `pkey:<product>:device`, StrongBox where
## the device has it, else the TEE) and one blob per value in `noBackupFilesDir` (accounts `device`
## and `token`), never backed up: the key could not follow a blob to another device. When the key is
## lost or permanently invalidated (a lock-screen reset can do it), its values are dropped and a read
## answers `reset`: the store surfaces that (`failed`), the token is gone (the device activates
## again) and the device id comes back from the device file.
##
## Migration from the file store (an install that ran before the plugin was added): a token or
## device id found only in the files is moved into the Keystore on first read; the token file is
## then removed (a failed removal is surfaced and retried on every read). Failures are never
## swallowed: a failed Keystore operation sets `last_error`, emits `failed` and makes status()
## report `degraded: keyring-error`. The token is never written to a file instead (no silent
## downgrade); the device id stays in the device file too, so a Keystore fault does not mint a new
## device per launch.
##
## PKeyCore picks this store by default on Android when the plugin is present (preferred()); pass
## PKeyOptions.store to override.

const DEVICE_ACCOUNT := "device"
const TOKEN_ACCOUNT := "token"

var product: String
var android: PKeyAndroid
var files: PKeyFileStore
var _device_id := ""
var _keystore_error := ""


func _init(p_product: String, p_android: PKeyAndroid = null, root := "user://pkey") -> void:
	product = p_product
	android = p_android if p_android != null else PKeyAndroid.shared()
	files = PKeyFileStore.new(p_product, root)
	files.failed.connect(func(err: Dictionary) -> void:
		last_error = err
		failed.emit(err))


## The store PKeyCore uses when PKeyOptions.store is null: this one on Android with the plugin,
## else the file store.
static func preferred(p_product: String, root := "user://pkey") -> PKeyStore:
	if PKeyHeaders.update_platform() == PKeyConstants.Platform.ANDROID:
		var android := PKeyAndroid.shared()
		if android.is_available():
			return PKeyKeystoreStore.new(p_product, android, root)
	return PKeyFileStore.new(p_product, root)


func get_token() -> String:
	var r := android.keystore_get(product, TOKEN_ACCOUNT)
	if not r.ok:
		_keystore_fail("read", TOKEN_ACCOUNT, r)
		return ""
	_note_reset(r, TOKEN_ACCOUNT)
	var value = r.detail.get("value")
	if value is String and value != "":
		# A migration whose file delete failed: retry it on every read until it succeeds, so no
		# plaintext copy of the token stays behind.
		_remove_legacy_token()
		return value
	# Migrate a token the file store holds.
	var legacy := files.get_token()
	if legacy != "" and set_token(legacy):
		_remove_legacy_token()
	return legacy


func _remove_legacy_token() -> void:
	var path := files.path_of(PKeyFileStore.TOKEN_FILE)
	if not FileAccess.file_exists(path):
		return
	if not files.clear_token():
		_fail("remove", path, ERR_FILE_CANT_WRITE, "the token was moved into the Keystore but its file could not be removed; retried on the next read")


func set_token(token: String) -> bool:
	var r := android.keystore_set(product, TOKEN_ACCOUNT, token)
	if not r.ok:
		_keystore_fail("write", TOKEN_ACCOUNT, r)
		return false
	_keystore_error = ""
	return true


func clear_token() -> bool:
	var r := android.keystore_delete(product, TOKEN_ACCOUNT)
	var ok := r.ok
	if not ok:
		_keystore_fail("remove", TOKEN_ACCOUNT, r)
	return files.clear_token() and ok


func has_device_id() -> bool:
	if _device_id != "":
		return true
	var r := android.keystore_get(product, DEVICE_ACCOUNT)
	if not r.ok:
		_keystore_fail("read", DEVICE_ACCOUNT, r)
		return files.has_device_id()
	if r.detail.get("value") is String and r.detail["value"] != "":
		return true
	return files.has_device_id()


## The Keystore's id; else the device file's (moved into the Keystore); else a new one derived
## from PKeyDeviceId's raw source and stored. Write-once like the file store.
func get_device_id() -> String:
	if _device_id != "":
		return _device_id
	var r := android.keystore_get(product, DEVICE_ACCOUNT)
	if r.ok:
		_note_reset(r, DEVICE_ACCOUNT)
		var stored = r.detail.get("value")
		if stored is String and PKeyDeviceId.is_well_formed(stored):
			_device_id = stored
			return _device_id
		if stored is String and stored != "":
			_fail("read", _where(DEVICE_ACCOUNT), ERR_FILE_CORRUPT, "the Keystore's device id is malformed; it is left in place")
			_device_id = files.get_device_id()
			return _device_id
	else:
		_keystore_fail("read", DEVICE_ACCOUNT, r)
	# The file's id when there is one (a migration, or a reset key), else a new one (the file
	# store derives and writes it, which also keeps it if the Keystore write below fails).
	_device_id = files.get_device_id()
	if r.ok:
		var w := android.keystore_set(product, DEVICE_ACCOUNT, _device_id)
		if not w.ok:
			_keystore_fail("write", DEVICE_ACCOUNT, w)
	return _device_id


func read_cache() -> Variant:
	return files.read_cache()


func write_cache(record: Dictionary) -> bool:
	return files.write_cache(record)


func clear_cache() -> bool:
	return files.clear_cache()


func status() -> Dictionary:
	var s := {"backend": PKeyConstants.StoreBackend.KEYSTORE}
	if _keystore_error != "":
		s["degraded"] = {"reason": PKeyConstants.StoreDegradedReason.KEYRING_ERROR, "detail": _keystore_error}
	return s


func _where(account: String) -> String:
	return "keystore:pkey:%s/%s" % [product, account]


## A read that reports the key was lost: its values are gone. Surfaced once per read that saw it.
func _note_reset(r: PKeyResult, account: String) -> void:
	var reset = r.detail.get("reset") if r.detail is Dictionary else null
	if reset is String and reset != "":
		_fail("read", _where(account), ERR_FILE_NOT_FOUND, "the Keystore key was lost (%s); its stored values were dropped" % reset)


func _keystore_fail(op: String, account: String, r: PKeyResult) -> void:
	var reason = r.detail.get("reason") if r.detail is Dictionary else null
	_keystore_error = "Keystore %s of %s failed (%s)" % [op, account, str(reason) if reason != null else r.message]
	_fail(op, _where(account), ERR_UNAVAILABLE, _keystore_error)
