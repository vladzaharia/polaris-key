class_name T2Rebuild
extends SceneTree
## Client-side rebuild of a complete v2 PCK from: old v1 PCK on disk + v2 manifest + downloaded changed blobs.
## args: old_pck manifest_json dl_dir out_pck method
##   method = packer      : PCKPacker, unchanged bytes read from the old PCK by offset (own directory parser)
##            packer_res  : PCKPacker, unchanged bytes read through res:// after mounting the old PCK
##            writer      : GDScript PCK writer, chunked copy by offset, exporter-identical layout
const L = preload("res://lib.gd")

func _init() -> void:
	var a := OS.get_cmdline_user_args()
	var old_pck: String = a[0]
	var man: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(a[1]))
	var dl: String = a[2]
	var out: String = a[3]
	var method: String = a[4]
	var T := {}
	var t := L.now_ms()
	# 1. index the old pack by content hash. The client keeps a sidecar manifest per installed pack
	#    (path -> sha256) written when the pack was verified; here we recompute it once and time it.
	var old := L.read_pck_dir(old_pck)
	T.parse_dir = L.now_ms() - t
	t = L.now_ms()
	var by_md5 := {}   # md5 of old entries (from the PCK directory, free) -> entry
	for e in old.entries:
		by_md5[e.md5.hex_encode()] = e
	T.index = L.now_ms() - t
	if method == "packer_res":
		t = L.now_ms()
		ProjectSettings.load_resource_pack(old_pck, true)
		T.mount_old = L.now_ms() - t
	# 2. order = v2 data order (by offset in the canonical v2 pack), so the result can be byte-identical
	var paths: Array = man.files.keys()
	paths.sort_custom(func(x, y): return man.files[x].ofs < man.files[y].ofs)
	t = L.now_ms()
	var src := FileAccess.open(old_pck, FileAccess.READ)
	var reused := 0
	var fetched := 0
	var packer: PCKPacker
	var w: L.PckWriter
	if method == "writer":
		w = L.PckWriter.new()
		w.md5 = false
		w.begin(out, 16)
	else:
		packer = PCKPacker.new()
		packer.pck_start(out, 16)
	for p: String in paths:
		var fe: Dictionary = man.files[p]
		var oe = by_md5.get(fe.md5)   # md5 match -> candidate; confirmed by sha256 at the end (whole-pack or per file)
		if oe != null and oe.size == fe.size:
			reused += fe.size
			if method == "writer":
				w.add_copy(p, src, oe.ofs, oe.size, fe.md5)
			elif method == "packer_res":
				packer.add_file_from_buffer(p, FileAccess.get_file_as_bytes("res://" + oe.path))
			else:
				src.seek(oe.ofs)
				packer.add_file_from_buffer(p, src.get_buffer(oe.size))
		else:
			var blob: String = dl.path_join(fe.sha256)
			if not FileAccess.file_exists(blob):
				push_error("missing blob for " + p)
				quit(1)
				return
			fetched += fe.size
			if method == "writer":
				var bf := FileAccess.open(blob, FileAccess.READ)
				w.add_copy(p, bf, 0, fe.size, fe.md5)
			else:
				packer.add_file(p, blob)
	if method == "writer":
		w.finish(true)
	else:
		packer.flush()
	T.build = L.now_ms() - t
	# 3. verify: whole-pack sha256 (only meaningful if the layout is canonical) + per-file sha256 via own parser
	t = L.now_ms()
	var whole := L.sha256_file(out)
	T.whole_sha = L.now_ms() - t
	t = L.now_ms()
	var rebuilt := L.read_pck_dir(out)
	var bad := 0
	var rf := FileAccess.open(out, FileAccess.READ)
	for e in rebuilt.entries:
		rf.seek(e.ofs)
		if L.sha256(rf.get_buffer(e.size)) != man.files[e.path].sha256:
			bad += 1
	T.per_file_sha = L.now_ms() - t
	var size := FileAccess.open(out, FileAccess.READ).get_length()
	print("method=%s files=%d reused=%.1fMB fetched=%.1fMB out=%d bytes whole_sha_match=%s per_file_bad=%d" % [method, paths.size(), reused / 1048576.0, fetched / 1048576.0, size, whole == man.pack_sha256, bad])
	var parts := []
	for k in T:
		parts.append("%s=%.0fms" % [k, T[k]])
	print("  timings: " + ", ".join(parts))
	quit()
