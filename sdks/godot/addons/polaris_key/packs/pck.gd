class_name PKeyPck
extends RefCounted
## The Godot PCK as the `godot.pck` handler reads, checks and writes it (P4-08; notes/A6 §2.2,
## §2.4, §5; notes/S-05 §4.6 and §5 (f); the CLI's `pck.ts` and `packLint.ts`, whose rules this
## file applies on the device so the publish lint and the device cannot drift).
##
## Layout (little-endian): magic "GDPC", format version, engine major, minor, patch, pack flags
## (6 × u32); v2: file base u64, 16 reserved u32, then the directory; v3/v4: file base u64,
## directory offset u64, 16 reserved u32. Directory: u32 count, then per entry u32 path length
## (NUL-padded to 4), the path, u64 offset (from the file base), u64 size, 16-byte MD5, u32 flags.
## Pack flags: 1 encrypted directory, 2 relative file base, 4 sparse bundle. Entry flags: 1
## encrypted, 2 removal, 4 delta.
##
##   read_directory(source)              {ok, header, entries} or {ok: false, error, detail, path?}
##   engine_check(header, requires)      "" or why the header's engine is not allowed here
##   directory_check(source, dir, prefixes, attachable)  {ok, errors: [{path, why}], count}: the
##                                       admission list and the references (P4-28)
##   embedded_code(path, data)           why a resource carries code, or ""
##   refs_problem(src, ctx)              why a resource's references are refused, or "" (P4-28)
##   rscc_body(data)                     an RSCC resource's body, bounded ({body} or {why}; P4-27)
##   remap_targets(text)                 the files a .remap or .import points to
##   write(path, entries, version)       a helper PCK (GDDL delta packs, copy hosts); Error
##   append_trailer(path, entries, version)  a directory appended to an existing file (A6 §5)
##   truncate(path, size)                undo the trailer; true when the file is `size` again
##   helper_version()                    the PCK format version this engine writes (PCKPacker)
##   mount(path, replace, offset)        ProjectSettings.load_resource_pack
##
## Nothing here iterates a const Array (thread-reachable: the directory check runs on a worker).

const MAGIC := 0x43504447
const PACK_DIR_ENCRYPTED := 1
const PACK_REL_FILEBASE := 2
const PACK_SPARSE_BUNDLE := 4
const PACK_FILE_ENCRYPTED := 1
const PACK_FILE_REMOVAL := 2
const PACK_FILE_DELTA := 4

## The registered device-side codes (conformance/parity/errors.json).
const DIRECTORY_REFUSED := PKeyConstants.ErrorCode.PCK_DIRECTORY_REFUSED
const ENGINE_MISMATCH := PKeyConstants.ErrorCode.PCK_ENGINE_MISMATCH

## The two entries `--export-pack` always adds and `pkey release publish` strips (S-05 §4.6).
const STRIP_PROJECT_BINARY := "project.binary"
const STRIP_CLASS_CACHE := ".godot/global_script_class_cache.cfg"
const UID_CACHE := ".godot/uid_cache.bin"

## The lint's limits (P4-03): above WARN_ENTRIES the mount stalls longer (logged); above
## MAX_ENTRIES a pack cannot publish, and the device refuses it too.
const WARN_ENTRIES := 1000
const MAX_ENTRIES := 20000

## v3/v4 header bytes (6 × u32, file base, directory offset, 16 reserved u32).
const HEADER_V3 := 104
const HEADER_V2 := 96

## The probed PCKPacker version, once known (0 = not yet; a failed probe is never cached).
static var _helper_version := 0
## Serialises the probe: zstd's batch decode may ask from a worker while the engine asks from
## the main thread.
static var _helper_mutex := Mutex.new()
## Where the probe writes its throwaway pack (a test points it somewhere unwritable).
static var helper_probe_dir := "user://pkey/tmp"
static var _res: Dictionary = {}
## The engine's script kinds (P4-08 audit GAP 5), filled on the main thread by `warm()`:
## {exts: {extension: true}, markers: PackedStringArray}.
static var _kinds: Dictionary = {}
## How many app resources' types have been read from disk (`_remapped_type` misses), for the
## tests' work count: a check naming one app scene many times reads its type once (P4-28 audit
## GAP D). Informational only; nothing reads it to decide.
static var type_reads := 0


static func _re(pattern: String) -> RegEx:
	var re = _res.get(pattern)
	if re == null:
		re = RegEx.create_from_string(pattern)
		_res[pattern] = re
	return re


## Compile every pattern and read the engine's script kinds on the main thread before a worker
## runs the directory check.
static func warm() -> void:
	for p in [_SCRIPT, _NATIVE, _NATIVE_DIR, _TEXT_RES, _BINARY_RES, _GD_HEAD, _PATH_ANY, _PATH_LINE, _DEST_LINE, _QUOTED, _EXT_LINE, _EXT_ATTR, _TYPE_KEY, _TEXT_TYPE]:
		_re(p)
	refresh_script_kinds()


## Re-read what this engine counts as a script (P4-08 audit GAP 5): every extension a loader
## recognises for `Script` except the generic resource containers (`tres`, `res`, `tscn`, `scn`,
## whose CONTENT the scan judges), and every class that inherits `Script` (a GDExtension language
## included) as a marker beside the known ones. Main thread only.
static func refresh_script_kinds() -> void:
	var exts := {}
	for e in ResourceLoader.get_recognized_extensions_for_type("Script"):
		var x := String(e).to_lower()
		if x != "tres" and x != "res" and x != "tscn" and x != "scn":
			exts[x] = true
	var markers := script_markers()
	var extra: Array = Array(ClassDB.get_inheriters_from_class("Script"))
	extra.sort()
	for c in extra:
		if not markers.has(String(c)):
			markers.append(String(c))
	_kinds = {"exts": exts, "markers": markers}


## The markers the scans refuse whatever the engine says (packLint.ts `SCRIPT_MARKERS`, the same
## order): the script types, then the properties that hold a script's source.
static func script_markers() -> PackedStringArray:
	return PackedStringArray(["GDScript", "CSharpScript", "ScriptExtension", "script/source", "source_code"])


## The kinds `warm()` read, or — before it ran — a local built-in-only set that is never stored,
## so no worker thread ever writes the static Dictionary.
static func _script_kinds() -> Dictionary:
	if _kinds.is_empty():
		return {"exts": {}, "markers": script_markers()}
	return _kinds


const _SCRIPT := "(?i)\\.(gd|gdc|cs)$"
const _NATIVE := "(?i)\\.(so|dll|dylib|wasm|gdextension)$|\\.so\\.\\d+(\\.\\d+)*$"
const _NATIVE_DIR := "(?i)\\.(framework|xcframework)$"
const _TEXT_RES := "(?i)\\.(tscn|tres|escn)$"
const _BINARY_RES := "(?i)\\.(scn|res)$"
# Whitespace is an explicit class in every pattern (never \s or \v, which PCRE2 and JS read
# differently), and lines are split by hand after CR → LF (P4-08 audit GAP 2, GAP 6).
const _GD_HEAD := "^[ \\t\\n\\r\\f\\x0B]*\\[gd_(scene|resource)\\b"
## A `path` key (quoted or not, with any `.<x>` segments) ANYWHERE in a .remap/.import line
## (P4-08 audit GAP B: the engine's tag parser needs no line start): the line must be _PATH_LINE.
## A key preceded by `/`, `.` or `-` is another key (`import_script/path` in every scene import's
## [params], GAP C), so those characters do not start one.
const _PATH_ANY := "(^|[^A-Za-z0-9_/.-])\"?path(\\.[A-Za-z0-9_-]+)*\"?[ \\t\\f\\x0B]*="
const _PATH_LINE := "^[ \\t\\f\\x0B]*path(?:\\.[A-Za-z0-9_-]+)?[ \\t\\f\\x0B]*=[ \\t\\f\\x0B]*\"([^\"\\\\]*)\"[ \\t\\f\\x0B]*$"
const _DEST_LINE := "^[ \\t\\f\\x0B]*dest_files[ \\t\\f\\x0B]*=[ \\t\\f\\x0B]*\\[([^\\]]*)\\]"
const _QUOTED := "\"([^\"]*)\""


static func _refuse(code: String, detail: String, path := "") -> Dictionary:
	var out := {"ok": false, "error": code, "detail": detail}
	if path != "":
		out["path"] = path
	return out


## The header (24 bytes at least): {ok, header: {formatVersion, engine: {major, minor, patch},
## flags}} for a PCK v2–v4 with no encrypted directory, no sparse bundle and no unknown flag.
static func read_header(head: PackedByteArray) -> Dictionary:
	if head.size() < 24 or head.decode_u32(0) != MAGIC:
		return _refuse(DIRECTORY_REFUSED, "not a Godot PCK (no GDPC magic)")
	var version := head.decode_u32(4)
	var flags := head.decode_u32(20)
	if version < 2 or version > 4:
		return _refuse(DIRECTORY_REFUSED, "PCK format v%d; v2, v3 and v4 only" % version)
	if flags & PACK_DIR_ENCRYPTED:
		return _refuse(DIRECTORY_REFUSED, "an encrypted directory (pack flags %d)" % flags)
	if flags & PACK_SPARSE_BUNDLE:
		return _refuse(DIRECTORY_REFUSED, "a sparse bundle (pack flags %d)" % flags)
	if flags & ~(PACK_DIR_ENCRYPTED | PACK_REL_FILEBASE | PACK_SPARSE_BUNDLE):
		return _refuse(DIRECTORY_REFUSED, "unknown pack flags %d" % flags)
	return {"ok": true, "header": {
		"formatVersion": version,
		"engine": {"major": head.decode_u32(8), "minor": head.decode_u32(12), "patch": head.decode_u32(16)},
		"flags": flags,
	}}


## A u64 field read as two u32 halves (no `decode_u64`: a value at or above 2^63 must not wrap
## negative); -1 above 2^53 − 1.
static func _u64(b: PackedByteArray, at: int) -> int:
	var lo := b.decode_u32(at)
	var hi := b.decode_u32(at + 4)
	if hi > 0x1FFFFF:
		return -1
	return hi * 4294967296 + lo


