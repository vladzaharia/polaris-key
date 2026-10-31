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


## Native adapters, in preference order. Each script extends PKeyPeerCrypto and has
## `static func lane() -> PKeyPeerCrypto`, which answers an adapter or null when its native side is
## absent (CC-14b.3 Apple, .6 Windows, .8 Android). A script that is not in the build is skipped.
## Tests replace the list through `select()`.
const NATIVE_LANE_SCRIPTS: Array[String] = [
	"res://addons/polaris_key/native/pkey_apple_crypto.gd",
	"res://addons/polaris_key/native/pkey_win_crypto.gd",
	"res://addons/polaris_key/native/pkey_android_crypto.gd",
]
## Set to "gdscript" to refuse every native lane (a kill switch for a native build gone wrong).
const ENV_LANE := "PKEY_PEER_CRYPTO"

static var _selected: PKeyPeerCrypto = null
static var _select_lock := Mutex.new()


## The port for this runtime (D-3). The first native lane that passes its known answers, else the
## GDScript lane. Chosen once per process; a lane that fails its answers is never used.
static func for_platform() -> PKeyPeerCrypto:
	_select_lock.lock()
	if _selected == null:
		_selected = select(_native_lanes())
	var chosen := _selected
	_select_lock.unlock()
	return chosen


## The first of `candidates` (PKeyPeerCrypto adapters; nulls are skipped) that is available and
## answers every known answer, else the GDScript lane. A native lane that does not pass is never
## returned, and neither is one whose answers have the wrong type.
static func select(candidates: Array) -> PKeyPeerCrypto:
	for c in candidates:
		if c is PKeyPeerCrypto and c.available() and c.known_answers_ok():
			return c
	return PKeyPeerCrypto.new()


## Forget the chosen lane (tests).
static func reset_for_tests() -> void:
	_select_lock.lock()
	_selected = null
	_select_lock.unlock()


static func _native_lanes() -> Array:
	var out := []
	if OS.get_environment(ENV_LANE) == "gdscript":
		return out
	for path in NATIVE_LANE_SCRIPTS:
		if not ResourceLoader.exists(path):
			continue
		var script = load(path)
		if script is GDScript and script.has_method("lane"):
			out.append(script.lane())
	return out


## A short name for status details: "gdscript" here; an adapter says "apple", "windows" or "android".
func lane_name() -> String:
	return "gdscript"


## Whether the adapter's native side can answer here. The GDScript lane always can. An adapter
## answers false when a native method is missing, so selection never calls it.
func available() -> bool:
	return true


## The known answers (D-3): the RFC 7748 section 5.2 first vector and section 6.1 public key,
## NIST's AES-256-GCM case 16 (with additional data) sealed and opened, a tampered tag and a
## tampered message refused, and a low-order point refused. False on any difference, so a lane
## that answers wrongly, or with the wrong type, is not chosen. Nothing here is secret.
func known_answers_ok() -> bool:
	return _curve_answers_ok() and _gcm_answers_ok()


func _curve_answers_ok() -> bool:
	var k := "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4".hex_decode()
	var u := "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c".hex_decode()
	var alice := "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a".hex_decode()
	var zero := PackedByteArray()
	zero.resize(32)
	var shared = x25519(k, u)
	var pub = x25519_public(alice)
	return shared is PackedByteArray and shared.hex_encode() == "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552" \
			and pub is PackedByteArray and pub.hex_encode() == "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a" \
			and x25519(k, zero) == null


func _gcm_answers_ok() -> bool:
	var key := "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308".hex_decode()
	var nonce := "cafebabefacedbaddecaf888".hex_decode()
	var aad := "feedfacedeadbeeffeedfacedeadbeefabaddad2".hex_decode()
	var plain := ("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72" \
			+ "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39").hex_decode()
	var want := ("522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa" \
			+ "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" + "76fc6ece0f4e1768cddf8853bb2d551b").hex_decode()
	var bad_tag := want.duplicate()
	bad_tag[bad_tag.size() - 1] ^= 1
	var bad_body := want.duplicate()
	bad_body[0] ^= 1
	var sealed = aes_gcm_seal(key, nonce, aad, plain)
	var opened = aes_gcm_open(key, nonce, aad, want)
	return sealed is PackedByteArray and sealed == want and opened is PackedByteArray and opened == plain \
			and aes_gcm_open(key, nonce, aad, bad_tag) == null and aes_gcm_open(key, nonce, aad, bad_body) == null


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
