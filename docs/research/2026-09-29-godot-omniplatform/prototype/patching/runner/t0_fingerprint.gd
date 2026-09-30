class_name T0Fp
extends SceneTree
## Mount the given packs (in order, replace_files per flag) and dump fingerprints of every source path in a manifest.
## args: out_json manifest_json pack1[:noreplace] pack2 ...
const L = preload("res://lib.gd")
func _init() -> void:
	var a := OS.get_cmdline_user_args()
	var man: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(a[1]))
	for i in range(2, a.size()):
		var spec: String = a[i]
		var rep := not spec.ends_with(":noreplace")
		var p := spec.trim_suffix(":noreplace")
		var t := L.now_ms()
		var ok := ProjectSettings.load_resource_pack(p, rep)
		print("mount %s replace=%s ok=%s %.1f ms" % [p.get_file(), rep, ok, L.now_ms() - t])
	var out := {}
	var t0 := L.now_ms()
	for sp in L.source_paths(man.files):
		out[sp] = L.fingerprint(sp)
	print("fingerprinted %d paths in %.0f ms" % [out.size(), L.now_ms() - t0])
	# raw byte check of every file the manifest lists (exercises delta decode for patched entries)
	var t1 := L.now_ms()
	var bad := []
	var nbytes := 0
	for p: String in man.files.keys():
		var b := FileAccess.get_file_as_bytes("res://" + p)
		nbytes += b.size()
		if L.sha256(b) != man.files[p].sha256:
			bad.append(p)
	print("raw check: %d/%d files byte-identical to manifest, %.1f MB read in %.0f ms; mismatched: %s" % [man.files.size() - bad.size(), man.files.size(), nbytes / 1048576.0, L.now_ms() - t1, bad])
	var f := FileAccess.open(a[0], FileAccess.WRITE)
	f.store_string(JSON.stringify(out, " ", true))
	quit()
