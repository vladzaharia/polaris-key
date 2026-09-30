class_name T9PrivateBake
extends SceneTree
## Per-file zstd --patch-from deltas applied by the engine under a PRIVATE namespace, then baked into a full v2 PCK.
## 1) append a trailer PCK directory to the old pack that re-exposes every old entry as __pkey/base/<path>
## 2) mount it at the trailer offset (replace_files=false): live res:// paths are untouched
## 3) mount a GDDL delta PCK whose entries target __pkey/base/<path>
## 4) stream the new pack: unchanged entries copied by offset, changed ones read through res:// (engine decodes),
##    added ones from downloaded blobs; truncate the old pack back; verify whole-pack SHA-256.
## args: old_pck zd_dir list_json v2_manifest dl_dir out_pck
const L = preload("res://lib.gd")
const NS := "__pkey/base/"
func _init() -> void:
	var a := OS.get_cmdline_user_args()
	var old: String = a[0]
	var man: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(a[3]))
	var changed: Array = JSON.parse_string(FileAccess.get_file_as_string(a[2]))
	var T := {}
	var t := L.now_ms()
	var d := L.read_pck_dir(old)
	var by_path := {}
	for e in d.entries:
		by_path[e.path] = e
	var n := FileAccess.open(old, FileAccess.READ).get_length()
	# 1) trailer
	var f := FileAccess.open(old, FileAccess.READ_WRITE)
	f.seek_end()
	var start := f.get_position()
	var hdr := StreamPeerBuffer.new()
	f.store_32(L.MAGIC); f.store_32(4); f.store_32(4); f.store_32(7); f.store_32(2); f.store_32(2)
	f.store_64(-start)   # file_base: start + (-start) == 0, so entry offsets are absolute
	f.store_64(104)      # directory right after the 104-byte header
	for i in 16:
		f.store_32(0)
	f.store_32(d.entries.size())
	for e in d.entries:
		var pb: PackedByteArray = (NS + e.path).to_utf8_buffer()
		var pad := (4 - pb.size() % 4) % 4
		f.store_32(pb.size() + pad); f.store_buffer(pb)
		if pad: f.store_buffer(L.PckWriter._zeros(pad))
		f.store_64(e.ofs); f.store_64(e.size); f.store_buffer(L.PckWriter._zeros(16)); f.store_32(0)
	f.close()
	T.trailer = L.now_ms() - t
	t = L.now_ms()
	var ok1 := ProjectSettings.load_resource_pack(old, false, start)
	# 3) delta pck targeting the private paths
	var w := L.PckWriter.new()
	w.begin("user://packs/priv_delta.pck")
	for p: String in changed:
		var z := FileAccess.get_file_as_bytes(a[1].path_join(man.files[p].sha256 + ".zst"))
		var g := "GDDL".to_ascii_buffer(); g.append(1); g.append_array(z)
		w.add(NS + p, g, L.F_DELTA)
	w.finish()
	var ok2 := ProjectSettings.load_resource_pack("user://packs/priv_delta.pck", false)
	T.mount = L.now_ms() - t
	# 4) bake
	t = L.now_ms()
	var paths: Array = man.files.keys()
	paths.sort_custom(func(x, y): return man.files[x].ofs < man.files[y].ofs)
	var src := FileAccess.open(old, FileAccess.READ)
	var out := L.PckWriter.new()
	out.begin(a[5], 16)
	var n_copy := 0
	var n_delta := 0
	var n_blob := 0
	for p: String in paths:
		var fe: Dictionary = man.files[p]
		var oe = by_path.get(p)
		if p in changed:
			out.add(p, FileAccess.get_file_as_bytes("res://" + NS + p)); n_delta += 1
		elif oe != null and oe.md5.hex_encode() == fe.md5 and oe.size == fe.size:
			out.add_copy(p, src, oe.ofs, oe.size, fe.md5); n_copy += 1
		else:
			out.add_copy(p, FileAccess.open(a[4].path_join(fe.sha256), FileAccess.READ), 0, fe.size, fe.md5); n_blob += 1
	out.finish(true)
	src = null
	T.bake = L.now_ms() - t
	# restore the old pack byte-for-byte
	var g := FileAccess.open(old, FileAccess.READ_WRITE)
	g.resize(n)
	g.close()
	t = L.now_ms()
	var sha_ok: bool = L.sha256_file(a[5]) == man.pack_sha256
	T.sha = L.now_ms() - t
	print("private bake: trailer mount=%s delta mount=%s | copied %d, engine-decoded %d, blobs %d | whole sha256 == CI v2.pck: %s" % [ok1, ok2, n_copy, n_delta, n_blob, sha_ok])
	print("  live namespace untouched: res://assets/data/level_005.json exists=%s; private path exists=%s" % [FileAccess.file_exists("res://assets/data/level_005.json"), FileAccess.file_exists("res://" + NS + "assets/data/level_005.json")])
	var parts := []
	for k in T:
		parts.append("%s=%.0fms" % [k, T[k]])
	print("  timings: " + ", ".join(parts) + "; old pack restored to %d bytes" % FileAccess.open(old, FileAccess.READ).get_length())
	quit()
