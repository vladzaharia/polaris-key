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
##   fetch(target, to, opts := {}) the verified download (`release.fetch`, SP-25; sdk-node
##                                `client.release.fetch`): one build's payload streamed to `to`,
##                                resumable, checked against the VERIFIED release record. A
##                                coroutine -> PKeyResult (below)
##
## With Release off, changelog() answers `service-unavailable` without a request and the two
## builders return "" (D-21: a client not told the service exists must not reach for it).
## Usable before configure() (every call then refuses).
##
## download_url() is the legacy `release/dl` route and is only built. fetch() never uses it: its URL
## is discovery's `distribution.endpoints.builds` template (else Release's `builds` alias,
## builds_url()), and the bytes go through PKeyDownload (credential-safe redirects, no gzip, Range).
##
## fetch(target, to, opts):
##   target   what to download, one of: a PKeyUpdateCheck whose decision is `binary` (its verified
##            record and build); a `binary` decision Dictionary ({action, release: {sha256},
##            build}); {record: <verified record doc>, build?}; {sha256: <record hash>, build?}.
##            A hash is resolved through PolarisKey.update.release_record (fetched and verified).
##            Without `build`, the record's only build is used
##   to       the destination file; bytes land in `<to>.part` and are renamed only once verified
##   opts     timeout (seconds, one budget; default PKeyDownload.DEFAULT_TIMEOUT), progress
##            (Callable(received, total))
## The request carries the X-PKey-* headers and, when the build URL is the control plane's own
## origin, the device bearer (gated delivery needs both); PKeyDownload drops the bearer on any
## cross-origin redirect. A resume sends `Range` and `If-Range: "<sha256>"`. A 403
## `attestation_required` attests and retries once (PKeyCore.with_attestation); any other refusal
## is reported by the body's own code (`download_auth_required`, `not_entitled`, …) and leaves no
## file. Size and SHA-256 are checked against the record's payload artifact before the rename: a
## short body keeps the part for the next call (`network`), wrong bytes delete it
## (`payload-mismatch`). ok detail: {path, size, sha256, version, build}.
##
## download_artifact(request) is the shared verified download under fetch() and the updater's
## sidecar and APK paths (PKeySidecarSwap.stage, PKeyApkUpdate.run).
##
## The bearer is forwarded when one is held, so Release's `entitled` access mode can authenticate;
## a refusal is reported by the body's own code, never retried.

var _core_ref: WeakRef = null
var _update_ref: WeakRef = null


## `update` (PKeyUpdate) resolves a record hash for fetch(); optional.
func attach(core: PKeyCore, update: Object = null) -> void:
	_core_ref = weakref(core)
	_update_ref = weakref(update) if update != null else null


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## The published release list, newest first. A coroutine.
func changelog() -> PKeyChangelogResult:
	var core := _core()
	if core == null:
		return PKeyChangelogResult.failed(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var off = core.require_service("release", PKeyConstants.Feature.RELEASE_CHANGELOG)
	if off != null:
		var refused := PKeyChangelogResult.failed(off.code, off.message)
		refused.detail = off.detail
		return refused
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


## The verified download of one build's payload (see the class doc). A coroutine.
func fetch(target: Variant, to: String, opts: Dictionary = {}) -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	if to == "":
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "fetch() needs a destination file.")
	# 1. The verified record and the build.
	var record = null
	var build_id := ""
	var hash := ""
	if target is PKeyUpdateCheck:
		var check := target as PKeyUpdateCheck
		if check.decision.get("action") != "binary":
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "This update decision is not a binary download.")
		record = check.record_doc
		build_id = String(check.decision.get("build", ""))
		if not (record is Dictionary) and check.decision.get("release") is Dictionary:
			hash = String(check.decision["release"].get("sha256", ""))
	elif target is Dictionary:
		var t: Dictionary = target
		if t.get("action") == "binary":
			build_id = String(t.get("build", ""))
			hash = String(t["release"].get("sha256", "")) if t.get("release") is Dictionary else ""
			if hash == "":
				return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "This decision names no release record hash.")
		elif t.get("record") is Dictionary:
			record = t["record"]
			build_id = String(t["build"]) if t.get("build") is String else ""
		elif t.get("sha256") is String:
			hash = t["sha256"]
			build_id = String(t["build"]) if t.get("build") is String else ""
		else:
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "fetch() needs a binary decision, a record or a record hash.")
	else:
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "fetch() needs a binary decision, a record or a record hash.")
	if not (record is Dictionary):
		var update: Object = _update_ref.get_ref() if _update_ref != null else null
		if update == null:
			return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "No update client to resolve release record %s." % hash)
		var rr = await update.release_record(hash)
		if not rr.ok:
			return PKeyResult.failure(rr.code, rr.message, rr.detail)
		record = rr.record_doc
	var builds: Array = record["builds"] if record.get("builds") is Array else []
	if build_id == "" and builds.size() == 1 and builds[0] is Dictionary:
		build_id = String(builds[0].get("id", ""))
	var version := String(record.get("version", ""))
	if PKeySidecarSwap.build_of(record, build_id).is_empty():
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, ("Release %s has no build %s." % [version, build_id]) if build_id != "" else ("Release %s has several builds; name one." % version))
	var art = PKeySidecarSwap.payload_of(record, build_id)
	if not (art is Dictionary) or not _is_hex64(String(art["sha256"])):
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "Build %s names no payload artifact." % build_id)
	# 2. The URL, from discovery.
	var url := builds_url(core, version, build_id)
	if url == "" and core.discovery_manifest == null:
		await core.discover()
		url = builds_url(core, version, build_id)
	if url == "":
		return PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "Discovery names no distribution builds route for this product.")
	# 3. The bearer only to the control plane's own origin.
	var h := core.headers()
	var same_origin: bool = PKeyTransport.parse_url(url).get("origin", "") == PKeyTransport.parse_url(core.base_url).get("origin", "-")
	if same_origin and core.tokens != null and core.tokens.has_token():
		h["Authorization"] = "Bearer %s" % core.tokens.current()
	var r := await download_artifact({
		"transport": core.transport,
		"url": url,
		"headers": h,
		"artifact": art,
		"to": to,
		"timeout": opts.get("timeout", PKeyDownload.DEFAULT_TIMEOUT),
		"progress": opts.get("progress", Callable()),
		"with_attestation": core.with_attestation,
	})
	if not r.ok:
		return r
	return PKeyResult.success({"path": r.detail["path"], "size": r.detail["size"], "sha256": r.detail["sha256"], "version": version, "build": build_id})


