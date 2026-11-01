@tool
class_name PKeyAndroidCrypto
extends PKeyPeerCrypto
## The Android lane of the crypto port (CC-14b.8, D-3): AES-256-GCM and X25519 on the JCA, through
## the `PolarisKeyAndroid` plugin's binary methods `cxSeal`, `cxOpen`, `cxX25519` and `cxX25519Pub`
## (sdks/godot/native/android; `PackedByteArray` in and out, so a key never becomes a string).
##
## Each reply is a status byte then the result: 1 ok, 0 refused (a tag that does not verify, an
## all-zero DH output: `dh_zero`), 2 unsupported, 3 bad input. X25519 is the platform's `XDH`, which
## exists from API 33 (D-14). Below that the plugin answers 2 and this adapter runs the GDScript
## ladder for X25519 (`x25519_native()` says which), as D-3 says; AES-GCM is native on every API.
##
## The lane selector (`PKeyPeerCrypto.for_platform()`, CC-14b.1) takes this adapter only after its
## known-answer self-test: this class does not vouch for itself. `create()` answers null when the
## plugin or one of its methods is missing, which is the GDScript lane (an older native binding).
## Nothing here prints or stores a key; the reply buffers are cleared after use (best effort:
## `PackedByteArray` copy-on-write is a recorded residual).

const SINGLETON := "PolarisKeyAndroid"
const METHODS := ["cxSeal", "cxOpen", "cxX25519", "cxX25519Pub"]
const OK := 1
const UNSUPPORTED := 2

var _native: Object = null
var _x25519_unsupported := false


## The adapter over `native` (anything with the four methods; tests pass a fake), else over the
## Engine singleton. Null when neither is there or a method is missing.
static func create(native: Object = null) -> PKeyAndroidCrypto:
	var target: Object = native
	if target == null:
		if not Engine.has_singleton(SINGLETON):
			return null
		target = Engine.get_singleton(SINGLETON)
	if target == null:
		return null
	for m in METHODS:
		if not target.has_method(m):
			return null
	var out := PKeyAndroidCrypto.new()
	out._native = target
	return out


## False once the plugin has said X25519 is unsupported here (API below 33): the ladder is GDScript.
func x25519_native() -> bool:
	return not _x25519_unsupported


func x25519_public(private_key: PackedByteArray) -> PackedByteArray:
	if private_key.size() != 32:
		return PackedByteArray()
	if _x25519_unsupported:
		return super.x25519_public(private_key)
	var reply = _native.call("cxX25519Pub", private_key)
	if _status(reply) == UNSUPPORTED:
		_x25519_unsupported = true
		return super.x25519_public(private_key)
	return _body(reply)


func x25519(private_key: PackedByteArray, peer_public: PackedByteArray) -> Variant:
	if private_key.size() != 32 or peer_public.size() != 32:
		return null
	if _x25519_unsupported:
		return super.x25519(private_key, peer_public)
	var reply = _native.call("cxX25519", private_key, peer_public)
	if _status(reply) == UNSUPPORTED:
		_x25519_unsupported = true
		return super.x25519(private_key, peer_public)
	var out := _body(reply)
	return out if out.size() == 32 else null


## Connect's Noise bound (65,535 bytes a message) stays on these two; Cloud Sync's segment bound is
## on `sync_seal` and `sync_open`, which share the native call.
func aes_gcm_seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
	if plain.size() + 16 > MAX_AEAD_BYTES:
		return PackedByteArray()
	return _seal(key, nonce, aad, plain)


func aes_gcm_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
	if sealed.size() > MAX_AEAD_BYTES:
		return null
	return _open(key, nonce, aad, sealed)


## One file segment or chunk object (1 MiB of message) with up to 64 KiB of AAD. The plugin has no
## bound of its own on the JCA call.
func sync_max_bytes() -> int:
	return PKeySyncAesGcm.MAX_BYTES


func sync_native() -> bool:
	return true


func sync_seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
	if plain.size() > sync_max_bytes() or aad.size() > PKeySyncAesGcm.MAX_AAD_BYTES:
		return PackedByteArray()
	return _seal(key, nonce, aad, plain)


func sync_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
	if sealed.size() - 16 > sync_max_bytes() or aad.size() > PKeySyncAesGcm.MAX_AAD_BYTES:
		return null
	return _open(key, nonce, aad, sealed)


func _seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
	if key.size() != 32 or nonce.size() != 12:
		return PackedByteArray()
	return _body(_native.call("cxSeal", key, nonce, aad, plain))


func _open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
	if key.size() != 32 or nonce.size() != 12 or sealed.size() < 16:
		return null
	var reply = _native.call("cxOpen", key, nonce, aad, sealed)
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
