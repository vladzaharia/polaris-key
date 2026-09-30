extends SceneTree
func _init() -> void:
	var z := FileAccess.get_file_as_bytes(OS.get_cmdline_user_args()[0])
	var out := z.decompress_dynamic(-1, FileAccess.COMPRESSION_ZSTD)
	print("decompress_dynamic on a --patch-from frame: size=", out.size())
	var out2 := z.decompress(37697544, FileAccess.COMPRESSION_ZSTD)
	print("decompress(known size) on a --patch-from frame: size=", out2.size())
	quit()
