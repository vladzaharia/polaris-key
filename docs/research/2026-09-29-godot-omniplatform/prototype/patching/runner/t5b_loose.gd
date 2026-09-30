class_name T5bLoose
extends SceneTree
func _init() -> void:
	for l in preload("res://loose_tests.gd").run(OS.get_cmdline_user_args()[0] if OS.get_cmdline_user_args().size() else ""):
		print(l)
	quit()
