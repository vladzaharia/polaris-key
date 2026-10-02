extends RefCounted
# @pkey-feature packs.handlers
# S-05 §4.6's f_uid case on the device (brief acceptance): two data packs built independently of
# this project (tests/fixtures/uid_packs/dataA, dataB; run_tests.sh imports and exports them with
# --export-pack into PKEY_UID_PACKS) are refused as exported (they carry `project.binary` and the
# class cache), admitted once stripped, and, mounted with replace_files=true, resolve their own
# `uid://` references and this project's (`uid://s05mainbase1`, tests/packs/uid_main_base.tres),
# while ProjectSettings.get_global_class_list() is unchanged. Runs on the editor and on the
# exported release template alike.

const S := preload("res://tests/packs/support.gd")
const MAIN_UID := "uid://s05mainbase1"


## The export without the two entries --export-pack always adds (the publish strip step), written
## by this engine: the entries copied byte for byte.
static func _stripped(src: PackedByteArray, dest: String) -> bool:
	var dir := PKeyPck.read_directory(PKeyByteSource.memory(src))
	if not dir["ok"]:
		return false
	var entries: Array = []
	for e in dir["entries"]:
		if e["path"] == PKeyPck.STRIP_PROJECT_BINARY or e["path"] == PKeyPck.STRIP_CLASS_CACHE:
			continue
		entries.append({"path": e["rawPath"], "bytes": src.slice(int(e["offset"]), int(e["offset"]) + int(e["size"])), "flags": 0})
	return PKeyPck.write(dest, entries, PKeyPck.helper_version()) == OK


## The paths a pack's `.godot/uid_cache.bin` names (u32 count; per entry an i64 id, a u32 length
## and the path).
static func _uid_cache_paths(pck: String) -> PackedStringArray:
	var src := PKeyByteSource.file(pck)
	var dir := PKeyPck.read_directory(src)
	var out := PackedStringArray()
	if not dir["ok"]:
		return out
	for e in dir["entries"]:
		if e["path"] != PKeyPck.UID_CACHE:
			continue
		var b := src.read(int(e["offset"]), int(e["size"]))
		var n := b.decode_u32(0)
		var p := 4
		for i in n:
			var ln := b.decode_u32(p + 8)
			out.append(b.slice(p + 12, p + 12 + ln).get_string_from_utf8())
			p += 12 + ln
	return out


static func _uid(text: String) -> Dictionary:
	var id := ResourceUID.text_to_id(text)
	var has := ResourceUID.has_id(id)
	return {"has": has, "path": ResourceUID.get_id_path(id) if has else ""}


func run(t: PKeyTestContext) -> void:
	var dir := OS.get_environment("PKEY_UID_PACKS")
	if not t.check("uid: PKEY_UID_PACKS names the exported data packs (run_tests.sh builds them)", dir != "" and FileAccess.file_exists(dir.path_join("dataA.pck")) and FileAccess.file_exists(dir.path_join("dataB.pck")), dir):
		return
	var classes_before := ProjectSettings.get_global_class_list().size()
	var main_before := _uid(MAIN_UID)
	t.check("uid: this project's own uid:// resolves before any mount", main_before["has"] and main_before["path"] == "res://tests/packs/uid_main_base.tres", S.canon(main_before))
	var scratch := S.scratch("uid")
	for name in ["A", "B"]:
		var x := String(name).to_lower()
		var raw := FileAccess.get_file_as_bytes(dir.path_join("data%s.pck" % name))
		var prefixes := ["res://packs/%s/" % x]
		var c := PKeyGodotPckHandler.check(PKeyByteSource.memory(raw), {"handler": {"prefixes": prefixes}}, {})
		t.check("uid: data%s as exported is refused (it still carries project.binary or the class cache)" % name, not c["ok"] and c["code"] == PKeyPck.DIRECTORY_REFUSED and (c.get("path") == PKeyPck.STRIP_PROJECT_BINARY or c.get("path") == PKeyPck.STRIP_CLASS_CACHE), S.canon(c))
		var stripped := scratch.path_join("data%s.pck" % name)
		t.check("uid: data%s stripped" % name, _stripped(raw, stripped))
		var c2 := PKeyGodotPckHandler.check(PKeyByteSource.file(stripped), {"handler": {"prefixes": prefixes}}, {})
		t.check("uid: data%s stripped is admitted (in-prefix remaps, the exported files they name, uid_cache.bin)" % name, c2["ok"], S.canon(c2))
	# A 4.4/4.5 exporter writes the WHOLE project's uid cache into a pack, excluded files included
	# (here the data project's stub of this project's resource); 4.6+ writes only what it exports.
	var foreign := PackedStringArray()
	for name in ["A", "B"]:
		for path in _uid_cache_paths(scratch.path_join("data%s.pck" % name)):
			if not path.begins_with("res://packs/%s/" % String(name).to_lower()):
				foreign.append(path)
	for name in ["A", "B"]:
		t.check("uid: data%s mounts with replace_files=true" % name, PKeyPck.mount(scratch.path_join("data%s.pck" % name), true))
	t.check("uid: get_global_class_list() is unchanged", ProjectSettings.get_global_class_list().size() == classes_before, "%d → %d" % [classes_before, ProjectSettings.get_global_class_list().size()])
	var main_after := _uid(MAIN_UID)
	var whole_cache := not foreign.is_empty()
	if whole_cache:
		# Measured on the 4.4.1 floor: its exporter writes the WHOLE project's uid cache into a pack
		# (here the data project's excluded stub of this project's resource; 4.7.2 writes only what
		# it exports), and mounting with replace_files=true then points this project's shared UID
		# at the stub. Packs exported by such an editor must not share a UID with the main project.
		t.info("uid: this %s export's uid_cache.bin also names %s" % [Engine.get_version_info().string, ", ".join(foreign)])
		t.check("uid: …so on this engine the main project's shared UID follows the pack's stub (measured)", main_after["has"] and foreign.has(main_after["path"]), S.canon(main_after))
	else:
		t.check("uid: this project's uid:// still resolves to its own file", main_after["has"] and main_after["path"] == "res://tests/packs/uid_main_base.tres", S.canon(main_after))
	for x in ["a", "b"]:
		var res := _uid("uid://s05data%sres1" % x)
		var scn := _uid("uid://s05data%sscn1" % x)
		t.check("uid: pack %s's own uid:// references register" % x, res["has"] and res["path"] == "res://packs/%s/thing.tres" % x and scn["has"] and scn["path"] == "res://packs/%s/scene.tscn" % x, "%s %s" % [S.canon(res), S.canon(scn)])
		if whole_cache:
			continue
		var thing = load("uid://s05data%sres1" % x)
		var by_uid = thing.get_meta("main_by_uid_only", null) if thing != null else null
		var by_both = thing.get_meta("main_by_uid_and_path", null) if thing != null else null
		t.check("uid: pack %s's resource loads by uid:// and reaches this project's resource by uid alone" % x, thing != null and thing.get_meta("tag", "") == "data-%s" % x and by_uid != null and by_uid.get_meta("tag", "") == "main" and by_both != null and by_both.get_meta("tag", "") == "main")
		var scene = load("uid://s05data%sscn1" % x)
		t.check("uid: pack %s's scene instantiates" % x, scene is PackedScene and (scene as PackedScene).can_instantiate())
	S.remove_tree(scratch)
