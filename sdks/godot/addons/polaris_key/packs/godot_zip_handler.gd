class_name PKeyGodotZipHandler
extends PKeyPackHandler
## `godot.zip` (CONTENT §4.2; P4-16): a zip Godot mounts with load_resource_pack, a container,
## activated at the next boot (`restart`), format version 1. Tolerated, not preferred: a zip
## cannot express removals, ignores replace_files and cannot be mounted at an offset; accept one
## only when a third party requires it.
##
## Before the rebuilt zip commits (its whole SHA-256 already equals the record's), and again
## before every mount, read_directory() reads the zip from its bytes and refuses
## (`pck-directory-refused`, with the entry's path) anything but a plain stored archive:
##
##   - the end record must close the file (no archive comment, so nothing can trail it: Godot's
##     PCK source looks for a `GDPC` magic at the END of any file it is asked to mount, and a
##     comment ending in one would mount as a PCK past this check), no ZIP64, one disk, the
##     central directory right before the end record, the first local header at byte 0;
##   - every entry STORED (method 0, compressed size = size), not encrypted, without a data
##     descriptor, its local header agreeing with the central one (name, flags, method, sizes),
##     its bytes inside the file and before the central directory, no two entries overlapping;
##   - every path normal (PKeyPck.path_ok) and named once (PKeyPackFiles.check_paths); directory
##     entries (`name/`, size 0) are skipped;
##
## then the godot.pck admission list (PKeyPck.directory_check over `handler.prefixes`): no
## script, native library, project.binary, class cache, out-of-prefix entry or resource that
## embeds code. A zip has no engine header: `requires.engine` is the record's claim only.
##
## A committed zip is stored as `store/<sha256>.zip` (Godot's ZIP source opens only `.zip` and
## `.pcz` paths; PKeyPackStorage names a container by its leading bytes) and mounted by
## PolarisKey.update.packs.mount() with the godot.pck packs: in mountOrder, after the first
## frame, never twice in a process.

const MAX_ENTRIES := 20000
const _EOCD := 0x06054b50
const _CDH := 0x02014b50
const _LFH := 0x04034b50
const _ZIP64_LOCATOR := 0x07064b50
const _SCAN_CHUNK := 1 << 20

## The packs this boot runs, by id (mounted by PolarisKey.update.packs.mount()).
var to_mount := {}
## Pack ids mounted in this process.
var mounted := {}


func _init() -> void:
	type = "godot.zip"
	layout = "container"
	activation = "restart"


func supports(format_version: int) -> bool:
	return format_version == 1


static func _refuse(detail: String, path := "") -> Dictionary:
	return {"ok": false, "code": PKeyPck.DIRECTORY_REFUSED, "detail": detail, "path": path}