## The directory of a PCK v2–v4 read through `source` (a file, or bytes): every entry's path
## (`res://` dropped), absolute offset, size, MD5 (hex) and flags, in directory order. Refused
## (`pck-directory-refused`, with the entry's path): an encrypted, removal or delta entry, unknown
## entry flags, bytes past the end of the file, a path that is not UTF-8, more than MAX_ENTRIES
## entries, or a directory that does not parse.
static func read_directory(source: PKeyByteSource) -> Dictionary:
	var head := source.read(0, HEADER_V3)
	var h := read_header(head)
	if not h["ok"]:
		return h
	var header: Dictionary = h["header"]
	var version: int = header["formatVersion"]
	if head.size() < (HEADER_V2 if version == 2 else HEADER_V3):
		return _refuse(DIRECTORY_REFUSED, "the header is truncated")
	var file_base := _u64(head, 24)
	var dir_at := HEADER_V2 if version == 2 else _u64(head, 32)
	if file_base < 0 or dir_at < 0 or dir_at + 4 > source.size:
		return _refuse(DIRECTORY_REFUSED, "the directory offset is out of range")
	# v3/v4 keep the directory last; v2 between the header and the file data.
	var dir_end := source.size if version != 2 else mini(source.size, maxi(file_base, dir_at + 4))
	var dir := source.read(dir_at, dir_end - dir_at)
	if dir.size() != dir_end - dir_at:
		return _refuse(DIRECTORY_REFUSED, "the directory cannot be read")
	var count := dir.decode_u32(0)
	if count > MAX_ENTRIES:
		return _refuse(DIRECTORY_REFUSED, "%d entries; a pack is at most %d (the mount stall grows with the entry count, S-05 §4.1)" % [count, MAX_ENTRIES])
	var p := 4
	var entries: Array = []
	for i in count:
		if p + 4 > dir.size():
			return _refuse(DIRECTORY_REFUSED, "the directory runs past the end")
		var sl := dir.decode_u32(p)
		p += 4
		if p + sl + 36 > dir.size():
			return _refuse(DIRECTORY_REFUSED, "a path runs past the end")
		var end := p + sl
		while end > p and dir[end - 1] == 0:
			end -= 1
		var raw_bytes := dir.slice(p, end)
		var raw := raw_bytes.get_string_from_utf8()
		if raw.to_utf8_buffer() != raw_bytes:
			return _refuse(DIRECTORY_REFUSED, "a path is not UTF-8")
		p += sl
		var rel := _u64(dir, p)
		var size := _u64(dir, p + 8)
		var md5 := dir.slice(p + 16, p + 32).hex_encode()
		var flags := dir.decode_u32(p + 32)
		p += 36
		var path := raw.substr(6) if raw.begins_with("res://") else raw
		if rel < 0 or size < 0:
			return _refuse(DIRECTORY_REFUSED, "a 64-bit field is out of range", path)
		if flags & PACK_FILE_ENCRYPTED:
			return _refuse(DIRECTORY_REFUSED, "an encrypted entry", path)
		if flags & PACK_FILE_REMOVAL:
			return _refuse(DIRECTORY_REFUSED, "a patch pack's removal entry", path)
		if flags & PACK_FILE_DELTA:
			return _refuse(DIRECTORY_REFUSED, "a patch pack's delta entry", path)
		if flags != 0:
			return _refuse(DIRECTORY_REFUSED, "unknown entry flags %d" % flags, path)
		if not path_ok(path):
			return _refuse(DIRECTORY_REFUSED, "an unsafe path (a `..`, `.` or empty segment, or a character the path rules refuse)", path)
		var offset := file_base + rel
		if offset + size > source.size:
			return _refuse(DIRECTORY_REFUSED, "its bytes run past the end of the file", path)
		entries.append({"rawPath": raw, "path": path, "offset": offset, "size": size, "md5": md5, "flags": flags})
	# Two entries that name one file (exactly, or by ASCII case, or a file and a directory of the
	# same name) cannot both be what the admission list judged.
	var paths: Array = []
	for e in entries:
		paths.append(e["path"])
	var pc := PKeyPackFiles.check_paths(paths)
	if not pc["ok"]:
		return _refuse(DIRECTORY_REFUSED, "a path the directory names twice (%s)" % pc["error"], String(pc["path"]))
	return {"ok": true, "header": header, "entries": entries}


## Whether a pack path (without `res://`) is one Godot will not rewrite on mount: the files
## index's path rules (no `..`, `.` or empty segment, no leading or trailing `/`, printable ASCII
## without `\ : * ? " < > |`), and equal to its own `simplify_path()`. A path that fails could
## land outside the prefix it appears to sit under once the engine normalises it.
static func path_ok(path: String) -> bool:
	if not PKeyPackFiles.path_safe(path):
		return false
	if path.contains("..") or path.contains("./") or path.contains("//") or path.ends_with("/") or path.ends_with("/."):
		return false
	return path == path.simplify_path()


## The engine version this process runs: [major, minor, patch].
static func running_engine() -> PackedInt64Array:
	var v := Engine.get_version_info()
	return PackedInt64Array([int(v["major"]), int(v["minor"]), int(v["patch"])])


## The header check: the pack's engine at most the running one (the device's own rule: a newer
## engine's pack may not load here), and its `major.minor` equal to `requires_engine`
## (`godot-<major>.<minor>`) when the variant names one (the publish lint's rule, same wording).
## "" when allowed.
static func engine_check(header: Dictionary, requires_engine: Variant = null) -> String:
	var e: Dictionary = header["engine"]
	var have := running_engine()
	var want := PackedInt64Array([int(e["major"]), int(e["minor"]), int(e["patch"])])
	for i in 3:
		if want[i] < have[i]:
			break
		if want[i] > have[i]:
			return "the PCK header says engine %d.%d.%d, newer than this engine (%d.%d.%d)." % [want[0], want[1], want[2], have[0], have[1], have[2]]
	return requires_check(header, requires_engine)


## The publish lint's engine rule alone: "" or its exact line.
static func requires_check(header: Dictionary, requires_engine: Variant) -> String:
	var e: Dictionary = header["engine"]
	if requires_engine is String and requires_engine != "godot-%d.%d" % [int(e["major"]), int(e["minor"])]:
		return "the PCK header says engine %d.%d.%d, outside requires.engine %s." % [int(e["major"]), int(e["minor"]), int(e["patch"]), requires_engine]
	return ""


## `lintPck`'s error lines, in its order, for a directory `read_directory` returned: the engine
## rule, then `<path>: <why>` per refused entry. The packs suite compares them with the CLI's.
static func lint_lines(source: PKeyByteSource, dir: Dictionary, prefixes: Array, requires_engine: Variant, attachable: Variant = null) -> PackedStringArray:
	var out := PackedStringArray()
	var why := requires_check(dir["header"], requires_engine)
	if why != "":
		out.append(why)
	var c := directory_check(source, dir, prefixes, attachable)
	for e in c["errors"]:
		out.append("%s: %s" % [e["path"], e["why"]])
	return out


static func _is_script(p: String) -> bool:
	if _re(_SCRIPT).search(p) != null:
		return true
	return (_script_kinds()["exts"] as Dictionary).has(p.get_extension().to_lower())


static func _is_native(p: String) -> bool:
	if _re(_NATIVE).search(p) != null:
		return true
	for s in p.split("/"):
		if _re(_NATIVE_DIR).search(s) != null:
			return true
	return false


## Strip `res://`; "" when the value does not start with it (and so names nothing in a pack).
static func _res_path(p: String) -> String:
	return p.substr(6) if p.begins_with("res://") else ""


## Every value a `.remap` or `.import` points the engine at, raw: each `path=` and `path.<x>=`
## value and every string in a `dest_files=[…]` array (`source_file` is the import's input, not
## something the pack loads), in order, without duplicates.
static func remap_values(text: String) -> PackedStringArray:
	var out := PackedStringArray()
	var lines := _lines(text)
	for line in lines:
		var m := _re(_PATH_LINE).search(line)
		if m != null and not out.has(m.get_string(1)):
			out.append(m.get_string(1))
	for line in lines:
		var m := _re(_DEST_LINE).search(line)
		if m == null:
			continue
		for q in _re(_QUOTED).search_all(m.get_string(1)):
			var v := q.get_string(1)
			if not out.has(v):
				out.append(v)
	return out


static func _lines(text: String) -> PackedStringArray:
	return text.replace("\r", "\n").split("\n")


## Why a .remap or .import cannot be read the way the engine would read it, or "" (P4-08 audit
## GAP 4, GAP 6, GAP B): a NUL byte, any other control byte but TAB, LF and CR, any backslash,
## invalid UTF-8 or a byte-order mark, or a line with a `path` key anywhere in it (quoted or not)
## that is not exactly `path[.<x>] = "<plain literal>"` (no StringName `&`, NodePath `^` or
## escape, no second key segment). Dictionary entries (`metadata={…}`) use `:`, not `=`.
static func remap_problem(data: PackedByteArray) -> String:
	if data.find(0) != -1:
		return "a .remap or .import with a NUL byte"
	for b in data:
		if b < 0x20 and b != 0x09 and b != 0x0A and b != 0x0D:
			return "a .remap or .import with a control byte"
	if data.find(0x5C) != -1:
		return "a .remap or .import with a backslash"
	if not utf8_valid(data):
		return "a .remap or .import that is not valid UTF-8"
	if has_bytes(data, PackedByteArray([0xEF, 0xBB, 0xBF])):
		return "a .remap or .import with a byte-order mark"
	for line in _lines(data.get_string_from_utf8()):
		if _re(_PATH_ANY).search(line) != null and _re(_PATH_LINE).search(line) == null:
			return "a path line the engine could read differently (%s)" % line
	return ""


## Strict UTF-8 (the Unicode table: no overlong form, no surrogate, nothing above U+10FFFF), so
## the device and the CLI never decode the same bytes differently.
static func utf8_valid(b: PackedByteArray) -> bool:
	var i := 0
	var n := b.size()
	while i < n:
		var c := b[i]
		if c < 0x80:
			i += 1
			continue
		var need := 0
		var lo := 0x80
		var hi := 0xBF
		if c >= 0xC2 and c <= 0xDF:
			need = 1
		elif c == 0xE0:
			need = 2
			lo = 0xA0
		elif (c >= 0xE1 and c <= 0xEC) or c == 0xEE or c == 0xEF:
			need = 2
		elif c == 0xED:
			need = 2
			hi = 0x9F
		elif c == 0xF0:
			need = 3
			lo = 0x90
		elif c >= 0xF1 and c <= 0xF3:
			need = 3
		elif c == 0xF4:
			need = 3
			hi = 0x8F
		else:
			return false
		if i + need >= n:
			return false
		var x := b[i + 1]
		if x < lo or x > hi:
			return false
		for k in range(2, need + 1):
			var y := b[i + k]
			if y < 0x80 or y > 0xBF:
				return false
		i += need + 1
	return true


