class_name FProbe
extends SceneTree
## S-05 (f): UID resolution and class_name globals across independently built packs.
## args: pack[:noreplace] ...   (absolute paths, mounted in order)
## Prints one "S05F|key|value" line per observation.

const UIDS := {
	"main_base": "uid://s05mainbase1",
	"a_res": "uid://s05dataares1",
	"a_scn": "uid://s05dataascn1",
	"b_res": "uid://s05databres1",
	"b_scn": "uid://s05databscn1",
	"c_res": "uid://s05datacres1",
}


func out(k: String, v) -> void:
	print("S05F|%s|%s" % [k, str(v)])


func uid_state(tag: String) -> void:
	for k: String in UIDS.keys():
		var id := ResourceUID.text_to_id(UIDS[k])
		var reg := ResourceUID.has_id(id)
		out("%s.uid.%s" % [tag, k], "%s -> %s" % [reg, ResourceUID.get_id_path(id) if reg else "-"])


func class_state(tag: String) -> void:
	var names := []
	for c: Dictionary in ProjectSettings.get_global_class_list():
		names.append(c["class"])
	names.sort()
	out(tag + ".ProjectSettings.get_global_class_list", "%d %s" % [names.size(), names])
	# Compile a fresh script that names class_name globals (resolution goes through ScriptServer).
	for cls in ["MainA", "MainE", "PackClass"]:
		var s := GDScript.new()
		s.source_code = "extends RefCounted\nfunc t():\n\treturn %s.new().tag()\n" % cls
		var err := s.reload()
		var val = s.new().t() if err == OK else "-"
		out("%s.compile_uses_%s" % [tag, cls], "%s %s" % [error_string(err), val])


func pack_files(tag: String) -> void:
	for p in ["res://.godot/uid_cache.bin", "res://.godot/global_script_class_cache.cfg", "res://project.binary", "res://main_res/base.tres"]:
		if FileAccess.file_exists(p):
			var b := FileAccess.get_file_as_bytes(p)
			out("%s.file.%s" % [tag, p], "%d B md5=%s" % [b.size(), FileAccess.get_md5(p).left(8)])
		else:
			out("%s.file.%s" % [tag, p], "absent")
	var base = load("res://main_res/base.tres")
	out(tag + ".main_base.tag", base.get_meta("tag") if base else "null")


func _init() -> void:
	out("engine", Engine.get_version_info().string)
	out("args", OS.get_cmdline_user_args())
	uid_state("before")
	class_state("before")
	pack_files("before")
	for spec: String in OS.get_cmdline_user_args():
		var rep := not spec.ends_with(":noreplace")
		var path := spec.trim_suffix(":noreplace")
		var t := Time.get_ticks_usec()
		var ok := ProjectSettings.load_resource_pack(path, rep)
		out("mount", "%s replace=%s -> %s (%.2f ms)" % [path.get_file(), rep, ok, (Time.get_ticks_usec() - t) / 1000.0])
	uid_state("after")
	class_state("after")
	pack_files("after")
	for x in ["a", "b"]:
		var r = load("uid://s05data%sres1" % x)
		if r == null:
			r = load("res://packs/%s/thing.tres" % x)
			out("after.%s.thing" % x, "loaded by path only" if r else "missing")
		if r:
			var m1 = r.get_meta("main_by_uid_and_path", null)
			var m2 = r.get_meta("main_by_uid_only", null)
			out("after.%s.thing.main_by_uid_and_path" % x, m1.get_meta("tag") if m1 else "null")
			out("after.%s.thing.main_by_uid_only" % x, m2.get_meta("tag") if m2 else "null")
		var ps = load("uid://s05data%sscn1" % x)
		if ps:
			var n: Node = ps.instantiate()
			var th = n.get_meta("thing", null)
			out("after.%s.scene_by_uid" % x, "%s thing=%s" % [n.name, th.get_meta("tag") if th else "null"])
			n.free()
		else:
			out("after.%s.scene_by_uid" % x, "null")
	var late = load("res://scripts/late_user.gd")
	out("after.late_script_first_compiled_after_mounts", late.new().run() if late and late.can_instantiate() else "FAILED")
	quit()
