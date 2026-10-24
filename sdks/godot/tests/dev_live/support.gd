class_name PKeyDevLive
extends RefCounted
## The bed for the dev_live suite (SP-41): the shipped Godot SDK, configured from the file
## `pkey sdk --lang godot --dev --write` generated (a polaris_key.tres), talking real HTTP over the SDK's own transport
## to a `pkey dev` server a CI lane (or a developer) started. Nothing here is a fake: the server
## runs the Worker's router with a seeded product, and the sign-in is approved by the harness-side
## approver, as a person on another device would.
##
##   PKEY_DEV_BASE_URL   the server's origin, http://127.0.0.1:<port> (no trailing slash)
##   PKEY_DEV_CONFIG     the polaris_key.tres `pkey sdk --lang godot --dev --url … --write`
##                       wrote. It lives outside this tree, so it is loaded by absolute path
##                       (uncached: it is not a resource of the project)
##   PKEY_DEV_APPROVE    packages/cli/scripts/dev-approve.mjs, run as
##                       `node <it> <verificationUri> <userCode>`; exit 0 means approved
##
## All three set: the suite runs. None set at all: it skips (a job that starts no pkey dev, such
## as the release workflow's, is not this suite's business). Any other state fails: a lane that
## meant to run it and lost a variable must not pass by skipping. The groups run in order on one
## server, each as the device of its role (`device_id`): `pkey dev` limits every test key to three
## key entries for the life of the server, and the lane runs this suite twice on it (the editor,
## then the exported pack), so what a run does to a key must be done once and stay done.

const SDK := preload("res://addons/polaris_key/polaris_key.gd")

const ENV_BASE_URL := "PKEY_DEV_BASE_URL"
const ENV_CONFIG := "PKEY_DEV_CONFIG"
const ENV_APPROVE := "PKEY_DEV_APPROVE"
const ENV_NAMES := [ENV_BASE_URL, ENV_CONFIG, ENV_APPROVE]

## The seven test keys `pkey dev` seeds, in the order it lists them (`GET /__dev/info`).
const KEYS := ["ok", "expired", "disabled", "revoked", "device-limit-full", "key-entry-limit", "floating"]

## What each role's device id is hashed from (see `device_id`).
const DEVICE_RAW := "godot-live-suite"

## A wall-clock hang guard on a wait for the server or the approver, never a pass condition: load
## can only lengthen a wait, so it cannot fail a check.
const HANG_GUARD_SECONDS := 60.0

var base_url := ""
var config_path := ""
var approve_path := ""
## `GET /__dev/info`, as the server last answered it.
var info: Dictionary = {}
## The generated polaris_key.tres, loaded.
var config: PKeyOptions = null
## The `configure()` result of the SDK `sdk()` last made.
var last_configure: PKeyResult = null

var _host: Node = null
var _control: PKeyTransport = null
var _scratch: Array[String] = []


# ── The environment ──────────────────────────────────────────────────────────────────────────

## {set, unset, empty}: the names of the three variables by state. A variable that is set to ""
## is `empty`, not `unset`: a lane that passes an empty value has lost it.
static func env_state() -> Dictionary:
	var out := {"set": [], "unset": [], "empty": []}
	for name in ENV_NAMES:
		if not OS.has_environment(name):
			out["unset"].append(name)
		elif OS.get_environment(name).strip_edges() == "":
			out["empty"].append(name)
		else:
			out["set"].append(name)
	return out


## True when none of the three variables is set at all: the suite skips.
static func is_skipped(state: Dictionary) -> bool:
	return state["unset"].size() == ENV_NAMES.size()


## True when all three are set and non-empty: the suite runs.
static func is_complete(state: Dictionary) -> bool:
	return state["set"].size() == ENV_NAMES.size()


# ── Opening ──────────────────────────────────────────────────────────────────────────────────