## The files a `.remap` or `.import` points to, as index paths (its `res://` values only).
static func remap_targets(text: String) -> PackedStringArray:
	var out := PackedStringArray()
	for v in remap_values(text):
		var p := _res_path(v)
		if p != "" and not out.has(p):
			out.append(p)
	return out


## Why a `.godot/uid_cache.bin` is refused, or "": every path it names must be a file of this
## pack (itself, or its `.remap` or `.import`), so a pack can register only its own UIDs and never
## re-point one the game or another pack owns. Layout: u32 count, then per entry an i64 id, a u32
## length and the path.
static func uid_cache_problem(data: PackedByteArray, in_pack: Dictionary) -> String:
	if data.size() < 4:
		return "a malformed uid cache"
	var n := data.decode_u32(0)
	var p := 4
	for i in n:
		if p + 12 > data.size():
			return "a malformed uid cache"
		var ln := data.decode_u32(p + 8)
		if p + 12 + ln > data.size():
			return "a malformed uid cache"
		var raw_bytes := data.slice(p + 12, p + 12 + ln)
		if raw_bytes.find(0) != -1:
			return "names a path with a NUL byte"
		var raw := raw_bytes.get_string_from_utf8()
		p += 12 + ln
		var t := _res_path(raw)
		if t == "" or not path_ok(t) or not (in_pack.has(t) or in_pack.has(t + ".remap") or in_pack.has(t + ".import")):
			return "names a path outside the pack (%s)" % raw
	if p != data.size():
		return "a malformed uid cache"
	return ""


## Why a resource entry carries code, or "" when it carries none (P4-03's `embeddedCode`, the
## same rules and wording, hardened by the P4-08 audit): an `RSCC` (compressed) resource, under any
## name, that `rscc_body` refuses, whose body is not a binary resource, or whose body names a
## marker (P4-27); an `RSRC` resource whose bytes name a script marker anywhere (`_binary_code`); a text
## resource (a `[gd_scene`/`[gd_resource` head, or a `.tscn`/`.tres`/`.escn` name) that fails the
## content rule (`_text_code`); a `.scn`/`.res`/exported file that is neither. Fails closed.
static func embedded_code(p: String, data: PackedByteArray, budget: Variant = null) -> String:
	return inspect(p, data, budget)["code"]


## `embedded_code`'s verdict, and — for a resource with no code — where its references are read
## (P4-28): {code, refs?: {kind: "text", data} or {kind: "binary", data, start}}, so an `RSCC`
## body is decompressed once.
static func inspect(p: String, data: PackedByteArray, budget: Variant = null) -> Dictionary:
	# By CONTENT first: Godot's binary loader takes `.material`, `.mesh`, `.anim` and every other
	# binary resource extension, so the extension never decides whether bytes are scanned.
	var magic := data.slice(0, 4).get_string_from_ascii() if data.size() >= 4 else ""
	if magic == "RSCC":
		# P4-27: bounded decompression (`rscc_body`), then the RSRC rules on the body.
		var r := rscc_body(data, budget)
		if r.has("why"):
			return {"code": "a compressed binary resource (RSCC) %s" % r["why"]}
		var body: PackedByteArray = r["body"]
		# The saver writes `RSRC` only uncompressed: the body starts at the header words after it,
		# the big-endian and real64 flags (0 or 1 each), then three versions (rscc.ts
		# `rsccBodyIsResource`).
		if body.size() < 20 or body.decode_u32(0) > 1 or body.decode_u32(4) > 1:
			return {"code": "a compressed binary resource (RSCC) whose body is not a binary resource"}
		var m := _marker(body)
		if m != "":
			return {"code": "a compressed binary resource (RSCC) that names %s (an embedded script or its source)" % m}
		return {"code": "", "refs": {"kind": "binary", "data": body, "start": 0}}
	if magic == "RSRC":
		var code := _binary_code(data)
		if code != "":
			return {"code": code}
		return {"code": "", "refs": {"kind": "binary", "data": data, "start": 4}}
	if sniffs_text_resource(data) or _re(_TEXT_RES).search(p) != null:
		var code := _text_code(data)
		if code != "":
			return {"code": code}
		return {"code": "", "refs": {"kind": "text", "data": data}}
	if _re(_BINARY_RES).search(p) != null or p.begins_with(".godot/exported/"):
		return {"code": "not a Godot resource (no RSRC header), so it cannot be inspected for embedded scripts"}
	return {"code": ""}


## The largest total an `RSCC` resource may declare: 64 MiB (packLint's `RSCC_MAX_TOTAL`, the
## same number; rscc.ts records the measured basis: a skinned, animated character imports to an
## 18.2 MB body and a 980,000-triangle mesh to 58.7 MB; about 4× the character, capped at 64 MiB).
const RSCC_MAX_TOTAL := 67108864
## The declared RSCC bytes one pack may hold in total, counted in directory order before any of
## an entry's blocks are read (packLint's `RSCC_PACK_BUDGET`): 512 MiB.
const RSCC_PACK_BUDGET := 536870912
## The largest zstd block (`ZSTD_BLOCKSIZE_MAX`).
const ZSTD_BLOCK_MAX := 131072
## The block-size bounds (Godot writes 4096): the block count stays at most the cap / 4096.
const RSCC_MIN_BLOCK := 4096
const RSCC_MAX_BLOCK := 1048576
## FileAccessCompressed's mode for zstd (`Compression::MODE_ZSTD`).
const RSCC_MODE_ZSTD := 2
const ZSTD_MAGIC := 0xFD2FB528


## The decompressed body of an `RSCC` resource (FileAccessCompressed), or why it is refused:
## {body} or {why} (the text after "a compressed binary resource (RSCC) "). The CLI's `rsccBody`
## (packages/cli/src/rscc.ts) applies the same rules with the same words. Layout (LE u32): "RSCC",
## mode, block size, total, bc = total / block size + 1 compressed sizes, the blocks, "RSCC". Every
## header field is bounded before anything is allocated or decoded: zstd only, the block size in
## RSCC_MIN_BLOCK..RSCC_MAX_BLOCK, the total at most RSCC_MAX_TOTAL, the table and every block
## inside the entry, the closing magic exactly at its end, and the pack's running total of declared
## bytes (`budget`, a {used} Dictionary the caller owns) within RSCC_PACK_BUDGET. Each block must be one zstd frame
## declaring its size (`zstd_frame_ok`; `decompress` alone would take concatenated and skippable
## frames, the CLI's decoder would not) and decode to exactly that size: `decompress` is given it
## as the output capacity, so a block that lies about its size stops there and is refused.
## Thread-safe: ints and PackedByteArrays only.
static func rscc_body(data: PackedByteArray, budget: Variant = null) -> Dictionary:
	var n := data.size()
	var h := _rscc_head(data, true)
	if h.has("why"):
		return h
	var bs: int = h["bs"]
	var total: int = h["total"]
	var bc: int = h["bc"]
	if budget is Dictionary:
		budget["used"] = int(budget.get("used", 0)) + total
		if int(budget["used"]) > RSCC_PACK_BUDGET:
			return {"why": "that takes the pack's declared RSCC bytes to %d, past the %d-byte budget" % [int(budget["used"]), RSCC_PACK_BUDGET]}
	var table_end := 16 + 4 * bc
	if table_end > n:
		return {"why": "whose block table runs past the end"}
	var starts := PackedInt64Array()
	var sizes := PackedInt64Array()
	var pos := table_end
	for i in bc:
		var cs := data.decode_u32(16 + 4 * i)
		if cs > n - pos:
			return {"why": "whose block %d runs past the end" % i}
		starts.append(pos)
		sizes.append(cs)
		pos += cs
	if pos + 4 > n or data[pos] != 0x52 or data[pos + 1] != 0x53 or data[pos + 2] != 0x43 or data[pos + 3] != 0x43:
		return {"why": "without its closing RSCC magic"}
	if pos + 4 != n:
		return {"why": "with bytes after its closing RSCC magic"}
	# Every frame's structure first, so nothing is allocated for a resource that cannot decode.
	for i in bc:
		var want := _rscc_block_size(h, i)
		if not zstd_frame_ok(data.slice(starts[i], starts[i] + sizes[i]), want):
			return {"why": "whose block %d is not one zstd frame of %d bytes" % [i, want]}
	var body := PackedByteArray()
	for i in bc:
		var want := _rscc_block_size(h, i)
		var out := _rscc_decode(data.slice(starts[i], starts[i] + sizes[i]), want)
		if out.size() != want:
			return {"why": "whose block %d does not decode to %d bytes" % [i, want]}
		body.append_array(out)
	return {"body": body}


## The RSCC header (`rscc_body`'s first rules, the same words): zstd only, the block size in
## RSCC_MIN_BLOCK..RSCC_MAX_BLOCK and, with `cap`, the total at most RSCC_MAX_TOTAL. {bs, total,
## bc} or {why}.
static func _rscc_head(head: PackedByteArray, cap: bool) -> Dictionary:
	if head.size() < 16:
		return {"why": "whose header is truncated"}
	var mode := head.decode_u32(4)
	if mode != RSCC_MODE_ZSTD:
		return {"why": "in compression mode %d; only zstd (mode %d) is inspected" % [mode, RSCC_MODE_ZSTD]}
	var bs := head.decode_u32(8)
	if bs < RSCC_MIN_BLOCK or bs > RSCC_MAX_BLOCK:
		return {"why": "with block size %d, outside %d..%d" % [bs, RSCC_MIN_BLOCK, RSCC_MAX_BLOCK]}
	var total := head.decode_u32(12)
	if cap and total > RSCC_MAX_TOTAL:
		return {"why": "that declares %d bytes, above the %d-byte cap" % [total, RSCC_MAX_TOTAL]}
	@warning_ignore("integer_division")
	return {"bs": bs, "total": total, "bc": total / bs + 1}


