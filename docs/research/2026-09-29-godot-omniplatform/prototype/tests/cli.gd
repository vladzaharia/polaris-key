class_name PKTestRunner
extends SceneTree
# Editor:   godot --headless --path . --script res://tests/cli.gd -- <suite> [args...]
# Exported: ./pkey.x86_64 --headless -- <suite> [args...]   (project main_loop_type = PKTestRunner;
#           official 4.7 templates refuse --path / --main-pack / --script)
# <suite> is one of: sha512 | ed25519 | jws | profile | platform

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var which: String = args[0] if args.size() > 0 else "ed25519"
	print("runner: %s build, engine %s, suite=%s" % ["debug" if OS.is_debug_build() else "release", Engine.get_version_info().string, which])
	var suite = load("res://tests/suite_%s.gd" % which).new()
	suite.run(args.slice(1))
	quit()
