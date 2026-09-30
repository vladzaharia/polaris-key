class_name T3bZChunks
extends SceneTree
## Like t3, but missing chunks arrive zstd-19 compressed (one frame per chunk): decompress(size, ZSTD) + SHA-256.
## Also: first-install cost (every chunk decompressed from the store) and raw SHA-256 / decompress throughput.
## args: old_pck v1_recipe v2_recipe zchunk_dir out_path expected_sha256 [full_store_dir]
const L = preload("res://lib.gd")
func _init() -> void:
	var a := OS.get_cmdline_user_args()
	var r1: Array = JSON.parse_string(FileAccess.get_file_as_string(a[1]))
	var r2: Array = JSON.parse_string(FileAccess.get_file_as_string(a[2]))
	var idx := {}
	for c in r1:
		idx[c.sha256] = c
	var t := L.now_ms()
	var src := FileAccess.open(a[0], FileAccess.READ)
	var out := FileAccess.open(a[4], FileAccess.WRITE)
	var whole := HashingContext.new()
	whole.start(HashingContext.HASH_SHA256)
	var local := 0
	var remote_z := 0
	var remote := 0
	var bad := 0
	var t_dec := 0.0
	for c in r2:
		var buf: PackedByteArray
		var lc = idx.get(c.sha256)
		if lc != null:
			src.seek(int(lc.ofs))
			buf = src.get_buffer(int(lc.size))
			local += buf.size()
		else:
			var z := FileAccess.get_file_as_bytes(a[3].path_join(c.sha256))
			remote_z += z.size()
			var td := L.now_ms()
			buf = z.decompress(int(c.size), FileAccess.COMPRESSION_ZSTD)
			t_dec += L.now_ms() - td
			remote += buf.size()
		if L.sha256(buf) != c.sha256:
			bad += 1
		whole.update(buf)
		out.store_buffer(buf)
	out.close()
	var ms := L.now_ms() - t
	print("zchunks: chunks=%d local=%.1fMB remote=%.2fMB (on the wire %.2fMB zstd) bad=%d whole_sha_ok=%s assemble+decompress+verify=%.0fms (decompress %.0fms) => %.0f MB/s" % [r2.size(), local / 1048576.0, remote / 1048576.0, remote_z / 1048576.0, bad, whole.finish().hex_encode() == a[5], ms, t_dec, (local + remote) / 1048576.0 / (ms / 1000.0)])
	# micro: SHA-256 and zstd decompress throughput on 64 KiB and 1 MiB buffers
	src.seek(0)
	var big := src.get_buffer(32 << 20)
	for bs: int in [65536, 1 << 20]:
		t = L.now_ms()
		var n := 0
		var o := 0
		while o + bs <= big.size():
			L.sha256(big.slice(o, o + bs))
			o += bs
			n += bs
		var sha_mbs := n / 1048576.0 / ((L.now_ms() - t) / 1000.0)
		var z := big.slice(0, bs).compress(FileAccess.COMPRESSION_ZSTD)
		t = L.now_ms()
		var reps: int = (8 << 20) / bs
		for i in reps:
			z.decompress(bs, FileAccess.COMPRESSION_ZSTD)
		var dec_mbs: float = reps * bs / 1048576.0 / ((L.now_ms() - t) / 1000.0)
		print("  block %7d: SHA-256 %.0f MB/s (incl. slice copy), zstd decompress %.0f MB/s" % [bs, sha_mbs, dec_mbs])
	quit()