## Block `i`'s decoded size: the block size, the last one the remainder.
static func _rscc_block_size(h: Dictionary, i: int) -> int:
	var bc: int = h["bc"]
	return int(h["total"]) - (bc - 1) * int(h["bs"]) if i == bc - 1 else int(h["bs"])


## One frame `zstd_frame_ok` passed, decoded with exactly `want` bytes of room (an empty block is
## never decoded: `decompress` takes no zero size). The caller compares the size.
static func _rscc_decode(frame: PackedByteArray, want: int) -> PackedByteArray:
	if want == 0:
		return PackedByteArray()
	return frame.decompress(want, FileAccess.COMPRESSION_ZSTD)


## Block 0 of the `RSCC` resource behind `src`, decoded, or {why} (P4-28 audit GAP D: a resource's
## type sits at the start of its body). Only the header, the first table entry and the first frame
## are read; the header rules of `rscc_body` apply but the total cap (an app scene may declare more
## than a pack may), and the frame is walked and decoded to exactly its declared size.
static func rscc_first_block(src: PKeyByteSource) -> Dictionary:
	var h := _rscc_head(src.read(0, 16), false)
	if h.has("why"):
		return h
	var table_end := 16 + 4 * int(h["bc"])
	var entry := src.read(16, 4)
	if entry.size() != 4 or table_end > src.size:
		return {"why": "whose block table runs past the end"}
	var cs := entry.decode_u32(0)
	if cs > src.size - table_end:
		return {"why": "whose block 0 runs past the end"}
	var want := _rscc_block_size(h, 0)
	var frame := src.read(table_end, cs)
	if frame.size() != cs or not zstd_frame_ok(frame, want):
		return {"why": "whose block 0 is not one zstd frame of %d bytes" % want}
	var out := _rscc_decode(frame, want)
	if out.size() != want:
		return {"why": "whose block 0 does not decode to %d bytes" % want}
	return {"body": out}


## Whether `f` is exactly one zstd frame whose header declares `size` content bytes (rscc.ts
## `zstdFrameOk`): the frame magic first, Single_Segment set, no reserved bit, no dictionary id, a
## content size equal to `size`, a block walk (raw, RLE or compressed; no reserved type; no block
## declaring more than 128 KiB or more than `size`) that ends with the last-block flag and the
## optional checksum exactly at the end. A frame of 0 bytes may carry only
## empty raw blocks and no checksum, so it is never decoded (`decompress` takes no zero size).
static func zstd_frame_ok(f: PackedByteArray, size: int) -> bool:
	var n := f.size()
	if n < 6 or f.decode_u32(0) != ZSTD_MAGIC:
		return false
	var fhd := f[4]
	var fcs_flag := fhd >> 6
	var single := (fhd >> 5) & 1
	var checksum := (fhd >> 2) & 1
	if (fhd & 0x08) != 0 or (fhd & 0x03) != 0:
		return false
	# Single_Segment only (no window descriptor): every frame Godot writes has it, and the 32-bit
	# wasm decoder and a 64-bit device disagree on a window of 2^31.
	if single != 1:
		return false
	var p := 5
	var fcs_len := 1
	if fcs_flag == 1:
		fcs_len = 2
	elif fcs_flag == 2:
		fcs_len = 4
	elif fcs_flag == 3:
		fcs_len = 8
	if p + fcs_len > n:
		return false
	var fcs := 0
	if fcs_len == 1:
		fcs = f[p]
	elif fcs_len == 2:
		fcs = f.decode_u16(p) + 256
	elif fcs_len == 4:
		fcs = f.decode_u32(p)
	else:
		if f.decode_u32(p + 4) != 0:
			return false
		fcs = f.decode_u32(p)
	if fcs != size:
		return false
	p += fcs_len
	while true:
		if p + 3 > n:
			return false
		var h := f[p] | (f[p + 1] << 8) | (f[p + 2] << 16)
		p += 3
		var last := h & 1
		var type := (h >> 1) & 3
		var bsize := h >> 3
		if type == 3:
			return false
		# No block above 128 KiB or above the frame's size (for raw and RLE, the regenerated size).
		if bsize > ZSTD_BLOCK_MAX or bsize > size:
			return false
		if size == 0 and (type != 0 or bsize != 0):
			return false
		var payload := 1 if type == 1 else bsize
		if payload > n - p:
			return false
		p += payload
		if last == 1:
			break
	if checksum == 1:
		if size == 0:
			return false
		p += 4
	return p == n


## Whether bytes look like a Godot resource the scan must read: a binary (`RSRC`), compressed
## (`RSCC`) or text (`[gd_scene` / `[gd_resource` head) resource.
static func sniffs_resource(head: PackedByteArray) -> bool:
	var magic := head.slice(0, 4).get_string_from_ascii() if head.size() >= 4 else ""
	return magic == "RSRC" or magic == "RSCC" or sniffs_text_resource(head)


## A leading UTF-8 byte-order mark is skipped first (P4-22 review): more scanning, fail-closed.
static func sniffs_text_resource(data: PackedByteArray) -> bool:
	var from := 3 if data.size() >= 3 and data[0] == 0xEF and data[1] == 0xBB and data[2] == 0xBF else 0
	return _re(_GD_HEAD).search(_latin1(data.slice(from, from + 64))) != null


static func _binary_code(data: PackedByteArray) -> String:
	# The raw bytes anywhere, without the u32 length prefix (P4-08 audit GAP 3): the engine's
	# string reader stops at the first NUL, so a padded string with a larger length still decodes
	# to the type. Fails closed: a coincidental match refuses, never admits.
	var m := _marker(data)
	return "" if m == "" else "a binary resource that names %s (an embedded script or its source)" % m


## The text without its backslashes, natively (the caller has checked it is valid UTF-8 with no
## NUL, so the round trip is exact but for a leading byte-order mark, which the parse drops and
## which no ASCII marker can include; measured on 4.7.2 and 4.4.1).
static func _without_backslashes(data: PackedByteArray) -> PackedByteArray:
	return data.get_string_from_utf8().replace("\\", "").to_utf8_buffer()


## The first script marker (in `script_markers()` order, then the engine's extra Script classes)
## whose UTF-8 bytes occur anywhere in `data`, or "".
static func _marker(data: PackedByteArray) -> String:
	var markers: PackedStringArray = _script_kinds()["markers"]
	var needles: Array = []
	for m in markers:
		needles.append(m.to_utf8_buffer())
	var k := first_present(data, needles)
	return "" if k == -1 else markers[k]


## Whether `needle` occurs in `hay` (an empty needle never does).
static func has_bytes(hay: PackedByteArray, needle: PackedByteArray) -> bool:
	return first_present(hay, [needle]) != -1


## The bytes the scan reads per window (P4-27 audit GAP 2).
const SCAN_WINDOW := 1048576
## Work counters for `first_present` (P1-13), test hooks like `type_reads`: every native pass
## the scan makes over a window (the hex encoding, each needle's search, the decimal re-check)
## adds one to `scan_probes` and the window's size to `scan_bytes`, and so must any candidate
## comparison a later change adds. The complexity checks diff them around a call, so they hold
## on a machine of any speed or load.
static var scan_probes := 0
static var scan_bytes := 0


## The index of the first of `needles` (list order) that occurs anywhere in `hay`, or -1, in
## GDScript work linear in `hay.size() / SCAN_WINDOW` whatever the bytes are (P4-27 audit GAP 2:
## a body that is a run of a marker's first byte made a per-hit loop take minutes). Each window,
## overlapping the next by the longest needle − 1 bytes, is hex-encoded once and searched
## natively per needle; a hit at an odd offset straddles bytes, so that window is re-checked
## exactly with its decimal form (`[71, 68, …]`, where `, ` delimits every byte).
static func first_present(hay: PackedByteArray, needles: Array) -> int:
	var longest := 0
	var hexes := PackedStringArray()
	var decs := PackedStringArray()
	for nd in needles:
		var b: PackedByteArray = nd
		longest = maxi(longest, b.size())
		hexes.append(b.hex_encode())
		decs.append(", %s, " % str(b).substr(1, str(b).length() - 2) if b.size() > 0 else "")
	if longest == 0 or hay.size() == 0:
		return -1
	var best := -1
	var start := 0
	while start < hay.size():
		var end := mini(hay.size(), start + SCAN_WINDOW + longest - 1)
		var win := hay.slice(start, end)
		var h := win.hex_encode()
		scan_probes += 1
		scan_bytes += win.size()
		var d := ""
		for k in needles.size():
			if best != -1 and k >= best:
				break
			if hexes[k] == "":
				continue
			var at := h.find(hexes[k])
			scan_probes += 1
			scan_bytes += win.size()
			if at == -1:
				continue
			if at % 2 == 1:
				if d == "":
					var w := str(win)
					d = ", %s, " % w.substr(1, w.length() - 2)
				scan_probes += 1
				scan_bytes += win.size()
				if d.find(decs[k]) == -1:
					continue
			best = k
		if best == 0 or end == hay.size():
			break
		start += SCAN_WINDOW
	return best


static func _latin1(b: PackedByteArray) -> String:
	var s := ""
	for x in b:
		s += char(x) if x != 0 else " "
	return s


## The text scan (P4-08 audit GAP 1, GAP 6): no regex over sections (VariantParser reads
## newlines as whitespace and fields as Variants: StringName, escapes, inline `Object(…)`), but a
## fail-closed content rule. Refused: a NUL byte, invalid UTF-8, any script marker anywhere, or
## any `\u` / `\U` escape (which can spell one).
static func _text_code(data: PackedByteArray) -> String:
	if data.find(0) != -1:
		return "a text resource with a NUL byte, which cannot be inspected for embedded scripts"
	if not utf8_valid(data):
		return "a text resource that is not valid UTF-8, which cannot be inspected for embedded scripts"
	var m := _marker(data)
	if m != "":
		return "a text resource that names %s (an embedded script or its source)" % m
	# GAP A: the parser keeps the character after an unknown escape (`"GD\Script"` reads as
	# GDScript), so search again with every backslash removed. Fails closed.
	var bare := PackedByteArray()
	if data.find(0x5C) != -1:
		bare = _without_backslashes(data)
		m = _marker(bare)
		if m != "":
			return "a text resource that names %s behind escapes (an embedded script or its source)" % m
	if first_present(data, [PackedByteArray([0x5C, 0x75]), PackedByteArray([0x5C, 0x55])]) != -1:
		return "a text resource with a \\u escape, which can spell a script type"
	return ""