## The directory of a stored zip read through `source`: {ok, header: {}, entries: [{rawPath,
## path, offset (of the entry's bytes), size, md5: "", flags: 0}]} in central-directory order,
## or {ok: false, code, detail, path}.
static func read_directory(source: PKeyByteSource) -> Dictionary:
	var n := source.size
	if n < 22:
		return _refuse("not a zip (shorter than its end record)")
	var eocd := source.read(n - 22, 22)
	if eocd.size() != 22 or eocd.decode_u32(0) != _EOCD:
		return _refuse("the zip's end record does not close the file (an archive comment or trailing bytes)")
	if eocd.decode_u16(20) != 0:
		return _refuse("the zip has an archive comment")
	# minizip looks for a ZIP64 locator in the 20 bytes before the end record first, and would
	# read a hidden ZIP64 directory instead of the one judged here.
	if n >= 42:
		var loc := source.read(n - 42, 4)
		if loc.size() == 4 and loc.decode_u32(0) == _ZIP64_LOCATOR:
			return _refuse("a ZIP64 end-of-central-directory locator")
	var disk := eocd.decode_u16(4)
	var cd_disk := eocd.decode_u16(6)
	var here := eocd.decode_u16(8)
	var count := eocd.decode_u16(10)
	var cd_size := eocd.decode_u32(12)
	var cd_at := eocd.decode_u32(16)
	if count == 0xFFFF or cd_size == 0xFFFFFFFF or cd_at == 0xFFFFFFFF:
		return _refuse("a ZIP64 archive")
	if disk != 0 or cd_disk != 0 or here != count:
		return _refuse("a multi-disk archive")
	if count > MAX_ENTRIES:
		return _refuse("%d entries; a pack is at most %d (the mount stall grows with the entry count, S-05 §4.1)" % [count, MAX_ENTRIES])
	if cd_at + cd_size != n - 22:
		return _refuse("the central directory does not end at the end record")
	if count == 0:
		return _refuse("an empty zip")
	var head := source.read(0, 4)
	if head.size() != 4 or head.decode_u32(0) != _LFH:
		return _refuse("the zip does not start with a local header")
	# Godot tries its PCK source before the ZIP source whatever the extension, and that source
	# looks for `GDPC` at the start, at the end and (in a self-contained export) at the embedded
	# PCK offset of the file it opens: no `GDPC` may appear anywhere in a godot.zip.
	var gdpc := _gdpc_at(source)
	if gdpc >= 0:
		return _refuse("the bytes `GDPC` (a Godot PCK magic) at offset %d; Godot's PCK source could mount it as a PCK" % gdpc)
	var cd := source.read(cd_at, cd_size)
	if cd.size() != cd_size:
		return _refuse("the central directory cannot be read")
	var p := 0
	var entries: Array = []
	var spans: Array = []
	for i in count:
		if p + 46 > cd.size() or cd.decode_u32(p) != _CDH:
			return _refuse("the central directory does not parse")
		var flags := cd.decode_u16(p + 8)
		var method := cd.decode_u16(p + 10)
		var csize := cd.decode_u32(p + 20)
		var usize := cd.decode_u32(p + 24)
		var nlen := cd.decode_u16(p + 28)
		var xlen := cd.decode_u16(p + 30)
		var clen := cd.decode_u16(p + 32)
		var disk_start := cd.decode_u16(p + 34)
		var local := cd.decode_u32(p + 42)
		if p + 46 + nlen + xlen + clen > cd.size():
			return _refuse("the central directory runs past its end")
		if clen != 0:
			return _refuse("an entry comment", cd.slice(p + 46, p + 46 + nlen).get_string_from_utf8())
		var name_bytes := cd.slice(p + 46, p + 46 + nlen)
		p += 46 + nlen + xlen + clen
		var name := name_bytes.get_string_from_utf8()
		if name.to_utf8_buffer() != name_bytes or name == "":
			return _refuse("an entry name is not UTF-8")
		var is_dir := name.ends_with("/")
		var path := name.trim_suffix("/") if is_dir else name
		if csize == 0xFFFFFFFF or usize == 0xFFFFFFFF or local == 0xFFFFFFFF:
			return _refuse("a ZIP64 entry", path)
		if disk_start != 0:
			return _refuse("a multi-disk entry", path)
		if flags & 0x41:
			return _refuse("an encrypted entry", path)
		if flags & 0x08:
			return _refuse("an entry with a data descriptor", path)
		if method != 0:
			return _refuse("a compressed entry (method %d); a godot.zip stores every entry" % method, path)
		if csize != usize:
			return _refuse("a stored entry whose sizes differ", path)
		if not PKeyPck.path_ok(path):
			return _refuse("an unsafe path (a `..`, `.` or empty segment, or a character the path rules refuse)", path)
		if is_dir and usize != 0:
			return _refuse("a directory entry with bytes", path)
		var lh := source.read(local, 30)
		if lh.size() != 30 or lh.decode_u32(0) != _LFH:
			return _refuse("its local header cannot be read", path)
		var lnlen := lh.decode_u16(26)
		var lxlen := lh.decode_u16(28)
		if lh.decode_u16(6) != flags or lh.decode_u16(8) != method or lh.decode_u32(18) != csize or lh.decode_u32(22) != usize or lnlen != nlen:
			return _refuse("its local header disagrees with the central directory", path)
		if source.read(local + 30, lnlen) != name_bytes:
			return _refuse("its local header names another file", path)
		var data_at := local + 30 + lnlen + lxlen
		if data_at + usize > cd_at:
			return _refuse("its bytes run past the central directory", path)
		spans.append([local, data_at + usize, path])
		if not is_dir:
			entries.append({"rawPath": name, "path": path, "offset": data_at, "size": usize, "md5": "", "flags": 0})
	if p != cd.size():
		return _refuse("the central directory has trailing bytes")
	spans.sort_custom(func(a, b): return a[0] < b[0])
	for k in range(1, spans.size()):
		if spans[k][0] < spans[k - 1][1]:
			return _refuse("two entries overlap", spans[k][2])
	var paths: Array = []
	for e in entries:
		paths.append(e["path"])
	var pc := PKeyPackFiles.check_paths(paths)
	if not pc["ok"]:
		return _refuse("a path the zip names twice (%s)" % pc["error"], String(pc["path"]))
	return {"ok": true, "header": {}, "entries": entries}


