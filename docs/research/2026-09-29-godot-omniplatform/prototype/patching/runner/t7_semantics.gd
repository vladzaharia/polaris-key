class_name T7Semantics
extends SceneTree
## Mount semantics probes (one case per process: there is no unmount).
## args: case [extra...]
const L = preload("res://lib.gd")
const P := "user://packs/"

func rd(p: String) -> String:
	if not FileAccess.file_exists("res://" + p):
		return "<absent>"
	var b := FileAccess.get_file_as_bytes("res://" + p)
	return b.get_string_from_utf8() if b.size() else "<unreadable:%s>" % error_string(FileAccess.get_open_error())

func sem() -> String:
	return "x=%s onlyA=%s onlyB=%s" % [rd("sem/x.json"), rd("sem/onlyA.json"), rd("sem/onlyB.json")]

func check(man_path: String) -> String:
	var man: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(man_path))
	var ok := 0
	for p: String in man.files.keys():
		if L.sha256(FileAccess.get_file_as_bytes("res://" + p)) == man.files[p].sha256:
			ok += 1
	return "%d/%d match %s" % [ok, man.files.size(), man_path.get_file()]

func tex_hash(t: Texture2D) -> String:
	return L.sha256(t.get_image().get_data()).left(12)

func _init() -> void:
	var a := OS.get_cmdline_user_args()
	var c: String = a[0]
	match c:
		"pck_true", "pck_false", "zip_true", "zip_false":
			var ext := c.get_slice("_", 0)
			var rep := c.ends_with("true")
			ProjectSettings.load_resource_pack(P + "A." + ext, true)
			ProjectSettings.load_resource_pack(P + "B." + ext, rep)
			print("%s: A then B(replace=%s): %s" % [c, rep, sem()])
		"removal_false":
			ProjectSettings.load_resource_pack(P + "A.pck", true)
			ProjectSettings.load_resource_pack(P + "Brm.pck", false)
			print("%s: A then Brm(replace=false, has removal entry for onlyA): %s" % [c, sem()])
		"inplace":
			var live := P + "live.pck"
			DirAccess.copy_absolute(P + "v1.pck", live)
			ProjectSettings.load_resource_pack(live, true)
			var tex: Texture2D = load("res://assets/tex1024/t1024_03.png")
			print("inplace: v1 mounted: %s; tex %s" % [check(a[1]), tex_hash(tex)])
			DirAccess.copy_absolute(P + "v2.pck", live)   # overwrite the mounted file with the new version
			print("inplace: after overwriting file (no remount): %s ; %s" % [check(a[2]), check(a[1])])
			var t2 = ResourceLoader.load("res://assets/tex1024/t1024_07.png", "", ResourceLoader.CACHE_MODE_IGNORE)
			print("inplace: fresh load of an untouched-before texture after overwrite: %s" % [t2])
			ProjectSettings.load_resource_pack(live, true)
			print("inplace: after re-mounting same path: %s ; removed-in-v2 file level_119.json -> %s" % [check(a[2]), rd("assets/data/level_119.json").left(20)])
		"newpath":
			ProjectSettings.load_resource_pack(P + "v1.pck", true)
			var tex: Texture2D = load("res://assets/tex1024/t1024_03.png")
			var mat: StandardMaterial3D = load("res://assets/materials/mat_04.tres")
			var h1 := tex_hash(tex)
			print("newpath: v1 tex=%s mat.roughness=%.3f" % [h1, mat.roughness])
			var t := L.now_ms()
			ProjectSettings.load_resource_pack(P + "v2.pck", true)
			print("newpath: mounted v2 at a new path in %.1f ms: %s" % [L.now_ms() - t, check(a[2])])
			var r_reuse: Texture2D = load("res://assets/tex1024/t1024_03.png")
			print("newpath: load() (CACHE_MODE_REUSE) same object=%s hash=%s (v1 was %s)" % [r_reuse == tex, tex_hash(r_reuse), h1])
			var r_ign: Texture2D = ResourceLoader.load("res://assets/tex1024/t1024_03.png", "", ResourceLoader.CACHE_MODE_IGNORE)
			print("newpath: CACHE_MODE_IGNORE new object hash=%s" % tex_hash(r_ign))
			var r_rep: Texture2D = ResourceLoader.load("res://assets/tex1024/t1024_03.png", "", ResourceLoader.CACHE_MODE_REPLACE)
			print("newpath: CACHE_MODE_REPLACE same object=%s; held v1 reference now hash=%s" % [r_rep == tex, tex_hash(tex)])
			var m2: StandardMaterial3D = ResourceLoader.load("res://assets/materials/mat_04.tres", "", ResourceLoader.CACHE_MODE_REPLACE)
			print("newpath: material REPLACE same object=%s held ref roughness=%.3f" % [m2 == mat, mat.roughness])
			print("newpath: removed-in-v2 level_119.json still visible: %s ; icon_100.png loads: %s" % [rd("assets/data/level_119.json").left(12), load("res://assets/icons/icon_100.png") != null])
			DirAccess.remove_absolute(ProjectSettings.globalize_path(P + "v1_copy_unused")) # no-op
		"container":
			var off := a[3].split(" ")
			var t := L.now_ms()
			var ok1 := ProjectSettings.load_resource_pack(P + "container.bin", true, int(off[0]))
			var ok2 := ProjectSettings.load_resource_pack(P + "container.bin", true, int(off[1]))
			print("container: mount v1@%s=%s, v2_delta@%s=%s (%.1f ms): %s" % [off[0], ok1, off[1], ok2, L.now_ms() - t, check(a[2])])
		"sparse":
			var ok := ProjectSettings.load_resource_pack(P + "sparse.bin", true, 2200000000)
			print("sparse: mount at offset 2200000000 -> %s; %s" % [ok, sem()])
		"zip_offset":
			var ok := ProjectSettings.load_resource_pack(P + "A.zip", true, 16)
			print("zip_offset: %s" % ok)
	quit()