# ── References to app scripts and UIDs (P4-28) ──────────────────────────────────────────────────
#
# The CLI's `packRefs.ts`, the same rules and words: a pack's resources may reference outside
# the pack only app resources that are not scripts (by path), the app scripts the app lists as
# attachable (`PKeyOptions.pack_attachable`: `res://` paths and `res://…/` directories), and UIDs
# the pack's own uid cache registers or the app lists. A reference is a text resource's
# `[ext_resource]` tag or a binary resource's external-resource table entry; the engine uses its
# UID when that resolves and its path otherwise, so both are judged. Anything the check cannot
# read the way the engine would is refused: an `ext_resource` line that is not one strict tag,
# the inline `Resource("…")` constructor, a path that is not already normal, a `.remap`/`.import`
# path, a non-canonical UID, and in a binary resource a big-endian file, a format above 6, a
# sub-resource path that is not `local://`, the pre-4.0 inline external reference, an unknown
# value type, or anything past the end.

## `ResourceFormatSaverBinary::FORMAT_VERSION` in 4.4.1 and 4.7.2.
const BINARY_FORMAT_MAX := 6
const _UID_CHARS := "abcdefghijklmnopqrstuvwxy012345678"
const _UID_MAX := 0x7FFFFFFFFFFFFFFF
const _AMBIGUOUS := ", so the device cannot tell what it loads"
const _EXT_LINE := "^[ \\t]*\\[ext_resource((?: [a-z_]+=\"[^\"\\\\]*\")+)\\][ \\t]*$"
const _EXT_ATTR := " ([a-z_]+)=\"([^\"\\\\]*)\""
## P4-28 audit GAP A (packRefs.ts `RESOURCE_PATH_WHY`, the same words): `Resource.set_path`
## registers a sub-resource in the resource cache under that path when nothing is cached there
## (the loader re-paths only the main resource), so a later load() of an app path would return
## the pack's object. The engine never stores the property.
const _TYPE_KEY := "(?m)^[ \\t]*type[ \\t]*=[ \\t]*\"([^\"]*)\""
const _TEXT_TYPE := "^[ \\t\\n\\r]*\\[gd_resource[^\\]\\n]*[ \\t]type=\"([^\"]*)\""
const RESOURCE_PATH_WHY := "sets resource_path, which can put it in the resource cache under an app path"


## `ResourceUID::id_to_text`.
static func uid_text(id: int) -> String:
	if id < 0:
		return "uid://<invalid>"
	var out := ""
	var v := id
	while true:
		out = _UID_CHARS[v % 34] + out
		@warning_ignore("integer_division")
		v = v / 34
		if v == 0:
			break
	return "uid://" + out


## The id of a `uid://` text in its canonical form only (`uid_text(id) == text`), or -1.
static func canonical_uid(text: String) -> int:
	if not text.begins_with("uid://"):
		return -1
	var s := text.substr(6)
	if s.length() < 1 or s.length() > 13:
		return -1
	var v := 0
	for i in s.length():
		var d := _UID_CHARS.find(s[i])
		if d < 0:
			return -1
		@warning_ignore("integer_division")
		if v > (_UID_MAX - d) / 34:
			return -1
		v = v * 34 + d
	return v if uid_text(v) == text else -1


## Why one attachable entry is malformed, or "" (packRefs.ts `attachableEntryProblem`).
static func attachable_problem(s: String) -> String:
	if s.begins_with("uid://"):
		return "not a canonical uid://" if canonical_uid(s) < 0 else ""
	if not s.begins_with("res://"):
		return "neither res:// nor uid://"
	var rest := s.substr(6)
	var path := rest.substr(0, rest.length() - 1) if rest.ends_with("/") else rest
	return "" if path_ok(path) else "not a normal res:// path"


## The attachable list, parsed: {paths: {res path: true}, dirs: PackedStringArray, uids: {id:
## true}}. A malformed entry is dropped (it admits nothing; `PKeyCore` refuses one at configure).
static func parse_attachable(list: Variant) -> Dictionary:
	var out := {"paths": {}, "dirs": PackedStringArray(), "uids": {}}
	if not (list is Array or list is PackedStringArray):
		return out
	var dirs := PackedStringArray()
	for e in list:
		if not (e is String or e is StringName):
			continue
		var s := String(e)
		if attachable_problem(s) != "":
			continue
		if s.begins_with("uid://"):
			out["uids"][canonical_uid(s)] = true
		elif s.ends_with("/"):
			dirs.append(s)
		else:
			out["paths"][s] = true
	out["dirs"] = dirs
	return out


static func _uid_problem(u: int, raw: String, ctx: Dictionary) -> String:
	if u < 0:
		return "references %s, which is not a canonical uid://%s" % [raw, _AMBIGUOUS]
	if (ctx["pack_uids"] as Dictionary).has(u) or (ctx["attachable"]["uids"] as Dictionary).has(u):
		return ""
	# Device only (the CLI cannot resolve an app UID, so it refuses every unlisted one): a UID this
	# app registers is judged by the path it names, so an app texture or scene a pack reaches by
	# UID passes and an app script still needs listing.
	if ctx.get("resolve", false) and ResourceUID.has_id(u):
		var path := ResourceUID.get_id_path(u)
		if path != "":
			return _path_problem(path, null, ctx)
	return "references %s, outside the pack's uid cache, which the app does not list as attachable" % uid_text(u)


## Device only (P4-28 audit GAP C): whether the app resource at `p` is a script by its real type,
## whatever the reference's `type` hint says (the engine picks a loader by extension, so a GDScript
## saved as `.tres` loads as a script). A `.remap` (an exported text resource) is followed first.
## A resource that exists but whose type the engine cannot tell counts as a script (fails closed).
static func _app_script_type(p: String, memo: Dictionary = {}) -> bool:
	var t := _remapped_type(p, memo)
	if t == "":
		return ResourceLoader.exists(p)
	return t == "Script" or ClassDB.is_parent_class(t, "Script")


## The type of the app resource at `p`, read the way the loaders do (GDScript cannot call
## `ResourceLoader.get_resource_type`, and loading would run a script's static initialisers): a
## `.remap` (an exported resource) is followed first; an imported file's type is its `.import`'s
## `type="…"`; a binary resource's (`RSRC`, or a bounded `RSCC` body) is its header's; a text
## resource's is its `[gd_resource type="…"]` head (`[gd_scene` is a PackedScene). "" when there is
## no such file or its type cannot be read. An `RSCC` file is read only to its first block
## (`rscc_first_block`), and `memo` (one per directory check) keeps each path's answer, so a pack
## naming one large app scene many times costs one header read (P4-28 audit GAP D).
static func _remapped_type(p: String, memo: Dictionary = {}) -> String:
	if memo.has(p):
		return memo[p]
	type_reads += 1
	var t := _read_type(p)
	memo[p] = t
	return t


static func _read_type(p: String) -> String:
	var target := p
	if FileAccess.file_exists(p + ".remap"):
		for v in remap_values(FileAccess.get_file_as_bytes(p + ".remap").get_string_from_utf8()):
			if v.begins_with("res://"):
				target = v
				break
	if FileAccess.file_exists(target + ".import"):
		var m := _re(_TYPE_KEY).search(FileAccess.get_file_as_bytes(target + ".import").get_string_from_utf8())
		return m.get_string(1) if m != null else ""
	if not FileAccess.file_exists(target):
		return ""
	var f := FileAccess.open(target, FileAccess.READ)
	if f == null:
		return ""
	var head := f.get_buffer(4)
	var body := PackedByteArray()
	if head.get_string_from_ascii() == "RSRC":
		body = f.get_buffer(mini(f.get_length() - 4, 65536))
	elif head.get_string_from_ascii() == "RSCC":
		f.close()
		var r := rscc_first_block(PKeyByteSource.file(target))
		if r.has("why"):
			return ""
		body = r["body"]
	else:
		var text := (head + f.get_buffer(mini(f.get_length() - 4, 4096))).get_string_from_utf8()
		if text.strip_edges(true, false).begins_with("[gd_scene"):
			return "PackedScene"
		var m := _re(_TEXT_TYPE).search(text)
		return m.get_string(1) if m != null else ""
	# The header words (big-endian, real64, major, minor, format), then the type string.
	if body.size() < 24:
		return ""
	var n := body.decode_u32(20)
	if 24 + n > body.size():
		return ""
	var raw := body.slice(24, 24 + n)
	var z := raw.find(0)
	return (raw if z == -1 else raw.slice(0, z)).get_string_from_utf8()


## Why one reference ({type: String or null, path, uid: null, a text String or a binary int}) is
## refused, or "" (the UID first, then the path). `ctx`: {in_pack, pack_uids, attachable, resolve}
## (`resolve`: the device's own lookups, P4-28 audit GAP C and the UID rule above).
static func ref_problem(ref: Dictionary, ctx: Dictionary) -> String:
	var uid = ref.get("uid")
	if uid is String:
		var why := _uid_problem(canonical_uid(uid), uid, ctx)
		if why != "":
			return why
	elif uid is int and uid != -1:
		# A binary entry without a UID stores -1 (`ResourceUID::INVALID_ID`).
		var why := _uid_problem(uid, uid_text(uid), ctx)
		if why != "":
			return why
	var p: String = ref["path"]
	if p.begins_with("uid://"):
		return _uid_problem(canonical_uid(p), p, ctx)
	return _path_problem(p, ref.get("type"), ctx)


