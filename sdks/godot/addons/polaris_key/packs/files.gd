class_name PKeyPackFiles
extends RefCounted
## The files index, `pkey-files/1`, its path rules and `treeDigest` (plans/P4-01.md §2.7;
## WIRE-CONTRACT-V4 §2.6): a port of client-core `packs/files.ts`. Pure over bytes; the zstd
## decoder is the caller's (a Callable(frame, size) -> PackedByteArray, empty on failure).
##
##   check_paths(paths)                  {ok: true} or {ok: false, error, path}
##   tree_digest(files)                  lowercase hex SHA-256 of `<sha256> <size> <path>\n` lines
##   strict_parse(bytes)                 {value, nw} (V4 §1.2 strict JSON over UTF-8), or null
##   parse_files_index(stored, ref, payload, decode, max_bytes)
##                                       {ok: true, index} or {ok: false, error, path?}
##
## Thread-safe (no const Array is iterated).

const FILES_INDEX_INVALID := "files-index-invalid"
const FILES_UNSAFE_PATH := "files-unsafe-path"
const FILES_DUPLICATE_PATH := "files-duplicate-path"
const FILES_CASE_COLLISION := "files-case-collision"
const FILES_PATH_CONFLICT := "files-path-conflict"
const FILES_LAYOUT_MISMATCH := "files-layout-mismatch"

const _BAD_CHARS := "\\:*?\"<>|"


## ASCII-only lowercase: paths are ASCII by rule 2, so nothing else needs folding.
static func ascii_lower(s: String) -> String:
	var b := s.to_utf8_buffer()
	for i in b.size():
		if b[i] >= 0x41 and b[i] <= 0x5A:
			b[i] = b[i] + 32
	return b.get_string_from_utf8()


static func _is_device(name: String) -> bool:
	var n := ascii_lower(name.get_slice(".", 0))
	if n == "con" or n == "prn" or n == "aux" or n == "nul":
		return true
	if n.length() == 4 and (n.begins_with("com") or n.begins_with("lpt")):
		var d := n.unicode_at(3)
		return d >= 0x31 and d <= 0x39
	return false


## Path rules 1–3 (A7 §3.3) and the `.pkey` addition (§2.7).
static func path_safe(path: String) -> bool:
	var n := path.to_utf8_buffer().size()
	if n < 1 or n > PKeyConstants.MAX_PACK_PATH_BYTES:
		return false
	for i in path.length():
		var c := path.unicode_at(i)
		if c < 0x20 or c > 0x7E or _BAD_CHARS.contains(path[i]):
			return false
	var segments := path.split("/", true)
	if ascii_lower(segments[0]) == ".pkey":
		return false
	for s in segments:
		if s == "" or s == "." or s == "..":
			return false
		if s.ends_with(" ") or s.ends_with("."):
			return false
		if _is_device(s):
			return false
	return true


## The path rules, in order (§2.7): a path that breaks rules 1–3 or whose first segment is
## `.pkey` (any case) is `files-unsafe-path`; an exact duplicate `files-duplicate-path`; an
## ASCII-case-insensitive duplicate `files-case-collision`; a path that is a directory prefix of
## another, or has one as its prefix, `files-path-conflict`. The later path is reported.
static func check_paths(paths: Array) -> Dictionary:
	var seen := {}
	var lower := {}
	var dirs := {}
	for path in paths:
		if not (path is String) or not path_safe(path):
			return {"ok": false, "error": FILES_UNSAFE_PATH, "path": str(path)}
		if seen.has(path):
			return {"ok": false, "error": FILES_DUPLICATE_PATH, "path": path}
		var lp := ascii_lower(path)
		if lower.has(lp):
			return {"ok": false, "error": FILES_CASE_COLLISION, "path": path}
		var parts := lp.split("/", true)
		var prefixes := PackedStringArray()
		for k in range(1, parts.size()):
			prefixes.append("/".join(parts.slice(0, k)))
		var conflict := dirs.has(lp)
		if not conflict:
			for x in prefixes:
				if lower.has(x):
					conflict = true
					break
		if conflict:
			return {"ok": false, "error": FILES_PATH_CONFLICT, "path": path}
		seen[path] = true
		lower[lp] = true
		for x in prefixes:
			dirs[x] = true
	return {"ok": true}


