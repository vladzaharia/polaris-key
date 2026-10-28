class_name PKeyRecordSealer
extends RefCounted
## A native sealer for the device key store (CC-26.7; plans/CC-01.md R-5 and Q12: software 25519
## keys in hardware-wrapped storage). Key generation, signing and agreement stay in GDScript
## (PKeyDeviceKeyStore, PKeyCurve25519); a sealer only wraps and unwraps the record's bytes under
## a platform key that never leaves secure storage:
##
##   Apple (iOS, macOS)  a Keychain AES-256-GCM key through PolarisKeyPlatform (PKeyAppleSealer)
##   Android             a Keystore AES-256-GCM key through :platform's KeystoreSealer (PKeyAndroidSealer)
##   Windows             DPAPI, user scope, no UI (PKeyWinSealer)
##   Linux, anything else  none: the store falls back to the engine-encrypted file (CC-26.6)
##
## The contract (every result is a PKeyResult):
##
##   seal(plain, context)   ok, detail PackedByteArray (the blob). May make the platform key.
##   open(blob, context)    ok, detail PackedByteArray (the record), or
##                          PKeyDeviceKeyStore.KEYS_UNREADABLE when the blob can NEVER open (the
##                          key is gone or invalidated, the tag fails, another format, another user).
##                          Never makes a key. A fault that may pass is STORE_FAULT, never "gone".
##   destroy()              ok. Deletes the platform key; a missing key is success.
##
## A sealer that is not there is `unavailable()` (a reason) and the store never calls it. A runtime
## or dependency that cannot seal answers PKeyResult.unsupported, never KEYS_UNREADABLE. Results,
## messages and `str()` carry a code and a status number only: never a key or a byte of the record.

const FEATURE := "core.devicekeys"


## A short name for status details ("keychain", "keystore", "dpapi").
func id() -> String:
	return "none"


## Why this sealer cannot be used here ("" when it can).
func unavailable() -> String:
	return "no native sealer"


func seal(_plain: PackedByteArray, _context: PackedByteArray) -> PKeyResult:
	return _unsupported()


func open(_blob: PackedByteArray, _context: PackedByteArray) -> PKeyResult:
	return _unsupported()


func destroy() -> PKeyResult:
	return _unsupported()


func _to_string() -> String:
	return "PKeyRecordSealer(%s)" % id()


func _unsupported() -> PKeyResult:
	return PKeyResult.unsupported(FEATURE, PKeyConstants.UnsupportedReason.DEPENDENCY, "device keys: " + unavailable())


## The sealer for this platform when its native lane is present, else null (the file fallback).
## `platform` "" means PKeyHeaders.update_platform() (so iOS and Android, which the headers know as
## build targets) with macOS and Windows through PKeyHeaders.platform().
static func for_platform(product: String, platform := "") -> PKeyRecordSealer:
	var p := platform if platform != "" else PKeyHeaders.platform()
	var s: PKeyRecordSealer = null
	match p:
		PKeyConstants.Platform.IOS, PKeyConstants.Platform.MACOS:
			if ClassDB.class_exists(PKeyApple.NATIVE_CLASS):
				s = PKeyAppleSealer.new(product, PKeyApple.shared(), p == PKeyConstants.Platform.MACOS)
		PKeyConstants.Platform.ANDROID:
			if Engine.has_singleton(PKeyAndroid.SINGLETON):
				s = PKeyAndroidSealer.new(product, PKeyAndroid.shared())
		PKeyConstants.Platform.WINDOWS:
			if ClassDB.class_exists(PKeyWinSealer.NATIVE_CLASS):
				s = PKeyWinSealer.new(product)
	return s if s != null and s.unavailable() == "" else null


## A native JSON reply (the Apple and Android `cmd` surface) as a PKeyResult. `field` is the reply
## member that carries base64 bytes ("" for none).
static func from_reply(r: Dictionary, field: String) -> PKeyResult:
	if r.get("unsupported", false):
		return PKeyResult.unsupported(FEATURE, str(r.get("reason", PKeyConstants.UnsupportedReason.RUNTIME)), "device keys: the native sealer is not available")
	if r.get("ok", false):
		if field == "":
			return PKeyResult.success()
		var v = r.get(field)
		if not (v is String):
			return _fault("a reply without %s" % field)
		return PKeyResult.success(Marshalls.base64_to_raw(v))
	var code := str(r.get("error", "error"))
	if code == "unopenable":
		return PKeyResult.failure(PKeyDeviceKeyStore.KEYS_UNREADABLE, "device keys: the record is unreadable")
	var why := code
	if r.get("status") != null:
		why += " %d" % int(r["status"])
	elif r.get("reason") != null:
		why += " %s" % str(r["reason"]).left(40)
	return _fault(why.left(60))


static func _fault(why: String) -> PKeyResult:
	return PKeyResult.failure(PKeyDeviceKeyStore.STORE_FAULT, "device keys: the native sealer failed (%s)" % why)
