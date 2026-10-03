class_name PKeyAudioBankHandler
extends PKeyPackHandler
## `audio.bank` (CONTENT §4.2; P4-16): a tree of FMOD `.bank` or Wwise `.bnk` files plus a
## `bank.json` descriptor at its root, format version 1. Not built in: the game registers it with
## the middleware it runs, and the callables that load and unload banks through it (the FMOD or
## Wwise integration is the game's; this handler only checks versions and places files):
##
##   PolarisKey.update.packs.register_handler(PKeyAudioBankHandler.new({
##       "middleware": "fmod", "version": "2.02.22",
##       "reload": func(paths: PackedStringArray): ...,   # present => hot, else restart
##       "unload": func(paths: PackedStringArray): ...}))
##
## `bank.json` (strict JSON object, at most 65,536 bytes): `middleware` (a token), `version`
## (`major.minor[.patch]`), optional `banks` (distinct index paths other than `bank.json`, in load
## order; default every other file in index order). The check (after the v1 tree rule): a
## missing or malformed descriptor is `descriptor`; another middleware, or another major.minor
## than the host's, is `middleware` (`pack-type-check-failed`, path `bank.json`). A bank is never
## mounted with load_resource_pack (a Godot audio pack ships as a godot.pck instead).

const DESCRIPTOR := "bank.json"
const MAX_DESCRIPTOR_BYTES := 65536
const _TOKEN := "\\A[a-z][a-z0-9-]{0,31}\\z"
const _VERSION := "\\A([0-9]{1,9})\\.([0-9]{1,9})(?:\\.[0-9]{1,9})?\\z"

var middleware := ""
var version := ""
var format_versions: Array = [1]
var reload := Callable()
var unload := Callable()
## Active banks by pack id: {location, paths}.
var _active := {}


func _init(opts: Dictionary = {}) -> void:
	type = "audio.bank"
	layout = "tree"
	middleware = String(opts.get("middleware", ""))
	version = String(opts.get("version", ""))
	if opts.get("format_versions") is Array:
		format_versions = opts["format_versions"]
	if opts.get("reload") is Callable:
		reload = opts["reload"]
	if opts.get("unload") is Callable:
		unload = opts["unload"]
	activation = "hot" if reload.is_valid() else "restart"
	# An invalid host configuration would refuse every pack; instead the handler is not valid,
	# so register_handler() returns false (and the type stays pack-type-unsupported).
	if RegEx.create_from_string(_TOKEN).search(middleware) == null or _major_minor(version).is_empty():
		push_error("PolarisKey: PKeyAudioBankHandler needs a middleware token and a major.minor[.patch] version (got %s %s); it was not registered." % [middleware, version])
		type = ""


func supports(format_version: int) -> bool:
	return format_versions.has(format_version)


static func _major_minor(v: String) -> PackedInt64Array:
	var m := RegEx.create_from_string(_VERSION).search(v)
	if m == null:
		return PackedInt64Array()
	return PackedInt64Array([int(m.get_string(1)), int(m.get_string(2))])


## The check over the index paths and the descriptor's bytes (null: no `bank.json`), against
## the host's middleware and version: {ok: true, banks} or {ok: false, code, detail, path}.
static func check_descriptor(paths: Array, descriptor: Variant, host_middleware: String, host_version: String) -> Dictionary:
	if not (descriptor is PackedByteArray) or descriptor.size() > MAX_DESCRIPTOR_BYTES:
		return type_refusal("descriptor", DESCRIPTOR)
	var r := PKeyJson.parse_bytes(descriptor)
	if not r["ok"] or not (r["value"] is Dictionary):
		return type_refusal("descriptor", DESCRIPTOR)
	var d: Dictionary = r["value"]
	if not (d.get("middleware") is String) or RegEx.create_from_string(_TOKEN).search(d["middleware"]) == null:
		return type_refusal("descriptor", DESCRIPTOR)
	if not (d.get("version") is String) or _major_minor(d["version"]).is_empty():
		return type_refusal("descriptor", DESCRIPTOR)
	var in_index := {}
	for p in paths:
		in_index[p] = true
	var banks: Array = []
	if d.has("banks"):
		if not (d["banks"] is Array) or d["banks"].is_empty():
			return type_refusal("descriptor", DESCRIPTOR)
		var seen := {}
		for b in d["banks"]:
			if not (b is String) or b == DESCRIPTOR or not in_index.has(b) or seen.has(b):
				return type_refusal("descriptor", DESCRIPTOR)
			seen[b] = true
			banks.append(b)
	else:
		for p in paths:
			if p != DESCRIPTOR:
				banks.append(p)
	if d["middleware"] != host_middleware or _major_minor(d["version"]) != _major_minor(host_version):
		return type_refusal("middleware", DESCRIPTOR)
	return {"ok": true, "banks": banks}


## The check over a tree directory (staged or installed).
func check_dir(dir: String) -> Dictionary:
	var paths = tree_files(dir)
	if paths == null:
		return type_refusal("unreadable", "")
	var desc = null
	if paths.has(DESCRIPTOR):
		var f := FileAccess.open(dir.path_join(DESCRIPTOR), FileAccess.READ)
		if f == null:
			return type_refusal("unreadable", DESCRIPTOR)
		var n := int(f.get_length())
		desc = f.get_buffer(mini(n, MAX_DESCRIPTOR_BYTES + 1))
		f.close()
	return check_descriptor(paths, desc, middleware, version)


func check_payload(dir: String, _record: Dictionary, _variant: Dictionary) -> Dictionary:
	var r := check_dir(dir)
	return {"ok": true} if r["ok"] else r


func activate(install: Dictionary) -> void:
	var id: String = install["packId"]
	var loc := String(install["location"])
	var r := check_dir(loc)
	if not r["ok"]:
		push_warning("PolarisKey: %s's audio banks could not be read at activation (%s)." % [id, r["detail"]])
		return
	var cur = _active.get(id)
	if cur is Dictionary and cur["location"] != loc:
		_unload(id)
	var abs := PackedStringArray()
	for b in r["banks"]:
		abs.append(ProjectSettings.globalize_path(loc.path_join(b)))
	_active[id] = {"location": loc, "paths": abs}
	if reload.is_valid():
		reload.call(abs)


func _unload(id: String) -> void:
	var cur = _active.get(id)
	if not (cur is Dictionary):
		return
	_active.erase(id)
	if unload.is_valid():
		unload.call(cur["paths"])


func deactivate(install: Dictionary) -> void:
	var id: String = install["packId"]
	var cur = _active.get(id)
	if cur is Dictionary and cur["location"] == install["location"]:
		_unload(id)


## The active release's bank paths (absolute, load order), or [].
func banks(pack_id: String) -> PackedStringArray:
	var cur = _active.get(pack_id)
	return cur["paths"] if cur is Dictionary else PackedStringArray()
