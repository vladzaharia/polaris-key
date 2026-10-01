class_name PKeyUpdate
extends RefCounted
## `PolarisKey.update`: today's version check and the appcast URL (sdk-node `update/client.ts`,
## the Python and Swift UpdateClient). The feed over Release's truth store, and no more: the
## outlet-aware decision, the signed feed and installing builds are wire v4 (P3-08, P3-10).
##
##   check(channel := "")          `GET /<p>/update/version[?channel=]` -> PKeyVersionCheck; emits
##                                 `update_available(check)` only when this build is behind. A
##                                 coroutine
##   appcast_url(channel, arch)    the Sparkle feed URL out of this session's discovery document,
##                                 or "" before discover() or with Update off. Godot has no
##                                 Sparkle; it exists for parity
##
## Usable before configure() (like `config`), so a signal connected early survives a later
## configure(); every call then answers `not-configured`.
##
## The channel. "" asks for the product's default (stable) and sends no `?channel=`. Anything else
## must be a channel name in the unified vocabulary (WIRE-CONTRACT-V3 §5.1): an alias is sent as
## its canonical name (never `staging`), `pr<n>` as `pr-<n>`, `pr` as this build's own `pr-<n>`
## (PKeyChannel.normalize_header). A malformed value (`1.2.3`, which the Worker refuses as a
## channel) is refused without a request.
##
## The bearer is forwarded when one is held (Release's `entitled` access mode needs it); a public
## feed ignores it. There is no throttle: the caller decides when to check (P1-10's DECIDE stage
## checks once per boot). A periodic caller must not let a failed check consume its interval.

## A check found a newer version than this build (PKeyOptions.version). Not emitted for an
## equal or older one, nor for a failed check.
signal update_available(check: PKeyVersionCheck)

var _core_ref: WeakRef = null


func attach(core: PKeyCore) -> void:
	_core_ref = weakref(core)


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## The newest build on `channel` and whether this build is behind it. A coroutine.
func check(channel := "") -> PKeyVersionCheck:
	var core := _core()
	if core == null:
		return PKeyVersionCheck.failed(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var off = core.require_service("update")
	if off != null:
		return PKeyVersionCheck.failed(off.code, off.message)
	var path := "update/version"
	if channel != "":
		var canonical = canonical_channel(channel, core.version)
		if canonical == null:
			return PKeyVersionCheck.failed(PKeyErrors.INVALID_OPTIONS, "channel must be a channel name (stable, beta, pr-<n>, dev or a manual channel matching %s), got '%s'." % [PKeyConstants.CHANNEL_NAME_PATTERN, channel])
		path += "?channel=%s" % PKeyUri.form(canonical)
	var r := await core.request("GET", path, null, core.tokens.has_token())
	var status: int = r.detail.get("status", 0) if r.detail is Dictionary else 0
	if status == 0:
		return PKeyVersionCheck.failed(r.code, r.message)
	if status == 403:
		var e: Dictionary = r.detail.get("error", {})
		var code: String = e.get("code", "")
		return PKeyVersionCheck.failed(StringName(code) if code != "" else PKeyErrors.FORBIDDEN, "This build is not entitled to that update channel.", status)
	if status < 200 or status >= 300:
		return PKeyVersionCheck.failed(PKeyErrors.NOT_FOUND, "update/version failed with status %d." % status, status)
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var body = parsed["value"] if parsed["ok"] else null
	if not (body is Dictionary) or not (body.get("version") is String) or body["version"] == "":
		return PKeyVersionCheck.failed(PKeyErrors.INVALID_RESPONSE, "update/version answered %d without a version." % status, status)
	var newest: String = body["version"]
	var result := PKeyVersionCheck.of(
		newest,
		body["tag"] if body.get("tag") is String else "",
		body["url"] if body.get("url") is String else "",
		PKeySemver.compare(core.version, newest) < 0,
		status,
	)
	if result.update_available:
		update_available.emit(result)
	return result


## The appcast URL from this session's discovery document (PKeyDiscovery.appcast_url_from), or ""
## before discover(), with Update off, without a published feed, or for a malformed channel.
func appcast_url(channel := "", arch := "") -> String:
	var core := _core()
	if core == null or core.discovery_manifest == null:
		return ""
	var c := ""
	if channel != "":
		var canonical = canonical_channel(channel, core.version)
		if canonical == null:
			return ""
		c = canonical
	return PKeyDiscovery.appcast_url_from(core.discovery_manifest, c, arch)


## `channel` as this SDK sends it (PKeyChannel.normalize_header), or null when it is not a channel
## name.
static func canonical_channel(channel: String, version: String) -> Variant:
	return PKeyChannel.normalize_header(channel, version)
