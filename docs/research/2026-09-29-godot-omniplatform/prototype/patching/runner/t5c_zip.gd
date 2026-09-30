class_name T5cZip
extends SceneTree
## ZIPReader / ZIPPacker throughput. args: zip_deflate zip_stored src_pck
const L = preload("res://lib.gd")
func _init() -> void:
	var a := OS.get_cmdline_user_args()
	for z in [a[0], a[1]]:
		var r := ZIPReader.new()
		var t := L.now_ms()
		r.open(z)
		var files := r.get_files()
		var t_open := L.now_ms() - t
		t = L.now_ms()
		var n := 0
		for f in files:
			n += r.read_file(f).size()
		var ms := L.now_ms() - t
		t = L.now_ms()
		for f in files:
			var dst := "user://extract/" + f
			DirAccess.make_dir_recursive_absolute(dst.get_base_dir())
			var fo := FileAccess.open(dst, FileAccess.WRITE)
			fo.store_buffer(r.read_file(f))
		var ms_x := L.now_ms() - t
		print("ZIPReader %s: %d files, open %.1f ms, read %.1f MB in %.0f ms (%.0f MB/s), extract-to-user:// %.0f ms (%.0f MB/s)" % [z.get_file(), files.size(), t_open, n / 1048576.0, ms, n / 1048576.0 / (ms / 1000.0), ms_x, n / 1048576.0 / (ms_x / 1000.0)])
	var dir := L.read_pck_dir(a[2])
	var src := FileAccess.open(a[2], FileAccess.READ)
	for lvl in [0, 1, -1, 9]:
		var zp := ZIPPacker.new()
		zp.compression_level = lvl
		var out := "user://packs/zp_%d.zip" % lvl
		var t := L.now_ms()
		zp.open(out)
		var n := 0
		for e in dir.entries:
			zp.start_file(e.path)
			src.seek(e.ofs)
			zp.write_file(src.get_buffer(e.size))
			zp.close_file()
			n += e.size
		zp.close()
		var ms := L.now_ms() - t
		var size := FileAccess.open(out, FileAccess.READ).get_length()
		var ok := ProjectSettings.load_resource_pack(out, false)
		print("ZIPPacker level %d: %.1f MB in %.0f ms (%.1f MB/s) -> %d bytes; mountable=%s" % [lvl, n / 1048576.0, ms, n / 1048576.0 / (ms / 1000.0), size, ok])
	quit()
