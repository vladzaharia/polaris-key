@tool
class_name PKeyAppleCrypto
extends PKeyPeerCrypto
## The Apple lane of the crypto port (CC-14b.3, D-3): AES-256-GCM and X25519 on CryptoKit, through
## the binary entry of the `PolarisKeyApple` plugin (`PKeyApple.cmd_bin`; sdks/swift
## PolarisKeyPlatform/CryptoOps.swift). Bytes in, bytes out: a key never becomes a String or JSON.
##
## Each reply is a status byte then the result: 1 ok, 0 refused (a tag that does not verify, an
## all-zero DH output: `dh_zero`), 3 bad input; an empty reply is an unknown op (a native build
## that predates the crypto ops), which makes the lane unavailable. The selector
## (`PKeyPeerCrypto.for_platform()`) takes this adapter only after its known-answer self-test; this
## class does not vouch for itself. `create()` answers null off iOS and macOS, without the binary
## entry, or in a build without the ops, which is the GDScript lane.
## Nothing here prints or stores a key. Reply buffers are cleared after use (best effort:
## `PackedByteArray` copy-on-write is a recorded residual).

const OK := 1
## The largest message a native call carries: the entry's bound less the header.
const MAX_BYTES := PKeyApple.BIN_MAX - 128

var _apple: PKeyApple = null


## The adapter over `apple` (a PKeyApple, or one with a fake native in tests), else over the
## process's shared one. Null when the binary entry or the crypto ops are not there.
static func create(apple: PKeyApple = null) -> PKeyAppleCrypto:
	if apple == null:
		if OS.get_name() != "iOS" and OS.get_name() != "macOS":
			return null
		if not ClassDB.class_exists(PKeyApple.NATIVE_CLASS):
			return null
		apple = PKeyApple.shared()
	if not apple.binary_available():
		return null
	var out := PKeyAppleCrypto.new()
	out._apple = apple
	return out


func lane_name() -> String:
	return "apple"


func available() -> bool:
	return _apple != null and _apple.binary_available()


func x25519_public(private_key: PackedByteArray) -> PackedByteArray:
	if private_key.size() != 32:
		return PackedByteArray()
	var out := _body(_apple.cmd_bin("cx_x25519_pub", private_key))
	return out if out.size() == 32 else PackedByteArray()


func x25519(private_key: PackedByteArray, peer_public: PackedByteArray) -> Variant:
	if private_key.size() != 32 or peer_public.size() != 32:
		return null
	var input := private_key + peer_public
	var reply := _apple.cmd_bin("cx_x25519", input)
	input.fill(0)
	var out := _body(reply)
	return out if out.size() == 32 else null


func aes_gcm_seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
	if key.size() != 32 or nonce.size() != 12 or aad.size() + plain.size() > MAX_BYTES:
		return PackedByteArray()
	var input := _gcm_input(key, nonce, aad, plain)
	var out := _body(_apple.cmd_bin("cx_seal", input))
	input.fill(0)
	return out if out.size() == plain.size() + 16 else PackedByteArray()


func aes_gcm_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
	if key.size() != 32 or nonce.size() != 12 or sealed.size() < 16 or aad.size() + sealed.size() > MAX_BYTES:
		return null
	var input := _gcm_input(key, nonce, aad, sealed)
	var reply := _apple.cmd_bin("cx_open", input)
	input.fill(0)
	if reply.is_empty() or reply[0] != OK:
		reply.fill(0)
		return null
	return _body(reply)


## key ‖ nonce ‖ aad length (u32 be) ‖ aad ‖ message. The key is in the buffer: the caller clears it
## after `cmd_bin`, which does not retain it.
static func _gcm_input(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, body: PackedByteArray) -> PackedByteArray:
	var head := PackedByteArray()
	head.resize(4)
	var n := aad.size()
	head[0] = (n >> 24) & 0xFF
	head[1] = (n >> 16) & 0xFF
	head[2] = (n >> 8) & 0xFF
	head[3] = n & 0xFF
	return key + nonce + head + aad + body


## The result after the status byte, or an empty array for any other status. The reply is cleared.
static func _body(reply: PackedByteArray) -> PackedByteArray:
	if reply.is_empty() or reply[0] != OK:
		reply.fill(0)
		return PackedByteArray()
	var out := reply.slice(1)
	reply.fill(0)
	return out