## The download URL of build `build_id` of release `version`: discovery's
## `distribution.endpoints.builds`, else `release.endpoints.builds` (never the R2-only `blobs`
## route, plans/P3-01.md §2.4), with `{selector}` and `{buildId}` percent-encoded; "" without one.
static func builds_url(core: PKeyCore, version: String, build_id: String) -> String:
	if core == null or core.discovery_manifest == null or version == "" or build_id == "":
		return ""
	var t := PKeyUpdate._endpoint(core.discovery_manifest, "distribution", "builds")
	if t == "":
		t = PKeyUpdate._endpoint(core.discovery_manifest, "release", "builds")
	if t == "":
		return ""
	t = t.replace("{selector}", PKeyUri.component(version))
	return PKeyUpdate._expand(core, t, "buildId", build_id)


## The shared verified download. `request`: {transport, url, headers, artifact: {sha256, size},
## to, timeout?, progress?: Callable(received, total), with_attestation?: Callable(call)}. Streams
## into `<to>.part` through PKeyDownload (resumed with Range and If-Range: "<sha256>"), checks size
## and SHA-256 against the artifact off the main thread, then replaces `to` with it. A mismatch
## removes the part (`payload-mismatch`); a download failure keeps the transport's or the
## server's code (a short body keeps the part to resume). ok detail: {path: to, size, sha256,
## status, resumed}. A coroutine.
static func download_artifact(request: Dictionary) -> PKeyResult:
	var art = request.get("artifact")
	if not (art is Dictionary) or not (art.get("sha256") is String) or not PKeyClaims.is_number(art.get("size")):
		return PKeyResult.failure(PKeyErrors.RECORD_MISMATCH, "The verified record names no payload artifact.")
	var size := int(art["size"])
	var sha := String(art["sha256"]).to_lower()
	var to := String(request.get("to", ""))
	var opts := {
		"expected_size": size,
		"timeout": float(request["timeout"]) if PKeyClaims.is_number(request.get("timeout")) else PKeyDownload.DEFAULT_TIMEOUT,
		"if_range": "\"%s\"" % sha,
	}
	if request.get("progress") is Callable and (request["progress"] as Callable).is_valid():
		opts["progress"] = request["progress"]
	var transport: PKeyTransport = request.get("transport")
	var url := String(request.get("url", ""))
	var headers: Dictionary = request.get("headers", {})
	var fetch := func() -> PKeyResult: return await PKeyDownload.fetch(transport, url, to, headers, opts)
	var attest: Callable = request.get("with_attestation", Callable())
	var r: PKeyResult
	if attest.is_valid():
		r = await attest.call(fetch)
	else:
		r = await fetch.call()
	if not r.ok:
		return r
	var part: String = r.detail["path"]
	if not await PKeySlots.verify_file(part, size, sha):
		DirAccess.remove_absolute(part)
		return PKeyResult.failure(PKeyErrors.PAYLOAD_MISMATCH, "The downloaded bytes do not match the record's size and SHA-256.")
	if FileAccess.file_exists(to):
		DirAccess.remove_absolute(to)
	if DirAccess.rename_absolute(part, to) != OK:
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The verified download could not be moved to %s." % to, {"reason": "rename"})
	return PKeyResult.success({"path": to, "size": size, "sha256": sha, "status": r.detail.get("status", 0), "resumed": r.detail.get("resumed", false)})


## Lowercase hex, 64 digits (a SHA-256).
static func _is_hex64(s: String) -> bool:
	if s.length() != 64:
		return false
	for c in s:
		if not ("0123456789abcdef".contains(c)):
			return false
	return true
