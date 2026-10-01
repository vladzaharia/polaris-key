class_name PKeyUpdate
extends RefCounted
## `PolarisKey.update`: the wire v4 update decision (plans/P3-01.md §2.5, §2.8; P3-08) and
## today's v3 version check (sdk-node `update/client.ts`, the Python and Swift UpdateClient).
##
##   decide(channel, staged, skip_version)  the signed, outlet-aware decision: feed (signed by
##                                 the product key) and pinned release record (signed by a CI
##                                 release key), verified in pure GDScript, then
##                                 PKeyDecision.decide_update -> PKeyUpdateCheck. Emits
##                                 `update_available(check)` when the decision is one to show
##                                 (boot "optional"). A coroutine
##   feed(channel)                 steps 1–9 alone -> PKeyUpdateFeed. A coroutine
##   release_record(sha256)        one record by hash -> PKeyReleaseRecordResult. A coroutine
##   check(channel := "")          v3: `GET /<p>/update/version[?channel=]` -> PKeyVersionCheck;
##                                 emits `update_available(check)` only when this build is
##                                 behind. Informational; fall back to it when decide() answers
##                                 `service-unavailable` (an older Worker). A coroutine
##   appcast_url(channel, arch)    the Sparkle feed URL out of this session's discovery document,
##                                 or "" before discover() or with Update off. Godot has no
##                                 Sparkle; it exists for parity
##
## Usable before configure() (like `config`), so a signal connected early survives a later
## configure(); every call then answers `not-configured`.
##
## The decision's inputs are gathered here and handed to the pure functions: the installed build
## from PolarisKey.build_info() (the export stamp: version, build, platform, arch, engine, and
## format when stamped; the project's settings without a stamp), the outlet through
## PKeyDecision.resolve_update_outlet (PKeyOptions.update_outlet wins, else the stamp's outlet,
## else `unknown`, which is never offered an update), the methods from
## PKeyOptions.update_methods, the install id (the device id), and the effective clock
## max(system, highWaterMark). The channel argument is the REQUESTED name; the answer's
## `channel` is the canonical one the verified feed claims, which keys the cache and the floors.
## Feeds and records persist in managed.json's `feeds` and `releaseRecords` slices (signed
## artifacts only; every floor is re-derived on load). Ed25519 runs on a WorkerThreadPool task
## where the build has threads, and in frame slices where it has none (web), so a decision never
## stalls the frame that draws the first scene.
##
## The v3 channel. "" asks for the product's default (stable) and sends no `?channel=`. Anything
## else must be a channel name in the unified vocabulary (WIRE-CONTRACT-V3 §5.1): an alias is
## sent as its canonical name (never `staging`), `pr<n>` as `pr-<n>`, `pr` as this build's own
## `pr-<n>` (PKeyChannel.normalize_header). A malformed value (`1.2.3`, which the Worker refuses
## as a channel) is refused without a request.
##
## The bearer is forwarded when one is held (Release's `entitled` access mode needs it); a public
## feed ignores it. There is no throttle: the caller decides when to check (P1-10's DECIDE stage
## checks once per boot). A periodic caller must not let a failed check consume its interval.

## Something to show the player. From decide(): a PKeyUpdateCheck whose decision is code-ready,
## binary, store, a mandatory platform answer, or blocked (boot "optional"); never `none`, never
## a failure. From the v3 check(): a PKeyVersionCheck that found a newer version than this build
## (PKeyOptions.version). Test the type (`result is PKeyUpdateCheck`) when connecting both.
signal update_available(result: PKeyResult)

## The record bound of plans/P3-01.md §2.5 step 12: a body over it cannot be a record any feed
## pins.
const MAX_RECORD_JWS_BYTES := 88844

var _core_ref: WeakRef = null
var _busy := false
signal _finished


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


# ── Wire v4: the signed feed, the release record and the decision ───────────────────────────

