extends SceneTree
## UID registration vs replace_files. args: pack[:noreplace] ...
func _init() -> void:
	for spec in OS.get_cmdline_user_args():
		var rep: bool = not spec.ends_with(":noreplace")
		print("mount ", spec, " -> ", ProjectSettings.load_resource_pack(spec.trim_suffix(":noreplace"), rep))
	var id := ResourceUID.text_to_id("uid://bkrkmjj8ew4gh")
	print("  icon_110 (new in v2) uid registered=", ResourceUID.has_id(id), " file exists=", FileAccess.file_exists("res://assets/icons/icon_110.png.import"))
	var id1 := ResourceUID.text_to_id("uid://db264eybucxx8")
	print("  t1024_03 (v1) uid registered=", ResourceUID.has_id(id1))
	quit()
