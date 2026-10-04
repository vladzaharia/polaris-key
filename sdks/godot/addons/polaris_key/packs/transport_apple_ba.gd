class_name PKeyPackAppleBaTransport
extends PKeyPackPlatformTransport
## `apple-ba` (P5-08; CONTENT §7, notes/S-01): Apple-hosted Background Assets through P5-05's
## PKeyApple (`ensure_packs`, `pack_path`, `pack_progress`). iOS only: macOS has no binding (P5-05
## Out), so there, as off iOS everywhere, it answers unsupported `runtime`; `dependency` on iOS
## without the GDExtension; the plugin's `version` (below iOS 26.4) or `outlet` (a build without
## the Background Assets extension, such as a sideload IPA) when it says so.
##
## One asset pack per content level, because a live asset-pack version switches every installed
## app version (CONTENT §6.6): the asset pack of `diceroll.foes` at contentApi 3 is
## `diceroll-foes-c3` (`asset_pack_id`, the same mapping as `@polaris-key/manifest`'s
## `assetPackId`). `pkey transport apple-ba package` puts the pack's payload and marker under
## `pkey/<asset pack id>/` in the asset pack, a unique prefix in the namespace Apple merges every
## pack into. That directory is resolved with `url(for:)` (PKeyApple.pack_path) on every call and
## never persisted; `url(for:)` returns a path even for a missing file, so the plugin's `exists`
## flag decides. An update replaces the files at the same path, so a new release is read at the
## next launch (S-01: update while mounted is safe for the running session).

## App Store Connect's asset-pack id grammar (notes/S-01 §5) and length cap.
const ASSET_PACK_ID_PATTERN := "^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$"
const ASSET_PACK_ID_MAX := 64
## The prefix every pack's files sit under inside its asset pack.
const PREFIX := "pkey"

## The PKeyApple facade (PKeyApple.shared() when null).
var apple: PKeyApple = null


func _init(p_apple: PKeyApple = null) -> void:
	apple = p_apple


func _apple() -> PKeyApple:
	if apple == null:
		apple = PKeyApple.shared()
	return apple


func id() -> String:
	return PKeyConstants.Transport.APPLE_BA


func feature() -> String:
	return PKeyConstants.Feature.PACKS_TRANSPORT_APPLE


func floats() -> bool:
	return true


## The asset pack `pack_id` needs at content level `level`: `.` becomes `-`, then `-c<level>`;
## "" when the result is not an App Store Connect asset-pack id (or `level` is unknown).
static func asset_pack_id(pack_id: String, level: int) -> String:
	if level < 0:
		return ""
	var re := RegEx.create_from_string("^[a-z0-9.-]+$")
	if re.search(pack_id) == null:
		return ""
	var out := "%s-c%d" % [pack_id.replace(".", "-"), level]
	if out.length() > ASSET_PACK_ID_MAX or RegEx.create_from_string(ASSET_PACK_ID_PATTERN).search(out) == null:
		return ""
	return out


func availability() -> PKeyResult:
	return _apple().availability(feature())


func _dir_path(pack_id: String) -> String:
	var asset := asset_pack_id(pack_id, content_api)
	return "" if asset == "" else "%s/%s" % [PREFIX, asset]


func _locate(pack_id: String) -> Dictionary:
	var rel := _dir_path(pack_id)
	if rel == "":
		return {"missing": true}
	var r: PKeyResult = await _apple().pack_path(rel)
	if not r.ok:
		return {"result": r}
	var d = r.detail
	if not (d is Dictionary) or d.get("exists") != true or not (d.get("path") is String) or String(d["path"]) == "":
		return {"missing": true}
	return {"dir": String(d["path"])}


func _fetch(pack_id: String) -> PKeyResult:
	var rel := _dir_path(pack_id)
	if rel == "":
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "%s has no Apple asset-pack id at content level %d (the id must match %s, at most %d characters)." % [pack_id, content_api, ASSET_PACK_ID_PATTERN, ASSET_PACK_ID_MAX])
	var asset := rel.get_file()
	var a := _apple()
	var forward := func(pid: String, bytes: int, total: int) -> void:
		if pid == asset:
			pack_progress.emit(pack_id, bytes, total)
	a.pack_progress.connect(forward)
	var r: PKeyResult = await a.ensure_packs([{"id": asset, "path": rel}])
	a.pack_progress.disconnect(forward)
	if not r.ok:
		return r
	var listed = r.detail.get("packs") if r.detail is Dictionary else null
	if listed is Array:
		for p in listed:
			if p is Dictionary and p.get("id") == asset and p.get("ready") != true:
				return PKeyResult.failure(PKeyErrors.PLATFORM_ERROR, "Background Assets could not make %s ready: %s." % [asset, str(p.get("error", "unknown"))], p)
	return PKeyResult.success({"assetPack": asset})
