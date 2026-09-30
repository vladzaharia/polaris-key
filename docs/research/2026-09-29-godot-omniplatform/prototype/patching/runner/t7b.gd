extends SceneTree
const L = preload("res://lib.gd")
func _init() -> void:
	print("sparse2: offset 2100000000 -> ", ProjectSettings.load_resource_pack("user://packs/sparse2.bin", true, 2100000000), " x=", FileAccess.get_file_as_string("res://sem/x.json"))
	ProjectSettings.load_resource_pack("user://packs/v1.pck", true)
	var tex: Texture2D = load("res://assets/tex1024/t1024_03.png")
	var h1 := L.sha256(tex.get_image().get_data()).left(12)
	ProjectSettings.load_resource_pack("user://packs/v2.pck", true)
	var r: Texture2D = ResourceLoader.load("res://assets/tex1024/t1024_03.png", "", ResourceLoader.CACHE_MODE_REPLACE_DEEP)
	print("tex REPLACE_DEEP same=", r == tex, " held=", L.sha256(tex.get_image().get_data()).left(12), " v1=", h1, " returned=", L.sha256(r.get_image().get_data()).left(12))
	# the imported .ctex is the real resource behind the .png remap
	var ctex: Texture2D = ResourceLoader.load("res://.godot/imported/t1024_03.png-8a9ac9148b29bec6ecba01a56274bb69.s3tc.ctex", "", ResourceLoader.CACHE_MODE_REPLACE)
	print("ctex path REPLACE same=", ctex == tex, " held=", L.sha256(tex.get_image().get_data()).left(12))
	quit()
