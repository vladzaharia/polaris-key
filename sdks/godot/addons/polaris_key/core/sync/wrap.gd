@tool
class_name PKeySyncWrap
extends RefCounted
## The key-transport blobs of WIRE-CONTRACT-V5 §13.11: the HPKE wrap of a root to a device's
## agreement key (`pkey-sync-wrap/1`), the recovery blob (the root sealed under a key from the
## recovery code) and the adopt blob (a previous or foreign root sealed under `K_adopt`). Every
## `open` answers null on any failure; a root and a code are never put in a message.
## A nonce comes from `Crypto.generate_random_bytes(12)` unless a test pins it.

const BLOB_VERSION := 0x01
const NONCE_BYTES := 12
const BLOB_BYTES := 1 + NONCE_BYTES + 32 + 16
## A wrapped root: the 32 bytes of the root and the 16-byte tag.
const WRAP_CT_BYTES := 48


## `"pkey-sync/1 wrap" NUL product NUL deviceId NUL ringId NUL u32be(epoch)`; empty on a bad epoch.
static func wrap_info(product: String, device_id: String, ring_id: String, epoch: int) -> PackedByteArray:
	if epoch < 0 or epoch > 0xFFFFFFFF:
		return PackedByteArray()
	var b := "pkey-sync/1 wrap".to_utf8_buffer()
	for part in [product, device_id, ring_id]:
		b.append(0)
		b.append_array((part as String).to_utf8_buffer())
	b.append(0)
	b.append_array(_u32(epoch))
	return b


## `{"kem": 32, "enc": PackedByteArray, "ct": PackedByteArray}`, or an empty Dictionary on a bad
## argument or an unusable recipient key. `kid` (16 bytes, of `root`) is the aad.
static func wrap_root(recipient_public: PackedByteArray, product: String, device_id: String, ring_id: String, epoch: int, kid: PackedByteArray, root: PackedByteArray, ephemeral_private: PackedByteArray = PackedByteArray()) -> Dictionary:
	var info := wrap_info(product, device_id, ring_id, epoch)
	if info.is_empty() or root.size() != PKeySyncHkdf.ROOT_BYTES:
		return {}
	var r := PKeySyncHpke.seal(recipient_public, info, kid, root, ephemeral_private)
	if r.is_empty():
		return {}
	return {"kem": PKeySyncHpke.KEM_X25519, "enc": r["enc"], "ct": r["ct"]}


## The 32-byte root, or null (an unknown `kem`, a wrong key, context or `kid`, tampering, a
## plaintext that is not 32 bytes). The caller still checks that `kid(root)` is the ring's rootKid.
static func unwrap_root(dh: Callable, recipient_public: PackedByteArray, product: String, device_id: String, ring_id: String, epoch: int, kid: PackedByteArray, kem: int, enc: PackedByteArray, ct: PackedByteArray) -> Variant:
	if kem != PKeySyncHpke.KEM_X25519:
		return null
	var info := wrap_info(product, device_id, ring_id, epoch)
	if info.is_empty():
		return null
	var root: Variant = PKeySyncHpke.open(dh, recipient_public, enc, info, kid, ct)
	if root == null or (root as PackedByteArray).size() != PKeySyncHkdf.ROOT_BYTES:
		return null
	return root


## `recovery.ct`: the root sealed under the code. Empty on a bad argument.
static func wrap_recovery(code: PackedByteArray, ring_id: String, epoch: int, kid: PackedByteArray, root: PackedByteArray, nonce: PackedByteArray = PackedByteArray()) -> PackedByteArray:
	if code.size() != PKeySyncRecoveryCode.CODE_BYTES:
		return PackedByteArray()
	return _seal_blob(PKeySyncHkdf.derive_recovery_key(code, ring_id), _aad("pkey-sync/1 recovery", ring_id, epoch, kid), root, nonce)


## The root, or null (a wrong code, ring, epoch or kid, or tampering).
static func unwrap_recovery(code: PackedByteArray, ring_id: String, epoch: int, kid: PackedByteArray, blob: PackedByteArray) -> Variant:
	if code.size() != PKeySyncRecoveryCode.CODE_BYTES:
		return null
	return _open_blob(PKeySyncHkdf.derive_recovery_key(code, ring_id), _aad("pkey-sync/1 recovery", ring_id, epoch, kid), blob)


## A previous or foreign root sealed under `K_adopt` of the current root. Empty on a bad argument.
static func seal_adopt(current_root: PackedByteArray, from_ring_id: String, epoch: int, kid: PackedByteArray, old_root: PackedByteArray, nonce: PackedByteArray = PackedByteArray()) -> PackedByteArray:
	if current_root.size() != PKeySyncHkdf.ROOT_BYTES:
		return PackedByteArray()
	return _seal_blob(PKeySyncHkdf.derive_adopt_key(current_root), _aad("pkey-sync/1 adopt", from_ring_id, epoch, kid), old_root, nonce)


## The adopted root, or null.
static func open_adopt(current_root: PackedByteArray, from_ring_id: String, epoch: int, kid: PackedByteArray, blob: PackedByteArray) -> Variant:
	if current_root.size() != PKeySyncHkdf.ROOT_BYTES:
		return null
	return _open_blob(PKeySyncHkdf.derive_adopt_key(current_root), _aad("pkey-sync/1 adopt", from_ring_id, epoch, kid), blob)


static func _u32(n: int) -> PackedByteArray:
	return PackedByteArray([(n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF])


## `label ringId u32be(epoch) kid`; empty on a bad epoch.
static func _aad(label: String, ring_id: String, epoch: int, kid: PackedByteArray) -> PackedByteArray:
	if epoch < 0 or epoch > 0xFFFFFFFF:
		return PackedByteArray()
	var b := label.to_utf8_buffer()
	b.append_array(ring_id.to_utf8_buffer())
	b.append_array(_u32(epoch))
	b.append_array(kid)
	return b


static func _seal_blob(key: PackedByteArray, aad: PackedByteArray, root: PackedByteArray, nonce: PackedByteArray) -> PackedByteArray:
	if aad.is_empty() or root.size() != PKeySyncHkdf.ROOT_BYTES or key.size() != 32:
		return PackedByteArray()
	var n := nonce if not nonce.is_empty() else Crypto.new().generate_random_bytes(NONCE_BYTES)
	if n.size() != NONCE_BYTES:
		return PackedByteArray()
	var sealed := PKeySyncAesGcm.seal(key, n, root, aad)
	if sealed.is_empty():
		return PackedByteArray()
	var out := PackedByteArray([BLOB_VERSION])
	out.append_array(n)
	out.append_array(sealed)
	return out


static func _open_blob(key: PackedByteArray, aad: PackedByteArray, blob: PackedByteArray) -> Variant:
	if aad.is_empty() or key.size() != 32 or blob.size() != BLOB_BYTES or blob[0] != BLOB_VERSION:
		return null
	var root: Variant = PKeySyncAesGcm.open(key, blob.slice(1, 13), blob.slice(13), aad)
	if root == null or (root as PackedByteArray).size() != PKeySyncHkdf.ROOT_BYTES:
		return null
	return root