## `treeDigest` (§2.7): the lowercase hex SHA-256 of one line `<sha256hex> <size> <path>\n` per
## file, sorted by path bytes; size in decimal without leading zeros. Empty tree: SHA-256 of "".
static func tree_digest(files: Array) -> String:
	var sorted := files.duplicate()
	sorted.sort_custom(func(a, b): return PKeyPackClaims.compare_bytes(a["path"], b["path"]) < 0)
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	var buf := PackedByteArray()
	for f in sorted:
		buf.append_array(("%s %d %s\n" % [f["sha256"], int(f["size"]), f["path"]]).to_utf8_buffer())
		if buf.size() >= 1 << 16:
			h.update(buf)
			buf = PackedByteArray()
	if not buf.is_empty():
		h.update(buf)
	return h.finish().hex_encode()


## V4 §1.2's strict JSON over UTF-8 bytes (no BOM), with the integer rule's pointers:
## {value, nw}, or null on any failure.
static func strict_parse(bytes: PackedByteArray) -> Variant:
	var r := PKeyJson.parse_bytes(bytes)
	if not r.get("ok", false):
		return null
	return {"value": r["value"], "nw": r["non_wire_integers"]}


## The member rules of one entry (§2.7), integer rule included.
static func _entry_ok(e: Variant, i: int, container: bool, nw: PKeyJson.PointerSet) -> bool:
	if not (e is Dictionary):
		return false
	var at := "/files/%d" % i
	if not (e.get("path") is String):
		return false
	if not PKeyClaims.is_wire_integer(e.get("size"), at + "/size", 0, nw):
		return false
	if not PKeyPackClaims.is_sha256(e.get("sha256")):
		return false
	var b = e.get("blob")
	if not (b is Dictionary):
		return false
	if not PKeyPackClaims.is_sha256(b.get("sha256")):
		return false
	if not PKeyClaims.is_wire_integer(b.get("bytes"), at + "/blob/bytes", 0, nw):
		return false
	if b.get("codec") is String and b["codec"] == "none":
		if float(b["bytes"]) != float(e["size"]) or b["sha256"] != e["sha256"]:
			return false
	elif not (b.get("codec") is String) or b["codec"] != "zstd":
		return false
	if container and not PKeyClaims.is_wire_integer(e.get("offset"), at + "/offset", 0, nw):
		return false
	return true


static func _invalid() -> Dictionary:
	return {"ok": false, "error": FILES_INDEX_INVALID}


## Decode one object's stored bytes by its ref's codec: `none` as stored, `zstd` through
## `decode` to exactly `size`. null on failure.
static func decode_stored(stored: PackedByteArray, codec: Variant, size: int, decode: Callable) -> Variant:
	if codec is String and codec == "none":
		return stored
	if codec is String and codec == "zstd" and decode.is_valid():
		var out = decode.call(stored, size)
		if out is PackedByteArray and out.size() == size:
			return out
		return null
	return null


