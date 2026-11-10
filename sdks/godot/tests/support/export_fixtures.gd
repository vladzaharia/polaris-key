class_name PKeyExportFixtures
extends RefCounted
## The export corpus rows (`sync-vectors.json` `exportCases`) as a transport: the changes as served, a file
## source built from each row's recipes, and the zip read back through the engine's `ZIPReader`. Shared by
## suite_sync_vectors (the corpus) and suite_cloud_sync_export (the host). A port of the Python
## `export_fixtures.py`.

const TransferCodec := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")
const PIECE := 300007


## A host codec over a root: the ring codec's surface (`locked`, `open`, `open_any`, `blind`) and the codec port's `open_pull`.
class RootCodec:
	extends RefCounted
	var root: PackedByteArray
	var is_locked := false

	func _init(p_root: PackedByteArray) -> void:
		root = p_root

	func locked() -> bool:
		return is_locked

	func open(collection: String, name: Variant, envelope: PackedByteArray, aliases: Array = []) -> Dictionary:
		return PKeySyncEnvelope.open_value(root, collection, name, envelope, aliases)

	func open_any(collection: String, envelope: PackedByteArray) -> Dictionary:
		return PKeySyncEnvelope.open_value_any_name(root, collection, envelope)

	func blind(kind: String, ctx: String, name: String) -> String:
		return PKeySyncBlind.blind(root, kind, ctx, name)

	func open_pull(body: Dictionary, mutations: Variant, aliases: Variant, open_keys: Array, record_keys: Array = []) -> Dictionary:
		return PKeySyncHostCodec.open_pull_with(body, self, mutations, aliases, open_keys, record_keys)


## What the transport serves: whole files and manifests by `collection NUL record NUL version`, chunks by
## `collection NUL id`.
class Transport:
	extends RefCounted
	var whole := {}
	var chunks := {}


## A reader over one stored object in pieces of `piece` bytes.
class Reader:
	extends RefCounted
	var _data: PackedByteArray
	var _at := 0
	var _piece: int
	var _src: Object

	func _init(src: Object, data: PackedByteArray, piece: int) -> void:
		_src = src
		_data = data
		_piece = piece

	func read_piece() -> PackedByteArray:
		if _at >= _data.size():
			return PackedByteArray()
		var p := _data.slice(_at, _at + _piece)
		_at += p.size()
		_src.stored_bytes += p.size()
		return p

	func close() -> void:
		pass


## A file source over a row's transport: bytes arrive in awkward pieces, and the reads are counted.
class FakeSource:
	extends RefCounted
	var row: Dictionary
	var transport: Transport
	var piece := PIECE
	var stored_bytes := 0
	var opened := 0
	var error: Dictionary = {}

	func _init(p_row: Dictionary, p_transport: Transport) -> void:
		row = p_row
		transport = p_transport

	func pointers(collection: String, record: String) -> Array:
		var out: Array = []
		for f: Dictionary in row["files"]:
			if f["collection"] == collection and f["record"] == record:
				out.append({"version": f["version"], "size": f["size"], "sha256": f["sha256"], "format": f["format"]})
		return out

	func open_stored(ref: Dictionary) -> Variant:
		opened += 1
		var key := PKeyExportFixtures.whole_key(ref["collection"], ref["record"], ref["version"])
		if not transport.whole.has(key):
			return null
		return Reader.new(self, transport.whole[key], piece)

	func chunk(collection: String, id_hex: String) -> Variant:
		return transport.chunks.get(collection + "\u0000" + id_hex)


## A sink that keeps every piece.
class CollectSink:
	extends RefCounted
	var parts: Array[PackedByteArray] = []
	var writes := 0
	var max_piece := 0
	## Set to make the next writes fail (a full disk).
	var fail_after := -1

	func write(data: PackedByteArray) -> bool:
		if fail_after >= 0 and writes >= fail_after:
			return false
		writes += 1
		parts.append(data.duplicate())
		max_piece = maxi(max_piece, data.size())
		return true

	func bytes() -> PackedByteArray:
		var out := PackedByteArray()
		for p in parts:
			out.append_array(p)
		return out


static func whole_key(collection: String, record: String, version: Variant) -> String:
	return "%s\u0000%s\u0000%d" % [collection, record, int(version)]


## The corpus plaintext: SHA-256(label || u32be(i)) blocks, cut to `length`.
static func stream(label: String, length: int) -> PackedByteArray:
	var out := PackedByteArray()
	var i := 0
	var head := label.to_utf8_buffer()
	while out.size() < length:
		var b := head.duplicate()
		b.append((i >> 24) & 255)
		b.append((i >> 16) & 255)
		b.append((i >> 8) & 255)
		b.append(i & 255)
		out.append_array(PKeySyncHkdf.sha256(b))
		i += 1
	return out.slice(0, length)


static func hex_bytes(h: String) -> PackedByteArray:
	return h.hex_decode()


static func _flip(b: PackedByteArray, at: int) -> PackedByteArray:
	var m := b.duplicate()
	m[at] = m[at] ^ 1
	return m


