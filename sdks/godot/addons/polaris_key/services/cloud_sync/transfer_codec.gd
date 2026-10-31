extends RefCounted
## What the transfer engine needs to know about how a collection stores its files (U-23.G4): the chunk
## ids, the chunk objects and the stored form of a manifest or a whole file. A port of Python
## `cloud_sync/transfer_codec.py`. The engine moves stored bytes and checks hashes; a codec is the one
## place that knows whether those bytes are sealed.
##
##   E2e     ids are HMAC-SHA256 under K_cid(c); chunks are `pkey-sync-chunk/1` objects (§13.8.3); a manifest
##           and a whole file are `pkey-sync-file/1` streams
##   Server  ids are the plain SHA-256; a chunk object is `0x00 | codec | body` (D-5); manifest and file are
##           stored as they are
##
## Writers emit codec 0 (raw) chunks only (D-4); readers decode codecs 0 and 1 (a zstd body declares its
## content size, checked before any decode). A stored chunk is at most `SERVER_CHUNK_MAX_STORED_BYTES`.
## Every opener answers `{ok: true, plain}` or `{ok: false, reason}`. The root of an E2e codec is never put
## in a result, a message or a log line.

const SERVER_CHUNK_MAX_STORED_BYTES := 1048576 + 30
const SERVER_OBJECT_VERSION := 0x00


class E2e:
	extends RefCounted
	var enc := "e2e"
	var _root: PackedByteArray
	var _collection: String
	var _coll_key: PackedByteArray
	var _kid: PackedByteArray
	var _decode: Callable

	func _init(root: PackedByteArray, collection: String, decode := Callable()) -> void:
		_root = root
		_collection = collection
		_decode = decode
		_coll_key = PKeySyncHkdf.derive_coll_key(root, collection)
		_kid = PKeySyncHkdf.derive_kid(root)

	func _to_string() -> String:
		return "E2eFileCodec(%s)" % _collection

	func chunk_id(plain: PackedByteArray) -> PackedByteArray:
		return PKeySyncChunks.chunk_id(_root, _collection, plain)

	func chunk_object_bytes(plain_len: int) -> int:
		return plain_len + 30

	func seal_chunk(id: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
		return PKeySyncChunks.seal(_root, _collection, id, PKeySyncChunks.CODEC_RAW, plain)

	func open_chunk(id: PackedByteArray, obj: PackedByteArray) -> Dictionary:
		return PKeySyncChunks.open(_root, _collection, id, obj, _decode)

	func stored_size(plain_size: int) -> int:
		return PKeySyncFileStream.sealed_size(plain_size)

	func plain_size(stored: int) -> int:
		return PKeySyncFileStream.plain_size_of(stored)

	func seal_manifest(plain: PackedByteArray) -> PackedByteArray:
		var r := PKeySyncFileStream.seal_file(_coll_key, _kid, plain)
		return r["sealed"] if r["ok"] else PackedByteArray()

	func open_manifest(stored: PackedByteArray) -> Dictionary:
		return PKeySyncFileStream.open_file(_coll_key, _kid, stored)

	## The stored form of a whole file (a fresh salt every call); empty when the lane refuses it.
	func seal_whole(plain: PackedByteArray) -> PackedByteArray:
		return seal_manifest(plain)

	func open_whole(stored: PackedByteArray) -> Dictionary:
		return PKeySyncFileStream.open_file(_coll_key, _kid, stored)


class Server:
	extends RefCounted
	var enc := "none"
	var _decode: Callable

	func _init(decode := Callable()) -> void:
		_decode = decode

	func chunk_id(plain: PackedByteArray) -> PackedByteArray:
		return PKeySyncHkdf.sha256(plain)

	func chunk_object_bytes(plain_len: int) -> int:
		return plain_len + 2

	func seal_chunk(id: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
		if id.size() != 32:
			return PackedByteArray()
		var out := PackedByteArray([SERVER_OBJECT_VERSION, PKeySyncChunks.CODEC_RAW])
		out.append_array(plain)
		return out

	func open_chunk(id: PackedByteArray, obj: PackedByteArray) -> Dictionary:
		if obj.size() < 2:
			return {"ok": false, "reason": "shape"}
		if obj.size() > SERVER_CHUNK_MAX_STORED_BYTES:
			return {"ok": false, "reason": "size"}
		if obj[0] != SERVER_OBJECT_VERSION:
			return {"ok": false, "reason": "version"}
		var codec := obj[1]
		if codec != PKeySyncChunks.CODEC_RAW and codec != PKeySyncChunks.CODEC_ZSTD:
			return {"ok": false, "reason": "codec"}
		var body := obj.slice(2)
		var plain := body
		if codec == PKeySyncChunks.CODEC_ZSTD:
			var size := PKeySyncChunks.zstd_content_size(body)
			if size < 0:
				return {"ok": false, "reason": "decode"}
			if size > PKeyConstants.SYNC_CDC_MAX_BYTES:
				return {"ok": false, "reason": "size"}
			var got: Variant = _decode.call(body, size) if _decode.is_valid() else PKeyPackZstd.new().decode(body, size)
			if not (got is PackedByteArray) or (got as PackedByteArray).size() != size:
				return {"ok": false, "reason": "decode"}
			plain = got
		if plain.size() > PKeyConstants.SYNC_CDC_MAX_BYTES:
			return {"ok": false, "reason": "size"}
		if not PKeySyncAesGcm.equal_constant_time(PKeySyncHkdf.sha256(plain), id):
			return {"ok": false, "reason": "id"}
		return {"ok": true, "plain": plain, "codec": codec}

	func stored_size(plain_size: int) -> int:
		return plain_size

	func plain_size(stored: int) -> int:
		return stored

	func seal_manifest(plain: PackedByteArray) -> PackedByteArray:
		return plain.duplicate()

	func open_manifest(stored: PackedByteArray) -> Dictionary:
		return {"ok": true, "plain": stored}

	func seal_whole(plain: PackedByteArray) -> PackedByteArray:
		return plain.duplicate()

	func open_whole(stored: PackedByteArray) -> Dictionary:
		return {"ok": true, "plain": stored}
