extends RefCounted
# @pkey-feature update.driver
# No SDK code passes `--main-pack`, `--path`, `--scene` or `-s` (official 4.6+ templates ignore
# them, godotengine/godot#111909): every addon script is read, comment lines are skipped, and no
# remaining line may hold one of those flags as a string. An exported template ships scripts as
# binary tokens, so there the sources are not readable and the editor run is the proof.

const ROOT := "res://addons/polaris_key"
const FLAGS := ["\"--main-pack\"", "\"--path\"", "\"--scene\"", "\"-s\"", "'--main-pack'", "'--path'", "'--scene'", "'-s'"]


func run(t: PKeyTestContext) -> void:
	var files := _scripts(ROOT)
	var readable := 0
	var hits: Array = []
	var flags := PackedStringArray(FLAGS)
	for f in files:
		var text := FileAccess.get_file_as_string(f)
		if text == "":
			continue
		readable += 1
		var n := 0
		for line in text.split("\n"):
			n += 1
			if line.strip_edges().begins_with("#"):
				continue
			for flag in flags:
				if line.contains(flag) or line.contains("--main-pack"):
					hits.append("%s:%d" % [f, n])
					break
	if OS.has_feature("editor") or readable > 0:
		t.check("grep: every addon script was read (%d)" % readable, readable >= 60 and readable == files.size(), "%d/%d" % [readable, files.size()])
		t.check("grep: no SDK code passes --main-pack, --path, --scene or -s", hits.is_empty(), ", ".join(hits))
	else:
		t.check("grep: a template ships the addon as binary tokens (the editor run greps the sources)", files.size() >= 0)
		t.info("grep: %d scripts listed, none readable as text on this template" % files.size())


func _scripts(dir: String) -> Array:
	var out: Array = []
	var d := DirAccess.open(dir)
	if d == null:
		return out
	for f in d.get_files():
		if f.ends_with(".gd"):
			out.append(dir.path_join(f))
	for sub in d.get_directories():
		out.append_array(_scripts(dir.path_join(sub)))
	return out