static func _path_problem(p: String, t: Variant, ctx: Dictionary) -> String:
	if not p.begins_with("res://") or not path_ok(p.substr(6)):
		return "references %s, which is not a normal res:// path or uid://%s" % [p, _AMBIGUOUS]
	var rest := p.substr(6)
	if rest.ends_with(".remap") or rest.ends_with(".import"):
		return "references %s, a .remap or .import file%s" % [p, _AMBIGUOUS]
	var in_pack: Dictionary = ctx["in_pack"]
	if in_pack.has(rest) or in_pack.has(rest + ".remap") or in_pack.has(rest + ".import"):
		return ""
	var script := _is_script(rest)
	if not script and t is String:
		script = t == "Script" or (_script_kinds()["markers"] as PackedStringArray).has(t)
	if not script and ctx.get("resolve", false):
		script = _app_script_type(p, ctx.get("types", {}))
	if not script:
		return ""
	var att: Dictionary = ctx["attachable"]
	if (att["paths"] as Dictionary).has(p):
		return ""
	for d in att["dirs"]:
		if p.begins_with(d):
			return ""
	return "references the app script %s, which the app does not list as attachable" % p


## A text resource's references ({refs}) or why it is refused ({why}). `text` is valid UTF-8
## without NUL (the embedded-code rule ran first).
static func text_refs(text: String) -> Dictionary:
	var t := text.replace("\r", "\n")
	# GAP A: the property name anywhere, as written or behind escapes (fails closed).
	if t.contains("resource_path") or t.replace("\\", "").contains("resource_path"):
		return {"why": RESOURCE_PATH_WHY}
	var lines := t.split("\n")
	var refs: Array = []
	for i in lines.size():
		var l := lines[i]
		if not l.contains("ext_resource"):
			continue
		var bad := {"why": "has an ext_resource tag on line %d the engine could read differently%s" % [i + 1, _AMBIGUOUS]}
		var m := _re(_EXT_LINE).search(l)
		if m == null:
			return bad
		var attrs := {}
		for a in _re(_EXT_ATTR).search_all(m.get_string(1)):
			var k := a.get_string(1)
			if not (k == "type" or k == "uid" or k == "path" or k == "id") or attrs.has(k):
				return bad
			attrs[k] = a.get_string(2)
		if not (attrs.has("type") and attrs.has("path") and attrs.has("id")):
			return bad
		refs.append({"type": attrs["type"], "path": attrs["path"], "uid": attrs.get("uid")})
	# `Resource(…)`: the identifier, then whitespace (≤ 0x20) or `;` comments, then `(`.
	var n := t.length()
	var at := t.find("Resource")
	while at != -1:
		var from := maxi(0, at - 3)
		var before := t.substr(from, at - from)
		if before != "Ext" and before != "Sub":
			var j := at + 8
			while true:
				while j < n and t.unicode_at(j) <= 0x20:
					j += 1
				if j < n and t[j] == ";":
					while j < n and t[j] != "\n":
						j += 1
					continue
				break
			if j < n and t[j] == "(":
				return {"why": "loads a resource by path inline (Resource(...))%s" % _AMBIGUOUS}
		at = t.find("Resource", at + 1)
	return {"refs": refs}


## A binary resource's references ({refs}) or why it is refused ({why}): `b` is the stream the
## loader reads (an `RSRC` file, or an `RSCC` body), `start` where its header words begin (4 after
## `RSRC`, 0 in a body). Every field is bounded before it is read; thread-safe (ints and
## PackedByteArrays only).
static func binary_refs(b: PackedByteArray, start: int) -> Dictionary:
	var r := _BinaryReader.new(b, start)
	if r.u32() != 0:
		return {"why": "is a big-endian binary resource%s" % _AMBIGUOUS} if r.ok else r.fail()
	r.u32() # real64 (unused by the loader)
	r.u32() # major
	r.u32() # minor
	var format := r.u32()
	if not r.ok:
		return r.fail()
	if format > BINARY_FORMAT_MAX:
		return {"why": "is a binary resource in format %d, above %d%s" % [format, BINARY_FORMAT_MAX, _AMBIGUOUS]}
	r.read_str() # type
	r.skip(8) # import metadata offset
	var flags := r.u32()
	r.skip(8) # uid
	if flags & 8:
		r.read_str() # script class
	r.skip(4 * 11)
	if not r.ok:
		return r.fail()
	r.part = "reference tables"
	var nstr := r.u32()
	var i := 0
	# GAP A: the string-table entries that name `resource_path` (a property may use one).
	while r.ok and i < nstr:
		var entry := r.read_str()
		if is_resource_path(entry):
			r.rp_names[i] = true
		if not name_utf8(entry):
			r.bad_names[i] = true
		i += 1
	var refs: Array = []
	var next := r.u32()
	i = 0
	while r.ok and i < next:
		var type := r.decode_text(r.read_str())
		var path := r.decode_text(r.read_str())
		var uid = null
		if flags & 2:
			uid = r.s64()
		refs.append({"type": type, "path": path, "uid": uid})
		i += 1
	var nint := r.u32()
	var offsets := PackedInt64Array()
	i = 0
	while r.ok and i < nint:
		var path := r.decode_text(r.read_str())
		var off := r.u64()
		if r.ok and i < nint - 1 and not path.begins_with("local://"):
			return {"why": "has a sub-resource path that is not local:// (%s)%s" % [path, _AMBIGUOUS]}
		offsets.append(off)
		i += 1
	if not r.ok:
		return r.fail()
	var table_end := r.pos
	r.part = "properties"
	var real := 8 if flags & 4 else 4
	# GAP B: the saver writes the internal resources in order after the tables, so each offset
	# must follow the tables and its predecessor, and each walk end by its successor's offset: no
	# byte is walked twice. The walked total is held to the stream length as a backstop.
	var walked := 0
	for k in offsets.size():
		var off := offsets[k]
		var prev := table_end - 1 if k == 0 else offsets[k - 1]
		if off < 0 or off <= prev or off > b.size():
			r.ok = false
			return r.fail()
		r.limit = maxi(off, mini(offsets[k + 1], b.size())) if k + 1 < offsets.size() else b.size()
		r.pos = off
		r.read_str() # the class
		var pc := r.u32()
		var j := 0
		while r.ok and j < pc:
			r.read_name(nstr, true)
			if r.rp_hit:
				return {"why": RESOURCE_PATH_WHY}
			var pending := 1
			while r.ok and pending > 0:
				pending -= 1
				var tag := r.u32()
				if not r.ok:
					break
				match tag:
					1, 42, 43: # NIL, CALLABLE, SIGNAL
						pass
					2, 3, 23: # BOOL, INT, RID
						r.skip(4)
					40, 41: # INT64, DOUBLE
						r.skip(8)
					4: # FLOAT
						r.skip(real)
					5, 44: # STRING, STRING_NAME
						r.read_str()
					10: # VECTOR2
						r.skip(2 * real)
					45: # VECTOR2I
						r.skip(8)
					11, 50, 13, 14: # RECT2, VECTOR4, PLANE, QUATERNION
						r.skip(4 * real)
					46, 51, 20: # RECT2I, VECTOR4I, COLOR (always single precision)
						r.skip(16)
					12: # VECTOR3
						r.skip(3 * real)
					47: # VECTOR3I
						r.skip(12)
					15, 18: # AABB, TRANSFORM2D
						r.skip(6 * real)
					16: # BASIS
						r.skip(9 * real)
					17: # TRANSFORM3D
						r.skip(12 * real)
					52: # PROJECTION
						r.skip(16 * real)
					22: # NODE_PATH: u16 names, u16 subnames (bit 15: absolute), each a string id
						var names := r.u16()
						var subs := r.u16() & 0x7FFF
						if format < 3:
							subs += 1
						var kk := 0
						while r.ok and kk < names + subs:
							r.read_name(nstr, false)
							kk += 1
					24: # OBJECT: empty, inline external (pre-4.0), internal index, external index
						var kind := r.u32()
						if r.ok and kind == 1:
							return {"why": "has an inline external reference (the pre-4.0 binary form)%s" % _AMBIGUOUS}
						if kind == 2 or kind == 3:
							r.skip(4)
						elif kind != 0:
							r.ok = false
					26: # DICTIONARY (bit 31: shared)
						pending += 2 * (r.u32() & 0x7FFFFFFF)
					30: # ARRAY (bit 31: shared)
						pending += r.u32() & 0x7FFFFFFF
					31: # PACKED_BYTE_ARRAY, padded to 4
						var nb := r.u32()
						r.skip(nb + (4 - nb % 4) % 4)
					32, 33: # PACKED_INT32_ARRAY, PACKED_FLOAT32_ARRAY
						r.skip(r.u32() * 4)
					48, 49: # PACKED_INT64_ARRAY, PACKED_FLOAT64_ARRAY
						r.skip(r.u32() * 8)
					34: # PACKED_STRING_ARRAY
						var ns := r.u32()
						var kk := 0
						while r.ok and kk < ns:
							r.read_str()
							kk += 1
					37: # PACKED_VECTOR2_ARRAY
						r.skip(r.u32() * 2 * real)
					35: # PACKED_VECTOR3_ARRAY
						r.skip(r.u32() * 3 * real)
					36: # PACKED_COLOR_ARRAY (always single precision)
						r.skip(r.u32() * 16)
					53: # PACKED_VECTOR4_ARRAY
						r.skip(r.u32() * 4 * real)
					_:
						return {"why": "has a value of unknown type %d%s" % [tag, _AMBIGUOUS]}
			j += 1
		if not r.ok:
			return r.fail()
		walked += r.pos - off
		if walked > b.size():
			r.ok = false
			return r.fail()
	return {"refs": refs}


