class_name PKeyUpdaterEnv
extends RefCounted
## Every side effect the updater performs outside its own files (P3-10): where the executable is,
## the environment, opening a link, restarting, running AppImageUpdate, reloading a web page.
## The real runtime by default; the tests replace it with a recording fake whose executable sits
## in a scratch directory, so the swap, the restart and every hand-off are exercised without
## leaving the test process.
##
## Never passes `--main-pack`, `--path`, `--scene` or `-s`: official 4.6+ templates ignore them
## (godotengine/godot#111909), so a restart relaunches the same executable with the arguments
## this process got, and the engine loads `<exe-name>.pck` beside it.


## The OS family (`windows`, `linux`, `macos`, `ios`, `android`, `web`).
func platform() -> String:
	return PKeyHeaders.platform()


## OS.get_executable_path(), `/`-separated on every platform (Windows too).
func executable_path() -> String:
	return OS.get_executable_path()


func env(name: String) -> String:
	return OS.get_environment(name)


func file_exists(path: String) -> bool:
	return FileAccess.file_exists(path)


func dir_exists(path: String) -> bool:
	return DirAccess.dir_exists_absolute(path)


func has_feature(tag: String) -> bool:
	return OS.has_feature(tag)


## True where nothing may act on a decision unless a caller enables it: the editor, a headless
## run (the test runner, a dedicated server) and a debug build, as Diceroll's updater is inert.
func inert() -> bool:
	return OS.has_feature("editor") or DisplayServer.get_name() == "headless" or OS.is_debug_build()


## Open `url` with the system handler. The updater calls this only with an https URL.
func shell_open(url: String) -> int:
	return OS.shell_open(url)


## Restart this executable with the arguments it got, after the main loop quits.
func restart() -> void:
	var args := OS.get_cmdline_args()
	var user := OS.get_cmdline_user_args()
	if not user.is_empty():
		args.append("--")
		args.append_array(user)
	OS.set_restart_on_exit(true, args)
	quit()


## Start `path` detached (an AppImage relaunch), then quit this process.
func relaunch(path: String) -> int:
	var args := OS.get_cmdline_args()
	var pid := OS.create_process(path, args)
	if pid > 0:
		quit()
	return pid


func quit() -> void:
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null:
		tree.quit()


## Run `path` with `args` and wait: the exit code (-1 when it could not start). Call it off the
## main thread for anything slow.
func execute(path: String, args: PackedStringArray) -> int:
	return OS.execute(path, args, [], false)


## The first executable called `name` in an ABSOLUTE PATH entry, or "".
func find_program(name: String) -> String:
	var sep := ";" if platform() == "windows" else ":"
	for dir in env("PATH").split(sep, false):
		# A relative entry (`.`, `bin`) would run whatever sits in the working directory.
		if not dir.is_absolute_path():
			continue
		var p := dir.path_join(name)
		if FileAccess.file_exists(p):
			return p
		if platform() == "windows" and FileAccess.file_exists(p + ".exe"):
			return p + ".exe"
	return ""


## Reload the page (web exports: the platform outlet's "reload" action).
func reload_web() -> bool:
	if not OS.has_feature("web") or not Engine.has_singleton("JavaScriptBridge"):
		return false
	Engine.get_singleton("JavaScriptBridge").eval("window.location.reload()", true)
	return true


## A native updater plugin's singleton (P5-07), or null when the plugin is not installed.
func native_singleton(name: String) -> Object:
	return Engine.get_singleton(name) if Engine.has_singleton(name) else null
