class_name PKeySecretServiceBackend
extends PKeyKeyringBackend
## The Secret Service on Linux (SP-27; gnome-keyring, KWallet's Secret Service bridge, KeePassXC)
## through `secret-tool` from libsecret-tools: no GDExtension to ship or build. Items carry the
## attributes `service` = `pkey:<product>` and `username` = the account, which is how
## python-keyring's SecretService backend finds them, so Python's and Godot's desktop builds of one
## product read the same item.
##
## The secret never reaches a command line: `store` reads it from stdin (OS.execute_with_pipe) and
## `lookup` prints it on stdout. Each call has a deadline (`timeout_ms`): a locked collection can
## raise an unlock prompt, and a call that does not finish is killed and reported, never awaited
## for ever on the main thread.
##
## unavailable() says why when `secret-tool` is not on PATH or there is no session bus
## (DBUS_SESSION_BUS_ADDRESS, or $XDG_RUNTIME_DIR/bus), and on an engine older than Godot 4.5,
## whose OS.execute_with_pipe never delivers what is written to the child's stdin (`store` then
## fails, and the write can raise SIGPIPE): the store keeps the token in its 0600 file and says so.
## A daemon that is not running or a locked collection shows up as a failed call, which the store
## surfaces.

## The program to run: `secret-tool` on PATH by default. Tests point it at a stand-in script.
var tool := ""
## The platform this answers for ("" means PKeyHeaders.platform()). Tests set it.
var platform := ""
var timeout_ms := 10000


func _init(p_tool := "", p_platform := "") -> void:
	tool = p_tool
	platform = p_platform


func id() -> String:
	return "secret-service"


func unavailable() -> String:
	var p := platform if platform != "" else PKeyHeaders.platform()
	if p != PKeyConstants.Platform.LINUX:
		return "the Secret Service backend runs on Linux, not %s" % (p if p != "" else "this platform")
	if not engine_pipes_stdin():
		return "secret-tool needs Godot 4.5 or later: Godot %s's OS.execute_with_pipe does not deliver stdin, and the secret never goes on a command line" % Engine.get_version_info().get("string", "4.4")
	if _program() == "":
		return "secret-tool (libsecret-tools) is not on PATH"
	if OS.get_environment("DBUS_SESSION_BUS_ADDRESS") == "":
		var runtime_dir := OS.get_environment("XDG_RUNTIME_DIR")
		if runtime_dir == "" or not FileAccess.file_exists(runtime_dir.path_join("bus")):
			return "no D-Bus session bus (DBUS_SESSION_BUS_ADDRESS is not set)"
	return ""


func get_secret(service: String, account: String) -> Dictionary:
	var why := unavailable()
	if why != "":
		return {"ok": false, "error": why}
	var r := _run(["lookup", "service", service, "username", account])
	if r["exit"] == 0:
		return {"ok": true, "value": r["out"]}
	# secret-tool exits 1 without a word when nothing matches; anything on stderr is a failure.
	if r["exit"] > 0 and r["err"].strip_edges() == "":
		return {"ok": true, "value": null}
	return {"ok": false, "error": _why("lookup", r)}


func set_secret(service: String, account: String, secret: String) -> Dictionary:
	var why := unavailable()
	if why != "":
		return {"ok": false, "error": why}
	var r := _run(["store", "--label=Polaris Key (%s)" % service, "service", service, "username", account], secret)
	return {"ok": true} if r["exit"] == 0 else {"ok": false, "error": _why("store", r)}


func delete_secret(service: String, account: String) -> Dictionary:
	var why := unavailable()
	if why != "":
		return {"ok": false, "error": why}
	var r := _run(["clear", "service", service, "username", account])
	if r["exit"] == 0 or (r["exit"] > 0 and r["err"].strip_edges() == ""):
		return {"ok": true}
	return {"ok": false, "error": _why("clear", r)}


## Whether this engine's OS.execute_with_pipe delivers stdin to the child (Godot 4.5 and later).
static func engine_pipes_stdin() -> bool:
	var v := Engine.get_version_info()
	return int(v.get("major", 0)) > 4 or (int(v.get("major", 0)) == 4 and int(v.get("minor", 0)) >= 5)


func _program() -> String:
	if tool != "":
		return tool if FileAccess.file_exists(tool) else ""
	for dir in OS.get_environment("PATH").split(":", false):
		var candidate := dir.path_join("secret-tool")
		if FileAccess.file_exists(candidate):
			return candidate
	return ""


static func _why(action: String, r: Dictionary) -> String:
	if r["timed_out"]:
		return "secret-tool %s did not finish in time (a locked collection waiting for its prompt?)" % action
	if r["exit"] < 0:
		return "secret-tool %s could not be started" % action
	var err: String = r["err"].strip_edges()
	return "secret-tool %s failed (exit %d)%s" % [action, r["exit"], (": " + err) if err != "" else ""]


## Run the tool: {exit (-1 when it did not start or was killed), out, err, timed_out}. `input` is
## written to stdin, which is then closed (stdout is not read then: `store` prints nothing).
func _run(args: PackedStringArray, input = null) -> Dictionary:
	var res := {"exit": -1, "out": "", "err": "", "timed_out": false}
	var p := OS.execute_with_pipe(_program(), args, false)
	if p.is_empty():
		return res
	var pid: int = p["pid"]
	var io: FileAccess = p["stdio"]
	var err_pipe: FileAccess = p.get("stderr")
	var out := PackedByteArray()
	var err := PackedByteArray()
	if input is String:
		io.store_buffer((input as String).to_utf8_buffer())
		io.close()
		io = null
	var deadline := Time.get_ticks_msec() + timeout_ms
	while true:
		var running := OS.is_process_running(pid)
		var got := false
		if io != null:
			var chunk := io.get_buffer(4096)
			if not chunk.is_empty():
				out.append_array(chunk)
				got = true
		if err_pipe != null:
			var echunk := err_pipe.get_buffer(4096)
			if not echunk.is_empty():
				err.append_array(echunk)
				got = true
		if not running and not got:
			break
		if Time.get_ticks_msec() > deadline:
			OS.kill(pid)
			res["timed_out"] = true
			break
		if not got:
			OS.delay_msec(2)
	if io != null:
		io.close()
	if err_pipe != null:
		err_pipe.close()
	res["out"] = out.get_string_from_utf8()
	res["err"] = err.get_string_from_utf8()
	if not res["timed_out"]:
		var code := OS.get_process_exit_code(pid)
		# Godot 4.4 answers the raw wait status (exit << 8); 4.5+ the exit code.
		res["exit"] = code >> 8 if code > 255 and code & 0xff == 0 else code
	return res
