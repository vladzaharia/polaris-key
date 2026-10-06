class_name PKeyTestFixtures
extends RefCounted
## Shared fixtures for the core and transcript suites. Nothing is signed here (the SDK has no
## signer): every document comes from a generator-owned mirror, either the corpus
## (res://tests/corpus/v2/) or the recorded transcripts (res://tests/transcripts/).

const SDK_SCRIPT := "res://addons/polaris_key/polaris_key.gd"
const TRANSCRIPTS := "res://tests/transcripts"
const CASES := "res://tests/corpus/v2/cases.json"
const MANIFEST := "res://parity.json"


static func read_json(path: String) -> Variant:
	if not FileAccess.file_exists(path):
		return null
	var j := JSON.new()
	if j.parse(FileAccess.get_file_as_string(path)) != OK:
		return null
	return j.data


static func transcript(id: String) -> Variant:
	return read_json("%s/%s.json" % [TRANSCRIPTS, id])


## The response body of the first exchange in `step` whose path ends with `suffix`, and its
## headers: {body, headers}, or {} when absent.
static func exchange(t: Dictionary, step: int, suffix: String) -> Dictionary:
	for x in t["steps"][step]["exchanges"]["items"]:
		if String(x["request"]["path"]).ends_with(suffix):
			return {"body": x["response"]["body"], "headers": x["response"]["headers"]}
	return {}


## The sync fixtures recorded in sync-etag-304: the trust manifest, both documents, their ETags,
## a newer config document, and the transcript's pins, product and device.
static func sync_docs() -> Dictionary:
	var t = transcript("sync-etag-304")
	if not (t is Dictionary):
		return {}
	var lic := exchange(t, 0, "/license/document")
	var cfg := exchange(t, 0, "/config/document")
	return {
		"product": t["product"],
		"trust": t["trust"],
		"device_id": t["initial"]["deviceId"],
		"token": t["initial"]["token"],
		"version": t["initial"]["version"],
		"now": t["now"],
		"trust_jws": exchange(t, 0, "/polaris-trust.jws")["body"],
		"license": lic["body"],
		"license_etag": lic["headers"]["etag"],
		"config": cfg["body"],
		"config_etag": cfg["headers"]["etag"],
		"config_newer": exchange(t, 2, "/config/document")["body"],
	}


## The corpus bundle case `id` (bundleCases), or null.
static func bundle_case(id: String) -> Variant:
	var c = read_json(CASES)
	if not (c is Dictionary):
		return null
	for b in c.get("bundleCases", []):
		if b.get("id") == id:
			return b
	return null


## The corpus jwsCase `id`, or null.
static func jws_case(id: String) -> Variant:
	var c = read_json(CASES)
	if not (c is Dictionary):
		return null
	for b in c.get("jwsCases", []):
		if b.get("id") == id:
			return b
	return null


## A fresh, empty `user://` directory for one test.
static func scratch_dir(tag: String) -> String:
	var d := "user://pkey-test/%s-%d-%d" % [tag, Time.get_ticks_usec(), randi() % 100000]
	remove_tree(d)
	DirAccess.make_dir_recursive_absolute(d)
	return d


static func remove_tree(path: String) -> void:
	var d := DirAccess.open(path)
	if d == null:
		return
	d.include_hidden = true
	for f in d.get_files():
		d.remove(f)
	for sub in d.get_directories():
		remove_tree(path.path_join(sub))
	DirAccess.remove_absolute(path)


## A new SDK root (the autoload's script), added under the tree root so its HTTPRequests run.
static func new_sdk() -> Node:
	var sdk: Node = load(SDK_SCRIPT).new()
	(Engine.get_main_loop() as SceneTree).root.add_child(sdk)
	return sdk


static func new_server(handler: Callable) -> PKeyFakeServer:
	var s := PKeyFakeServer.new()
	s.handler = handler
	(Engine.get_main_loop() as SceneTree).root.add_child(s)
	s.listen()
	return s


## Options for the transcript product, pointed at `base_url`, with an injected clock cell
## (`clock[0]` is the current epoch second).
static func options(base_url: String, store: PKeyStore, clock: Array, product := "djdl", pins: Dictionary = {}, version := "1.0.0") -> PKeyOptions:
	var o := PKeyOptions.new()
	o.product = product
	o.base_url = base_url
	o.version = version
	o.pinned_trust_keys = pins
	o.store = store
	o.request_timeout_seconds = 5.0
	o.now_source = func(): return clock[0]
	# The exported template carries the CI build stamp; these tests must not see it.
	o.build_stamp_path = ""
	return o


## For complexity checks that hold on a loaded machine: each Callable in `fns` runs `rounds`
## times, interleaved (fns[0], fns[1], …, fns[0], …), and the fastest run of each is returned in
## ms. Compare the results with one another (a ratio), never with a fixed number of milliseconds:
## load slows every run, the fastest run is the one it slowed least, and interleaving puts each
## function's runs under the same load. An absolute bound belongs only to a hang guard.
static func fastest_ms(fns: Array, rounds := 3) -> PackedFloat64Array:
	var best := PackedFloat64Array()
	best.resize(fns.size())
	best.fill(INF)
	for r in rounds:
		for i in fns.size():
			var t0 := Time.get_ticks_usec()
			(fns[i] as Callable).call()
			best[i] = minf(best[i], (Time.get_ticks_usec() - t0) / 1000.0)
	return best


## Lets `frames` frames pass.
static func frames(n: int) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	for i in n:
		await tree.process_frame
