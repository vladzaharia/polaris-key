class_name PKeyRelease
extends RefCounted
## `PolarisKey.release`: the software truth store's public face (sdk-node `release/client.ts`, the
## Python ReleaseClient). Thin, unsigned JSON: a release note is not a grant, so nothing here is
## verified.
##
##   changelog()                  `GET /<p>/release/changelog` -> PKeyChangelogResult (`entries`:
##                                Array[PKeyChangelogEntry], newest first). A coroutine
##   install_url()                `<base>/<p>/release/install.sh`, built, not fetched
##   download_url(version, binary, arch, checksum := false, dmg := false)
##                                `<base>/<p>/release/dl/<version>/<binary>-<arch>[.dmg]`, each
##                                segment encoded as JS encodeURIComponent does (PKeyUri.component,
##                                byte-identical to sdk-node), `?checksum=sha256` when asked. The
##                                Worker requires an arch suffix (arm64, aarch64, x86_64, amd64)
##
## With Release off, changelog() answers `service-unavailable` without a request and the two
## builders return "" (D-21: a client not told the service exists must not reach for it).
## Usable before configure() (every call then refuses).
##
## Only URLs are built here. Fetching an artifact needs PKeyTransport's credential-safe redirects
## and `accept_gzip = false` (gzip breaks Range): P3-10 downloads through download_url().
##
## The bearer is forwarded when one is held, so Release's `entitled` access mode can authenticate;
## a refusal is reported by the body's own code, never retried.

var _core_ref: WeakRef = null


func attach(core: PKeyCore) -> void:
	_core_ref = weakref(core)


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## The published release list, newest first. A coroutine.
func changelog() -> PKeyChangelogResult:
	var core := _core()
	if core == null:
		return PKeyChangelogResult.failed(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var off = core.require_service("release")
	if off != null:
		return PKeyChangelogResult.failed(off.code, off.message)
	var r := await core.request("GET", "release/changelog", null, core.tokens.has_token())
	var status: int = r.detail.get("status", 0) if r.detail is Dictionary else 0
	if status == 0:
		return PKeyChangelogResult.failed(r.code, r.message)
	if status == 401 or status == 403:
		# Nested v3 (`{"error":{"code":…}}`, the entitled mode) or flat (`{"error":"…"}`): the
		# refusal names itself (PKeyErrors.read_body reads both).
		var e: Dictionary = r.detail.get("error", {})
		var code: String = e.get("code", "")
		if code == "":
			code = PKeyErrors.UNAUTHORIZED if status == 401 else PKeyErrors.FORBIDDEN
		var why := "this feed needs a usable licence" if status == 401 else "this build is not entitled to that feed"
		return PKeyChangelogResult.failed(StringName(code), "release/changelog refused: %s." % why, status)
	if status < 200 or status >= 300:
		return PKeyChangelogResult.failed(PKeyErrors.NOT_FOUND, "release/changelog failed with status %d." % status, status)
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return PKeyChangelogResult.failed(PKeyErrors.INVALID_RESPONSE, "release/changelog answered %d with a body that is not a JSON object." % status, status)
	var result := PKeyChangelogResult.new(true)
	result.status = status
	var raw = parsed["value"].get("entries")
	if raw is Array:
		for item in raw:
			if item is Dictionary:
				result.entries.append(PKeyChangelogEntry.from_dict(item))
	return result


## The canonical install-script URL, or "" with Release off.
func install_url() -> String:
	var core := _core()
	if core == null or not core.enabled("release"):
		return ""
	return core.url("release/install.sh")


## The artifact URL, or "" with Release off. Built, not fetched.
func download_url(version: String, binary: String, arch: String, checksum := false, dmg := false) -> String:
	var core := _core()
	if core == null or not core.enabled("release"):
		return ""
	var name := "%s-%s%s" % [binary, arch, ".dmg" if dmg else ""]
	var url := core.url("release/dl/%s/%s" % [PKeyUri.component(version), PKeyUri.component(name)])
	return url + "?checksum=sha256" if checksum else url
