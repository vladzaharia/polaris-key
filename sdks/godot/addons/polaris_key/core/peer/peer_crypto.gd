@tool
class_name PKeyPeerCrypto
extends RefCounted
## The crypto port of the Cloud Connect engine (CC-14, D-3): X25519 and AES-256-GCM, the two
## primitives the Noise layer needs that the engine lacks. This default is GDScript, built on the
## code Cloud Sync and the device key store already ship (`PKeyCurve25519`, `PKeySyncAesGcm`); a
## native adapter (CC-14b) overrides the four methods and is chosen only after a known-answer
## self-test. No curve or cipher code lives here.
##
## Every method answers a refusal as a value, never an error: an empty array from `x25519_public`
## and the two seal and open methods when an argument is unusable, null from `x25519` and
## `aes_gcm_open` for a refused point, an all-zero result or a tag that does not verify.
## The arrays passed in belong to the caller, who clears them.

## A Noise message is at most 65,535 bytes, so one AEAD call carries at most 65,519 of them.
const MAX_AEAD_BYTES := 65535


## The port for this runtime. The GDScript lane everywhere until CC-14b adds the native ones.
static func for_platform() -> PKeyPeerCrypto:
	return PKeyPeerCrypto.new()


## The public key (u-coordinate) of a 32-byte X25519 private key. Empty when the key is not 32 bytes.
func x25519_public(private_key: PackedByteArray) -> PackedByteArray:
	if private_key.size() != 32:
		return PackedByteArray()
	return PKeyCurve25519.x25519_public(private_key)


## The shared secret of `private_key` and a peer's public key, or null when the peer key is not 32
## bytes, is a low-order point (in any spelling), or the result is all zero.
func x25519(private_key: PackedByteArray, peer_public: PackedByteArray) -> Variant:
	if private_key.size() != 32 or peer_public.size() != 32 or PKeyCurve25519.is_low_order(peer_public):
		return null
	var out := PKeyCurve25519.x25519(private_key, peer_public)
	var any := 0
	for b in out:
		any |= b
	return out if any != 0 else null


## Ciphertext then the 16-byte tag. Empty when an argument is unusable (a key that is not 32 bytes,
## a nonce that is not 12 bytes, or more than 65,519 bytes of plaintext).
func aes_gcm_seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
	if plain.size() + PKeySyncAesGcm.TAG_BYTES > MAX_AEAD_BYTES:
		return PackedByteArray()
	return PKeySyncAesGcm.seal(key, nonce, plain, aad)


## The plaintext, or null when an argument is unusable or the tag does not verify. A valid empty
## message opens to an empty array: test `== null`.
func aes_gcm_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
	if sealed.size() > MAX_AEAD_BYTES:
		return null
	return PKeySyncAesGcm.open(key, nonce, sealed, aad)


## `n` bytes from the engine's CSPRNG.
func random_bytes(n: int) -> PackedByteArray:
	return Crypto.new().generate_random_bytes(n)
