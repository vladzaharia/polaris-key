extends RefCounted
## Shared helpers for the patching experiments (pure GDScript, no GDExtension).

const MAGIC := 0x43504447
const F_ENC := 1
const F_REMOVAL := 2
const F_DELTA := 4

static func now_ms() -> float:
	return Time.get_ticks_usec() / 1000.0

static func sha256(b: PackedByteArray) -> String:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update(b)
	return h.finish().hex_encode()

## Stream a byte range of a file through SHA-256 (1 MiB chunks).
static func sha256_range(path: String, ofs: int, size: int, chunk := 1 << 20) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	f.seek(ofs)
	var left := size
	while left > 0:
		var n := mini(chunk, left)
		h.update(f.get_buffer(n))
		left -= n
	return h.finish().hex_encode()

static func sha256_file(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	return sha256_range(path, 0, f.get_length())

## Parse a PCK directory (v2/v3/v4, unencrypted) straight from disk. Offsets returned are absolute.
static func read_pck_dir(path: String, base := 0) -> Dictionary:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return {}
	f.seek(base)
	if f.get_32() != MAGIC:
		return {}
	var version := f.get_32()
	var engine := [f.get_32(), f.get_32(), f.get_32()]
	var flags := f.get_32()
	var file_base := f.get_64() + base
	var dir_off := f.get_64() + base
	f.seek(dir_off)
	var count := f.get_32()
	var entries := []
	for i in count:
		var sl := f.get_32()
		var p := f.get_buffer(sl).get_string_from_utf8()
		var ofs := f.get_64()
		var size := f.get_64()
		var md5 := f.get_buffer(16)
		var fl := f.get_32()
		entries.append({"path": p, "ofs": file_base + ofs, "size": size, "md5": md5, "flags": fl})
	return {"version": version, "engine": engine, "flags": flags, "file_base": file_base, "dir_off": dir_off, "entries": entries}


## Minimal PCK v4 writer (same layout as the editor's exporter: 16-byte alignment, header 104 B).
class PckWriter:
	var f: FileAccess
	var align := 16
	var file_base := 0
	var recs := []
	var md5 := true

	func begin(path: String, p_align := 16) -> Error:
		align = p_align
		f = FileAccess.open(path, FileAccess.WRITE)
		if f == null:
			return FileAccess.get_open_error()
		f.store_32(MAGIC); f.store_32(4); f.store_32(4); f.store_32(7); f.store_32(2)
		f.store_32(2) # PACK_REL_FILEBASE
		f.store_64(0); f.store_64(0)
		for i in 16:
			f.store_32(0)
		_pad(align)
		file_base = f.get_position()
		return OK

	func _pad(a: int) -> void:
		var r := f.get_position() % a
		if r:
			f.store_buffer(_zeros(a - r))

	static func _zeros(n: int) -> PackedByteArray:
		var z := PackedByteArray()
		z.resize(n)
		return z

	func add(path: String, data: PackedByteArray, flags := 0) -> void:
		var o := f.get_position()
		f.store_buffer(data)
		_pad(align)
		var h := PackedByteArray()
		if md5 and not (flags & F_REMOVAL):
			var hc := HashingContext.new()
			hc.start(HashingContext.HASH_MD5)
			hc.update(data)
			h = hc.finish()
		else:
			h = _zeros(16)
		recs.append([path, o - file_base, data.size(), h, flags])

	## Copy a byte range from another file without materialising it all (chunked).
	func add_copy(path: String, src: FileAccess, ofs: int, size: int, md5_hex := "", chunk := 1 << 20) -> void:
		var o := f.get_position()
		src.seek(ofs)
		var left := size
		while left > 0:
			var n := mini(chunk, left)
			f.store_buffer(src.get_buffer(n))
			left -= n
		_pad(align)
		recs.append([path, o - file_base, size, md5_hex.hex_decode() if md5_hex != "" else _zeros(16), 0])

	func add_removal(path: String) -> void:
		recs.append([path, f.get_position() - file_base, 0, _zeros(16), F_REMOVAL])

	## Raw directory entry (used for self-reference / wrap-around experiments).
	func add_entry(path: String, rel_ofs: int, size: int, flags := 0) -> void:
		recs.append([path, rel_ofs, size, _zeros(16), flags])

	func finish(sort_dir := true) -> int:
		_pad(align)
		var dir_off := f.get_position()
		if sort_dir:
			recs.sort_custom(func(a, b): return a[0] < b[0])
		f.store_32(recs.size())
		for r in recs:
			var pb: PackedByteArray = r[0].to_utf8_buffer()
			var pad := (4 - pb.size() % 4) % 4
			f.store_32(pb.size() + pad)
			f.store_buffer(pb)
			if pad:
				f.store_buffer(_zeros(pad))
			f.store_64(r[1]); f.store_64(r[2]); f.store_buffer(r[3]); f.store_32(r[4])
		var end := f.get_position()
		f.seek(24)
		f.store_64(file_base)
		f.store_64(dir_off)
		f.close()
		return end


## Source paths (as a game would load them) derived from a manifest's pack paths.
static func source_paths(files: Dictionary) -> Array:
	var out := []
	for p: String in files.keys():
		if p.ends_with(".csv.import"):
			continue
		if p.ends_with(".import"):
			out.append(p.trim_suffix(".import"))
		elif p.ends_with(".remap"):
			if not p.ends_with(".gd.remap"):
				out.append(p.trim_suffix(".remap"))
		elif p.ends_with(".json") or p.ends_with(".po") or p.ends_with(".translation"):
			out.append(p)
	out.sort()
	return out

## Load a resource the normal way and reduce it to a content fingerprint.
static func fingerprint(path: String) -> String:
	var rp := "res://" + path
	if path.ends_with(".json"):
		var b := FileAccess.get_file_as_bytes(rp)
		return "json:" + sha256(b) if b.size() else "MISSING"
	var r = ResourceLoader.load(rp, "", ResourceLoader.CACHE_MODE_IGNORE)
	if r == null:
		return "MISSING"
	if r is Texture2D:
		var img: Image = r.get_image()
		return "tex:%dx%d:%s" % [img.get_width(), img.get_height(), sha256(img.get_data())]
	if r is AudioStreamWAV:
		return "wav:" + sha256(r.data)
	if r is AudioStreamOggVorbis:
		return "ogg:%.3f:%s" % [r.get_length(), sha256(var_to_bytes(r.packet_sequence.packet_data))]
	if r is FontFile:
		return "font:" + sha256(r.data)
	if r is Translation:
		var msgs: PackedStringArray = r.get_translated_message_list()
		return "tr:%d:%s" % [msgs.size(), sha256(var_to_bytes(msgs))]
	if r is PackedScene:
		var n: Node = r.instantiate()
		var parts := []
		for c in [n] + n.get_children():
			parts.append("%s/%s/%s/%s" % [c.name, c.get_class(), c.get("position"), c.get("texture").resource_path if c.get("texture") else ""])
		n.free()
		return "scn:" + sha256(";".join(parts).to_utf8_buffer())
	if r is StandardMaterial3D:
		return "mat:%s:%s:%s" % [r.albedo_color, r.roughness, r.metallic]
	return "res:" + sha256(var_to_bytes(r.get_meta_list().map(func(k): return r.get_meta(k))))