## Read the environment, compile the generated config and ask the server who it is. Records a
## failing check for each step that cannot go on and returns false then.
func open(t: PKeyTestContext) -> bool:
	base_url = OS.get_environment(ENV_BASE_URL).strip_edges().rstrip("/")
	config_path = OS.get_environment(ENV_CONFIG).strip_edges()
	approve_path = OS.get_environment(ENV_APPROVE).strip_edges()
	_host = Node.new()
	_host.name = "PKeyDevLiveHost"
	(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	_control = PKeyTransport.new(_host)
	_control.timeout = 15.0

	var ready := true
	ready = t.check("open: PKEY_DEV_BASE_URL is the loopback origin of a pkey dev server", PKeyTransport.check_base_url(base_url).ok and base_url.begins_with("http://"), base_url) and ready
	ready = t.check("open: PKEY_DEV_CONFIG names the generated config file", FileAccess.file_exists(config_path), config_path) and ready
	ready = t.check("open: PKEY_DEV_APPROVE names the approver script", FileAccess.file_exists(approve_path), approve_path) and ready
	if not ready:
		return false

	var loaded = ResourceLoader.load(config_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not t.check("open: the generated polaris_key.tres loads as PKeyOptions", loaded is PKeyOptions, config_path):
		return false
	config = loaded

	var got := await refresh_info()
	if not t.check("open: the server answers GET /__dev/info (a healthy pkey dev)", got["status"] == 200 and info.has("keys") and info.has("product"), "status %s %s" % [got["status"], got["error"]]):
		return false
	return true


## Free what the suite made: the harness node and every scratch directory.
func close() -> void:
	for dir in _scratch:
		PKeyTestFixtures.remove_tree(dir)
	_scratch.clear()
	if _host != null and is_instance_valid(_host):
		_host.queue_free()
	_host = null


# ── The server ───────────────────────────────────────────────────────────────────────────────

## `GET /__dev/info` again (the release list changes when a test publishes one). The answer, as
## `call_dev` returns it; `info` holds the body when it was an object.
func refresh_info() -> Dictionary:
	var got := await call_dev("GET", "/__dev/info")
	if got["status"] == 200 and got["body"] is Dictionary:
		info = got["body"]
	return got


## One request to the server, over the SDK's own transport: {status, body (parsed JSON or null),
## error}. `status` is 0 when no answer arrived. A POST carries the header the control surface
## requires, which a web page cannot add to a cross-origin request.
func call_dev(method: String, path: String, body: Variant = null) -> Dictionary:
	var headers := {"Accept": "application/json"}
	var bytes := PackedByteArray()
	if body != null:
		headers["Content-Type"] = "application/json"
		bytes = JSON.stringify(body).to_utf8_buffer()
	if method == "POST":
		headers["X-PKey-Dev"] = "1"
	var r: PKeyResult = await _control.request(method, base_url + path, headers, bytes)
	if not r.ok:
		return {"status": 0, "body": null, "error": "%s: %s" % [r.code, r.message]}
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	return {"status": int(r.detail["status"]), "body": parsed["value"] if parsed["ok"] else null, "error": ""}


## One control command (`expire`, `config`, `release`, …): the answer of `POST /__dev/<command>`.
func control(command: String, body: Dictionary) -> Dictionary:
	return await call_dev("POST", "/__dev/" + command, body)


## The seeded test key named `name` (see KEYS).
func key(name: String) -> String:
	var keys = info.get("keys")
	return String(keys.get(name, "")) if keys is Dictionary else ""


## The newest stable release the server holds, or "".
func latest_stable() -> String:
	var newest := ""
	for r in info.get("releases", []):
		if r is Dictionary and r.get("channel") == "stable" and (newest == "" or PKeySemver.compare(String(r["version"]), newest) > 0):
			newest = String(r["version"])
	return newest


## `version` with its patch number raised by one: a stable release newer than it.
static func next_patch(version: String) -> String:
	var parts := version.split(".")
	if parts.size() != 3:
		return ""
	return "%s.%s.%d" % [parts[0], parts[1], int(parts[2]) + 1]


# ── The SDK ──────────────────────────────────────────────────────────────────────────────────

## A copy of the generated polaris_key.tres, as `PolarisKey.boot()` reads it.
func options() -> PKeyOptions:
	var o: PKeyOptions = config.duplicate()
	o.pinned_keys = config.pinned_keys.duplicate()
	o.pinned_release_keys = config.pinned_release_keys.duplicate()
	return o


## The device a role runs as. The Worker counts a key entry for every seat a licence's key
## claims (one per new authorisation, never given back, three per licence on this server), so a
## device that took a licence's seat keeps it for the life of the server and each later
## activation of that licence is the same device activating again. And a device holding a live
## seat on one licence has to prove it owns the id before the Worker looks at another licence's
## key, so a refused key must come from a device that holds nothing. Each role is its own device:
##
##   key        activates `ok` and keeps its seat: the quickstart, the ok row, the config change
##   floating   activates `floating` and keeps its seat
##   refused    activates the keys that are refused, so it never holds a seat
##   signin     signs in and signs out (a sign-in is never a key entry)
##
## Hashed from fixed text, so a rerun on the same server (the lane runs this suite once in the
## editor and once from the exported pack) is the same devices.
func device_id(role: String) -> String:
	return PKeyDeviceId.from_raw(String(info.get("product", "")), "%s:%s" % [DEVICE_RAW, role])


## A configured and started SDK node running as the device of `role`: the quickstart's options
## plus what a test must pin (an in-memory store holding that device, no export stamp).
## `tweak(opts)` edits the options first. The clock is the machine's: the server signs documents
## with its own. `last_configure` holds the `configure()` result.
func sdk(role: String, tweak := Callable()) -> Node:
	var node: Node = PKeyTestFixtures.new_sdk()
	var opts := options()
	opts.store = PKeyMemoryStore.new(device_id(role))
	opts.version = "1.0.0"
	# The exported pack carries the CI stamp; this suite decides its own platform and outlet.
	opts.build_stamp_path = ""
	opts.persist_settings = false
	opts.device_name = "Godot live suite"
	if tweak.is_valid():
		tweak.call(opts)
	last_configure = node.configure(opts)
	if last_configure.ok:
		await node.start()
	return node


## Free an SDK node. A device that activated a key keeps its seat (see `device_id`).
func drop(node: Node) -> void:
	if node != null and is_instance_valid(node):
		node.queue_free()


## A `build.json` for an install of this product, written where the SDK reads it: a macOS
## `direct` build at `version`. The dev release is a macOS build, so this is the one install the
## server publishes updates for from any host.
func write_stamp(version: String) -> String:
	var dir := PKeyTestFixtures.scratch_dir("dev-live")
	_scratch.append(dir)
	var path := dir.path_join("build.json")
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return ""
	var engine := Engine.get_version_info()
	f.store_string(JSON.stringify({
		"pkeyBuild": 1,
		"product": info.get("product", ""),
		"version": version,
		"build": 1,
		"outlet": "direct",
		"channel": "stable",
		"engine": "godot-%d.%d" % [engine["major"], engine["minor"]],
		"engineVersion": String(engine["string"]),
		"platform": "macos",
		"arch": "arm64",
		"format": "zip",
		"packSources": "embedded",
		"embeddedPacks": [],
		"debug": false,
		"sdkVersion": SDK.SDK_VERSION,
		"outletIds": {},
	}))
	f.close()
	return path


# ── The person on the other device ───────────────────────────────────────────────────────────

## Approve a device-code sign-in the way a person does on a phone: the harness approver opens the
## prompt's verification page, enters its code and confirms. {code, output}: its exit code (0:
## approved) and what it printed. `node` is the one on PATH; when it cannot start at all the code
## is -1 and the output says so.
func approve(prompt: PKeySignInPrompt) -> Dictionary:
	var out: Array = []
	var code := OS.execute("node", PackedStringArray([approve_path, prompt.verification_uri, prompt.user_code]), out, true)
	var lines := PackedStringArray()
	for o in out:
		lines.append(String(o))
	var text := "\n".join(lines).strip_edges()
	if code == -1 and text == "":
		text = "could not run `node` (is it on PATH?)"
	return {"code": code, "output": text}


# ── Waiting ──────────────────────────────────────────────────────────────────────────────────

## Let `seconds` of real time pass. Used where the server's own clock must tick: its documents
## are signed in whole seconds, and one signed in the same second as the last is not newer.
static func pause(seconds: float) -> void:
	await (Engine.get_main_loop() as SceneTree).create_timer(seconds, true, false, true).timeout


## Wait until `box` (an Array a signal handler appends to) is not empty, at most `seconds`.
## Whether it is.
static func until_filled(box: Array, seconds: float = HANG_GUARD_SECONDS) -> bool:
	var tree := Engine.get_main_loop() as SceneTree
	var deadline := Time.get_ticks_msec() + int(seconds * 1000.0)
	while box.is_empty() and Time.get_ticks_msec() < deadline:
		await tree.process_frame
	return not box.is_empty()


## `identity.wait_for_sign_in(prompt)` with the hang guard: when the code is never approved the
## wait would run to the code's lifetime, so after HANG_GUARD_SECONDS it is cancelled and ends
## `cancelled`.
static func wait_for_sign_in(node: Node, prompt: PKeySignInPrompt) -> PKeySignInResult:
	var settled := [false]
	var timer := (Engine.get_main_loop() as SceneTree).create_timer(HANG_GUARD_SECONDS, true, false, true)
	timer.timeout.connect(func() -> void:
		if not settled[0] and is_instance_valid(node):
			node.identity.cancel())
	var result: PKeySignInResult = await node.identity.wait_for_sign_in(prompt)
	settled[0] = true
	return result


## Whether `got` and `want` (String -> String maps) hold the same pairs.
static func same_pairs(got: Variant, want: Variant) -> bool:
	if not (got is Dictionary) or not (want is Dictionary) or got.size() != want.size():
		return false
	for k in want:
		if not got.has(k) or String(got[k]) != String(want[k]):
			return false
	return true


## Whether `got` and `want` (an Array or a PackedStringArray each) hold the same strings, in any
## order and counting each once.
static func same_set(got: Variant, want: Variant) -> bool:
	if not (got is Array or got is PackedStringArray) or not (want is Array or want is PackedStringArray):
		return false
	var a := {}
	var b := {}
	for v in got:
		a[String(v)] = true
	for v in want:
		b[String(v)] = true
	return a.size() == b.size() and a.keys().all(func(k) -> bool: return b.has(k))
