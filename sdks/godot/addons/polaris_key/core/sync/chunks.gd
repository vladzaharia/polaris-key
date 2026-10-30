@tool
class_name PKeySyncChunks
extends RefCounted
## Chunk ids and chunk objects (WIRE-CONTRACT-V5 §13.8.3, §13.10.2).
##
##   id      E2E: HMAC-SHA256(K_cid(c), plainChunk); server mode: SHA-256(plainChunk). Hex on the
##           wire (`SYNC_CHUNK_ID_PATTERN`), 32 raw bytes as a key salt and in the aad.
##   object  `pkey-sync-chunk/1`: 0x01 | codec | nonce(12) | AES-256-GCM(K_chunk(id), nonce,
##           aad = 0x01 | codec | id, body). codec 0 is the chunk as is, codec 1 is one zstd frame
##           that declares its content size. A writer may compress (D-4: writers here emit codec
##           0); a reader decodes both. K_chunk is per chunk id, but one id can be sealed with
##           different bodies, so the nonce is synthetic: HMAC-SHA256(K_chunk, 0x01 | codec |
##           body)[0:12]. The reader takes the nonce from the object and recomputes it after the
##           tag opens.
##
## `root` is the 32-byte ring root in E2E mode and `null` in server mode (ids only; an object is
## sealed under the ring, so `seal` and `open` need a root).
##
## The engine's AES-256-GCM here takes at most `PKeySyncAesGcm.MAX_BYTES` (64 KiB) a call, so an
## object whose body is larger answers the reason `unsupported` (a seal answers an empty array)
## instead of a wrong `auth`; U-23.G2 raises the cap (D-10).

const OBJECT_VERSION := 0x01
const CODEC_RAW := 0
const CODEC_ZSTD := 1
## Version, codec, nonce and the tag: the smallest object (an empty body).
const OBJECT_MIN_BYTES := 2 + 12 + 16
const NONCE_BYTES := 12
const ID_BYTES := 32

static var _id_re: RegEx


static func _static_init() -> void:
	_id_re = RegEx.create_from_string("\\A[0-9a-f]{64}\\z")


## 32 raw bytes of a chunk id, or null when the text is not 64 lowercase hex characters.
static func id_bytes(hex: String) -> Variant:
	if _id_re.search(hex) == null:
		return null
	return hex.hex_decode()


## The id of a plaintext chunk: `root` is the ring root (E2E) or `null` (server mode, the plain
## SHA-256). An empty array for a root that is not 32 bytes.
static func chunk_id(root: Variant, collection: String, plain: PackedByteArray) -> PackedByteArray:
	if root == null:
		return PKeySyncHkdf.sha256(plain)
	if not (root is PackedByteArray) or (root as PackedByteArray).size() != PKeySyncHkdf.ROOT_BYTES:
		return PackedByteArray()
	return PKeySyncHkdf.hmac(PKeySyncHkdf.derive_chunk_id_key(root, collection), plain)


## `chunk_id` as the 64-character hex of the wire ("" when the id is unusable).
static func chunk_id_hex(root: Variant, collection: String, plain: PackedByteArray) -> String:
	return chunk_id(root, collection, plain).hex_encode()


static func _synthetic_nonce(key: PackedByteArray, codec: int, body: PackedByteArray) -> PackedByteArray:
	var msg := PackedByteArray([OBJECT_VERSION, codec])
	msg.append_array(body)
	var mac := PKeySyncHkdf.hmac(key, msg)
	return mac.slice(0, NONCE_BYTES) if not mac.is_empty() else mac


static func _chunk_key(root: PackedByteArray, collection: String, id: PackedByteArray) -> PackedByteArray:
	return PKeySyncHkdf.derive_chunk_key(PKeySyncHkdf.derive_coll_key(root, collection), id)


## Seals `body` (the chunk for codec 0, one zstd frame for codec 1) as the object for `id`. The
## caller computed `id` from the plaintext; `open` checks it again. An empty array means refusal:
## a bad root, id or codec, or a body over the AES-GCM cap.
static func seal(root: PackedByteArray, collection: String, id: PackedByteArray, codec: int, body: PackedByteArray) -> PackedByteArray:
	if root.size() != PKeySyncHkdf.ROOT_BYTES or id.size() != ID_BYTES:
		return PackedByteArray()
	if codec != CODEC_RAW and codec != CODEC_ZSTD:
		return PackedByteArray()
	var aad := PackedByteArray([OBJECT_VERSION, codec])
	aad.append_array(id)
	var key := _chunk_key(root, collection, id)
	if key.is_empty():
		return PackedByteArray()
	var nonce := _synthetic_nonce(key, codec, body)
	if nonce.is_empty():
		return PackedByteArray()
	var ct := PKeySyncAesGcm.seal(key, nonce, body, aad)
	if ct.is_empty():
		return PackedByteArray()
	var out := aad.slice(0, 2)
	out.append_array(nonce)
	out.append_array(ct)
	return out


