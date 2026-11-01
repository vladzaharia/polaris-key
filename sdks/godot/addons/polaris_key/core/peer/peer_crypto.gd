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
## The known-answer message that a native sync lane seals whole: 1 MiB, one file segment. Its
## sealed form (key 0..31, nonce 0xA0.., AAD "pkey-sync-kat", byte i = i*31+7 mod 256) is pinned by
## digest, computed with another implementation (Node's OpenSSL).
const SYNC_KAT_BYTES := 1048576
const SYNC_KAT_SEALED_SHA256 := "20985c5839f5d4ccc63675c2e97146b4e8de8c720a4536b93b8f36b9fa50d672"


## Native adapters, in preference order. Each script extends PKeyPeerCrypto and has
## `static func lane()` or `static func create()` (called without arguments), which answers an
## adapter or null when its native side is absent (CC-14b.3 Apple, .6 Windows (planned path),
## .8 Android). A script that is not in the build is skipped.
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
		if not (script is GDScript):
			continue
		if script.has_method("lane"):
			out.append(script.lane())
		elif script.has_method("create"):
			out.append(script.create())
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
	return _curve_answers_ok() and _gcm_answers_ok() and _gcm_empty_answers_ok() and _sync_answers_ok()


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


## GCM specification cases 13 and 14 (AES-256, zero key and nonce, no additional data): an empty
## message seals to its tag alone, and sixteen zero bytes to one block and a tag. A flipped tag bit
## must be refused in both. Transport frames use this empty-AAD path.
func _gcm_empty_answers_ok() -> bool:
	var key := PackedByteArray()
	key.resize(32)
	var nonce := PackedByteArray()
	nonce.resize(12)
	var none := PackedByteArray()
	var zeros := PackedByteArray()
	zeros.resize(16)
	var want13 := "530f8afbc74536b9a963b4f1c4cb738b".hex_decode()
	var want14 := ("cea7403d4d606b6e074ec5d3baf39d18" + "d0d1c8a799996bf0265b98b5d48ab919").hex_decode()
	var bad13 := want13.duplicate()
	bad13[15] ^= 1
	var bad14 := want14.duplicate()
	bad14[31] ^= 1
	var sealed13 = aes_gcm_seal(key, nonce, none, none)
	var sealed14 = aes_gcm_seal(key, nonce, none, zeros)
	var opened13 = aes_gcm_open(key, nonce, none, want13)
	var opened14 = aes_gcm_open(key, nonce, none, want14)
	return sealed13 is PackedByteArray and sealed13 == want13 \
			and sealed14 is PackedByteArray and sealed14 == want14 \
			and opened13 is PackedByteArray and opened13.is_empty() \
			and opened14 is PackedByteArray and opened14 == zeros \
			and aes_gcm_open(key, nonce, none, bad13) == null and aes_gcm_open(key, nonce, none, bad14) == null


## The answers behind the sync entry points (`sync_seal`, `sync_open`), which the Cloud Sync AEAD
## facade (`PKeySyncAead`) calls for settings and files: an empty message and an empty AAD through
## that path, a tampered tag refused, and, for a native lane that takes a whole segment, one 1 MiB
## message with a pinned digest of the sealed output. The GDScript lane is the reference for the
## rest, so it skips the 1 MiB case (it would cost seconds) and `sync_native()` says which applies.
func _sync_answers_ok() -> bool:
	var key := PackedByteArray()
	key.resize(32)
	var nonce := PackedByteArray()
	nonce.resize(12)
	var none := PackedByteArray()
	var want_empty := "530f8afbc74536b9a963b4f1c4cb738b".hex_decode()
	var bad := want_empty.duplicate()
	bad[0] ^= 1
	var sealed = sync_seal(key, nonce, none, none)
	var opened = sync_open(key, nonce, none, want_empty)
	if not (sealed is PackedByteArray and sealed == want_empty and opened is PackedByteArray and opened.is_empty() \
			and sync_open(key, nonce, none, bad) == null):
		return false
	var k2 := PackedByteArray()
	var n2 := PackedByteArray()
	for i in 32:
		k2.append(i)
	for i in 12:
		n2.append(0xA0 + i)
	var aad := "pkey-sync-kat".to_utf8_buffer()
	var small := PackedByteArray([1, 2, 3])
	var s2 = sync_seal(k2, n2, aad, small)
	var o2 = sync_open(k2, n2, aad, s2)
	if not (s2 is PackedByteArray and s2.size() == 19 and o2 is PackedByteArray and o2 == small):
		return false
	var wrong_aad = sync_open(k2, n2, "pkey-sync-kaT".to_utf8_buffer(), s2)
	if wrong_aad != null:
		return false
	if not sync_native() or sync_max_bytes() < SYNC_KAT_BYTES:
		return true
	var plain := PackedByteArray()
	plain.resize(SYNC_KAT_BYTES)
	for i in SYNC_KAT_BYTES:
		plain[i] = (i * 31 + 7) & 0xFF
	var big = sync_seal(k2, n2, aad, plain)
	if not (big is PackedByteArray and big.size() == SYNC_KAT_BYTES + 16 and _sha256_hex(big) == SYNC_KAT_SEALED_SHA256):
		return false
	var back = sync_open(k2, n2, aad, big)
	var ok: bool = back is PackedByteArray and back == plain
	var flipped: PackedByteArray = (big as PackedByteArray).duplicate()
	flipped[flipped.size() - 1] ^= 1
	return ok and sync_open(k2, n2, aad, flipped) == null


static func _sha256_hex(data: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(data)
	return ctx.finish().hex_encode()


## Cloud Sync's entry points (U-40.2, GM.1). They differ from the Noise methods above only in
## their bounds: the Noise methods stop at 65,519 message bytes, these at `sync_max_bytes()`. The
## GDScript lane is `PKeySyncAesGcm` (1 MiB of message, 64 KiB of AAD). An adapter overrides all
## three together. A refusal is the same value as above: an empty array from `sync_seal`, null
## from `sync_open`. Callers go through `PKeySyncAead`, which checks the bound and falls back.
func sync_max_bytes() -> int:
	return PKeySyncAesGcm.MAX_BYTES


## True for an adapter whose sync calls run native code, so the known answers add the 1 MiB case.
func sync_native() -> bool:
	return false


func sync_seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
	return PKeySyncAesGcm.seal(key, nonce, plain, aad)


func sync_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
	return PKeySyncAesGcm.open(key, nonce, sealed, aad)


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