## The cursor `binary_refs` reads with: every read is bounded; the first failure sticks (`ok`).
class _BinaryReader:
	var b: PackedByteArray
	var pos := 0
	var ok := true
	var part := "header"
	## Reads stop here: the stream's end, then (GAP B) each internal resource's successor.
	var limit := 0
	## GAP A: string-table indices naming `resource_path`, and whether a property used one.
	var rp_names := {}
	var rp_hit := false
	## String-table indices that are not valid UTF-8 (a property may not use one).
	var bad_names := {}

	func _init(p_b: PackedByteArray, p_start: int) -> void:
		b = p_b
		pos = p_start
		limit = b.size()

	func fail() -> Dictionary:
		return {"why": "is a binary resource whose %s cannot be read, so the device cannot tell what it loads" % part}

	func need(n: int) -> bool:
		if not ok or n < 0 or pos + n > limit:
			ok = false
		return ok

	func u32() -> int:
		if not need(4):
			return 0
		pos += 4
		return b.decode_u32(pos - 4)

	func u16() -> int:
		if not need(2):
			return 0
		pos += 2
		return b.decode_u16(pos - 2)

	func s64() -> int:
		if not need(8):
			return 0
		pos += 8
		return b.decode_s64(pos - 8)

	## A u64 offset; -1 above 2^53 − 1.
	func u64() -> int:
		if not need(8):
			return 0
		var lo := b.decode_u32(pos)
		var hi := b.decode_u32(pos + 4)
		pos += 8
		return -1 if hi > 0x1FFFFF else hi * 4294967296 + lo

	func skip(n: int) -> void:
		if need(n):
			pos += n

	func read_str() -> PackedByteArray:
		var n := u32()
		if not need(n):
			return PackedByteArray()
		pos += n
		return b.slice(pos - n, pos)

	## A string as the loader decodes it: up to the first NUL, valid UTF-8 without a byte-order
	## mark (the engine drops a leading one), or the read fails.
	func decode_text(s: PackedByteArray) -> String:
		if not ok:
			return ""
		var z := s.find(0)
		var cut := s if z == -1 else s.slice(0, z)
		if PKeyPck.has_bytes(cut, PackedByteArray([0xEF, 0xBB, 0xBF])) or not PKeyPck.utf8_valid(cut):
			ok = false
			return ""
		return cut.get_string_from_utf8()

	## A string id: a table index, or (bit 31) an inline string; `prop`: a property's name, which
	## may not be `resource_path` (GAP A; `rp_hit` stops the walk).
	func read_name(nstr: int, prop: bool) -> void:
		var id := u32()
		if not ok:
			return
		if id & 0x80000000:
			var n := id & 0x7FFFFFFF
			if not need(n):
				return
			pos += n
			var inline := b.slice(pos - n, pos)
			if prop and PKeyPck.is_resource_path(inline):
				rp_hit = true
				ok = false
			elif prop and not PKeyPck.name_utf8(inline):
				ok = false
		elif id >= nstr:
			ok = false
		elif prop and rp_names.has(id):
			rp_hit = true
			ok = false
		elif prop and bad_names.has(id):
			ok = false


## Whether string bytes decode to `resource_path` as the loader reads them: up to the first NUL,
## a leading byte-order mark dropped (packRefs.ts `isResourcePath`).
static func is_resource_path(s: PackedByteArray) -> bool:
	var z := s.find(0)
	var cut := s if z == -1 else s.slice(0, z)
	if cut.size() >= 3 and cut[0] == 0xEF and cut[1] == 0xBB and cut[2] == 0xBF:
		cut = cut.slice(3)
	return cut == "resource_path".to_ascii_buffer()


## Whether a binary string, up to its first NUL, is valid UTF-8 (a property name that is not is
## refused: the loader would rewrite it).
static func name_utf8(s: PackedByteArray) -> bool:
	var z := s.find(0)
	return utf8_valid(s if z == -1 else s.slice(0, z))


## The ids a uid cache registers, as {id: true}; {} when it is malformed.
static func uid_cache_ids(data: PackedByteArray) -> Dictionary:
	var out := {}
	if data.size() < 4:
		return out
	var n := data.decode_u32(0)
	var p := 4
	for i in n:
		if p + 12 > data.size():
			return {}
		var ln := data.decode_u32(p + 8)
		if p + 12 + ln > data.size():
			return {}
		out[data.decode_s64(p)] = true
		p += 12 + ln
	return out


## Why a resource's references are refused (`ref_problem` over `text_refs` / `binary_refs`), or "".
static func refs_problem(src: Dictionary, ctx: Dictionary) -> String:
	var r: Dictionary
	if src["kind"] == "text":
		r = text_refs((src["data"] as PackedByteArray).get_string_from_utf8())
	else:
		r = binary_refs(src["data"], int(src["start"]))
	if r.has("why"):
		return r["why"]
	for ref in r["refs"]:
		var why := ref_problem(ref, ctx)
		if why != "":
			return why
	return ""


## The admission list (notes/S-05 §5 (f); P4-03's `lintPck`), over a directory `read_directory`
## returned and the bytes behind it. A `godot.pck` payload may contain only (1) entries under one
## of `prefixes` (`res://…/`), including their `.remap` and `.import` files; (2) the
## `.godot/exported/…` and `.godot/imported/…` files those in-prefix files point to; (3)
## `.godot/uid_cache.bin`. Every admitted resource must carry no code (`embedded_code`).
## Everything else is refused with its path — `project.binary`, the class cache, scripts (and a
## `.remap` that points to one), native libraries and `.gdextension` files, an out-of-prefix
## path, an exported or imported file nothing in the pack names. Every admitted resource's
## references outside the pack must be ones `attachable` (the app's `pack_attachable`) lists
## (P4-28, `ref_problem`). Returns {ok, errors: [{path, why}], count, warning}.
static func directory_check(source: PKeyByteSource, dir: Dictionary, prefixes: Array, attachable: Variant = null) -> Dictionary:
	var pre := PackedStringArray()
	for p in prefixes:
		if p is String:
			var rp := _res_path(p)
			if rp != "":
				pre.append(rp)
	var errors: Array = []
	var named := {}
	var deferred := PackedStringArray()
	var entries: Array = dir["entries"]
	# The pack's RSCC decompression budget, counted in directory order (P4-27).
	var budget := {"used": 0}
	var in_pack := {}
	var pack_uids := {}
	for e in entries:
		in_pack[e["path"]] = true
		if e["path"] == UID_CACHE:
			pack_uids = uid_cache_ids(source.read(int(e["offset"]), int(e["size"])))
	# P4-28: what the pack's resources may reference outside the pack.
	var ref_ctx := {"in_pack": in_pack, "pack_uids": pack_uids, "attachable": parse_attachable(attachable), "resolve": true, "types": {}}
	for e in entries:
		var p: String = e["path"]
		if p == STRIP_PROJECT_BINARY or p == STRIP_CLASS_CACHE:
			errors.append({"path": p, "why": "--export-pack's %s replaces the main pack's copy." % p})
			continue
		if _is_script(p):
			errors.append({"path": p, "why": "a script; a pack carries data only (S-07 row 13)."})
			continue
		if _is_native(p):
			errors.append({"path": p, "why": "a native library or GDExtension; a pack carries data only."})
			continue
		var in_prefix := false
		for x in pre:
			if p.begins_with(x):
				in_prefix = true
				break
		var needs_bytes := p == UID_CACHE or (in_prefix and (p.ends_with(".remap") or p.ends_with(".import")))
		var scanned := _re(_TEXT_RES).search(p) != null or _re(_BINARY_RES).search(p) != null or p.begins_with(".godot/exported/")
		if not scanned and p != UID_CACHE:
			# Sniff every other entry's head: a resource is scanned whatever its extension.
			scanned = sniffs_resource(source.read(int(e["offset"]), mini(67, int(e["size"]))))
		var data := PackedByteArray()
		if needs_bytes or scanned:
			data = source.read(int(e["offset"]), int(e["size"]))
			if data.size() != int(e["size"]):
				errors.append({"path": p, "why": "its bytes cannot be read."})
				continue
		if p == UID_CACHE:
			var why := uid_cache_problem(data, in_pack)
			if why != "":
				errors.append({"path": p, "why": "%s; a pack registers only its own UIDs." % why})
			continue
		var res := inspect(p, data, budget) if scanned else {"code": ""}
		if res["code"] != "":
			errors.append({"path": p, "why": "%s; a pack carries data only." % res["code"]})
			continue
		if res.has("refs"):
			var rwhy := refs_problem(res["refs"], ref_ctx)
			if rwhy != "":
				errors.append({"path": p, "why": "%s." % rwhy})
				continue
		if in_prefix:
			if needs_bytes:
				var problem := remap_problem(data)
				if problem != "":
					errors.append({"path": p, "why": "%s; a pack loads only its own files." % problem})
					continue
				var text := data.get_string_from_utf8()
				var targets := remap_targets(text)
				var src := p.substr(0, p.rfind("."))
				var script := ""
				for t in targets:
					if _is_script(t):
						script = t
						break
				if _is_script(src) or script != "":
					errors.append({"path": p, "why": "remaps a script%s; a pack carries data only." % (" (%s)" % script if script != "" else "")})
					continue
				# Every value must be a normalised path of THIS pack: nothing in the base game, no
				# absolute path, nothing the engine would rewrite into another prefix.
				var outside := ""
				for v in remap_values(text):
					if v == "":
						continue
					var t := _res_path(v)
					if t == "" or not path_ok(t) or not in_pack.has(t):
						outside = v
						break
				if outside != "":
					errors.append({"path": p, "why": "remaps a path outside the pack (%s); a pack loads only its own files." % outside})
					continue
				for t in targets:
					named[t] = true
			continue
		if p.begins_with(".godot/exported/") or p.begins_with(".godot/imported/"):
			deferred.append(p)
			continue
		errors.append({"path": p, "why": "outside the handler prefixes (%s)." % ", ".join(PackedStringArray(prefixes))})
	for p in deferred:
		if not named.has(p):
			errors.append({"path": p, "why": "no in-prefix .remap or .import names it, so nothing in the pack could load it."})
	var count := entries.size()
	var warning := ""
	if count > WARN_ENTRIES:
		warning = "%d entries, above %d: mounting it stalls longer (S-05 §4.1)" % [count, WARN_ENTRIES]
	return {"ok": errors.is_empty(), "errors": errors, "count": count, "warning": warning}


## The data-only rule over a TREE payload (P4-08 review N5): every file whose content is a Godot
## resource (binary `RSRC`, compressed `RSCC`, a `[gd_scene`/`[gd_resource` head) or whose
## extension names one is scanned with `embedded_code` before the tree commits; a script, a
## native library or a `.gdextension` file is refused by name. {ok} or {ok: false, code, detail,
## path}. `dir` is the staged tree.
static func tree_check(dir: String) -> Dictionary:
	var paths = PKeyPackStorage.walk_tree(dir)
	if paths == null:
		return {"ok": false, "code": DIRECTORY_REFUSED, "detail": "the staged tree cannot be listed", "path": ""}
	var budget := {"used": 0}
	for p in paths:
		var why := ""
		if _is_script(p):
			why = "a script; a pack carries data only (S-07 row 13)."
		elif _is_native(p):
			why = "a native library or GDExtension; a pack carries data only."
		else:
			var src := PKeyByteSource.file(dir.path_join(p))
			var resource: bool = _re(_TEXT_RES).search(p) != null or _re(_BINARY_RES).search(p) != null or sniffs_resource(src.read(0, 67))
			if resource:
				var code := embedded_code(p, PKeyByteSource.read_all(src), budget)
				if code != "":
					why = "%s; a pack carries data only." % code
		if why != "":
			return {"ok": false, "code": DIRECTORY_REFUSED, "detail": "%s: %s" % [p, why], "path": p}
	return {"ok": true}


