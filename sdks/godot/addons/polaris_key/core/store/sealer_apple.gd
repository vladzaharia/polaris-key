class_name PKeyAppleSealer
extends PKeyRecordSealer
## The Apple sealer (CC-26.7): PolarisKeyPlatform's `dk_seal` / `dk_open` / `dk_destroy` through the
## PolarisKeyApple GDExtension (sdks/swift/Sources/PolarisKeyPlatform/DeviceKeySealer.swift). The
## AES-256-GCM key is a Keychain item `pkey:<product>` / `device-key-seal`, AfterFirstUnlock
## ThisDeviceOnly, never synchronizable, no access group (the login keychain on a macOS desktop
## build, as the token store). It is a Keychain key, not a Secure Enclave key. A Keychain error that
## may pass is a fault; only a key that is gone or a blob that fails its tag is "unreadable".
##
## The record travels to the plugin as base64 in a JSON request, held in a String for one call;
## GDScript cannot wipe a String, so that copy is best effort (the same as keychain_set's value).

var product: String
## The facade to call (PKeyApple.shared(), or a test's over a fake native object).
var apple: PKeyApple
var _login: bool


func _init(p_product: String, p_apple: PKeyApple, login_keychain := false) -> void:
	product = p_product
	apple = p_apple
	_login = login_keychain


func id() -> String:
	return "keychain"


func unavailable() -> String:
	if apple == null:
		return "the PolarisKeyApple GDExtension is not in this build"
	var gate := apple.availability(PKeyConstants.Feature.CORE_STORE)
	return "" if gate.ok else gate.message


func seal(plain: PackedByteArray, context: PackedByteArray) -> PKeyResult:
	return PKeyRecordSealer.from_reply(_call({"op": "dk_seal", "context": Marshalls.raw_to_base64(context), "plain": Marshalls.raw_to_base64(plain)}), "blob")


func open(blob: PackedByteArray, context: PackedByteArray) -> PKeyResult:
	return PKeyRecordSealer.from_reply(_call({"op": "dk_open", "context": Marshalls.raw_to_base64(context), "blob": Marshalls.raw_to_base64(blob)}), "plain")


func destroy() -> PKeyResult:
	return PKeyRecordSealer.from_reply(_call({"op": "dk_destroy"}), "")


func _call(q: Dictionary) -> Dictionary:
	q["product"] = product
	if _login:
		q["keychain"] = PKeyApple.LOGIN_KEYCHAIN
	return apple.call_sync(q, PKeyConstants.Feature.CORE_STORE)
