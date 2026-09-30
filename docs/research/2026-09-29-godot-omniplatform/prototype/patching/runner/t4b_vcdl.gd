class_name T4bVcdl
extends SceneTree
## Pure-GDScript VCDIFF-lite applier: zstd (no dictionary) + COPY/ADD ops. args: old patch out expected_sha
const L = preload("res://lib.gd")
func _init() -> void:
	var a := OS.get_cmdline_user_args()
	var t := L.now_ms()
	var pf := FileAccess.get_file_as_bytes(a[1])
	var raw_len := pf.decode_u64(0)
	var raw := pf.slice(8).decompress(raw_len, FileAccess.COMPRESSION_ZSTD)
	var t_dec := L.now_ms() - t
	assert(raw.slice(0, 4).get_string_from_ascii() == "VCDL")
	var nops := raw.decode_u32(4)
	var new_len := raw.decode_u64(8)
	var lits_len := raw.decode_u64(16)
	var op := 24
	var lit := 24 + nops * 13
	t = L.now_ms()
	var src := FileAccess.open(a[0], FileAccess.READ)
	var out := FileAccess.open(a[2], FileAccess.WRITE)
	for i in nops:
		var kind := raw[op]
		var n := raw.decode_u32(op + 9)
		if kind == 0:
			src.seek(raw.decode_u64(op + 1))
			out.store_buffer(src.get_buffer(n))
		else:
			out.store_buffer(raw.slice(lit, lit + n))
			lit += n
		op += 13
	out.close()
	var t_apply := L.now_ms() - t
	t = L.now_ms()
	var ok := L.sha256_file(a[2]) == a[3]
	var t_sha := L.now_ms() - t
	print("vcdl: ops=%d out=%.1fMB decompress %.0f ms, apply %.0f ms (%.0f MB/s), sha256 %.0f ms, sha_ok=%s" % [nops, new_len / 1048576.0, t_dec, t_apply, new_len / 1048576.0 / (t_apply / 1000.0), t_sha, ok])
	quit()