static func root_of(row: Dictionary) -> Variant:
	return hex_bytes(row["rootHex"]) if row.has("rootHex") else null


## The host codec and the file-codec factory of a row (`null` and the server codec in server mode).
static func codecs_of(row: Dictionary) -> Dictionary:
	var root: Variant = root_of(row)
	if root == null:
		return {"codec": null, "file_codec": func(_c: String) -> Object: return TransferCodec.Server.new()}
	return {"codec": RootCodec.new(root), "file_codec": func(c: String) -> Object: return TransferCodec.E2e.new(root, c)}


## What the transport serves for each file and chunk of a row.
static func transport_of(row: Dictionary, file_codec: Callable) -> Transport:
	var root: Variant = root_of(row)
	var t := Transport.new()
	for f: Dictionary in row["files"]:
		var key := whole_key(f["collection"], f["record"], f["version"])
		if f.has("stored"):
			var r: Dictionary = f["stored"]
			var swap: Variant = r.get("swap")
			var label: String = swap["label"] if swap != null else r["label"]
			var salt: Variant = swap.get("saltHex") if swap != null else r.get("saltHex")
			var plain := stream(label, int(r["length"]))
			var served := plain
			if salt != null and root != null:
				var ck := PKeySyncHkdf.derive_coll_key(root, f["collection"])
				var kid := PKeySyncHkdf.derive_kid(root)
				served = PKeySyncFileStream.seal_file(ck, kid, plain, hex_bytes(salt))["sealed"]
			if r.has("extra"):
				served.append_array(stream(String(r["label"]) + " extra", int(r["extra"])))
			if r.has("flipAt"):
				served = _flip(served, int(r["flipAt"]))
			if r.has("cut"):
				served = served.slice(0, int(r["cut"]))
			t.whole[key] = served
		elif f.has("chunked"):
			var r: Dictionary = f["chunked"]
			var codec: Object = file_codec.call(f["collection"])
			var lens: Array = r["chunkLens"]
			var total := 0
			for n in lens:
				total += int(n)
			var plain := stream(r["label"], total)
			var records: Array = []
			var at := 0
			for i in lens.size():
				var n := int(lens[i])
				var body := plain.slice(at, at + n)
				at += n
				var cid: PackedByteArray = codec.chunk_id(body)
				records.append({"id": cid, "plain_len": n})
				if r.has("dropChunk") and int(r["dropChunk"]) == i:
					continue
				var obj: PackedByteArray = codec.seal_chunk(cid, body)
				if r.has("flipChunk") and int(r["flipChunk"]) == i:
					obj[obj.size() - 1] = obj[obj.size() - 1] ^ 1
				t.chunks[String(f["collection"]) + "\u0000" + cid.hex_encode()] = obj
			var digest := PKeySyncHkdf.sha256(plain)
			if r.get("plainSha256Flip", false):
				digest[0] = digest[0] ^ 1
			var manifest := PKeySyncManifest.encode({"plain_size": int(r.get("manifestPlainSize", total)), "plain_sha256": digest, "records": records})
			var stored := manifest
			if root != null:
				var ck := PKeySyncHkdf.derive_coll_key(root, f["collection"])
				var kid := PKeySyncHkdf.derive_kid(root)
				stored = PKeySyncFileStream.seal_file(ck, kid, manifest, hex_bytes(r["saltHex"]))["sealed"]
			if r.has("manifestFlipAt"):
				stored = _flip(stored, int(r["manifestFlipAt"]))
			t.whole[key] = stored
	return t


## The core's input for a row.
static func input_of(row: Dictionary, source: Object, extra := {}) -> Dictionary:
	var c := codecs_of(row)
	var inp := {
		"product": row["product"],
		"exported_at": row["exportedAt"],
		"unsynced": row["unsynced"],
		"include_revisions": row["includeRevisions"],
		"changes": row["changes"],
		"files": source,
		"codec": c["codec"],
		"file_codec": c["file_codec"],
		"caps": row.get("caps", {}),
	}
	inp.merge(extra, true)
	return inp


## Runs a row through the core into a collecting sink: `{result, sink, source}`.
static func run_row(row: Dictionary, piece := PIECE) -> Dictionary:
	var c := codecs_of(row)
	var source := FakeSource.new(row, transport_of(row, c["file_codec"]))
	source.piece = piece
	var sink := CollectSink.new()
	var result: Dictionary = await PKeySyncExport.run(input_of(row, source), sink)
	return {"result": result, "sink": sink, "source": source}


## The entries of an archive in central-directory order through `ZIPReader`: `[{name, data}]`, or null when the
## engine cannot open it.
static func read_zip(data: PackedByteArray, tag: String) -> Variant:
	var dir := PKeyTestFixtures.scratch_dir("export_zip_" + tag)
	var path := dir.path_join("a.zip")
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_buffer(data)
	f.close()
	var z := ZIPReader.new()
	var out: Variant = null
	if z.open(path) == OK:
		out = []
		for name in z.get_files():
			out.append({"name": name, "data": z.read_file(name)})
		z.close()
	PKeyTestFixtures.remove_tree(dir)
	return out
