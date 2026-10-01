class_name PKTestRunner
extends SceneTree
# The prototype's spike-probe harness. The verifier and its suites (sha512, ed25519, jws, profile)
# moved to sdks/godot in P1-01; run them there:
#   godot --headless --path sdks/godot -- --pkey-test <suite>
#
# Editor:   godot --headless --path . --script res://tests/cli.gd -- <suite> [args...]
# Exported: ./pkey.x86_64 --headless -- <suite> [args...]   (project main_loop_type = PKTestRunner;
#           official 4.7 templates refuse --path / --main-pack / --script)
# <suite> is one of: platform (the default) | outlet (S-06), or a probe suite another spike adds.

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var which: String = args[0] if args.size() > 0 else "platform"
	print("runner: %s build, engine %s, suite=%s" % ["debug" if OS.is_debug_build() else "release", Engine.get_version_info().string, which])
	var path := "res://tests/suite_%s.gd" % which
	if not ResourceLoader.exists(path):
		print("suite %s moved to sdks/godot (P1-01): godot --headless --path sdks/godot -- --pkey-test %s" % [which, which])
		quit(1)
		return
	var suite = load(path).new()
	suite.run(args.slice(1))
	quit()
