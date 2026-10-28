class_name PKeyWinSealer
extends PKeyRecordSealer
## The Windows sealer (CC-26.7): DPAPI through pkey_win.dll's PKeyWinDpapiNative
## (native/windows/credman/pkey_credman.cpp). CryptProtectData with CRYPTPROTECT_UI_FORBIDDEN and
## user scope: only this Windows user on this machine opens the blob, without a prompt. The entropy
## is the context (which names the product), so another product's blob does not open. DPAPI keeps no
## per-product key, so destroy() has nothing to delete: the store removes its record. `unopenable`
## (not DPAPI data, another user or machine) is "unreadable"; any other failure is a fault.

const NATIVE_CLASS := "PKeyWinDpapiNative"

var product: String
## The native object (a PKeyWinDpapiNative, or a test's stand-in with protect / unprotect).
var native: Object = null


func _init(p_product: String, p_native: Object = null) -> void:
	product = p_product
	native = p_native


func id() -> String:
	return "dpapi"


func _native() -> Object:
	if native == null and ClassDB.class_exists(NATIVE_CLASS):
		native = ClassDB.instantiate(NATIVE_CLASS)
	return native


func unavailable() -> String:
	if _native() == null:
		return "the pkey_win.dll GDExtension (PKeyWinDpapiNative) is not in this build"
	return ""


func seal(plain: PackedByteArray, context: PackedByteArray) -> PKeyResult:
	var r = _native().protect(plain, context) if _native() != null else null
	if not (r is Dictionary):
		return PKeyRecordSealer._fault("no reply")
	if not r.get("ok", false):
		return PKeyRecordSealer._fault("win32 %d" % int(r.get("win32", 0)))
	var blob = r.get("blob")
	return PKeyResult.success(blob) if blob is PackedByteArray and not blob.is_empty() else PKeyRecordSealer._fault("empty blob")


func open(blob: PackedByteArray, context: PackedByteArray) -> PKeyResult:
	var r = _native().unprotect(blob, context) if _native() != null else null
	if not (r is Dictionary):
		return PKeyRecordSealer._fault("no reply")
	if not r.get("ok", false):
		if r.get("unopenable", false):
			return PKeyResult.failure(PKeyDeviceKeyStore.KEYS_UNREADABLE, "device keys: the record is unreadable")
		return PKeyRecordSealer._fault("win32 %d" % int(r.get("win32", 0)))
	var plain = r.get("plain")
	return PKeyResult.success(plain) if plain is PackedByteArray else PKeyRecordSealer._fault("no plain")


func destroy() -> PKeyResult:
	return PKeyResult.success()
