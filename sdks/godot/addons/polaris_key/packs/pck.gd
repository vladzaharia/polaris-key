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
##   directory_check(source, dir, prefixes)  {ok, errors: [{path, why}], count}: the admission list
##   embedded_code(path, data)           why a resource carries code, or ""
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

static var _helper_version := -1
static var _res: Dictionary = {}
## The engine's script kinds (P4-08 audit GAP 5), filled on the main thread by `warm()`:
## {exts: {extension: true}, markers: PackedStringArray}.
static var _kinds: Dictionary = {}


static func _re(pattern: String) -> RegEx:
	var re = _res.get(pattern)
	if re == null:
		re = RegEx.create_from_string(pattern)
		_res[pattern] = re
	return re


## Compile every pattern and read the engine's script kinds on the main thread before a worker
## runs the directory check.
static func warm() -> void:
	for p in [_SCRIPT, _NATIVE, _NATIVE_DIR, _TEXT_RES, _BINARY_RES, _GD_HEAD, _PATH_ANY, _PATH_LINE, _DEST_LINE, _QUOTED]:
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
static func lint_lines(source: PKeyByteSource, dir: Dictionary, prefixes: Array, requires_engine: Variant) -> PackedStringArray:
	var out := PackedStringArray()
	var why := requires_check(dir["header"], requires_engine)
	if why != "":
		out.append(why)
	var c := directory_check(source, dir, prefixes)
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
	if find_bytes(data, PackedByteArray([0xEF, 0xBB, 0xBF])) != -1:
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
## same rules and wording, hardened by the P4-08 audit): an `RSCC` (compressed) resource under any
## name; an `RSRC` resource whose bytes name a script marker anywhere (`_binary_code`); a text
## resource (a `[gd_scene`/`[gd_resource` head, or a `.tscn`/`.tres`/`.escn` name) that fails the
## content rule (`_text_code`); a `.scn`/`.res`/exported file that is neither. Fails closed.
static func embedded_code(p: String, data: PackedByteArray) -> String:
	# By CONTENT first: Godot's binary loader takes `.material`, `.mesh`, `.anim` and every other
	# binary resource extension, so the extension never decides whether bytes are scanned.
	var magic := data.slice(0, 4).get_string_from_ascii() if data.size() >= 4 else ""
	if magic == "RSCC":
		return "a compressed binary resource (RSCC), which cannot be inspected for embedded scripts; export it uncompressed"
	if magic == "RSRC":
		return _binary_code(data)
	if sniffs_text_resource(data):
		return _text_code(data)
	if _re(_TEXT_RES).search(p) != null:
		return _text_code(data)
	if _re(_BINARY_RES).search(p) != null or p.begins_with(".godot/exported/"):
		return "not a Godot resource (no RSRC header), so it cannot be inspected for embedded scripts"
	return ""


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


static func _without_backslashes(data: PackedByteArray) -> PackedByteArray:
	var out := PackedByteArray()
	var start := 0
	var at := data.find(0x5C)
	while at != -1:
		out.append_array(data.slice(start, at))
		start = at + 1
		at = data.find(0x5C, start)
	out.append_array(data.slice(start))
	return out


## The first script marker (in `script_markers()` order, then the engine's extra Script classes)
## whose UTF-8 bytes occur anywhere in `data`, or "".
static func _marker(data: PackedByteArray) -> String:
	for s in (_script_kinds()["markers"] as PackedStringArray):
		if find_bytes(data, s.to_utf8_buffer()) != -1:
			return s
	return ""


## The first index of `needle` in `hay`, or -1 (native `find` on the needle's first byte, then a
## slice compare).
static func find_bytes(hay: PackedByteArray, needle: PackedByteArray) -> int:
	if needle.is_empty() or needle.size() > hay.size():
		return -1
	var first := needle[0]
	var last := hay.size() - needle.size()
	var at := hay.find(first, 0)
	while at != -1 and at <= last:
		if hay.slice(at, at + needle.size()) == needle:
			return at
		at = hay.find(first, at + 1)
	return -1


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
	if find_bytes(data, PackedByteArray([0x5C, 0x75])) != -1 or find_bytes(data, PackedByteArray([0x5C, 0x55])) != -1:
		return "a text resource with a \\u escape, which can spell a script type"
	return ""


## The admission list (notes/S-05 §5 (f); P4-03's `lintPck`), over a directory `read_directory`
## returned and the bytes behind it. A `godot.pck` payload may contain only (1) entries under one
## of `prefixes` (`res://…/`), including their `.remap` and `.import` files; (2) the
## `.godot/exported/…` and `.godot/imported/…` files those in-prefix files point to; (3)
## `.godot/uid_cache.bin`. Every admitted resource must carry no code (`embedded_code`).
## Everything else is refused with its path — `project.binary`, the class cache, scripts (and a
## `.remap` that points to one), native libraries and `.gdextension` files, an out-of-prefix
## path, an exported or imported file nothing in the pack names. Returns {ok, errors: [{path,
## why}], count, warning}.
static func directory_check(source: PKeyByteSource, dir: Dictionary, prefixes: Array) -> Dictionary:
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
	var in_pack := {}
	for e in entries:
		in_pack[e["path"]] = true
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
		var code := embedded_code(p, data) if scanned else ""
		if code != "":
			errors.append({"path": p, "why": "%s; a pack carries data only." % code})
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
				var code := embedded_code(p, PKeyByteSource.read_all(src))
				if code != "":
					why = "%s; a pack carries data only." % code
		if why != "":
			return {"ok": false, "code": DIRECTORY_REFUSED, "detail": "%s: %s" % [p, why], "path": p}
	return {"ok": true}


## The PCK format version this engine reads and writes (what PCKPacker produces), probed once.
## 0 when it cannot be determined.
static func helper_version() -> int:
	if _helper_version >= 0:
		return _helper_version
	_helper_version = 0
	var dir := "user://pkey/tmp"
	DirAccess.make_dir_recursive_absolute(dir)
	var path := dir.path_join("pck-version-probe.pck")
	var packer := PCKPacker.new()
	if packer.pck_start(path) == OK and packer.flush() == OK:
		var f := FileAccess.open(path, FileAccess.READ)
		if f != null:
			var head := f.get_buffer(8)
			f.close()
			if head.size() == 8 and head.decode_u32(0) == MAGIC:
				_helper_version = head.decode_u32(4)
	DirAccess.remove_absolute(path)
	return _helper_version


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
