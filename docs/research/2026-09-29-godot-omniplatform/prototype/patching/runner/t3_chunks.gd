class_name T3Chunks
extends SceneTree
## Reassemble v2.pck from local v1.pck chunks + downloaded missing chunks, SHA-256 verified per chunk.
## args: old_pck v1_recipe v2_recipe chunk_dir out_path expected_sha256
const L = preload("res://lib.gd")
func _init() -> void:
	var a := OS.get_cmdline_user_args()
	var t := L.now_ms()
	var r1: Array = JSON.parse_string(FileAccess.get_file_as_string(a[1]))
	var r2: Array = JSON.parse_string(FileAccess.get_file_as_string(a[2]))
	var idx := {}
	for c in r1:
		idx[c.sha256] = c
	var t_parse := L.now_ms() - t
	t = L.now_ms()
	var src := FileAccess.open(a[0], FileAccess.READ)
	var out := FileAccess.open(a[4], FileAccess.WRITE)
	var whole := HashingContext.new()
	whole.start(HashingContext.HASH_SHA256)
	var local := 0
	var remote := 0
	var bad := 0
	for c in r2:
		var buf: PackedByteArray
		var lc = idx.get(c.sha256)
		if lc != null:
			src.seek(int(lc.ofs))
			buf = src.get_buffer(int(lc.size))
			local += buf.size()
		else:
			buf = FileAccess.get_file_as_bytes(a[3].path_join(c.sha256))
			remote += buf.size()
		if L.sha256(buf) != c.sha256:
			bad += 1
		whole.update(buf)
		out.store_buffer(buf)
	out.close()
	var ms := L.now_ms() - t
	var total := local + remote
	print("chunks=%d local=%.1fMB remote=%.1fMB (%.1f%%) bad=%d whole_sha_ok=%s  recipe_parse=%.0fms assemble+verify=%.0fms => %.0f MB/s" % [r2.size(), local / 1048576.0, remote / 1048576.0, 100.0 * remote / total, bad, whole.finish().hex_encode() == a[5], t_parse, ms, total / 1048576.0 / (ms / 1000.0)])
	# pure-GDScript FastCDC cost (gear hash loop) on 2 MiB, to see whether a client could chunk without a recipe
	var gear := PackedInt64Array()
	gear.resize(256)
	var x := 0x9e3779b9
	for i in 256:
		x = x ^ ((x << 13) & 0xFFFFFFFF); x = x ^ (x >> 17); x = x ^ ((x << 5) & 0xFFFFFFFF)
		gear[i] = x
	src.seek(0)
	var data := src.get_buffer(2 << 20)
	t = L.now_ms()
	var h := 0
	var cuts := 0
	for i in data.size():
		h = ((h << 1) + gear[data[i]]) & 0xFFFFFFFF
		if (h & 0xFFFF0000) == 0:
			cuts += 1
	var cms := L.now_ms() - t
	print("GDScript gear-hash chunking: %.2f MB/s (%d cut points)" % [2.0 / (cms / 1000.0), cuts])
	quit()
