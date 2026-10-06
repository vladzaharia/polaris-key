class_name PKeyKeychainStore
extends PKeyStore
## The iOS store (P5-05): the device id and the `pkeyt_` token in the Keychain, through the Apple
## platform plugin (PKeyApple), and the verified cache in the file store under
## `user://pkey/<product>/` (it is re-verified at every load, so it needs no secrecy).
##
## Keychain items are generic passwords under service `pkey:<product>` (accounts `device` and
## `token`) in the data-protection keychain, `AfterFirstUnlockThisDeviceOnly`, with no access
## group (notes/S-09 §Results 3). The Keychain is the device id's source of truth: a reinstall
## removes `user://` but, on the simulator at least, keeps Keychain items, so "Keychain present,
## file absent" is a reinstall, not a new device.
##
## Migration from the file store (an install that ran before the plugin was added): a token or
## device id found only in the files is moved into the Keychain on first read; the token file is
## then removed (a failed removal is surfaced and retried on every read). Failures are never swallowed: a failed Keychain operation sets `last_error`,
## emits `failed` and makes status() report `degraded: keyring-error`. The token is never written
## to a file instead (no silent downgrade); a device id that cannot be stored in the Keychain is
## kept in the device file, so a Keychain fault does not mint a new device per launch.
##
## PKeyCore picks this store by default on iOS when the plugin is present (preferred()); pass
## PKeyOptions.store to override.

const DEVICE_ACCOUNT := "device"
const TOKEN_ACCOUNT := "token"

var product: String
var apple: PKeyApple
var files: PKeyFileStore
var _device_id := ""
var _keychain_error := ""


func _init(p_product: String, p_apple: PKeyApple = null, root := "user://pkey") -> void:
	product = p_product
	apple = p_apple if p_apple != null else PKeyApple.shared()
	files = PKeyFileStore.new(p_product, root)
	files.failed.connect(func(err: Dictionary) -> void:
		last_error = err
		failed.emit(err))


## The store PKeyCore uses when PKeyOptions.store is null: this one on iOS with the Apple plugin,
## else PKeyKeystoreStore.preferred() (the Keystore store on Android with its plugin, the keyring
## store on macOS, Windows and Linux, else the file store).
static func preferred(p_product: String, root := "user://pkey") -> PKeyStore:
	if PKeyHeaders.platform() == PKeyConstants.Platform.IOS:
		var apple := PKeyApple.shared()
		if apple.is_available():
			return PKeyKeychainStore.new(p_product, apple, root)
	# Elsewhere: the Keystore store on Android with its plugin (P5-06), the keyring store on the
	# desktops (SP-27), else the file store.
	return PKeyKeystoreStore.preferred(p_product, root)


func get_token() -> String:
	var r := apple.keychain_get(product, TOKEN_ACCOUNT)
	if not r.ok:
		_keychain_fail("read", TOKEN_ACCOUNT, r)
		return ""
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


## Delete the file store's token file after the token reached the Keychain. A failure is
## surfaced (`failed`) and retried by the next get_token().
func _remove_legacy_token() -> void:
	var path := files.path_of(PKeyFileStore.TOKEN_FILE)
	if not FileAccess.file_exists(path):
		return
	if not files.clear_token():
		_fail("remove", path, ERR_FILE_CANT_WRITE, "the token was moved into the Keychain but its file could not be removed; retried on the next read")


func set_token(token: String) -> bool:
	var r := apple.keychain_set(product, TOKEN_ACCOUNT, token)
	if not r.ok:
		_keychain_fail("write", TOKEN_ACCOUNT, r)
		return false
	_keychain_error = ""
	return true


func clear_token() -> bool:
	var r := apple.keychain_delete(product, TOKEN_ACCOUNT)
	var ok := r.ok
	if not ok:
		_keychain_fail("remove", TOKEN_ACCOUNT, r)
	return files.clear_token() and ok


func has_device_id() -> bool:
	if _device_id != "":
		return true
	var r := apple.keychain_get(product, DEVICE_ACCOUNT)
	if not r.ok:
		# Surfaced, not swallowed; the device file may still hold the id.
		_keychain_fail("read", DEVICE_ACCOUNT, r)
		return files.has_device_id()
	if r.detail.get("value") is String and r.detail["value"] != "":
		return true
	return files.has_device_id()


## The Keychain's id; else the device file's (moved into the Keychain); else a new one derived
## from PKeyDeviceId's raw source and stored. Write-once like the file store.
func get_device_id() -> String:
	if _device_id != "":
		return _device_id
	var r := apple.keychain_get(product, DEVICE_ACCOUNT)
	if r.ok:
		var stored = r.detail.get("value")
		if stored is String and PKeyDeviceId.is_well_formed(stored):
			_device_id = stored
			return _device_id
		if stored is String and stored != "":
			_fail("read", _where(DEVICE_ACCOUNT), ERR_FILE_CORRUPT, "the Keychain's device id is malformed; it is left in place")
			_device_id = files.get_device_id()
			return _device_id
	else:
		_keychain_fail("read", DEVICE_ACCOUNT, r)
	# The file's id when there is one (a migration), else a new one (the file store derives and
	# writes it, which also keeps it if the Keychain write below fails).
	_device_id = files.get_device_id()
	if r.ok:
		var w := apple.keychain_set(product, DEVICE_ACCOUNT, _device_id)
		if not w.ok:
			_keychain_fail("write", DEVICE_ACCOUNT, w)
	return _device_id


func read_cache() -> Variant:
	return files.read_cache()


func write_cache(record: Dictionary) -> bool:
	return files.write_cache(record)


func clear_cache() -> bool:
	return files.clear_cache()


func status() -> Dictionary:
	var s := {"backend": "keychain"}
	if _keychain_error != "":
		s["degraded"] = {"reason": "keyring-error", "detail": _keychain_error}
	return s


func _where(account: String) -> String:
	return "keychain:pkey:%s/%s" % [product, account]


func _keychain_fail(op: String, account: String, r: PKeyResult) -> void:
	var status = r.detail.get("status") if r.detail is Dictionary else null
	_keychain_error = "Keychain %s of %s failed (%s)" % [op, account, ("OSStatus %d" % int(status)) if status != null else r.message]
	_fail(op, _where(account), ERR_UNAVAILABLE, _keychain_error)
