extends RefCounted
# Every addon script loads, on the editor and in an exported pack (where scripts may be remapped),
# and the autoload is registered.

const ROOT := "res://addons/polaris_key"


func run(t: PKeyTestContext) -> void:
	var scripts := _scripts(ROOT)
	t.check("load: the addon has scripts", scripts.size() >= 25, "%d found" % scripts.size())
	for path in scripts:
		var s = load(path)
		t.check("load: %s" % path.trim_prefix(ROOT + "/"), s is GDScript and (s as GDScript).can_instantiate())
	var tree := Engine.get_main_loop() as SceneTree
	var pk := tree.root.get_node_or_null("PolarisKey")
	t.check("load: the PolarisKey autoload is registered", pk != null and pk.get_script() != null \
			and pk.get_script().resource_path == "res://addons/polaris_key/polaris_key.gd")


static func _scripts(dir: String) -> PackedStringArray:
	var out := PackedStringArray()
	var d := DirAccess.open(dir)
	if d == null:
		return out
	for f in d.get_files():
		var name := f.trim_suffix(".remap")
		if name.ends_with(".gd") and not name.ends_with("plugin.gd") and not out.has(dir.path_join(name)):
			out.append(dir.path_join(name))
	for sub in d.get_directories():
		out.append_array(_scripts(dir.path_join(sub)))
	return out
