@tool
class_name PKeyWinCrypto
extends PKeyPeerCrypto
## The Windows lane of the crypto port (CC-14b.6, D-3): AES-256-GCM on CNG (BCrypt) and, with the
## curve methods present (CC-14b.7), X25519 on Monocypher, through `PKeyWinCryptoNative` in
## `pkey_win.dll` (sdks/godot/native/windows/crypto; `PackedByteArray` in and out, so a key never
## becomes a string). It has the same shape as `PKeyAndroidCrypto`.
##
## Each reply is a status byte then the result: 1 ok, 0 refused (a tag that does not verify, an
## all-zero DH output: `dh_zero`), 2 unsupported, 3 bad input. A method the loaded DLL lacks (an
## export that carries an older `pkey_win.dll`) is the GDScript ladder for that primitive
## (`x25519_native()` says which for the curve); a plugin that answers 2 is remembered the same way.
##
## The lane selector (`PKeyPeerCrypto.for_platform()`, CC-14b.1) takes this adapter only after its
## known-answer self-test: this class does not vouch for itself. `create()` answers null when the
## class or an AES-GCM method is missing, which is the GDScript lane. Nothing here prints or stores
## a key; the reply buffers are cleared after use (best effort: `PackedByteArray` copy-on-write is
## a recorded residual).

const NATIVE_CLASS := "PKeyWinCryptoNative"
const AEAD_METHODS := ["aes_gcm_seal", "aes_gcm_open"]
const CURVE_METHODS := ["x25519", "x25519_public"]
const OK := 1
const UNSUPPORTED := 2

var _native: Object = null
var _x25519_unsupported := false


## The adapter over `native` (anything with the methods; tests pass a fake), else over a new
## `PKeyWinCryptoNative`. Null when neither is there or an AES-GCM method is missing.
static func create(native: Object = null) -> PKeyWinCrypto:
	var target: Object = native
	if target == null:
		if not ClassDB.class_exists(NATIVE_CLASS) or not ClassDB.can_instantiate(NATIVE_CLASS):
			return null
		target = ClassDB.instantiate(NATIVE_CLASS)
	if target == null:
		return null
	for m in AEAD_METHODS:
		if not target.has_method(m):
			return null
	var out := PKeyWinCrypto.new()
	out._native = target
	out._x25519_unsupported = not (target.has_method(CURVE_METHODS[0]) and target.has_method(CURVE_METHODS[1]))
	return out


## False when the DLL has no curve methods or has said X25519 is unsupported: the ladder is GDScript.
func x25519_native() -> bool:
	return not _x25519_unsupported


func x25519_public(private_key: PackedByteArray) -> PackedByteArray:
	if private_key.size() != 32:
		return PackedByteArray()
	if _x25519_unsupported:
		return super.x25519_public(private_key)
	var reply = _native.call("x25519_public", private_key)
	if _status(reply) == UNSUPPORTED:
		_x25519_unsupported = true
		return super.x25519_public(private_key)
	return _body(reply)


func x25519(private_key: PackedByteArray, peer_public: PackedByteArray) -> Variant:
	if private_key.size() != 32 or peer_public.size() != 32:
		return null
	if _x25519_unsupported:
		return super.x25519(private_key, peer_public)
	var reply = _native.call("x25519", private_key, peer_public)
	if _status(reply) == UNSUPPORTED:
		_x25519_unsupported = true
		return super.x25519(private_key, peer_public)
	var out := _body(reply)
	return out if out.size() == 32 else null


## The native entry stops at 65,535 bytes, so Cloud Sync settings go native here and files (1 MiB
## segments) stay on the GDScript lane through `PKeySyncAead`.
func sync_max_bytes() -> int:
	return MAX_AEAD_BYTES - 16


func sync_native() -> bool:
	return true


func sync_seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
	if aad.size() >= MAX_AEAD_BYTES:
		return PackedByteArray()
	return aes_gcm_seal(key, nonce, aad, plain)


func sync_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
	if aad.size() >= MAX_AEAD_BYTES:
		return null
	return aes_gcm_open(key, nonce, aad, sealed)


func aes_gcm_seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
	if key.size() != 32 or nonce.size() != 12 or plain.size() + 16 > MAX_AEAD_BYTES:
		return PackedByteArray()
	return _body(_native.call("aes_gcm_seal", key, nonce, aad, plain))


func aes_gcm_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
	if key.size() != 32 or nonce.size() != 12 or sealed.size() < 16 or sealed.size() > MAX_AEAD_BYTES:
		return null
	var reply = _native.call("aes_gcm_open", key, nonce, aad, sealed)
	if _status(reply) != OK:
		return null
	return _body(reply)


## The status byte of a reply, or -1 for anything that is not a non-empty PackedByteArray.
static func _status(reply: Variant) -> int:
	if not (reply is PackedByteArray) or (reply as PackedByteArray).is_empty():
		return -1
	return (reply as PackedByteArray)[0]


## The result after the status byte, or an empty array for any other status. The raw reply is cleared.
static func _body(reply: Variant) -> PackedByteArray:
	if _status(reply) != OK:
		return PackedByteArray()
	var raw: PackedByteArray = reply
	var out := raw.slice(1)
	raw.fill(0)
	return out
