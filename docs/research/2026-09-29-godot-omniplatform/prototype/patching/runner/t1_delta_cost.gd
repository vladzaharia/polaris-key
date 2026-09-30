class_name T1DeltaCost
extends SceneTree
## Per-open cost of delta-patched entries vs plain entries. args: N pack1 [pack2...]
const L = preload("res://lib.gd")
func _init() -> void:
	var a := OS.get_cmdline_user_args()
	var n := int(a[0])
	for i in range(1, a.size()):
		ProjectSettings.load_resource_pack(a[i], true)
	for spec in [[".godot/imported/t2048_01.png-39a9de6f65138e1b537277ed15134b03.s3tc.ctex", "assets/tex2048/t2048_01.png"],
			[".godot/imported/t1024_03.png-8a9ac9148b29bec6ecba01a56274bb69.s3tc.ctex", "assets/tex1024/t1024_03.png"],
			[".godot/imported/t2048_00.png-225c07af1053769c2f5605bc2bad79ba.s3tc.ctex", "assets/tex2048/t2048_00.png"],
			["assets/data/level_005.json", ""]]:
		var t := L.now_ms()
		for k in n:
			var f := FileAccess.open("res://" + spec[0], FileAccess.READ)
			var b := f.get_buffer(f.get_length())
		var t_raw := (L.now_ms() - t) / n
		var t_load := 0.0
		if spec[1] != "":
			t = L.now_ms()
			for k in n:
				var r = ResourceLoader.load("res://" + spec[1], "", ResourceLoader.CACHE_MODE_IGNORE)
			t_load = (L.now_ms() - t) / n
		print("%-40s raw open+read %.2f ms   load() %.2f ms" % [spec[0].get_file().left(40), t_raw, t_load])
	print("static mem %.1f MB" % (OS.get_static_memory_usage() / 1048576.0))
	quit()
