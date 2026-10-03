class_name PKeyPacksTestSupport
extends RefCounted
## Shared plumbing for the packs suite: the content corpus (read from the checkout through
## PKEY_CONTENT_CORPUS: `content/` is not mirrored, plans/P4-01.md §4.1), `<ref>`
## materialisation, canonical JSON comparison, and scratch directories under user://.

const PLAN_MATRIX := "res://tests/corpus/v2/plan-matrix.json"
const CASES := "res://tests/corpus/v2/cases.json"

static var _blob_cache: Dictionary = {}
static var _decoded: Dictionary = {}


## The content corpus directory (absolute), or "" when PKEY_CONTENT_CORPUS is unset or wrong.
static func content_dir() -> String:
	var d := OS.get_environment("PKEY_CONTENT_CORPUS")
	if d == "" or not FileAccess.file_exists(d.path_join("cases.json")):
		return ""
	return d


## Godot's own JSON for test inputs (the corpus is generator output, not wire bytes).
static func read_json(path: String) -> Variant:
	if not FileAccess.file_exists(path):
		return null
	var j := JSON.new()
	if j.parse(FileAccess.get_file_as_string(path)) != OK:
		return null
	return j.data


static func read_json_bytes(bytes: PackedByteArray) -> Variant:
	var j := JSON.new()
	if j.parse(bytes.get_string_from_utf8()) != OK:
		return null
	return j.data


static func blob(name: String) -> PackedByteArray:
	if not _blob_cache.has(name):
		_blob_cache[name] = FileAccess.get_file_as_bytes(content_dir().path_join("blobs").path_join(name))
	return _blob_cache[name]


## Materialise a `<ref>`: the blob (decoded when `codec` is `zstd`) or the text, then mutated.
static func materialise(ref: Dictionary) -> PackedByteArray:
	var bytes: PackedByteArray
	if ref.get("text") is String:
		bytes = (ref["text"] as String).to_utf8_buffer()
	else:
		var name := String(ref.get("blob", ""))
		var raw := blob(name)
		if ref.get("codec") == "zstd":
			var key := "%s:%d" % [name, int(ref.get("size", 0))]
			if not _decoded.has(key):
				_decoded[key] = PKeyPackZstd.new().decode(raw, int(ref["size"]))
			bytes = _decoded[key]
		else:
			bytes = raw
		bytes = bytes.duplicate()
	for m in ref.get("mutate", []):
		match String(m.get("op", "")):
			"truncate":
				bytes = bytes.slice(0, int(m["length"]))
			"xor":
				bytes[int(m["offset"])] = bytes[int(m["offset"])] ^ int(m["value"])
			"putU16", "putU32", "putU64":
				# plans/P4-10.md §4.2: little-endian; a putU64 value is below 2^53.
				var width: int = {"putU16": 2, "putU32": 4, "putU64": 8}[String(m["op"])]
				var v := int(m["value"])
				for k in width:
					bytes[int(m["offset"]) + k] = (v >> (8 * k)) & 0xFF
			_:
				push_error("unknown mutation %s" % str(m))
	return bytes


## Canonical JSON of a value, keys sorted, whole floats as integers.
static func canon(v: Variant) -> String:
	match typeof(v):
		TYPE_DICTIONARY:
			var m := {}
			for k in v.keys():
				m[str(k)] = v[k]
			var keys: Array = m.keys()
			keys.sort()
			var parts := PackedStringArray()
			for k in keys:
				parts.append(JSON.stringify(k) + ":" + canon(m[k]))
			return "{" + ",".join(parts) + "}"
		TYPE_ARRAY:
			var parts := PackedStringArray()
			for x in v:
				parts.append(canon(x))
			return "[" + ",".join(parts) + "]"
		TYPE_FLOAT:
			return str(int(v)) if v == floor(v) and absf(v) <= 9007199254740992.0 else JSON.stringify(v)
		TYPE_INT:
			return str(v)
		TYPE_BOOL:
			return "true" if v else "false"
		TYPE_NIL:
			return "null"
		TYPE_STRING_NAME:
			return JSON.stringify(String(v))
	return JSON.stringify(v)


static func same(a: Variant, b: Variant) -> bool:
	return canon(a) == canon(b)


## One check that `got` equals `want` by canonical JSON; the detail names both only on failure.
static func check_same(t: PKeyTestContext, name: String, got: Variant, want: Variant) -> bool:
	var ok := same(got, want)
	return t.check(name, ok, "" if ok else "got %s want %s" % [canon(got).left(600), canon(want).left(600)])


## A fresh scratch directory under user://pkey-test/.
static func scratch(tag: String) -> String:
	var d := "user://pkey-test/%s-%d" % [tag, Time.get_ticks_usec()]
	remove_tree(d)
	DirAccess.make_dir_recursive_absolute(d)
	return d


static func remove_tree(path: String) -> void:
	if not DirAccess.dir_exists_absolute(path):
		if FileAccess.file_exists(path):
			DirAccess.remove_absolute(path)
		return
	var d := DirAccess.open(path)
	if d == null:
		return
	d.include_hidden = true
	for f in d.get_files():
		DirAccess.remove_absolute(path.path_join(f))
	for sub in d.get_directories():
		remove_tree(path.path_join(sub))
	DirAccess.remove_absolute(path)


static func write_file(path: String, bytes: PackedByteArray) -> bool:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return false
	var ok := f.store_buffer(bytes)
	f.close()
	return ok
