extends SceneTree
## After mounting the given packs (spec[:noreplace]), are the files removed in v2 still visible? Also: can a user:// directory be mounted?
func _init() -> void:
	for spec in OS.get_cmdline_user_args():
		print("  mount %s -> %s" % [spec.get_file(), ProjectSettings.load_resource_pack(spec.trim_suffix(":noreplace"), not spec.ends_with(":noreplace"))])
	var vis := []
	for p in ["assets/data/level_119.json", "assets/icons/icon_100.png.import", "assets/tex512/t512_39.png.import"]:
		vis.append("%s=%s" % [p.get_file(), FileAccess.file_exists("res://" + p)])
	print("  removed-in-v2 visible: ", ", ".join(vis))
	quit()
