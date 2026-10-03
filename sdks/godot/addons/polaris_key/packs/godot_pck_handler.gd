class_name PKeyGodotPckHandler
extends PKeyPackHandler
## `godot.pck` (README §5.7, CONTENT §8.3; notes/A6 §4, notes/S-05 §5 (f)): a Godot resource pack,
## a container, activated at the next boot (`restart`). Its record's `formatVersion` is the PCK
## header's format version (WIRE-CONTRACT-V4 §2.5.1; `pkey release publish` signs it): v2 up to the
## version this engine writes itself, which is what it mounts (measured: 4.4.1 writes and mounts v2
## only; 4.7.2 writes v4 and mounts v2–v4). Any other version is `pack-type-unsupported` before a
## byte is fetched, and a payload whose header disagrees with its record is refused before commit.
##
## Before a rebuilt pack is committed (its whole-pack SHA-256 already equals the record's) the
## handler checks the PCK header (format v2–v4, no encryption, no sparse bundle; the engine at most
## the running one and inside the variant's `requires.engine`: `pck-engine-mismatch`) and the
## directory (the admission list over `handler.prefixes`: `pck-directory-refused` with the first
## refused path). A committed pack is mounted at the next boot from its own content-addressed path
## (`user://pkey/store/<sha256>.pck`) by PolarisKey.update.packs.mount(): in `mountOrder`, one
## per frame, after the same checks, with `replace_files=true` (S-05 §4.6: with `false` the pack's
## UIDs never register). It is never overwritten and never mounted twice in a process.

## The packs this boot runs, by id: activated at load, or committed (or rolled back) before
## their id was mounted in this process. PolarisKey.update.packs.mount() mounts them.
var to_mount := {}
## Pack ids mounted in this process: a later commit of one activates at the next boot.
var mounted := {}


func _init() -> void:
	type = "godot.pck"
	layout = "container"
	activation = "restart"


func supports(format_version: int) -> bool:
	return format_version >= 2 and format_version <= max_format_version()


## The newest PCK format this engine mounts: the one it writes (PCKPacker, probed once), or v2,
## which every Godot 4 mounts, when the probe cannot run.
static func max_format_version() -> int:
	var v := PKeyPck.helper_version()
	return v if v >= 2 else 2


static func _variant_engine(variant: Dictionary) -> Variant:
	var r = variant.get("requires")
	if r is Dictionary and r.get("engine") is String:
		return r["engine"]
	return null


static func _prefixes(record: Dictionary) -> Array:
	var h = record.get("handler")
	if h is Dictionary and h.get("prefixes") is Array:
		return h["prefixes"]
	return []


## The header and directory checks over a pack's bytes: {ok, count, warning} or {ok: false,
## code, detail, path?}. Thread-safe (call PKeyPck.warm() on the main thread first).
static func check(source: PKeyByteSource, record: Dictionary, variant: Dictionary) -> Dictionary:
	var dir := PKeyPck.read_directory(source)
	if not dir["ok"]:
		return {"ok": false, "code": PKeyPck.DIRECTORY_REFUSED, "detail": dir.get("detail", ""), "path": dir.get("path", "")}
	# A verified record always names its formatVersion; a bare directory check passes none.
	var fv = record.get("formatVersion")
	if record.has("formatVersion") and (not (fv is int or fv is float) or int(fv) != int(dir["header"]["formatVersion"])):
		return {"ok": false, "code": PKeyPck.DIRECTORY_REFUSED, "detail": "the PCK header is format v%d; the record says v%s" % [int(dir["header"]["formatVersion"]), str(int(fv)) if (fv is int or fv is float) else str(fv)]}
	var why := PKeyPck.engine_check(dir["header"], _variant_engine(variant))
	if why != "":
		return {"ok": false, "code": PKeyPck.ENGINE_MISMATCH, "detail": why}
	var c := PKeyPck.directory_check(source, dir, _prefixes(record))
	if not c["ok"]:
		var first: Dictionary = c["errors"][0]
		var lines := PackedStringArray()
		for e in c["errors"]:
			lines.append("%s: %s" % [e["path"], e["why"]])
		return {"ok": false, "code": PKeyPck.DIRECTORY_REFUSED, "detail": "; ".join(lines), "path": first["path"]}
	return {"ok": true, "count": c["count"], "warning": c["warning"]}


func check_output(source: PKeyByteSource, record: Dictionary, variant: Dictionary) -> Dictionary:
	return check(source, record, variant)


## A release a delegated content key signed is never mounted (plans/P4-19.md §2.5: no delegated
## file reaches `load_resource_pack`). Step 16 already refuses a delegated `godot.pck`; this holds
## even if a stored install claimed otherwise.
func activate(install: Dictionary) -> void:
	if install.has("delegation"):
		push_warning("PolarisKey: %s carries a delegation; a delegated release is never mounted." % install.get("packId", ""))
		return
	to_mount[install["packId"]] = install


## A revoked install (plans/P4-13.md §2.5) not yet mounted leaves this boot's mount. A mounted
## pack cannot be unmounted; it is refused from the next boot on.
func withdraw(install: Dictionary) -> void:
	var cur = to_mount.get(install["packId"])
	if cur is Dictionary and cur["recordSha256"] == install["recordSha256"] and not mounted.has(install["packId"]):
		to_mount.erase(install["packId"])


## A restart install may join this boot while its id has not been mounted in this process.
func can_activate_now(install: Dictionary) -> bool:
	return not mounted.has(install["packId"])