## `parseFilesIndex(stored, ref, variant)` (§2.7): the first failure, in order:
##  1. `ref.size` above the limit (before anything is decoded), the stored SHA-256 or length
##     differs from the ref, the decode fails, or the decoded length is not `ref.size`;
##  2. strict JSON or the integer rule;
##  3. `format`, `layout` (the ref's), `payload` (the variant's), `files` and the entry members
##     → all `files-index-invalid`;
##  4. the path rules in index order → the path codes, with `path`;
##  5. a container that breaks the layout rule → `files-layout-mismatch`; a tree whose paths are
##     not strictly ascending, whose sizes do not sum to `payload.size`, or whose `treeDigest`
##     differs from `payload.sha256` → `files-index-invalid`.
## `payload`: the variant's {size, sha256}. `max_bytes` < 0 means MAX_FILES_INDEX_BYTES.
static func parse_files_index(stored: PackedByteArray, ref: Dictionary, payload: Dictionary, decode: Callable, max_bytes := -1) -> Dictionary:
	var limit := max_bytes if max_bytes >= 0 else PKeyConstants.MAX_FILES_INDEX_BYTES
	# 1. The stored object against its ref, then the decode.
	if not PKeyClaims.is_number(ref.get("size")) or float(ref["size"]) > float(limit):
		return _invalid()
	if not PKeyClaims.is_number(ref.get("bytes")) or stored.size() != int(ref["bytes"]) or float(stored.size()) != float(ref["bytes"]):
		return _invalid()
	if not PKeyPackClaims.same(PKeyPackClaims.sha256_hex(stored), ref.get("sha256")):
		return _invalid()
	var decoded = decode_stored(stored, ref.get("codec"), int(ref["size"]), decode)
	if decoded == null or (decoded as PackedByteArray).size() != int(ref["size"]):
		return _invalid()

	# 2. Strict JSON; the integer rule runs with the member rules.
	var parsed = strict_parse(decoded)
	if parsed == null:
		return _invalid()
	var doc = parsed["value"]
	var nw: PKeyJson.PointerSet = parsed["nw"]

	# 3. The member rules.
	if not (doc is Dictionary):
		return _invalid()
	if not PKeyPackClaims.same(doc.get("format"), PKeyConstants.FILES_FORMAT) or not (doc.get("layout") is String) or not PKeyPackClaims.same(doc["layout"], ref.get("layout")):
		return _invalid()
	var p = doc.get("payload")
	if not (p is Dictionary):
		return _invalid()
	if not PKeyClaims.is_wire_integer(p.get("size"), "/payload/size", 0, nw):
		return _invalid()
	if not PKeyPackClaims.is_sha256(p.get("sha256")):
		return _invalid()
	if not PKeyClaims.is_number(payload.get("size")) or float(p["size"]) != float(payload["size"]) or not PKeyPackClaims.same(p["sha256"], payload.get("sha256")):
		return _invalid()
	var files = doc.get("files")
	if not (files is Array) or files.size() > PKeyConstants.MAX_INDEX_FILES:
		return _invalid()
	var container: bool = PKeyPackClaims.same(doc["layout"], "container")
	for i in files.size():
		if not _entry_ok(files[i], i, container, nw):
			return _invalid()

	# 4. The path rules.
	var paths: Array = []
	for e in files:
		paths.append(e["path"])
	var pc := check_paths(paths)
	if not pc["ok"]:
		return pc

	# 5. The layout.
	var total := 0
	for e in files:
		total += int(e["size"])
	if container:
		var end := 0
		for e in files:
			var offset := int(e["offset"])
			if offset < end:
				return {"ok": false, "error": FILES_LAYOUT_MISMATCH}
			end = offset + int(e["size"])
		if end > int(p["size"]):
			return {"ok": false, "error": FILES_LAYOUT_MISMATCH}
		var gaps = ref.get("gaps")
		if not (gaps is Dictionary) or not gaps.has("size"):
			return {"ok": false, "error": FILES_LAYOUT_MISMATCH}
		if not PKeyClaims.is_number(gaps["size"]) or float(int(p["size"]) - total) != float(gaps["size"]):
			return {"ok": false, "error": FILES_LAYOUT_MISMATCH}
	elif PKeyPackClaims.same(doc["layout"], "tree"):
		for i in range(1, files.size()):
			if PKeyPackClaims.compare_bytes(files[i - 1]["path"], files[i]["path"]) >= 0:
				return _invalid()
		if total != int(p["size"]):
			return _invalid()
		if tree_digest(files) != p["sha256"]:
			return _invalid()
	return {"ok": true, "index": doc}