## The decision for `channel` (the REQUESTED name; "" means this build's channel), a coroutine.
## `staged`: {version, channel} for an update the host staged and verified (its `channel` the
## PKeyUpdateCheck.channel it was staged under), or null. `skip_version`: the version the boot
## guard rolled back, or null. See PKeyUpdateCheck for the answer and its failures.
func decide(channel := "", staged: Variant = null, skip_version: Variant = null) -> PKeyUpdateCheck:
	var ready = await _begin()
	if ready is PKeyResult:
		_end()
		return PKeyUpdateCheck.failed(ready.code, ready.message, ready.detail)
	var flow := await PKeyUpdateFlow.run(_flow_opts(ready, channel, staged, skip_version))
	if not flow["ok"]:
		_end()
		var e: Dictionary = flow["error"]
		return PKeyUpdateCheck.failed(StringName(e["code"]), _message(e), e)
	var core: PKeyCore = ready["core"]
	if not core.cache.apply_update(flow["committed"], flow["records"]):
		push_warning("PolarisKey: the update slices could not be written (%s)." % str(core.last_store_error))
	_end()
	var result := PKeyUpdateCheck.of(flow)
	if result.boot == PKeyDecision.BOOT_OPTIONAL:
		update_available.emit(result)
	return result


## The channel feed this install holds for `channel` after fetching it (steps 1–9), a
## coroutine. A refused or missing answer falls back to the committed feed, as decide() does.
func feed(channel := "") -> PKeyUpdateFeed:
	var ready = await _begin()
	if ready is PKeyResult:
		_end()
		return PKeyUpdateFeed.failed(ready.code, ready.message, ready.detail)
	var core: PKeyCore = ready["core"]
	var step := await PKeyUpdateFlow.feed_step(_flow_opts(ready, channel, null, null))
	if not step["ok"]:
		_end()
		var e: Dictionary = step["error"]
		return PKeyUpdateFeed.failed(StringName(e["code"]), _message(e), e)
	# Records stay only while a committed feed pins them.
	var pinned := _pinned(step["committed"], core.update_platform())
	var records := {}
	for h in core.cache.release_records:
		if pinned.has(h):
			records[h] = core.cache.release_records[h]
	core.cache.apply_update(step["committed"], records)
	_end()
	return PKeyUpdateFeed.of(step["feed"], step["feed_source"], step["errors"])


## One release record by its lowercase hex SHA-256 (steps 11–16), a coroutine. When a committed
## feed's target for this platform pins the hash, the record is cross-checked against that pin
## and kept; otherwise only steps 12–14 run and nothing is kept.
func release_record(sha256: String) -> PKeyReleaseRecordResult:
	var ready = await _begin()
	if ready is PKeyResult:
		_end()
		return PKeyReleaseRecordResult.failed(ready.code, ready.message, ready.detail)
	var core: PKeyCore = ready["core"]
	var platform := core.update_platform()
	var pin = null
	for k in core.cache.feeds:
		var t = PKeyDecision.feed_target(core.cache.feeds[k]["feed"]["app"]["targets"], platform)
		if t is Dictionary and t["release"]["sha256"] == sha256:
			pin = {"deliverable": "app", "version": t["release"]["version"], "seq": t["release"]["seq"]}
			break
	var opts := {
		"release_keys": core.options.pinned_release_keys, "product_trust": core.trust.effective(),
		"expected_aud": core.product, "expected_hash": sha256, "offload": true,
	}
	if pin != null:
		opts["pin"] = pin
	var source := "cache"
	var held = core.cache.release_records.get(sha256)
	var r := {"ok": false, "step": "jws"}
	if held is Dictionary and pin != null:
		r = await PKeyReleaseRecord.verify_release_record(held["jws"], opts)
	var body = null
	if not r["ok"]:
		source = "network"
		var got: Dictionary = await ready["fetch_record"].call(sha256)
		if not got["ok"]:
			_end()
			return PKeyReleaseRecordResult.failed(StringName(got["code"]), "The release record could not be fetched (%s)." % got["code"])
		body = got["body"]
		r = await PKeyReleaseRecord.verify_release_record(body, opts)
		if not r["ok"]:
			_end()
			if r["step"] == PKeyReleaseRecord.STEP_CROSS_CHECK:
				return PKeyReleaseRecordResult.failed(PKeyErrors.RECORD_MISMATCH, "The release record does not match the feed's pin.")
			return PKeyReleaseRecordResult.failed(PKeyErrors.RECORD_REJECTED, "The release record was refused at step %s." % r["step"], {"code": String(PKeyErrors.RECORD_REJECTED), "detail": r["step"]})
	if pin != null and body != null:
		var records: Dictionary = core.cache.release_records.duplicate()
		records[sha256] = {"jws": (body as PackedByteArray).get_string_from_ascii() if body is PackedByteArray else body, "record": r["record"]}
		core.cache.apply_update(core.cache.feeds, records)
	_end()
	return PKeyReleaseRecordResult.of(sha256, r["record"], source, pin != null)


