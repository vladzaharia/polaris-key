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
		# The sources are not text here, so prove what is shipped instead: the addon's scripts are
		# in the pack as compiled tokens, and the updater's scripts load from them.
		var compiled := _scripts(ROOT, PackedStringArray([".gdc", ".gd.remap"]))
		var loads := true
		for path in ["updater/sidecar_swap.gd", "updater/updater_env.gd", "updater/boot_guard.gd", "distribution/outlets/appimage.gd"]:
			loads = loads and load(ROOT.path_join(path)) is GDScript
		t.check("grep: on a template the addon ships as compiled scripts (the editor run greps the sources), and the updater's load", compiled.size() >= 60 and loads, "%d compiled, loads=%s" % [compiled.size(), loads])


func _scripts(dir: String, suffixes := PackedStringArray([".gd"])) -> Array:
	var out: Array = []
	var d := DirAccess.open(dir)
	if d == null:
		return out
	for f in d.get_files():
		for suffix in suffixes:
			if f.ends_with(suffix):
				out.append(dir.path_join(f))
				break
	for sub in d.get_directories():
		out.append_array(_scripts(dir.path_join(sub), suffixes))
	return out