## The first offset of `GDPC` in `source`, or -1: read in 1 MiB windows overlapping by 3
## bytes, each hex-encoded once and searched natively (a hit at an odd hex offset straddles two
## bytes and is skipped), so the work stays linear whatever the bytes are.
static func _gdpc_at(source: PKeyByteSource) -> int:
	var at := 0
	while at < source.size:
		var chunk := source.read(at, mini(_SCAN_CHUNK, source.size - at))
		if chunk.is_empty():
			return -1
		var hex := chunk.hex_encode()
		var i := hex.find("47445043")
		while i >= 0 and i % 2 == 1:
			i = hex.find("47445043", i + 1)
		if i >= 0:
			return at + i / 2
		if at + chunk.size() >= source.size:
			return -1
		at += chunk.size() - 3
	return -1


static func _prefixes(record: Dictionary) -> Array:
	var h = record.get("handler")
	if h is Dictionary and h.get("prefixes") is Array:
		return h["prefixes"]
	return []


## The zip and admission checks over a pack's bytes: {ok, count, warning} or {ok: false, code,
## detail, path}. Thread-safe (call PKeyPck.warm() on the main thread first).
static func check(source: PKeyByteSource, record: Dictionary, _variant: Dictionary) -> Dictionary:
	var dir := read_directory(source)
	if not dir["ok"]:
		return dir
	var c := PKeyPck.directory_check(source, dir, _prefixes(record))
	if not c["ok"]:
		var first: Dictionary = c["errors"][0]
		var lines := PackedStringArray()
		for e in c["errors"]:
			lines.append("%s: %s" % [e["path"], e["why"]])
		return {"ok": false, "code": PKeyPck.DIRECTORY_REFUSED, "detail": "; ".join(lines), "path": first["path"]}
	return {"ok": true, "count": c["count"], "warning": c["warning"]}


func check_output(source: PKeyByteSource, record: Dictionary, variant: Dictionary) -> Dictionary:
	return check(source, record, variant)


func activate(install: Dictionary) -> void:
	to_mount[install["packId"]] = install


## A revoked install not yet mounted leaves this boot's mount.
func withdraw(install: Dictionary) -> void:
	var cur = to_mount.get(install["packId"])
	if cur is Dictionary and cur["recordSha256"] == install["recordSha256"] and not mounted.has(install["packId"]):
		to_mount.erase(install["packId"])


## A restart install may join this boot while its id has not been mounted in this process.
func can_activate_now(install: Dictionary) -> bool:
	return not mounted.has(install["packId"])
