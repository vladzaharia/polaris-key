class_name PKeyHostIo
extends RefCounted
## Every side effect the fingerprint reader performs, in one replaceable object (sdk-node's
## `FingerprintIo`), so the per-platform parsers run over captured output and tests can drive
## any platform's branch on any host. The default reads this machine.
##
## `run` and `read` are called from a WorkerThreadPool task (PKeyFingerprint.capture): an
## override must be thread-safe, which a fixture-backed fake trivially is.


## "windows", "macos", "linux", "ios", "android", "web", or "" for anything else.
func platform() -> String:
	return PKeyHeaders.update_platform()


## The program's stdout, or null when it could not run or exited non-zero. Desktop only:
## `OS.execute` blocks, has no timeout and starts the child with no stdin handle on Windows (so
## PowerShell cannot wait on one), and is unavailable on mobile and web.
func run(program: String, args: PackedStringArray) -> Variant:
	if not OS.has_feature("pc"):
		return null
	var out: Array = []
	var code := OS.execute(program, args, out, false, false)
	if code != 0 or out.is_empty():
		return null
	return String(out[0])


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
