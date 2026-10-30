class_name PKeyHostIo
extends RefCounted
## Every side effect the fingerprint reader performs, in one replaceable object (sdk-node's
## `FingerprintIo`), so the per-platform parsers run over captured output and tests can drive
## any platform's branch on any host. The default reads this machine.
##
## `run` and `read` are called from a WorkerThreadPool task (PKeyFingerprint.capture): an
## override must be thread-safe, which a fixture-backed fake trivially is.


## How long a command may run before it is killed. The Windows reads are PowerShell's CIM query and
## the system tools, and a cold PowerShell on a runner can take many seconds (the platform suite waits
## for the capture there); the other desktops' commands answer at once.
const TIMEOUT_MSEC := 10000
const WINDOWS_TIMEOUT_MSEC := 30000
## A command that prints more than this is killed and read as failed: every command here prints a few
## kilobytes.
const MAX_OUTPUT_BYTES := 4 * 1024 * 1024
const _POLL_MSEC := 5
const _READ_CHUNK := 65536

static var _pipes_checked := false
static var _pipes_bounded := false

## Overrides the time limit of `run`, in milliseconds. 0: the default of this platform. (Tests.)
var timeout_msec := 0
## Why the last `run` answered null: &"unavailable" (not a desktop), &"start" (the process did not
## start), &"timeout" (it was killed), &"output" (it printed too much), &"exit" (a non-zero exit
## status), or &"" (it succeeded). Read it from the thread that called `run`.
var last_outcome: StringName = &""


## "windows", "macos", "linux", "ios", "android", "web", or "" for anything else.
func platform() -> String:
	return PKeyHeaders.update_platform()


## The program's stdout, or null when it could not run, exited non-zero, ran past its time limit or
## printed too much. Desktop only: mobile and web run no commands.
##
## The child runs with `OS.execute_with_pipe` and non-blocking pipes (Godot 4.5 and later): the caller
## polls its output and its state every few milliseconds, and a child that has not exited by the time
## limit is killed (`OS.kill`), so a hung command (a PowerShell waiting on a console, a tool stuck on
## a dead mount) costs the time limit and no more. Both pipes are drained as the child writes, so a
## chatty child never blocks on a full pipe. Call it off the main thread: it waits for the child.
## Before Godot 4.5 the pipes cannot be read without blocking, and `OS.execute` runs the command
## without a limit, as it always did.
func run(program: String, args: PackedStringArray) -> Variant:
	last_outcome = &"unavailable"
	if not OS.has_feature("pc"):
		return null
	if not _bounded_pipes():
		return _run_unbounded(program, args)
	return _run_bounded(program, args, _limit())


## The limit `run` applies, in milliseconds.
func _limit() -> int:
	if timeout_msec > 0:
		return timeout_msec
	return WINDOWS_TIMEOUT_MSEC if platform() == "windows" else TIMEOUT_MSEC


## True when this engine's `OS.execute_with_pipe` has the `blocking` argument (4.5 and later).
static func _bounded_pipes() -> bool:
	if not _pipes_checked:
		_pipes_checked = true
		for m: Dictionary in ClassDB.class_get_method_list(&"OS", true):
			if m["name"] == "execute_with_pipe":
				_pipes_bounded = (m["args"] as Array).size() >= 3
	return _pipes_bounded


func _run_unbounded(program: String, args: PackedStringArray) -> Variant:
	var out: Array = []
	var code := OS.execute(program, args, out, false, false)
	if code != 0 or out.is_empty():
		last_outcome = &"exit"
		return null
	last_outcome = &""
	return String(out[0])


func _run_bounded(program: String, args: PackedStringArray, limit_msec: int) -> Variant:
	var started := Time.get_ticks_msec()
	var child: Dictionary = OS.call("execute_with_pipe", program, args, false)
	var out: FileAccess = child.get("stdio")
	var err: FileAccess = child.get("stderr")
	if child.is_empty() or out == null or err == null:
		last_outcome = &"start"
		return null
	var pid: int = child["pid"]
	var data := PackedByteArray()
	while true:
		var fresh := _drain(out, MAX_OUTPUT_BYTES + 1 - data.size())
		data.append_array(fresh)
		var got := fresh.size() + _drain(err, _READ_CHUNK).size()
		if data.size() > MAX_OUTPUT_BYTES:
			return _abandon(pid, out, err, &"output")
		if not OS.is_process_running(pid):
			# What the child wrote just before it exited.
			data.append_array(_drain(out, MAX_OUTPUT_BYTES + 1 - data.size()))
			break
		if Time.get_ticks_msec() - started >= limit_msec:
			return _abandon(pid, out, err, &"timeout")
		if got == 0:
			OS.delay_msec(_POLL_MSEC)
	var code := OS.get_process_exit_code(pid)
	out.close()
	err.close()
	if code != 0 or data.size() > MAX_OUTPUT_BYTES:
		last_outcome = &"exit"
		return null
	last_outcome = &""
	return data.get_string_from_utf8()


## Kill a child that overstayed and let go of its pipes. `OS.kill` reaps the child itself, so the
## process is not asked after again. Always null.
func _abandon(pid: int, out: FileAccess, err: FileAccess, outcome: StringName) -> Variant:
	OS.kill(pid)
	out.close()
	err.close()
	last_outcome = outcome
	return null


## What is available on a non-blocking pipe, at most `limit` bytes plus one read.
static func _drain(pipe: FileAccess, limit: int) -> PackedByteArray:
	var all := PackedByteArray()
	while all.size() < limit:
		var chunk := pipe.get_buffer(_READ_CHUNK)
		if chunk.is_empty():
			break
		all.append_array(chunk)
	return all


## The file's text, or null when it does not exist or cannot be read.
func read(path: String) -> Variant:
	if not FileAccess.file_exists(path):
		return null
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return null
	var text := f.get_as_text()
	f.close()
	return text


## The entry names in a directory (files, directories and symbolic links alike), or [] when it
## cannot be opened. /sys/class/net holds symbolic links to directories.
func list_dir(path: String) -> PackedStringArray:
	var out := PackedStringArray()
	var d := DirAccess.open(path)
	if d == null:
		return out
	d.include_hidden = false
	d.list_dir_begin()
	var name := d.get_next()
	while name != "":
		if name != "." and name != "..":
			out.append(name)
		name = d.get_next()
	d.list_dir_end()
	out.sort()
	return out


func env(name: String) -> String:
	return OS.get_environment(name)


func processor_name() -> String:
	return OS.get_processor_name()


func processor_count() -> int:
	return OS.get_processor_count()


## Total physical memory in bytes, or -1 when unknown.
func memory_bytes() -> int:
	var info := OS.get_memory_info()
	return int(info.get("physical", -1))


func model_name() -> String:
	return OS.get_model_name()


## `OS.get_unique_id()`: identifierForVendor on iOS, ANDROID_ID on Android, /etc/machine-id on
## Linux, the platform serial on macOS, a hardware-profile GUID on Windows; "" on web.
func unique_id() -> String:
	if OS.has_feature("web"):
		return ""
	return OS.get_unique_id()
