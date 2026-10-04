class_name PKeyPackPlatformTransport
extends PKeyPackTransport
## A store transport (P5-08; CONTENT §7): the platform moves the bytes, Polaris Key keeps the
## identity. The three behind this base are PKeyPackAppleBaTransport (`apple-ba`, Apple-hosted
## Background Assets through P5-05's PKeyApple), PKeyPackPlayPadTransport (`play-pad`, Play Asset
## Delivery through P5-06's PKeyAndroid) and PKeyPackSteamTransport (`steam-depot`, depots through
## GodotSteam). Without its plugin each answers the typed unsupported result (PARITY §2.2), and the
## SDK runs on: `installed()` is empty and the planner refuses a pack bound to it with
## `plan-transport-unsupported` (never a silent CDN fallback, CONTENT §8.1).
##
## The layering rule (CONTENT §7). After the platform says a pack is there, the transport reads the
## pack's directory fresh (a platform path is re-resolved on every call and never persisted: Apple's
## `url(for:)` changes per launch, Play's path carries the versionCode) and hands the engine a
## baseline, exactly the shape PKeyPackEmbeddedTransport gives for `res://pkey_packs/`:
##
##   container   `<dir>/X` with its marker `<dir>/X.pkey.json` beside it (one marker per directory)
##   tree        `<dir>/` with `<dir>/.pkey/pack.json`
##
## measured off the main thread (SHA-256 and size, or the treeDigest over every file). The engine
## then verifies the marker with the release-record verifier and matches the bytes against the
## signed record (PKeyPackEngine.load_state's platform list, `_ensure_platform`); a platform's own
## hashes are never trusted (CONTENT §12). The transport never writes into the platform's
## directory.
##
## A platform transport carries the packs in `packs` (pack ids). It makes no range requests, so the
## engine never plans `chunk` through it (`supports_range()` false, P4-11), and it fetches no
## record or object: the engine's CDN transport still fetches the signed record by hash.
##
##   var t := PKeyPackAppleBaTransport.new()
##   t.packs = ["diceroll.foes"]
##   PolarisKey.update.packs.platform_transport = t     # before start()
##
## `floats()`: whether a release the platform delivers may be newer than the build's pin (CONTENT
## §6.6, TRANSPORT_FLOATS): Apple-hosted packs and Steam content-only builds float, Play asset
## packs ship with the app bundle and stay pinned.

## Download progress of a pack, in the platform's bytes.
signal pack_progress(pack_id: String, bytes: int, total: int)

## A single-file payload's marker suffix and a tree's marker path (WIRE-CONTRACT-V4 §3.7).
const MARKER_SUFFIX := ".pkey.json"
const TREE_MARKER := ".pkey/pack.json"

## The pack ids this transport carries on this install.
var packs: Array = []
## The app's content level (`contentApi`), from the content stamp unless set; -1: unknown.
var content_api := -1


## The feature this transport proves (`packs.transport.*`).
func feature() -> String:
	return ""


func floats() -> bool:
	return true


func carries(pack_id: String) -> bool:
	return packs.has(pack_id)


## PKeyResult.success() when the platform can deliver packs here, else the typed unsupported
## result (`runtime` off the platform, `dependency` without the plugin, `outlet` where the store
## does not deliver this build). Synchronous.
func availability() -> PKeyResult:
	return PKeyResult.unsupported(feature(), PKeyConstants.UnsupportedReason.RUNTIME, "No platform transport here.")


## Where the platform holds `pack_id` NOW: {dir} or {missing: true}, or {result: PKeyResult} when
## the platform could not be asked. A coroutine; subclasses override it.
func _locate(_pack_id: String) -> Dictionary:
	return {"missing": true}


## Ask the platform to make `pack_id` available. A coroutine returning a PKeyResult; subclasses
## override it.
func _fetch(_pack_id: String) -> PKeyResult:
	return availability()


## The baseline of `pack_id` as the platform holds it now: {marker, location, payload, packId,
## transport, floats}, {location, error} when its directory cannot be read as a pack, or {} when
## the platform holds no copy (or cannot be asked). A coroutine.
func baseline(pack_id: String) -> Dictionary:
	if not availability().ok:
		return {}
	var loc: Dictionary = await _locate(pack_id)
	if not loc.has("dir"):
		return {}
	var dir := String(loc["dir"]).trim_suffix("/")
	var b: Dictionary = await PKeyPackJob.run(probe.bind(dir), "PolarisKey platform pack")
	if b.is_empty():
		return {}
	b["packId"] = pack_id
	b["transport"] = id()
	b["floats"] = floats()
	return b


## Every carried pack the platform holds now, as baselines (see baseline()). Empty when the
## platform is unavailable. A coroutine.
func installed() -> Array:
	var out: Array = []
	if not availability().ok:
		return out
	for p in packs:
		var b: Dictionary = await baseline(String(p))
		if not b.is_empty():
			out.append(b)
	return out


## Make `pack_id` available through the platform: success once it is there, else the platform's
## failure, or the typed unsupported result. A coroutine.
func ensure_pack(pack_id: String) -> PKeyResult:
	var gate := availability()
	if not gate.ok:
		return gate
	if not carries(pack_id):
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "%s does not carry %s." % [id(), pack_id])
	return await _fetch(pack_id)


## Read one pack directory (synchronous; run it off the main thread): a single container whose
## marker sits beside it, else a tree with `.pkey/pack.json`. {} when the directory holds neither
## (or does not exist); {location, error: "format"} when it is ambiguous or unreadable.
static func probe(dir: String) -> Dictionary:
	var l := PKeyPackStorage.list_dir(dir)
	if not l["ok"]:
		return {"location": dir, "error": "format"}
	var markers: Array = []
	for f in l["files"]:
		if String(f).ends_with(MARKER_SUFFIX):
			markers.append(String(f))
	if markers.size() > 1:
		return {"location": dir, "error": "format"}
	if markers.size() == 1:
		var payload_path := dir.path_join(markers[0].trim_suffix(MARKER_SUFFIX))
		var m := PKeyPackStorage.read_bytes(dir.path_join(markers[0]))
		var p := PKeyPackStorage.measure_file(payload_path)
		if not m["ok"] or m.has("missing") or not p["ok"]:
			return {"location": payload_path, "error": "format"}
		return {"marker": m["bytes"], "location": payload_path, "payload": {"kind": "file", "sha256": p["sha256"], "size": p["size"]}}
	var tm := PKeyPackStorage.read_bytes(dir.path_join(TREE_MARKER))
	if not tm["ok"]:
		return {"location": dir, "error": "format"}
	if tm.has("missing"):
		return {}
	var digest := PKeyPackStorage.directory_tree_digest(dir)
	if digest == "":
		return {"location": dir, "error": "format"}
	return {"marker": tm["bytes"], "location": dir, "payload": {"kind": "tree", "treeDigest": digest}}


## One frame of the main loop (no SceneTree: returns at once). A coroutine.
static func _frame() -> void:
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null:
		await tree.process_frame