## Serialises decide(), feed() and release_record(): each is a read-modify-write of the update
## slices, so a second call waits for the first rather than overwriting its commit. Then step 1
## and the option refusals: a PKeyResult failure, or {core, feed_template, record_template,
## fetch_feed, fetch_record}.
func _begin() -> Variant:
	while _busy:
		await _finished
	_busy = true
	var core := _core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	if core.options.pinned_release_keys.is_empty():
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "PKeyOptions.pinned_release_keys is empty: a release record has nothing to verify against.")
	if core.discovery_manifest == null:
		var d := await core.discover()
		if not d.ok:
			var kind: String = d.detail.get("kind", "") if d.detail is Dictionary else ""
			# Offline: decide from what is committed, if this build expects Update at all.
			if kind == "error" and core.enabled("update"):
				var code := String(d.code)
				var offline := func(_arg: String) -> Dictionary: return {"ok": false, "code": code}
				return {"core": core, "fetch_feed": offline, "fetch_record": offline}
			return PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "Discovery is unavailable (%s), so the signed feed cannot be found." % d.code)
	var feed_t := _endpoint(core.discovery_manifest, "update", "feed")
	var record_t := _endpoint(core.discovery_manifest, "release", "record")
	if feed_t == "" or record_t == "":
		return PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "This Worker serves no signed update feed (no update.endpoints.feed or release.endpoints.record in discovery); use check().")
	var platform := core.update_platform()
	var fetch_feed := func(channel: String) -> Dictionary:
		var url := _with_query(_expand(core, feed_t, "channel", channel), "platform", platform)
		return await _get_jose(core, url, 0)
	var fetch_record := func(sha256: String) -> Dictionary:
		return await _get_jose(core, _expand(core, record_t, "sha256", sha256), MAX_RECORD_JWS_BYTES)
	return {"core": core, "fetch_feed": fetch_feed, "fetch_record": fetch_record}


func _end() -> void:
	_busy = false
	_finished.emit()


## The installed build, the outlet and the rest of the decision's inputs (see the class notes).
func _flow_opts(ready: Dictionary, channel: String, staged: Variant, skip_version: Variant) -> Dictionary:
	var core: PKeyCore = ready["core"]
	var info := core.build_info()
	var stamp = core.build_stamp
	var resolved = PKeyDecision.resolve_update_outlet({"host": core.options.host_outlet(), "stamp": stamp if stamp is Dictionary else null})
	if resolved == null:
		resolved = {"id": null, "kind": PKeyDecision.OUTLET_UNKNOWN, "subkind": null}
	return {
		"channel": channel if channel != "" else core.channel,
		"expected_aud": core.product,
		"trust": core.trust.effective(),
		"release_keys": core.options.pinned_release_keys,
		"now": core.clock.now(),
		"install_id": core.device_id,
		"installed": installed_build(core, info),
		"outlet": {"id": resolved["id"], "kind": resolved["kind"]},
		"subkind": resolved["subkind"],
		"staged": staged if staged is Dictionary else null,
		"skip_version": skip_version if skip_version is String else null,
		"methods": Array(core.options.update_methods),
		"cache": {"feeds": PKeyCache._jws_map(core.cache.feeds), "releaseRecords": PKeyCache._jws_map(core.cache.release_records)},
		"fetch_feed": ready["fetch_feed"],
		"fetch_record": ready["fetch_record"],
		"offload": true,
	}


