@tool
class_name PKeySyncAesGcm
extends RefCounted
## AES-256-GCM (NIST SP 800-38D) for Linux and the editor, where no native AEAD is linked
## (CC-13, R-12). The block cipher is the engine's `AESContext` in ECB mode, used as a CTR
## keystream; the XOR and GHASH are GDScript. GHASH and the XOR are bitwise with arithmetic masks:
## no branch and no table index in them depends on the key, the data or the tag, and the tag
## compare ORs every byte. Only lengths steer control flow. The block cipher itself is the engine's
## (mbedtls software AES), whose table lookups this file does not control. At most 64 KiB per call (a setting is at most 8 KiB); files stay
## native-only. A 12-byte nonce, a 32-byte key and a 16-byte tag are the only shapes.

const KEY_BYTES := 32
const NONCE_BYTES := 12
const TAG_BYTES := 16
const MAX_BYTES := 65536

## GHASH reduction polynomial 0xE1 << 120, as the signed high word.
const _R_HI := -0x1F00000000000000
const _M63 := 0x7FFFFFFFFFFFFFFF


## Seals `plain` under `key` and `nonce`, binding `aad`. Returns ciphertext followed by the 16-byte
## tag. An empty array means refusal (a bad size, or the engine cipher failed) and nothing else: a
## success is never empty, since the tag is 16 bytes. Test the result with `.is_empty()`.
## A nonce must never repeat under a key: draw it from `Crypto.generate_random_bytes(12)`.
static func seal(key: PackedByteArray, nonce: PackedByteArray, plain: PackedByteArray, aad: PackedByteArray = PackedByteArray()) -> PackedByteArray:
	if key.size() != KEY_BYTES or nonce.size() != NONCE_BYTES or plain.size() > MAX_BYTES or aad.size() > MAX_BYTES:
		return PackedByteArray()
	var ks := _keystream(key, nonce, plain.size())
	if ks.is_empty():
		return PackedByteArray()
	var ct := _xor(plain, ks, 32)
	var tag := _tag(ks, ct, aad)
	ct.append_array(tag)
	return ct


## Opens `sealed` (ciphertext then tag). Returns the plaintext, or null when an argument is
## unusable, the engine cipher failed or the tag does not verify. A valid empty message opens to an
## EMPTY array, which is not a failure: always test `== null`, never truthiness or `is_empty()`. The
## tag is checked before any plaintext is produced.
static func open(key: PackedByteArray, nonce: PackedByteArray, sealed: PackedByteArray, aad: PackedByteArray = PackedByteArray()) -> Variant:
	if key.size() != KEY_BYTES or nonce.size() != NONCE_BYTES or aad.size() > MAX_BYTES:
		return null
	if sealed.size() < TAG_BYTES or sealed.size() - TAG_BYTES > MAX_BYTES:
		return null
	var n := sealed.size() - TAG_BYTES
	var ct := sealed.slice(0, n)
	var ks := _keystream(key, nonce, n)
	if ks.is_empty():
		return null
	var want := _tag(ks, ct, aad)
	if not equal_constant_time(want, sealed.slice(n)):
		return null
	return _xor(ct, ks, 32)


## Compares two byte strings in time that depends only on their length: every byte is read and
## the differences are ORed, with no early exit.
static func equal_constant_time(a: PackedByteArray, b: PackedByteArray) -> bool:
	if a.size() != b.size():
		return false
	var diff := 0
	for i in a.size():
		diff |= a[i] ^ b[i]
	return diff == 0


## The CTR keystream (empty on an engine failure), laid out as block 0 = E(0) (the GHASH key H), block 1 = E(J0) (the tag
## mask), blocks 2.. = the keystream for `n` message bytes.
static func _keystream(key: PackedByteArray, nonce: PackedByteArray, n: int) -> PackedByteArray:
	var blocks := 2 + (n + 15) / 16
	var buf := PackedByteArray()
	buf.resize(blocks * 16)
	var n0 := nonce.decode_u64(0)
	var n1 := nonce.decode_u32(8)
	for i in range(1, blocks):
		# Block 1 is J0 (counter 1); block k >= 2 is counter k.
		var c := i
		var be := ((c & 0xFF) << 24) | ((c & 0xFF00) << 8) | ((c >> 8) & 0xFF00) | ((c >> 24) & 0xFF)
		var o := i * 16
		buf.encode_u64(o, n0)
		buf.encode_u32(o + 8, n1)
		buf.encode_u32(o + 12, be)
	var aes := AESContext.new()
	if aes.start(AESContext.MODE_ECB_ENCRYPT, key) != OK:
		return PackedByteArray()
	var out := aes.update(buf)
	aes.finish()
	# A cipher that answers the wrong size is a failure, never a short keystream.
	if out.size() != blocks * 16:
		return PackedByteArray()
	return out


static func _xor(data: PackedByteArray, ks: PackedByteArray, ks_offset: int) -> PackedByteArray:
	var out := PackedByteArray()
	out.resize(data.size())
	for i in data.size():
		out[i] = data[i] ^ ks[ks_offset + i]
	return out


static func _be64(b: PackedByteArray, o: int) -> int:
	return (b[o] << 56) | (b[o + 1] << 48) | (b[o + 2] << 40) | (b[o + 3] << 32) | (b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7]


static func _tag(ks: PackedByteArray, ct: PackedByteArray, aad: PackedByteArray) -> PackedByteArray:
	var hh := _be64(ks, 0)
	var hl := _be64(ks, 8)
	var yh := 0
	var yl := 0
	# The length block is two big-endian 64-bit counts.
	var lb := PackedByteArray()
	lb.resize(16)
	for i in 8:
		lb[i] = (aad.size() * 8 >> (56 - 8 * i)) & 0xFF
		lb[8 + i] = (ct.size() * 8 >> (56 - 8 * i)) & 0xFF
	for part in [aad, ct, lb]:
		var p: PackedByteArray = part
		var padded := p.duplicate()
		padded.resize((p.size() + 15) / 16 * 16)
		for off in range(0, padded.size(), 16):
			var xh := yh ^ _be64(padded, off)
			var xl := yl ^ _be64(padded, off + 8)
			# Z = X * H in GF(2^128), bit by bit, most significant bit of X first.
			var zh := 0
			var zl := 0
			var vh := hh
			var vl := hl
			for b in range(63, -1, -1):
				var m := -((xh >> b) & 1)
				zh ^= vh & m
				zl ^= vl & m
				var lsb := vl & 1
				vl = ((vl >> 1) & _M63) | ((vh & 1) << 63)
				vh = ((vh >> 1) & _M63) ^ (_R_HI & -lsb)
			for b in range(63, -1, -1):
				var m := -((xl >> b) & 1)
				zh ^= vh & m
				zl ^= vl & m
				var lsb := vl & 1
				vl = ((vl >> 1) & _M63) | ((vh & 1) << 63)
				vh = ((vh >> 1) & _M63) ^ (_R_HI & -lsb)
			yh = zh
			yl = zl
	var tag := PackedByteArray()
	tag.resize(16)
	for i in 8:
		tag[i] = ((yh >> (56 - 8 * i)) & 0xFF) ^ ks[16 + i]
		tag[8 + i] = ((yl >> (56 - 8 * i)) & 0xFF) ^ ks[24 + i]
	return tag
