@tool
class_name PKeySyncHpke
extends RefCounted
## HPKE (RFC 9180) base mode: DHKEM(X25519, HKDF-SHA256) 0x0020, HKDF-SHA256 0x0001, AES-256-GCM
## 0x0002, one message per context (sequence 0). The recipient's private half is never read here:
## `open` takes a `dh` Callable `(peer_public: PackedByteArray) -> Variant` that answers the 32-byte
## shared secret or null (the device key store's `dh`, through `dh_of_store`).
## A failure is an empty array or null, never a message that says which byte was wrong.

const KEM_X25519 := 0x0020
const ENC_BYTES := 32
const _KDF := 0x0001
const _AEAD := 0x0002
const _V1 := "HPKE-v1"


## `{"enc": PackedByteArray, "ct": PackedByteArray}`, or an empty Dictionary when the recipient key
## is not usable (wrong length, low order, an all-zero result) or the AEAD refuses.
## `ephemeral_private` is for a test vector only; otherwise a fresh key is drawn.
static func seal(recipient_public: PackedByteArray, info: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray, ephemeral_private: PackedByteArray = PackedByteArray()) -> Dictionary:
	if recipient_public.size() != ENC_BYTES or PKeyCurve25519.is_low_order(recipient_public):
		return {}
	var sk := ephemeral_private if not ephemeral_private.is_empty() else Crypto.new().generate_random_bytes(32)
	if sk.size() != 32:
		return {}
	var enc := PKeyCurve25519.x25519_public(sk)
	var dh := PKeyCurve25519.x25519(sk, recipient_public)
	if _all_zero(dh):
		return {}
	var kn := _key_schedule(_shared_secret(dh, enc + recipient_public), info)
	var ct := PKeySyncAesGcm.seal(kn[0], kn[1], plain, aad)
	if ct.is_empty():
		return {}
	return {"enc": enc, "ct": ct}


## The plaintext, or null (a bad `enc`, a refused or zero `dh`, a wrong key, info or aad, tampering).
## A valid empty message is an empty array: test `== null`.
static func open(dh: Callable, recipient_public: PackedByteArray, enc: PackedByteArray, info: PackedByteArray, aad: PackedByteArray, ct: PackedByteArray) -> Variant:
	if enc.size() != ENC_BYTES or recipient_public.size() != ENC_BYTES:
		return null
	var shared: Variant = dh.call(enc)
	if not (shared is PackedByteArray) or (shared as PackedByteArray).size() != 32 or _all_zero(shared):
		return null
	var kn := _key_schedule(_shared_secret(shared, enc + recipient_public), info)
	return PKeySyncAesGcm.open(kn[0], kn[1], ct, aad)


## A `dh` Callable over a raw X25519 private scalar (vectors and tests; a device's own key stays in
## its store). It refuses a low-order peer and an all-zero result.
static func dh_of_private(private_key: PackedByteArray) -> Callable:
	return func(peer: Variant) -> Variant:
		if not (peer is PackedByteArray) or (peer as PackedByteArray).size() != 32 or PKeyCurve25519.is_low_order(peer):
			return null
		var out := PKeyCurve25519.x25519(private_key, peer)
		return null if _all_zero(out) else out


## A `dh` Callable over a `PKeyDeviceKeyStore`: the private half stays inside the store.
static func dh_of_store(store: Object) -> Callable:
	return func(peer: Variant) -> Variant:
		if not (peer is PackedByteArray):
			return null
		var r: PKeyResult = store.dh(peer)
		if r == null or not r.ok or not (r.detail is PackedByteArray):
			return null
		return r.detail


static func _all_zero(b: PackedByteArray) -> bool:
	var acc := 0
	for x in b:
		acc |= x
	return acc == 0


static func _suite_kem() -> PackedByteArray:
	var s := "KEM".to_utf8_buffer()
	s.append(KEM_X25519 >> 8)
	s.append(KEM_X25519 & 0xFF)
	return s


static func _suite_hpke() -> PackedByteArray:
	var s := "HPKE".to_utf8_buffer()
	for v in [KEM_X25519, _KDF, _AEAD]:
		s.append(v >> 8)
		s.append(v & 0xFF)
	return s


static func _labeled_extract(suite: PackedByteArray, salt: PackedByteArray, label: String, ikm: PackedByteArray) -> PackedByteArray:
	var data := _V1.to_utf8_buffer()
	data.append_array(suite)
	data.append_array(label.to_utf8_buffer())
	data.append_array(ikm)
	var k := salt
	if k.is_empty():
		k = PackedByteArray()
		k.resize(32)
	return PKeySyncHkdf.hmac(k, data)


static func _labeled_expand(suite: PackedByteArray, prk: PackedByteArray, label: String, info: PackedByteArray, length: int) -> PackedByteArray:
	var data := PackedByteArray([length >> 8, length & 0xFF])
	data.append_array(_V1.to_utf8_buffer())
	data.append_array(suite)
	data.append_array(label.to_utf8_buffer())
	data.append_array(info)
	return _expand(prk, data, length)


## HKDF-Expand (RFC 5869 §2.3).
static func _expand(prk: PackedByteArray, info: PackedByteArray, length: int) -> PackedByteArray:
	var okm := PackedByteArray()
	var t := PackedByteArray()
	var i := 1
	while okm.size() < length:
		var block := t.duplicate()
		block.append_array(info)
		block.append(i)
		t = PKeySyncHkdf.hmac(prk, block)
		okm.append_array(t)
		i += 1
	okm.resize(length)
	return okm


static func _shared_secret(dh: PackedByteArray, kem_context: PackedByteArray) -> PackedByteArray:
	var suite := _suite_kem()
	var prk := _labeled_extract(suite, PackedByteArray(), "eae_prk", dh)
	return _labeled_expand(suite, prk, "shared_secret", kem_context, 32)


## `[key (32), base_nonce (12)]`.
static func _key_schedule(secret: PackedByteArray, info: PackedByteArray) -> Array:
	var suite := _suite_hpke()
	var psk_id_hash := _labeled_extract(suite, PackedByteArray(), "psk_id_hash", PackedByteArray())
	var info_hash := _labeled_extract(suite, PackedByteArray(), "info_hash", info)
	var context := PackedByteArray([0])
	context.append_array(psk_id_hash)
	context.append_array(info_hash)
	var s := _labeled_extract(suite, secret, "secret", PackedByteArray())
	return [_labeled_expand(suite, s, "key", context, 32), _labeled_expand(suite, s, "base_nonce", context, 12)]
