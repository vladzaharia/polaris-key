class_name MsixProbe
extends SceneTree
## S-05 (d): what a Godot export sees when it runs from a full-trust MSIX package.
## user args (after "--"):  --report=<abs path to a .jsonl outside AppData>  --phase=<name>
## Appends one JSON line to the report and prints it with the prefix "S05D|", then quits.
## Observations: user:// location, executable path, whether the install directory is writable
## (the sidecar-PCK swap needs that), a marker in user:// written by one phase and read by the
## next (install -> update -> after uninstall and reinstall), and a file seeded by the harness in
## the *real* %APPDATA% before install (MSIX: "opened from the real AppData location, then no
## virtualization for that file occurs").

const MARKER := "user://s05d_marker.txt"
const SEEDED := "user://s05d_preexisting.txt"


func _arg(name: String, fallback: String) -> String:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--%s=" % name):
			return a.substr(name.length() + 3)
	return fallback


func _try_write(path: String) -> Dictionary:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return {"path": path, "ok": false, "error": error_string(FileAccess.get_open_error())}
	f.store_string("s05d")
	f.close()
	var back := FileAccess.get_file_as_string(path) == "s05d"
	var rm := DirAccess.remove_absolute(path)
	return {"path": path, "ok": true, "read_back": back, "removed": rm == OK}


func _initialize() -> void:
	var phase := _arg("phase", "manual")
	var report := _arg("report", "")
	var exe := OS.get_executable_path()
	var exe_dir := exe.get_base_dir()
	var prev_marker := FileAccess.get_file_as_string(MARKER) if FileAccess.file_exists(MARKER) else ""
	var seeded_before := FileAccess.get_file_as_string(SEEDED) if FileAccess.file_exists(SEEDED) else ""
	var d := {
		"t": "s05d",
		"phase": phase,
		"engine": Engine.get_version_info().string,
		"version": ProjectSettings.get_setting("application/config/version"),
		"pack_marker": FileAccess.get_file_as_string("res://marker.txt").strip_edges(),
		"os": OS.get_name(),
		"os_version": OS.get_version(),
		"exe": exe,
		"exe_in_windowsapps": exe.to_lower().contains("\\windowsapps\\") or exe.to_lower().contains("/windowsapps/"),
		"user_data_dir": OS.get_user_data_dir(),
		"env_appdata": OS.get_environment("APPDATA"),
		"env_localappdata": OS.get_environment("LOCALAPPDATA"),
		"cmdline_args": OS.get_cmdline_args(),
		"user_args": OS.get_cmdline_user_args(),
		"packs_beside_exe": Array(DirAccess.get_files_at(exe_dir)).filter(func(f: String) -> bool: return f.ends_with(".pck")),
		# The sidecar swap writes a new .pck beside the executable; MSIX documents this as refused.
		"write_beside_exe": _try_write(exe_dir.path_join("s05d_sidecar_probe.pck")),
		"write_user": _try_write("user://s05d_write_probe.bin"),
		"marker_before": prev_marker,
		"seeded_before": seeded_before,
	}
	# Leave state for the next phase to find.
	var m := FileAccess.open(MARKER, FileAccess.WRITE)
	if m:
		m.store_string("%s|%s|%s" % [phase, d["version"], d["pack_marker"]])
		m.close()
	d["marker_written"] = FileAccess.get_file_as_string(MARKER)
	if seeded_before != "":
		var s := FileAccess.open(SEEDED, FileAccess.READ_WRITE)
		if s:
			s.seek_end()
			s.store_string("|touched-by-%s" % phase)
			s.close()
		d["seeded_after"] = FileAccess.get_file_as_string(SEEDED)
	d["user_files"] = Array(DirAccess.get_files_at("user://"))
	var line := JSON.stringify(d)
	print("S05D|" + line)
	if report != "":
		var r := FileAccess.open(report, FileAccess.READ_WRITE) if FileAccess.file_exists(report) else FileAccess.open(report, FileAccess.WRITE)
		if r:
			r.seek_end()
			r.store_line(line)
			r.close()
		else:
			printerr("S05D|report not writable: %s (%s)" % [report, error_string(FileAccess.get_open_error())])
	quit(0)
