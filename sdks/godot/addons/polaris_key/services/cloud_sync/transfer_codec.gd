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

## A codec whose key is the key ring's. Every call and every stream piece asks `is_stale` first. It is stale
## once the ring has locked or its root has been replaced (a new root accepted, adopted or recovered): from
## then on it drops the inner codec (and the root in it), answers nothing usable (an empty result or
## `{ok: false, reason: "locked"}`) and sets `tripped`, which the saves layer reads to report `sync-locked`
## rather than a file error. Nothing after the lock is sealed under a zeroed, replaced or stale root.
class Guarded:
	extends RefCounted
	var enc := "e2e"
	var tripped := false
	## The ring's root generation this codec was made at (0 when unknown).
	var root_generation := 0
	var _inner: Object
	var _is_stale: Callable

	func _init(inner: Object, is_stale: Callable) -> void:
		_inner = inner
		_is_stale = is_stale
		enc = inner.enc

	func _to_string() -> String:
		return "GuardedFileCodec(locked=%s)" % locked()

	## True once the ring has locked or replaced its root (and from then on, for good).
	func locked() -> bool:
		if _inner == null:
			return true
		if _is_stale.is_valid() and _is_stale.call():
			tripped = true
			_inner = null
			return true
		return false

	## The inner codec for a worker thread, or null when stale. The caller asks `locked()` again on the main
	## thread when the work is done and throws the result away if it went stale.
	func inner() -> Object:
		return null if locked() else _inner

	func chunk_id(plain: PackedByteArray) -> PackedByteArray:
		return PackedByteArray() if locked() else _inner.chunk_id(plain)

	func chunk_object_bytes(plain_len: int) -> int:
		return -1 if locked() else _inner.chunk_object_bytes(plain_len)

	func seal_chunk(id: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
		return PackedByteArray() if locked() else _inner.seal_chunk(id, plain)

	func open_chunk(id: PackedByteArray, obj: PackedByteArray) -> Dictionary:
		return {"ok": false, "reason": "locked"} if locked() else _inner.open_chunk(id, obj)

	func stored_size(plain_size: int) -> int:
		return -1 if locked() else _inner.stored_size(plain_size)

	func plain_size(stored: int) -> int:
		return -1 if locked() else _inner.plain_size(stored)

	func seal_manifest(plain: PackedByteArray) -> PackedByteArray:
		return PackedByteArray() if locked() else _inner.seal_manifest(plain)

	func open_manifest(stored: PackedByteArray) -> Dictionary:
		return {"ok": false, "reason": "locked"} if locked() else _inner.open_manifest(stored)

	func seal_whole(plain: PackedByteArray) -> PackedByteArray:
		return PackedByteArray() if locked() else _inner.seal_whole(plain)

	func open_whole(stored: PackedByteArray) -> Dictionary:
		return {"ok": false, "reason": "locked"} if locked() else _inner.open_whole(stored)


## The guarded end-to-end file codec of `collection` over `port` (a codec port: `with_root`, `locked`,
## `root_generation`), made for the root held now; null while the ring is locked. It is stale when the ring
## locks or the root generation moves.
static func e2e_for(port: Object, collection: String) -> Variant:
	if not port.has_method("with_root"):
		return null
	return port.with_root(func(root: PackedByteArray) -> Variant:
		var generation: int = port.root_generation()
		var g := Guarded.new(E2e.new(root, collection), func() -> bool: return port.locked() or port.root_generation() != generation)
		g.root_generation = generation
		return g)


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

	## A stream sealer / opener under this codec's keys, for a caller that steps through a file itself.
	func whole_sealer() -> PKeySyncFileStream.Sealer:
		return PKeySyncFileStream.Sealer.new(_coll_key, _kid)

	func whole_opener() -> PKeySyncFileStream.Opener:
		return PKeySyncFileStream.Opener.new(_coll_key, _kid)


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
