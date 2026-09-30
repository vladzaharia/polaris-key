class_name T4Delta
extends SceneTree
## Apply `zstd --patch-from` deltas from pure GDScript by wrapping them as PACK_FILE_DELTA entries
## (the engine's own 4.6+ delta decoder does the work at native speed).
## args: mode ...
##   files  <base_pck> <zd_dir> <list_json> <v2_manifest>            per-file deltas
##   whole  <base_pck> <patchfrom_zst> <out_pck> <expected_sha> copy|append
const L = preload("res://lib.gd")

static func gddl(zst: PackedByteArray) -> PackedByteArray:
	var b := "GDDL".to_ascii_buffer()
	b.append(1)
	b.append_array(zst)
	return b

func _init() -> void:
	var a := OS.get_cmdline_user_args()
	if a[0] == "files":
		_files(a)
	else:
		_whole(a)
	quit()

func _files(a: PackedStringArray) -> void:
	var man: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(a[4]))
	var list: Array = JSON.parse_string(FileAccess.get_file_as_string(a[3]))
	var t := L.now_ms()
	var w := L.PckWriter.new()
	w.begin("user://packs/dp_files.pck")
	for p: String in list:
		w.add(p, gddl(FileAccess.get_file_as_bytes(a[2].path_join(man.files[p].sha256 + ".zst"))), L.F_DELTA)
	w.finish()
	var t_build := L.now_ms() - t
	ProjectSettings.load_resource_pack(a[1], true)
	ProjectSettings.load_resource_pack("user://packs/dp_files.pck", false)  # deltas apply even with replace_files=false
	t = L.now_ms()
	var ok := 0
	for p: String in list:
		if L.sha256(FileAccess.get_file_as_bytes("res://" + p)) == man.files[p].sha256:
			ok += 1
	print("per-file: wrote delta pck (%d entries) in %.1f ms; %d/%d patched files byte-identical to v2; read+decode %.1f ms" % [list.size(), t_build, ok, list.size(), L.now_ms() - t])

func _whole(a: PackedStringArray) -> void:
	var base: String = a[1]
	var mode: String = a[5]
	var vpath := "__pkey_base/whole.bin"
	var n := FileAccess.open(base, FileAccess.READ).get_length()
	var mem0 := OS.get_static_memory_usage()
	var t := L.now_ms()
	var host: String
	if mode == "copy":
		# wrapper PCK = header + old bytes + 1-entry directory (streamed copy, constant memory)
		host = "user://packs/wrap_base.pck"
		var w := L.PckWriter.new()
		w.begin(host)
		w.add_copy(vpath, FileAccess.open(base, FileAccess.READ), 0, n)
		w.finish()
		ProjectSettings.load_resource_pack(host, false)
	else:
		# append a second PCK header+directory after the old pack's end; its single entry covers bytes [0, n)
		# via uint64 wrap-around of file_base. Mount at offset n. Truncate afterwards.
		host = base
		var f := FileAccess.open(host, FileAccess.READ_WRITE)
		f.seek_end()
		var start := f.get_position()
		f.store_32(L.MAGIC); f.store_32(4); f.store_32(4); f.store_32(7); f.store_32(2); f.store_32(2)
		f.store_64(-start)          # file_base (relative) -> start + (-start) == 0
		f.store_64(104)             # directory right after this 104-byte header
		for i in 16:
			f.store_32(0)
		f.store_32(1)
		var pb := vpath.to_utf8_buffer()
		f.store_32(pb.size()); f.store_buffer(pb)
		f.store_64(0); f.store_64(n); f.store_buffer(L.PckWriter._zeros(16)); f.store_32(0)
		f.close()
		print("  mount trailer at offset %d: %s" % [start, ProjectSettings.load_resource_pack(host, false, start)])
	var t_host := L.now_ms() - t
	t = L.now_ms()
	var dw := L.PckWriter.new()
	dw.begin("user://packs/whole_delta.pck")
	dw.add(vpath, gddl(FileAccess.get_file_as_bytes(a[2])), L.F_DELTA)
	dw.finish()
	ProjectSettings.load_resource_pack("user://packs/whole_delta.pck", false)
	var t_dpck := L.now_ms() - t
	t = L.now_ms()
	var src := FileAccess.open("res://" + vpath, FileAccess.READ)
	var len := src.get_length()      # triggers the decode (whole old file + delta -> memory)
	var t_decode := L.now_ms() - t
	var mem1 := OS.get_static_memory_usage()
	t = L.now_ms()
	var out := FileAccess.open(a[3], FileAccess.WRITE)
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	var left := len
	while left > 0:
		var c := src.get_buffer(mini(1 << 20, left))
		h.update(c)
		out.store_buffer(c)
		left -= c.size()
	out.close()
	src = null
	var ok := h.finish().hex_encode() == a[4]
	var t_write := L.now_ms() - t
	if mode == "append":
		var f := FileAccess.open(host, FileAccess.READ_WRITE)
		f.resize(n)
		f.close()
		print("  truncated base back to %d bytes; base sha256 restored: %s" % [n, L.sha256_file(host)])
	print("whole-pack (%s): out=%d bytes sha_ok=%s | host %.0f ms, delta pck %.1f ms, decode %.0f ms, write+sha %.0f ms | static mem during decode +%.0f MB" % [mode, len, ok, t_host, t_dpck, t_decode, t_write, (mem1 - mem0) / 1048576.0])
