class_name T2bBake
extends SceneTree
## "Bake" a native delta patch: mount base + delta patch, stream every v2 file through res:// (engine applies
## the deltas) into a fresh exporter-identical PCK, verify the whole-pack sha256. args: base patch manifest out
const L = preload("res://lib.gd")
func _init() -> void:
	var a := OS.get_cmdline_user_args()
	var man: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(a[2]))
	var t := L.now_ms()
	ProjectSettings.load_resource_pack(a[0], true)
	ProjectSettings.load_resource_pack(a[1], true)
	var t_mount := L.now_ms() - t
	var paths: Array = man.files.keys()
	paths.sort_custom(func(x, y): return man.files[x].ofs < man.files[y].ofs)
	t = L.now_ms()
	var w := L.PckWriter.new()
	w.begin(a[3], 16)
	for p: String in paths:
		w.add(p, FileAccess.get_file_as_bytes("res://" + p))
	w.finish(true)
	var t_build := L.now_ms() - t
	t = L.now_ms()
	var ok: bool = L.sha256_file(a[3]) == man.pack_sha256
	print("bake: mount %.1f ms, build %.0f ms, sha256 %.0f ms, byte-identical to CI v2.pck: %s" % [t_mount, t_build, L.now_ms() - t, ok])
	quit()