## The decision's `installed` input from the build stamp (PolarisKey.build_info()): version (the
## stamp's, else this Core's), buildNumber (the stamp's `build` as a string; null for 0), the
## platform, the device's arch (the stamp's unless it says `universal`), format
## (PKeyOptions.update_format, else the stamp's `format`, else null) and engine
## (`godot-<major>.<minor>`: the stamp's, or the running engine's without a stamp; null for a
## stamp that names none).
static func installed_build(core: PKeyCore, info: Dictionary) -> Dictionary:
	var version = info.get("version")
	if not (version is String) or version == "":
		version = core.version
	var build = info.get("build")
	var arch = info.get("arch")
	if not (arch is String) or not PKeyConstants.ARCH_VALUES.has(arch):
		arch = PKeyHeaders.arch()
	var format = null
	if core.options.update_format != "":
		format = core.options.update_format
	elif info.get("format") is String and info["format"] != "":
		format = info["format"]
	var engine = info.get("engine")
	return {
		"version": version,
		"binaryVersion": version,
		"buildNumber": str(int(build)) if PKeyClaims.is_number(build) and int(build) > 0 else null,
		"platform": core.update_platform(),
		"arch": arch,
		"format": format,
		"engine": engine if engine is String and engine != "" else null,
	}


## A service fragment's endpoint template from the discovery document, or "".
static func _endpoint(manifest: Variant, service: String, name: String) -> String:
	if not (manifest is Dictionary) or not (manifest.get("services") is Dictionary):
		return ""
	var fragment = manifest["services"].get(service)
	if not (fragment is Dictionary) or not PKeyClaims.is_true(fragment.get("enabled")):
		return ""
	var endpoints = fragment.get("endpoints")
	var t = endpoints.get(name) if endpoints is Dictionary else null
	return t if t is String else ""


## `template` with `{name}` replaced by `value`, percent-encoded as encodeURIComponent, and
## resolved against the control plane.
static func _expand(core: PKeyCore, template: String, name: String, value: String) -> String:
	var url := template.replace("{%s}" % name, PKeyUri.component(value))
	if not (url.begins_with("https://") or url.begins_with("http://")):
		url = PKeyTransport.resolve(core.base_url + "/", url)
	return url


## URLSearchParams.set(name, value) on `url`.
static func _with_query(url: String, name: String, value: String) -> String:
	var fragment := ""
	var at := url.find("#")
	if at >= 0:
		fragment = url.substr(at)
		url = url.substr(0, at)
	var query := ""
	var q := url.find("?")
	if q >= 0:
		query = url.substr(q + 1)
		url = url.substr(0, q)
	return url + "?" + PKeyDiscovery._set_param(query, name, PKeyUri.form(value)) + fragment


## One `application/jose` GET with the X-PKey-* headers and the bearer when one is held:
## {ok: true, body: PackedByteArray} for a 2xx, else {ok: false, code}: the Worker's wire code
## when its answer names one (`feed_not_composable`, …), `http-error` when it names none, or the
## transport's own code. `limit` > 0 caps the body: a larger answer reads as a body of
## limit + 1 bytes, which the record verifier refuses at step `hash` without hashing.
static func _get_jose(core: PKeyCore, url: String, limit: int) -> Dictionary:
	var h := core.headers({"Accept": "application/jose"})
	if core.tokens.has_token():
		h["Authorization"] = "Bearer %s" % core.tokens.current()
	var opts := {"body_limit": limit} if limit > 0 else {}
	var r := await core.transport.request("GET", url, h, PackedByteArray(), opts)
	if not r.ok:
		if limit > 0 and r.code == PKeyErrors.RESPONSE_TOO_LARGE:
			var stand_in := PackedByteArray()
			stand_in.resize(limit + 1)
			return {"ok": true, "body": stand_in}
		return {"ok": false, "code": String(r.code)}
	var status: int = r.detail["status"]
	if status >= 200 and status < 300:
		return {"ok": true, "body": r.detail["body"]}
	var e := PKeyErrors.read_body(r.detail["body"])
	return {"ok": false, "code": e["code"] if e["code"] != "" else String(PKeyErrors.HTTP_ERROR)}


static func _pinned(committed: Dictionary, platform: String) -> Dictionary:
	var out := {}
	for k in committed:
		var t = PKeyDecision.feed_target(committed[k]["feed"]["app"]["targets"], platform)
		if t is Dictionary:
			out[t["release"]["sha256"]] = true
	return out


static func _message(e: Dictionary) -> String:
	if e.get("detail") is String:
		return "The update decision has nothing to decide from: %s (%s)." % [e["code"], e["detail"]]
	return "The update decision has nothing to decide from: %s." % e["code"]


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
