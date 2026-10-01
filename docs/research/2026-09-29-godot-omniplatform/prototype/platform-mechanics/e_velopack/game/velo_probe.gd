extends Node
## S-05 (e): what a Godot export sees when Velopack runs it as the main executable.
## Appends one JSON line per launch to $S05_VELO_LOG (default user://velo.log), and quits at once
## (from the autoload's _init) when the arguments carry a --veloapp-* hook.
## A normal launch also reports which pack files sit next to the executable, then quits after
## S05_RUN_SECONDS (default 1.5) so the harness can run it unattended.

var hooked := false


func _log(d: Dictionary) -> void:
	var p := OS.get_environment("S05_VELO_LOG")
	if p == "":
		p = "user://velo.log"
	var f := FileAccess.open(p, FileAccess.READ_WRITE) if FileAccess.file_exists(p) else FileAccess.open(p, FileAccess.WRITE)
	if f:
		f.seek_end()
		f.store_line(JSON.stringify(d))

func _init() -> void:
	var args := OS.get_cmdline_args()
	var hook := ""
	for a in args:
		if a.begins_with("--veloapp-"):
			hook = a
	var d := {"t": "autoload_init", "ticks_ms": Time.get_ticks_msec(), "version": ProjectSettings.get_setting("application/config/version"),
		"args": args, "user_args": OS.get_cmdline_user_args(), "hook": hook, "display": DisplayServer.get_name(),
		"window_size": DisplayServer.window_get_size(), "exe": OS.get_executable_path(), "user_dir": OS.get_user_data_dir(),
		"env_firstrun": OS.get_environment("VELOPACK_FIRSTRUN"), "env_restart": OS.get_environment("VELOPACK_RESTART")}
	if hook == "":
		var exe_dir := OS.get_executable_path().get_base_dir()
		var res_dir := exe_dir.path_join("../Resources").simplify_path()
		var packs := {}
		for dir in [exe_dir, res_dir]:
			for f in DirAccess.get_files_at(dir):
				if f.ends_with(".pck"):
					packs[dir.path_join(f)] = FileAccess.get_md5(dir.path_join(f)).left(8)
		d["packs_beside_exe"] = packs
		d["marker"] = FileAccess.get_file_as_string("res://marker.txt").strip_edges()
	_log(d)
	if hook != "":
		hooked = true
		Engine.get_main_loop().quit()

func _ready() -> void:
	if not hooked:
		var s := float(OS.get_environment("S05_RUN_SECONDS")) if OS.get_environment("S05_RUN_SECONDS") != "" else 1.5
		await get_tree().create_timer(s).timeout
		get_tree().quit()
