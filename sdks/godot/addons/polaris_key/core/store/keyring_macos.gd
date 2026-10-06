class_name PKeyMacKeychainBackend
extends PKeyKeyringBackend
## The macOS login keychain (SP-27) through PolarisKeyApple's desktop build: generic-password
## items under service `pkey:<product>`, never synchronizable, in the file-based login keychain
## (the data-protection keychain needs a `keychain-access-groups` entitlement an unsigned or plain
## Developer ID build does not have). Python's `keyring` and Kotlin's java-keyring use the same
## keychain and item names on macOS.
##
## Without libpkey_apple.dylib (native/macos/build_apple.sh --install <project>) unavailable()
## says so and nothing is called.

## The facade to call; PKeyApple.shared() on first use when the GDExtension is present. Tests set
## one over a fake native object.
var apple: PKeyApple = null


func _init(p_apple: PKeyApple = null) -> void:
	apple = p_apple


func id() -> String:
	return "keychain"


func _facade() -> PKeyApple:
	if apple == null and ClassDB.class_exists(PKeyApple.NATIVE_CLASS):
		apple = PKeyApple.shared()
	return apple


func unavailable() -> String:
	var a := _facade()
	if a == null:
		return "the PolarisKeyApple GDExtension (libpkey_apple.dylib) is not in this build"
	var gate := a.availability(PKeyConstants.Feature.CORE_STORE)
	return "" if gate.ok else gate.message


func get_secret(service: String, account: String) -> Dictionary:
	var product := _product(service)
	if product == "":
		return {"ok": false, "error": "the service %s is not pkey:<product>" % service}
	var r := _facade().keychain_get(product, account, PKeyApple.LOGIN_KEYCHAIN)
	if not r.ok:
		return {"ok": false, "error": _why(r)}
	var v = r.detail.get("value")
	return {"ok": true, "value": v if v is String else null}


func set_secret(service: String, account: String, secret: String) -> Dictionary:
	var product := _product(service)
	if product == "":
		return {"ok": false, "error": "the service %s is not pkey:<product>" % service}
	var r := _facade().keychain_set(product, account, secret, PKeyApple.LOGIN_KEYCHAIN)
	return {"ok": true} if r.ok else {"ok": false, "error": _why(r)}


func delete_secret(service: String, account: String) -> Dictionary:
	var product := _product(service)
	if product == "":
		return {"ok": false, "error": "the service %s is not pkey:<product>" % service}
	var r := _facade().keychain_delete(product, account, PKeyApple.LOGIN_KEYCHAIN)
	return {"ok": true} if r.ok else {"ok": false, "error": _why(r)}


## PolarisKeyPlatform builds the service itself from the product (`pkey:<product>`).
static func _product(service: String) -> String:
	return service.substr(PKeyKeyringStore.SERVICE_PREFIX.length()) if service.begins_with(PKeyKeyringStore.SERVICE_PREFIX) else ""


static func _why(r: PKeyResult) -> String:
	var d = r.detail
	if d is Dictionary and d.get("status") != null:
		return "Keychain %s (OSStatus %d)" % [str(d.get("error", "error")), int(d["status"])]
	if d is Dictionary and d.has("error"):
		return "Keychain %s" % str(d["error"])
	return r.message