## The content size a zstd frame header declares (RFC 8878 §3.1.1.1), or -1 when the frame does
## not start with the magic, is cut short or declares none.
static func zstd_content_size(f: PackedByteArray) -> int:
	if f.size() < 6 or f[0] != 0x28 or f[1] != 0xB5 or f[2] != 0x2F or f[3] != 0xFD:
		return -1
	var d := f[4]
	var flag := d >> 6
	var single := (d >> 5) & 1
	var dict_bytes: int = [0, 1, 2, 4][d & 3]
	var at := 5 + (0 if single == 1 else 1) + dict_bytes
	var width := 0
	if flag == 0:
		width = 1 if single == 1 else 0
	else:
		width = [0, 2, 4, 8][flag]
	if width == 0 or f.size() < at + width:
		return -1
	# A declared size past 2^53 would be refused as `size` anyway; the top bit also reads as
	# negative in a signed 64-bit value, so cap it here.
	var v := 0
	for i in range(width - 1, -1, -1):
		v = v * 256 + f[at + i]
		if v > 0x7FFFFFFFFFFF:
			return 0x7FFFFFFFFFFF
	return v + 256 if flag == 1 else v


## Opens the object for `id` in `collection`. Answers `{"ok": true, "plain": PackedByteArray,
## "codec": int}` or `{"ok": false, "reason": r}`. The checks run in this order: `shape`,
## `version`, `codec`, `auth` (the tag, which covers the codec and the id), `nonce`, `decode` /
## `size` (the zstd frame must declare a content size of at most `SYNC_CDC_MAX_BYTES`, checked
## before any decode), and last `id` (the keyed hash of the plaintext is `id`). `unsupported` is
## this engine's own reason (see the file comment). `decode` is a `Callable(frame, size) ->
## PackedByteArray` for a codec 1 body; the default is the engine's zstd (`PKeyPackZstd`).
static func open(root: PackedByteArray, collection: String, id: PackedByteArray, object: PackedByteArray, decode: Callable = Callable()) -> Dictionary:
	if object.size() < OBJECT_MIN_BYTES:
		return _bad("shape")
	if object[0] != OBJECT_VERSION:
		return _bad("version")
	var codec := object[1]
	if codec != CODEC_RAW and codec != CODEC_ZSTD:
		return _bad("codec")
	if id.size() != ID_BYTES or root.size() != PKeySyncHkdf.ROOT_BYTES:
		return _bad("auth")
	if object.size() - OBJECT_MIN_BYTES > PKeySyncAesGcm.MAX_BYTES:
		return _bad("unsupported")
	var aad := object.slice(0, 2)
	aad.append_array(id)
	var key := _chunk_key(root, collection, id)
	var nonce := object.slice(2, 2 + NONCE_BYTES)
	var opened: Variant = PKeySyncAesGcm.open(key, nonce, object.slice(2 + NONCE_BYTES), aad)
	if opened == null:
		return _bad("auth")
	var body: PackedByteArray = opened
	var want := _synthetic_nonce(key, codec, body)
	if not PKeySyncAesGcm.equal_constant_time(want, nonce):
		return _bad("nonce")
	var plain := body
	if codec == CODEC_ZSTD:
		var size := zstd_content_size(body)
		if size < 0:
			return _bad("decode")
		if size > PKeyConstants.SYNC_CDC_MAX_BYTES:
			return _bad("size")
		var got: Variant = decode.call(body, size) if decode.is_valid() else PKeyPackZstd.new().decode(body, size)
		if not (got is PackedByteArray) or (got as PackedByteArray).size() != size:
			return _bad("decode")
		plain = got
	if plain.size() > PKeyConstants.SYNC_CDC_MAX_BYTES:
		return _bad("size")
	if not PKeySyncAesGcm.equal_constant_time(chunk_id(root, collection, plain), id):
		return _bad("id")
	return {"ok": true, "plain": plain, "codec": codec}


static func _bad(reason: String) -> Dictionary:
	return {"ok": false, "reason": reason}
