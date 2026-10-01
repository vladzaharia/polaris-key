class_name PKeyFakeHost
extends PKeyHostIo
## A PKeyHostIo over one host of res://tests/fixtures/devices-captures.json: commands answer by
## program basename (`reg`, `powershell`, `ioreg`, …), files and directories from the fixture.
## `missing` lists programs or paths that behave as absent (a missing command, an unreadable
## file). Every call is recorded in `calls`. Thread-safe: it only reads its own data (the
## capture runs on a WorkerThreadPool task).

const CAPTURES := "res://tests/fixtures/devices-captures.json"

var host: Dictionary
var missing: PackedStringArray = PackedStringArray()
var calls: Array = []
var _mutex := Mutex.new()


func _init(p_host: Dictionary = {}) -> void:
	host = p_host


## The fixture host `name` (windows, macos, linux, ios, android, web), or null.
static func load_host(name: String) -> PKeyFakeHost:
	var all = PKeyTestFixtures.read_json(CAPTURES)
	if not (all is Dictionary) or not (all.get(name) is Dictionary):
		return null
	return PKeyFakeHost.new(all[name])


static func basename(program: String) -> String:
	var b := program.replace("\\", "/").get_file()
	return b.trim_suffix(".exe")


func platform() -> String:
	return host.get("platform", "")


func run(program: String, args: PackedStringArray) -> Variant:
	var name := basename(program)
	_mutex.lock()
	calls.append({"program": program, "args": args})
	_mutex.unlock()
	if missing.has(name):
		return null
	var v = host.get("out", {}).get(name)
	return v if v is String else null


func read(path: String) -> Variant:
	if missing.has(path):
		return null
	var v = host.get("files", {}).get(path)
	return v if v is String else null


func list_dir(path: String) -> PackedStringArray:
	var v = host.get("dirs", {}).get(path)
	return PackedStringArray(v) if v is Array else PackedStringArray()


func env(name: String) -> String:
	return str(host.get("env", {}).get(name, ""))


func processor_name() -> String:
	return str(host.get("cpu_name", ""))


func processor_count() -> int:
	return int(host.get("cpu_count", 0))


func memory_bytes() -> int:
	return int(host.get("memory", -1))


func model_name() -> String:
	return str(host.get("model", ""))


func unique_id() -> String:
	return str(host.get("unique_id", ""))


## Every raw value this host could hand the fingerprint, for "never in a request body" checks.
## ramBucket is left out: a one- or two-digit power of two is not an identifier and would match
## any number in a body.
func raw_values() -> PackedStringArray:
	var out := PackedStringArray()
	var expected: Dictionary = host.get("expected", {})
	for k in expected:
		if k != "ramBucket":
			out.append(String(expected[k]))
	return out