## The PCK format version this engine reads and writes (what PCKPacker produces), probed once
## and then cached. 0 when it cannot be determined right now: a failure is not cached, so a later
## call probes again (a transient write failure never downgrades the process). Thread-safe; the
## pack engine probes it on the main thread at construction.
static func helper_version() -> int:
	_helper_mutex.lock()
	if _helper_version <= 0:
		_helper_version = _probe_helper_version()
	var v := _helper_version
	_helper_mutex.unlock()
	return v


static func _probe_helper_version() -> int:
	var found := 0
	var dir := helper_probe_dir
	DirAccess.make_dir_recursive_absolute(dir)
	var path := dir.path_join("pck-version-probe-%d.pck" % OS.get_thread_caller_id())
	var packer := PCKPacker.new()
	if packer.pck_start(path) == OK and packer.flush() == OK:
		var f := FileAccess.open(path, FileAccess.READ)
		if f != null:
			var head := f.get_buffer(8)
			f.close()
			if head.size() == 8 and head.decode_u32(0) == MAGIC:
				found = head.decode_u32(4)
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
	return found


static func _pad16(n: int) -> int:
	return (16 - n % 16) % 16


## The common header for a helper pack written by this engine: magic, `version`, the running
## engine, REL_FILEBASE, then `file_base` and `dir_offset` (both relative to the pack's start),
## then 16 reserved words.
static func _header(version: int, file_base: int, dir_offset: int) -> PackedByteArray:
	var e := running_engine()
	var b := PackedByteArray()
	b.resize(HEADER_V3)
	b.fill(0)
	b.encode_u32(0, MAGIC)
	b.encode_u32(4, version)
	b.encode_u32(8, e[0])
	b.encode_u32(12, e[1])
	b.encode_u32(16, e[2])
	b.encode_u32(20, PACK_REL_FILEBASE)
	b.encode_s64(24, file_base)
	b.encode_s64(32, dir_offset)
	return b


## One directory record: the path NUL-padded to 4, offset, size, a zero MD5 (Godot never checks
## directory MD5s, A6 §2.1), flags.
static func _record(path: String, offset: int, size: int, flags: int) -> PackedByteArray:
	var pb := path.to_utf8_buffer()
	pb.resize(pb.size() + (4 - pb.size() % 4) % 4)
	var r := PackedByteArray()
	r.resize(4)
	r.encode_u32(0, pb.size())
	r.append_array(pb)
	var tail := PackedByteArray()
	tail.resize(36)
	tail.fill(0)
	tail.encode_s64(0, offset)
	tail.encode_s64(8, size)
	tail.encode_u32(32, flags)
	r.append_array(tail)
	return r


static func _store(f: FileAccess, b: PackedByteArray) -> bool:
	if b.is_empty():
		return true
	if not f.store_buffer(b):
		return false
	return f.get_error() == OK


## Write a v2 PCK (the 4.4 and 4.5 layout: header, directory, then 16-aligned data).
static func _write_v2(path: String, entries: Array) -> Error:
	var sizes := PackedInt64Array()
	for e in entries:
		sizes.append((e["source"] as PKeyByteSource).size if e.has("source") else (e["bytes"] as PackedByteArray).size())
	var dir_size := 4
	for e in entries:
		var pb: PackedByteArray = String(e["path"]).to_utf8_buffer()
		dir_size += 4 + pb.size() + (4 - pb.size() % 4) % 4 + 36
	var file_base := HEADER_V2 + dir_size
	file_base += _pad16(file_base)
	var recs := PackedByteArray()
	var count := PackedByteArray()
	count.resize(4)
	count.encode_u32(0, entries.size())
	recs.append_array(count)
	var rel := 0
	for i in entries.size():
		recs.append_array(_record(entries[i]["path"], rel, sizes[i], int(entries[i].get("flags", 0))))
		rel += sizes[i] + _pad16(sizes[i])
	var head := PackedByteArray()
	head.resize(HEADER_V2)
	head.fill(0)
	var e := running_engine()
	head.encode_u32(0, MAGIC)
	head.encode_u32(4, 2)
	head.encode_u32(8, e[0])
	head.encode_u32(12, e[1])
	head.encode_u32(16, e[2])
	head.encode_u32(20, 0)
	head.encode_s64(24, file_base)
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return FileAccess.get_open_error()
	var pad := PackedByteArray()
	pad.resize(file_base - HEADER_V2 - recs.size())
	pad.fill(0)
	var ok := _store(f, head) and _store(f, recs) and _store(f, pad)
	for i in entries.size():
		if not ok:
			break
		var en: Dictionary = entries[i]
		if en.has("source"):
			var src: PKeyByteSource = en["source"]
			var done := 0
			while ok and done < src.size:
				var chunk := src.read(done, mini(PKeyByteSource.READ_CHUNK, src.size - done))
				if chunk.is_empty():
					ok = false
					break
				ok = _store(f, chunk)
				done += chunk.size()
		else:
			ok = ok and _store(f, en["bytes"])
		var tail := PackedByteArray()
		tail.resize(_pad16(sizes[i]))
		tail.fill(0)
		ok = ok and _store(f, tail)
	var length := int(f.get_length())
	f.close()
	if not ok or length != file_base + rel:
		DirAccess.remove_absolute(path)
		return ERR_FILE_CANT_WRITE
	return OK


## Write a helper PCK at `path` in this engine's layout (`version`: v2 is the 4.4/4.5 layout,
## v3/v4 put the 16-aligned data first and the directory last). `entries`: [{path, flags, bytes:
## PackedByteArray} or {path, flags, source: PKeyByteSource}]; a source is copied in READ_CHUNK
## steps. Every write is checked; the file is read back for its length. OK, or the failing Error
## (the file is removed).
static func write(path: String, entries: Array, version: int) -> Error:
	if version == 2:
		return _write_v2(path, entries)
	if version < 2:
		return ERR_UNAVAILABLE
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return FileAccess.get_open_error()
	var ok := _store(f, _header(version, 0, 0))
	var file_base := HEADER_V3
	var recs := PackedByteArray()
	var count := 0
	for e in entries:
		if not ok:
			break
		var at := int(f.get_position())
		var size := 0
		if e.has("source"):
			var src: PKeyByteSource = e["source"]
			var done := 0
			while ok and done < src.size:
				var chunk := src.read(done, mini(PKeyByteSource.READ_CHUNK, src.size - done))
				if chunk.is_empty():
					ok = false
					break
				ok = _store(f, chunk)
				done += chunk.size()
			size = done
		else:
			var bytes: PackedByteArray = e["bytes"]
			ok = ok and _store(f, bytes)
			size = bytes.size()
		var pad := PackedByteArray()
		pad.resize(_pad16(int(f.get_position())))
		pad.fill(0)
		ok = ok and _store(f, pad)
		recs.append_array(_record(e["path"], at - file_base, size, int(e.get("flags", 0))))
		count += 1
	var dir_offset := int(f.get_position())
	var head := PackedByteArray()
	head.resize(4)
	head.encode_u32(0, count)
	ok = ok and _store(f, head) and _store(f, recs)
	if ok:
		f.seek(24)
		var fb := PackedByteArray()
		fb.resize(16)
		fb.encode_s64(0, file_base)
		fb.encode_s64(8, dir_offset)
		ok = _store(f, fb)
	var length := int(f.get_length())
	f.close()
	if not ok or length != dir_offset + 4 + recs.size():
		DirAccess.remove_absolute(path)
		return ERR_FILE_CANT_WRITE
	return OK


## Append a trailer to the existing file at `path` (A6 §5, `expose_private`): a PCK header whose
## file base wraps to the start of the file (`-start`), so each entry's offset is absolute, then a
## directory exposing `entries` ([{path, offset, size}], ranges of the file) under their private
## names. Returns {ok, start (where the trailer begins: the file's size before), error}. The
## caller mounts `path` at `start` and truncates back with `truncate(path, start)` afterwards.
static func append_trailer(path: String, entries: Array, version: int) -> Dictionary:
	if version < 3:
		return {"ok": false, "start": -1, "error": ERR_UNAVAILABLE}
	var f := FileAccess.open(path, FileAccess.READ_WRITE)
	if f == null:
		return {"ok": false, "start": -1, "error": FileAccess.get_open_error()}
	f.seek_end()
	var start := int(f.get_position())
	var recs := PackedByteArray()
	var head := PackedByteArray()
	head.resize(4)
	head.encode_u32(0, entries.size())
	recs.append_array(head)
	for e in entries:
		recs.append_array(_record(e["path"], int(e["offset"]), int(e["size"]), 0))
	var ok := _store(f, _header(version, -start, HEADER_V3)) and _store(f, recs)
	var length := int(f.get_length())
	f.close()
	if not ok or length != start + HEADER_V3 + recs.size():
		truncate(path, start)
		return {"ok": false, "start": start, "error": ERR_FILE_CANT_WRITE}
	return {"ok": true, "start": start, "error": OK}


## Truncate `path` back to `size` bytes; true when the file then is exactly `size` long.
static func truncate(path: String, size: int) -> bool:
	var f := FileAccess.open(path, FileAccess.READ_WRITE)
	if f == null:
		return false
	var e := f.resize(size)
	f.close()
	if e != OK:
		return false
	var g := FileAccess.open(path, FileAccess.READ)
	if g == null:
		return false
	var n := int(g.get_length())
	g.close()
	return n == size


## Mount a pack. `offset` must be below 2^31 (the C++ parameter is a 32-bit int, A6 §2.7).
static func mount(path: String, replace := true, offset := 0) -> bool:
	if offset < 0 or offset >= 2147483648:
		return false
	return ProjectSettings.load_resource_pack(path, replace, offset)
