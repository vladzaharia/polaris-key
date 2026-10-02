class_name PKeyPackPatch
extends RefCounted
## `pkey-patch/1`, the descriptor of a `files`-scope delta set (plans/P4-01.md §2.7;
## WIRE-CONTRACT-V4 §2.6), and the one object-ref opener every applier shares: a port of
## client-core `packs/patch.ts`. Pure; returns null on any failure (the caller's code).


## A stored object against its ref, then its decoded bytes (§2.7 step 1): the stored length and
## SHA-256 must equal the ref's, the codec be `zstd` (decoded to exactly `size`) or `none`. null
## on any failure. `max_size` >= 0 refuses a larger `ref.size` before a byte is read.
static func open_object(stored: PKeyByteSource, ref: Dictionary, zstd: PKeyPackZstd, max_size := -1) -> Variant:
	if stored == null:
		return null
	if not PKeyClaims.is_number(ref.get("size")) or not PKeyClaims.is_number(ref.get("bytes")):
		return null
	if max_size >= 0 and not (float(ref["size"]) <= float(max_size)):
		return null
	if not PKeyPackSelect.usable_codec(ref.get("codec")):
		return null
	if float(stored.size) != float(ref["bytes"]):
		return null
	var bytes := PKeyByteSource.read_all(stored)
	if float(bytes.size()) != float(ref["bytes"]):
		return null
	if not PKeyPackClaims.same(PKeyPackClaims.sha256_hex(bytes), ref.get("sha256")):
		return null
	if ref["codec"] == "none":
		return bytes
	var out := zstd.decode(bytes, int(ref["size"]))
	return out if out.size() == int(ref["size"]) else null


## `parsePatch(stored, delta, targetPayloadSha256, targetIndex)` (§2.7): the descriptor of a
## `files` delta set, or null (the caller's `delta-artifact-mismatch`). Refused: a descriptor
## whose `patch` ref fails `open_object` (MAX_FILES_INDEX_BYTES included), that is not strict JSON
## or breaks the integer rule, whose `format`, `scope`, `method`, `from`, `to` or `data` differ
## from the record's delta and the target, or whose entries break the member rules: each a path of
## the target index at most once, in target index order, `to` and `size` equal to that entry's,
## `offset` and `length` integers whose ranges follow the layout rule and end within
## `data.bytes`, `from` 64 lowercase hex on a `delta` entry, `codec` `zstd` or `none` (with
## `length == size`) on a `blob` entry.
static func parse_patch(stored: PKeyByteSource, delta: Dictionary, target_payload_sha256: String, target: Dictionary, zstd: PKeyPackZstd) -> Variant:
	var pr = delta.get("patch")
	var data = delta.get("data")
	if not (pr is Dictionary) or not (data is Dictionary):
		return null
	var decoded = open_object(stored, pr, zstd, PKeyConstants.MAX_FILES_INDEX_BYTES)
	if decoded == null:
		return null
	var parsed = PKeyPackFiles.strict_parse(decoded)
	if parsed == null:
		return null
	var doc = parsed["value"]
	var nw: PKeyJson.PointerSet = parsed["nw"]
	if not (doc is Dictionary):
		return null
	if not PKeyPackClaims.same(doc.get("format"), PKeyConstants.PATCH_FORMAT) or not PKeyPackClaims.same(doc.get("scope"), "files"):
		return null
	if not PKeyPackClaims.same(doc.get("method"), delta.get("method")) or not PKeyPackClaims.same(doc.get("from"), delta.get("from")):
		return null
	if not PKeyPackClaims.same(doc.get("to"), target_payload_sha256):
		return null
	var d = doc.get("data")
	if not (d is Dictionary) or not PKeyPackClaims.same(d.get("sha256"), data.get("sha256")):
		return null
	if not PKeyClaims.is_wire_integer(d.get("bytes"), "/data/bytes", 0, nw):
		return null
	if float(d["bytes"]) != float(data.get("bytes", -1)):
		return null
	var list = doc.get("entries")
	if not (list is Array) or list.size() > PKeyConstants.MAX_INDEX_FILES:
		return null
	var files: Array = target["files"]
	var by_path := {}
	for i in files.size():
		by_path[files[i]["path"]] = i
	var seen := {}
	var last_index := -1
	var end := 0
	for i in list.size():
		var e = list[i]
		var at := "/entries/%d" % i
		if not (e is Dictionary) or not (e.get("path") is String) or seen.has(e["path"]):
			return null
		seen[e["path"]] = true
		var ti: int = by_path.get(e["path"], -1)
		if ti < 0 or ti <= last_index:
			return null
		last_index = ti
		var tf: Dictionary = files[ti]
		if not PKeyPackClaims.same(e.get("to"), tf["sha256"]):
			return null
		if not PKeyClaims.is_wire_integer(e.get("size"), at + "/size", 0, nw):
			return null
		if float(e["size"]) != float(tf["size"]):
			return null
		if not PKeyClaims.is_wire_integer(e.get("offset"), at + "/offset", 0, nw):
			return null
		if not PKeyClaims.is_wire_integer(e.get("length"), at + "/length", 0, nw):
			return null
		if int(e["offset"]) < end:
			return null
		end = int(e["offset"]) + int(e["length"])
		if PKeyPackClaims.same(e.get("op"), "delta"):
			if not PKeyPackClaims.is_sha256(e.get("from")):
				return null
		elif PKeyPackClaims.same(e.get("op"), "blob"):
			if PKeyPackClaims.same(e.get("codec"), "none"):
				if float(e["length"]) != float(e["size"]):
					return null
			elif not PKeyPackClaims.same(e.get("codec"), "zstd"):
				return null
		else:
			return null
	if end > int(data["bytes"]):
		return null
	return doc
