class_name PKeyUpdaterTestSupport
extends RefCounted
## Plumbing for the updater groups: a portable install in a scratch directory (an executable and
## its sidecar `<exe-name>.pck`), "launches" of it (a fresh SDK per launch, configured with the
## version of the pack that runs, the updater enabled on a recording PKeyFakeUpdaterEnv), and
## synthetic verified decisions for a pack whose bytes the test owns. Release records are
## verified by P3-08's suites; what the updater reads is the verified record Dictionary.

const PRODUCT := "djdl"
const DEVICE := "dev_7c1e2d"
## An https bytes host for links (a link is opened only when it is https; nothing fetches it).
const DL := "https://dl.example.com"

var server: PKeyFakeServer = null
var plan := {}


## A loopback server answering by path prefix: an Array of answers (the last repeats; a Callable
## gets the request).
func serve() -> PKeyFakeServer:
	server = PKeyTestFixtures.new_server(_answer)
	return server


func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	for prefix in plan:
		if path.begins_with(prefix):
			var q: Array = plan[prefix]
			var a = q[0] if q.size() == 1 else q.pop_front()
			return a.call(req) if a is Callable else a
	return {"status": 404, "headers": {"Content-Type": "application/json"}, "body": "{\"error\":{\"code\":\"not_found\"}}"}


func requests(prefix: String) -> Array:
	return server.requests.filter(func(r): return String(r["path"]).begins_with(prefix)) if server != null else []


func free_server() -> void:
	if server != null:
		server.queue_free()
		server = null


## A portable install: {dir, exe, pck, user, env}. The pack holds `old` bytes.
static func install(tag: String, old: PackedByteArray, os := "linux", exe_name := "game.x86_64") -> Dictionary:
	var dir := PKeyTestFixtures.scratch_dir(tag)
	var app := dir.path_join("app")
	DirAccess.make_dir_recursive_absolute(app)
	var exe := app.path_join(exe_name)
	write(exe, "ELF".to_utf8_buffer())
	var pck := exe.get_basename() + ".pck"
	write(pck, old)
	var e := PKeyFakeUpdaterEnv.new()
	e.os = os
	e.exe = exe
	return {"dir": dir, "exe": exe, "pck": pck, "user": dir.path_join("user"), "env": e}


## One launch of `inst`: a configured, started SDK whose running version is `version` (what the
## pack's own stamp would say), with the updater enabled on the install's env. `tweak(opts)`.
func launch(inst: Dictionary, version: String, tweak := Callable(), token := "") -> Node:
	var s := PKeyTestFixtures.new_sdk()
	var base := server.base_url() if server != null else "http://127.0.0.1:9"
	var opts := PKeyTestFixtures.options(base, PKeyMemoryStore.new(DEVICE, token), [1700000100.0], PRODUCT, {}, version)
	opts.store_root = inst["user"]
	opts.update_methods = PackedStringArray(["native", "download", "sidecar-pck"])
	if tweak.is_valid():
		tweak.call(opts)
	var r: PKeyResult = s.configure(opts)
	if not r.ok:
		push_error("launch: configure refused: %s" % r)
		return s
	await s.start()
	var u: PKeyUpdater = s.update.updater
	u.env = inst["env"]
	u.enabled = true
	u.rename_wait_msec = 1
	u.boot_ok_seconds = 0.2
	u.bridges = {}
	return s


## Discovery as this session's: the builds template (and, optionally, the updater feeds). `bytes`:
## the bytes host of the builds route (the loopback server by default, which staging fetches; DL
## for a link the test only expects opened).
func discovered(s: Node, extra_update := {}, bytes := "") -> void:
	var base := (server.base_url() if server != null else "http://127.0.0.1:9") + "/" + PRODUCT
	var builds := (bytes + "/" + PRODUCT) if bytes != "" else base
	var update := {"enabled": true, "endpoints": {"feed": base + "/update/{channel}/feed.jws"}}
	update["endpoints"].merge(extra_update, true)
	s.core.discovery_manifest = {"product": PRODUCT, "services": {
		"distribution": {"enabled": true, "endpoints": {"builds": builds + "/distribution/builds/{selector}/{buildId}"}},
		"release": {"enabled": true, "endpoints": {"record": base + "/release/records/{sha256}"}},
		"update": update,
	}}


## A verified binary {sidecar-pck} answer for a pack of `payload` bytes (or a declared
## size/sha256 that the bytes need not match), staged under `channel`.
static func sidecar_check(version: String, payload: PackedByteArray, channel := "stable", engine := "", declared := {}) -> PKeyUpdateCheck:
	var r := PKeyUpdateCheck.new(true)
	r.channel = channel
	r.decision = {
		"action": "binary", "method": "sidecar-pck",
		"release": {"version": version, "seq": 15, "sha256": "ab".repeat(32)},
		"build": "linux-pck", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false,
	}
	r.boot = "optional"
	r.feed_doc = {"channel": channel, "app": {"versionScheme": "semver"}}
	r.record_doc = {
		"version": version,
		"builds": [{
			"id": "linux-pck", "platform": "linux", "arch": "any", "format": "pck",
			"requires": {"engine": engine if engine != "" else PKeyBuildStamp.engine_id()},
			"artifacts": [{"name": "game.pck", "role": "payload", "sha256": String(declared.get("sha256", sha(payload))), "size": int(declared.get("size", payload.size()))}],
		}],
	}
	return r


## A decision answer of `action` (with its members), wrapped as an ok PKeyUpdateCheck.
static func check_of(decision: Dictionary) -> PKeyUpdateCheck:
	var r := PKeyUpdateCheck.new(true)
	r.channel = "stable"
	r.decision = decision
	r.boot = PKeyDecision.boot_decision(decision)
	r.undismissable = PKeyDecision.is_undismissable(decision)
	return r


static func bytes(n: int, seed: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	var x := seed * 2654435761 + 1
	for i in n:
		x = (x * 1103515245 + 12345) & 0x7fffffff
		b[i] = (x >> 16) & 0xff
	return b


static func sha(b: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(b)
	return ctx.finish().hex_encode()


static func write(path: String, b: PackedByteArray) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_buffer(b)
	f.close()


static func read(path: String) -> PackedByteArray:
	return FileAccess.get_file_as_bytes(path) if FileAccess.file_exists(path) else PackedByteArray()


## A server answer serving `body` for GET with Range support (206 + Content-Range for
## `bytes=<n>-`), unless `ranges` is false (always 200).
static func ranged(body: PackedByteArray, ranges := true) -> Callable:
	return func(req: Dictionary) -> Dictionary:
		var r := String(req["headers"].get("range", ""))
		if ranges and r.begins_with("bytes=") and r.ends_with("-"):
			var from := int(r.substr(6, r.length() - 7))
			if from >= body.size():
				return {"status": 416, "headers": {"Content-Range": "bytes */%d" % body.size()}}
			return {"status": 206, "headers": {"Content-Type": "application/octet-stream", "Content-Range": "bytes %d-%d/%d" % [from, body.size() - 1, body.size()]}, "body": body.slice(from)}
		return {"status": 200, "headers": {"Content-Type": "application/octet-stream"}, "body": body}
