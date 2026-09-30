class_name T7cUid
extends SceneTree
func _init() -> void:
	var a := OS.get_cmdline_user_args()
	for i in range(0, a.size()):
		ProjectSettings.load_resource_pack(a[i], true)
	print("uid new-in-v2 (uid://bkrkmjj8ew4gh) -> ", ResourceUID.get_id_path(ResourceUID.text_to_id("uid://bkrkmjj8ew4gh")) if ResourceUID.has_id(ResourceUID.text_to_id("uid://bkrkmjj8ew4gh")) else "unregistered", " load=", load("uid://bkrkmjj8ew4gh") != null)
	print("uid v1 (uid://db264eybucxx8) -> ", ResourceUID.has_id(ResourceUID.text_to_id("uid://db264eybucxx8")))
	quit()
