class_name PKeyAndroidSealer
extends PKeyRecordSealer
## The Android sealer (CC-26.7): the Godot plugin's `ks_seal` / `ks_open` / `ks_destroy`, which run
## :platform's KeystoreSealer (CC-26.5) over an AndroidKeyStore AES-256-GCM key whose alias is bound
## to the product (`pkey:<product>:devicekeys`; hardware-backed where the device has it). A Keystore
## fault that may pass is a fault, never "gone"; an invalidated or missing key is "unreadable".

var product: String
var android: PKeyAndroid
var _hardware := false


func _init(p_product: String, p_android: PKeyAndroid) -> void:
	product = p_product
	android = p_android


func id() -> String:
	return "keystore"


## What the last reply said about the Keystore key (KeyInfo.isInsideSecureHardware or the API 31
## security level); false until a call has answered.
func hardware_backed() -> bool:
	return _hardware


func unavailable() -> String:
	if android == null:
		return "the PolarisKeyAndroid plugin is not in this build"
	var why := android.unsupported_reason()
	return "" if why == "" else "the PolarisKeyAndroid plugin is not available (%s)" % why


func seal(plain: PackedByteArray, context: PackedByteArray) -> PKeyResult:
	return PKeyRecordSealer.from_reply(_call({"op": "ks_seal", "context": Marshalls.raw_to_base64(context), "plain": Marshalls.raw_to_base64(plain)}), "blob")


func open(blob: PackedByteArray, context: PackedByteArray) -> PKeyResult:
	return PKeyRecordSealer.from_reply(_call({"op": "ks_open", "context": Marshalls.raw_to_base64(context), "blob": Marshalls.raw_to_base64(blob)}), "plain")


func destroy() -> PKeyResult:
	return PKeyRecordSealer.from_reply(_call({"op": "ks_destroy"}), "")


func _call(q: Dictionary) -> Dictionary:
	q["product"] = product
	var r := android.call_sync(q)
	if r.get("ok", false) and r.has("hardware"):
		_hardware = r["hardware"] == true
	return r
