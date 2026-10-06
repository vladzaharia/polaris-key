extends RefCounted
# @pkey-feature core.discover core.sync core.cache config.schema config.mint devices.register devices.report
# @pkey-feature license.activate license.enroll license.deactivate license.reregister identity.devicecode identity.devicelabel
# @pkey-feature release.changelog release.download update.feed release.record update.decide
# @pkey-feature commerce.receipt
# @pkey-feature packs.apply.chunk
# @pkey-feature license.refusals ui.boot release.distribution telemetry.updates
# @pkey-feature license.manage
# The Godot transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/, read from the
# generator-owned mirror res://tests/transcripts/ (written by `pnpm gen:transcripts`; never edit
# it). Drives the `PolarisKey` root through every recorded conversation that
# res://parity.json (sdks/godot/parity.json) makes applicable, against PKeyFakeServer serving the
# Worker's recorded answers and asserting every request (PKeyTranscriptReplay).
#
# Which transcripts run is DATA: one for a feature this SDK has not implemented is skipped, and
# starts running the moment the manifest claims it. The SDK clock is pinned to each step's `now`:
# the recorded documents were signed at a fixed instant and expire an hour later.
#
# Nothing is stubbed: the 401 re-acquire is the SDK's own (PolarisKey.license installs P1b-06's
# route rule, P1-03), and so is the post-sync report (PolarisKey.devices, P1-05); the recording
# checks every header and body shape they send, and that the report's keys are on the Worker's
# allowlist.
#
# `updateDecide` (plans/P3-01.md §5, §6) runs PolarisKey.update.decide(args.channel, args.staged,
# args.skipVersion) with `initial.update` as the build's configuration: `pinnedReleaseKeys` as
# PKeyOptions.pinned_release_keys, the host `outlet` as update_outlet (a kind, or {id, kind,
# subkind}), `methods` as update_methods, `installed.format` as update_format, and `platform`,
# `arch` and the rest of `installed` as a build stamp written for the run; `cache: {feeds,
# releaseRecords}` seeds the store's record, and carries from step to step as the SDK writes it.
# The endpoints come from the last discovery the transcript ran, else the Worker's standard
# templates. Its `expect` keys are the five UpdateCheck members (PKeyUpdateCheck.to_dictionary),
# or `result: "error"` and `code`. P3-03's `update-feed-rollback` and `update-record-by-hash`
# replay through it; the synthetic transcripts at the end of this file (corpus-signed: the SDK has
# no signer) add an alias request and prove the mapping fails on a doctored recording.
#
# `chunkRange` (P4-32, plans/P4-32.md §5) is PKeyPackChunks.chunk_range_fetch over
# PKeyPackCdnTransport's public open_range (PKeyPackHttp.open_range on HTTPClient, the body
# pulled from PKeyFakeServer), against the blobs template the last discover returned, rebased
# onto the loopback server (the recording names the transcript's base). `range` is the fetch's
# status; `bytes` the body it returned, as a string.
#
# `activate` and `enroll` report the PKeyActivationResult's `kind` as `result` and, on a refusal,
# its `code` (the body's wire code, activate-refusals). `boot` is PolarisKey.boot() with a
# PKeyBoot view in the tree and the real PKeyBootHost (discovery on), its `outcome` as
# `bootOutcome`. `downloadModel` is PolarisKey.distribution.download_model(): `platforms` the
# model's group ids in order and `current` the group for `initial.platform`, by value. `report`
# also says how many update events the updater still queues (`updatesPending`): with
# `initial.updateJournal` the updater is forced active over a scratch store root and the journal
# is its queue (state.json `events`), oldest first.

const FLOOR := 4


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var manifest = PKeyTestFixtures.read_json(PKeyTestFixtures.MANIFEST)
	if not t.check("parity manifest present", manifest is Dictionary, PKeyTestFixtures.MANIFEST):
		return true
	var ids := _ids()
	t.check("the transcript set is present", ids.size() >= 8, "%d transcripts" % ids.size())
	var replayed := 0
	for id in ids:
		var tr = PKeyTestFixtures.transcript(id)
		if not t.check("%s parses" % id, tr is Dictionary and tr.get("transcriptVersion") == 1.0):
			continue
		if not PKeyTranscriptReplay.applies(tr, manifest):
			t.info("skip %s: parity.json does not claim %s" % [id, JSON.stringify(tr["features"])])
			continue
		var fails := await replay(tr)
		t.check("%s replays" % id, fails.is_empty(), "\n  ".join(fails))
		replayed += 1
	t.check("replay coverage", replayed >= FLOOR, "%d replayed, floor %d" % [replayed, FLOOR])
	await _negative(t)
	await _synthetic_update(t)
	return true


static func _ids() -> PackedStringArray:
	var out := PackedStringArray()
	var d := DirAccess.open(PKeyTestFixtures.TRANSCRIPTS)
	if d == null:
		return out
	for f in d.get_files():
		var name := f.trim_suffix(".remap")
		if name.ends_with(".json"):
			out.append(name.trim_suffix(".json"))
	out.sort()
	return out


## Replays one transcript; [] when every step matched the recording and its expectations.
static func replay(tr: Dictionary) -> Array:
	var engine := PKeyTranscriptReplay.new(tr)
	var server := PKeyTestFixtures.new_server(engine.handle)
	var store := PKeyMemoryStore.new(tr["initial"]["deviceId"], tr["initial"].get("token", ""))
	var clock := [tr["now"]]
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, tr["product"], tr["trust"], tr["initial"]["version"])
	if tr["initial"].get("services") is Array:
		opts.expected_services = PackedStringArray(tr["initial"]["services"])
	# PX-W13: `initial.deviceName` stands in for the platform's device name; absent = none.
	opts.send_device_name = tr["initial"].get("deviceName") is String
	opts.device_name = String(tr["initial"].get("deviceName", ""))
	if tr["initial"].get("update") is Dictionary:
		_configure_update(opts, store, tr["initial"]["update"])
	var journal = tr["initial"].get("updateJournal")
	if journal is Array:
		opts.store_root = PKeyTestFixtures.scratch_dir("transcript-journal")
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.set_meta("pkey_platform", String(tr["initial"].get("platform", "")))
	var fails: Array = []
	var cr: PKeyResult = sdk.configure(opts)
	if not cr.ok:
		fails.append("configure: %s" % cr)
	else:
		if journal is Array:
			var updater: PKeyUpdater = sdk.update.updater
			updater.enabled = true
			var st := updater.slots.load_state()
			st["events"] = (journal as Array).duplicate(true)
			if not updater.slots.save_state(st):
				fails.append("the update journal could not be seeded")
		await sdk.start()
		for i in tr["steps"].size():
			var step: Dictionary = engine.begin_step(i)
			clock[0] = step.get("now", tr["now"])
			if step["action"] == "updateDecide" and sdk.core.discovery_manifest == null:
				# The transcript ran no discovery: the Worker's standard templates, as React's replayer.
				sdk.core.discovery_manifest = _standard_discovery(server.base_url(), tr["product"])
			if step["action"] == "chunkRange" and sdk.core.discovery_manifest is Dictionary:
				# The discovered blobs template names the transcript's base; the bytes come from the
				# loopback server.
				sdk.core.discovery_manifest = _rebased(sdk.core.discovery_manifest, tr["baseUrl"], server.base_url())
			var observed := await _act(sdk, store, step)
			# A built URL names the loopback server; the recording names the transcript's base.
			if observed.get("url") is String and String(observed["url"]).begins_with(server.base_url() + "/"):
				observed["url"] = tr["baseUrl"] + String(observed["url"]).substr(server.base_url().length())
			fails.append_array(engine.end_step())
			for key in step["expect"]:
				if not _same(observed.get(key), step["expect"][key]):
					fails.append("%s step %d (%s): %s: expected %s, got %s" % [tr["id"], i, step["action"], key, JSON.stringify(step["expect"][key]), JSON.stringify(observed.get(key))])
	sdk.queue_free()
	server.queue_free()
	return fails


## THE mapping from transcript verbs and `expect` keys onto the Godot SDK.
static func _act(sdk: Node, store: PKeyMemoryStore, step: Dictionary) -> Dictionary:
	var out := {}
	match step["action"]:
		"discover":
			var r: PKeyResult = await sdk.discover()
			out["result"] = r.detail.get("kind", "") if r.detail is Dictionary else ""
		"fetchSchema":
			out["catalog"] = await sdk.config.fetch_schema()
		"mintToken":
			var r: PKeyMintResult = await sdk.config.mint_token(step["args"]["recipeId"])
			out["result"] = "ok" if r.ok else String(r.code)
			if r.ok:
				out["token"] = r.token
				out["expiresAt"] = r.expires_at
		"sync":
			var r: PKeySyncResult = await sdk.sync(PKeyClaims.is_true(step["args"].get("force")))
			out["applied"] = r.applied
			out["unauthorized"] = r.unauthorized
			out["blocked"] = r.blocked
			var docs := {}
			for slice in r.documents:
				if r.documents[slice] != "skipped":
					docs[slice] = r.documents[slice]
			out["documents"] = docs
		"activate":
			var r: PKeyActivationResult = await sdk.license.activate_with_key(step["args"]["key"])
			out["result"] = String(r.kind)
			if not r.ok:
				out["code"] = String(r.code)
			# PX-W8: the refusal link, exactly as served; null when the result carries none.
			if r.kind == PKeyActivationResult.KIND_DEVICE_LIMIT:
				out["manageUrl"] = r.manage_url
		"enroll":
			var r: PKeyActivationResult = await sdk.license.enroll()
			out["result"] = String(r.kind)
			if not r.ok:
				out["code"] = String(r.code)
			# PX-W8: the refusal link, exactly as served; null when the result carries none.
			if r.kind == PKeyActivationResult.KIND_DEVICE_LIMIT:
				out["manageUrl"] = r.manage_url
		"boot":
			var view := PKeyBoot.new()
			view.auto_sdk = false
			(Engine.get_main_loop() as SceneTree).root.add_child(view)
			var r: PKeyBootResult = await sdk.boot({"view": view, "host": PKeyBootHost.new(sdk)})
			out["bootOutcome"] = r.outcome
			view.queue_free()
		"downloadModel":
			var r: PKeyResult = await sdk.distribution.download_model()
			out["result"] = "ok" if r.ok else String(r.code)
			if r.ok:
				var platforms: Array = []
				var current = null
				for g in r.detail["platforms"]:
					if g is Dictionary:
						platforms.append(g.get("platform"))
						if current == null and g.get("platform") == sdk.get_meta("pkey_platform"):
							current = g
				out["platforms"] = platforms
				out["current"] = current
		"deactivate":
			var r: PKeyResult = await sdk.license.deactivate()
			out["result"] = "ok" if r.ok else String(r.code)
		"register":
			var r: PKeyResult = await sdk.devices.register()
			out["result"] = r.detail.get("kind", "") if r.detail is Dictionary else ""
		"report":
			out["result"] = await sdk.devices.report()
			out["updatesPending"] = sdk.update.updater.events().size()
		"beginSignIn":
			var prompt: PKeySignInPrompt = await sdk.identity.request_sign_in(String(step["args"].get("deviceName", "")))
			sdk.set_meta("pkey_prompt", prompt)
			if prompt.ok:
				out["prompt"] = {
					"userCode": prompt.user_code,
					"verificationUri": prompt.verification_uri,
					"verificationUriComplete": prompt.verification_uri_complete,
					"expiresIn": prompt.expires_in,
					"interval": prompt.interval,
					"deviceName": prompt.device_name if prompt.device_name != "" else null,
				}
			else:
				out["result"] = String(prompt.code)
		"pollSignIn":
			var p: Dictionary = await sdk.identity.poll_sign_in(sdk.get_meta("pkey_prompt"))
			out["result"] = _sign_in_status(p["status"])
			if p.has("interval"):
				out["interval"] = p["interval"]
		"waitForSignIn":
			# Any wait between polls would be a real timer; the recorded wait starts past expiry.
			sdk.identity.sleeper = func(_s: float) -> void: pass
			var r: PKeySignInResult = await sdk.identity.wait_for_sign_in(sdk.get_meta("pkey_prompt"))
			out["result"] = "ready" if r.ok else _sign_in_status(String(r.kind))
		"changelog":
			var r: PKeyChangelogResult = await sdk.release.changelog()
			out["result"] = "ok" if r.ok else "error"
			if r.ok:
				out["entries"] = r.to_array()
			else:
				out["code"] = String(r.code)
		"installUrl":
			out["url"] = sdk.release.install_url()
		"downloadUrl":
			var a: Dictionary = step["args"]
			out["url"] = sdk.release.download_url(String(a["version"]), String(a["binary"]), String(a["arch"]), PKeyClaims.is_true(a.get("checksum")), PKeyClaims.is_true(a.get("dmg")))
		"updateDecide":
			var a: Dictionary = step["args"]
			var r: PKeyUpdateCheck = await sdk.update.decide(String(a.get("channel", "")), a.get("staged"), a.get("skipVersion"))
			out["result"] = "ok" if r.ok else "error"
			if r.ok:
				out.merge(r.to_dictionary(), true)
			else:
				out["code"] = String(r.code)
		"commerceBinding":
			var r: PKeyResult = await sdk.commerce.get_binding()
			out["result"] = "ok" if r.ok else String(r.code)
			if r.ok:
				out["bindingId"] = r.detail["bindingId"]
				out["products"] = r.detail["products"]
			else:
				out["reason"] = _refusal_reason(r)
		"commerceClaim":
			var a: Dictionary = step["args"]
			var r: PKeyResult = await sdk.commerce.claim(String(a["store"]), a.get("payload", {}))
			out["result"] = "ok" if r.ok else String(r.code)
			if r.ok:
				out["flag"] = r.detail.get("flag")
				out["state"] = r.detail.get("state")
				out["granted"] = r.detail.get("granted")
			else:
				out["reason"] = _refusal_reason(r)
		"chunkRange":
			var a: Dictionary = step["args"]
			var cdn := PKeyPackCdnTransport.new(sdk.core)
			var fetch_range := PKeyPackChunks.chunk_range_fetch(cdn.open_range)
			var r: Dictionary = await fetch_range.call(String(a["bundle"]), int(a["offset"]), int(a["length"]))
			out["range"] = r["status"]
			if r["status"] == "ok":
				var bytes := PackedByteArray()
				while true:
					var got = await r["body"].take(4096)
					if not (got is PackedByteArray) or (got as PackedByteArray).is_empty():
						break
					bytes.append_array(got)
				out["bytes"] = bytes.get_string_from_ascii()
		_:
			out["unsupported"] = step["action"]
	var services := {}
	var caps: Dictionary = sdk.capabilities()
	for slug in caps:
		services[slug] = PKeyClaims.is_true(caps[slug]["enabled"])
	out["services"] = services
	out["licenseStatus"] = sdk.status()["status"]
	out["tokenHeld"] = store.token != ""
	return out


## The refusal body's `reason` (P6-01's commerce refusals carry one beside `error`).
static func _refusal_reason(r: PKeyResult) -> Variant:
	if r.detail is Dictionary and r.detail.get("error") is Dictionary:
		var reason = r.detail["error"].get("reason", "")
		return reason if reason != "" else null
	return null


## `initial.update` onto the options, a build stamp written for the run and the store's record.
static func _configure_update(opts: PKeyOptions, store: PKeyMemoryStore, u: Dictionary) -> void:
	opts.pinned_release_keys = u.get("pinnedReleaseKeys", {})
	var outlet = u.get("outlet")
	if outlet is String:
		opts.update_outlet = outlet
	elif outlet is Dictionary:
		opts.update_outlet = String(outlet.get("kind", ""))
		opts.update_outlet_id = String(outlet.get("id", "")) if outlet.get("id") is String else ""
		opts.update_outlet_subkind = String(outlet.get("subkind")) if outlet.get("subkind") is String else ""
	if u.get("methods") is Array:
		opts.update_methods = PackedStringArray(u["methods"])
	var installed: Dictionary = u.get("installed", {})
	if installed.get("format") is String:
		opts.update_format = installed["format"]
	var build = installed.get("buildNumber")
	var stamp := {
		"pkeyBuild": 1,
		"product": "",
		"version": String(installed.get("version", "")),
		"build": int(build) if build is String and (build as String).is_valid_int() else 0,
		"outlet": "",
		"channel": "",
		"engine": String(installed["engine"]) if installed.get("engine") is String else "",
		"platform": String(u.get("platform", "")),
		"arch": String(u.get("arch", "")),
	}
	var path := "%s/stamp.json" % PKeyTestFixtures.scratch_dir("transcript-stamp")
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify(stamp))
		f.close()
	opts.build_stamp_path = path
	var cache = u.get("cache")
	if cache is Dictionary and (cache.get("feeds") is Dictionary or cache.get("releaseRecords") is Dictionary):
		var rec := {"v": PKeyCache.VERSION}
		for slice in PKeyCache.UPDATE_SLICES:
			if cache.get(slice) is Dictionary and not (cache[slice] as Dictionary).is_empty():
				rec[slice] = (cache[slice] as Dictionary).duplicate()
		store.cache = rec


## The discovery document's two update endpoints at the Worker's standard templates.
static func _standard_discovery(base: String, product: String) -> Dictionary:
	var root := "%s/%s" % [base, product]
	return {
		"product": product,
		"services": {
			"update": {"enabled": true, "endpoints": {"feed": root + "/update/{channel}/feed.jws"}},
			"release": {"enabled": true, "endpoints": {"record": root + "/release/records/{sha256}"}},
		},
	}


## `manifest` with its distribution blobs template moved from `from` (the recorded base) to `to`
## (the loopback server).
static func _rebased(manifest: Dictionary, from: String, to: String) -> Dictionary:
	var m: Dictionary = manifest.duplicate(true)
	var dist = m.get("services", {}).get("distribution")
	if dist is Dictionary and dist.get("endpoints") is Dictionary:
		var t = dist["endpoints"].get("blobs")
		if t is String and (t as String).begins_with(from + "/"):
			dist["endpoints"]["blobs"] = to + (t as String).substr(from.length())
	return m


## The transcripts' sign-in vocabulary (sdk-node `SignInPoll`): the server's `timeout` and the
## client's expiry are both `expired`, and its `error` state is `error`.
static func _sign_in_status(status: String) -> String:
	match status:
		"timeout", "expired":
			return "expired"
		"denied":
			return "error"
	return status


# ── The replayer fails on a doctored transcript (it is not vacuous) ──────────────────────

func _negative(t: PKeyTestContext) -> void:
	var base = PKeyTestFixtures.transcript("sync-etag-304")
	if not t.check("negative: base transcript present", base is Dictionary):
		return
	var extra: Dictionary = base.duplicate(true)
	var items: Array = extra["steps"][0]["exchanges"]["items"]
	extra["steps"][0]["exchanges"]["items"] = items.filter(func(x): return not String(x["request"]["path"]).ends_with("/config/document"))
	var f := await replay(extra)
	t.check("negative: an extra request fails", _mentions(f, "unexpected request: GET /djdl/config/document"), "\n  ".join(f))

	var omitted: Dictionary = base.duplicate(true)
	omitted["steps"][0]["exchanges"]["items"].append(omitted["steps"][0]["exchanges"]["items"][0].duplicate(true))
	f = await replay(omitted)
	t.check("negative: an omitted request fails", _mentions(f, "expected request not sent: GET /djdl/.well-known/polaris-trust.jws"), "\n  ".join(f))

	var header: Dictionary = base.duplicate(true)
	for x in header["steps"][0]["exchanges"]["items"]:
		if String(x["request"]["path"]).ends_with("/license/document"):
			x["request"]["requiredHeaders"].append("x-pkey-doctored")
	f = await replay(header)
	t.check("negative: a dropped required header fails", _mentions(f, "required header x-pkey-doctored: missing"), "\n  ".join(f))

	var outcome: Dictionary = base.duplicate(true)
	outcome["steps"][1]["expect"]["documents"] = {"license": "applied", "config": "applied"}
	f = await replay(outcome)
	t.check("negative: a different outcome fails", _mentions(f, "step 1 (sync): documents"), "\n  ".join(f))

	# telemetry-report-updates passes only when the seeded journal really drains (16, then 1).
	var journal = PKeyTestFixtures.transcript("telemetry-report-updates")
	if t.check("negative: telemetry-report-updates present", journal is Dictionary):
		var drained: Dictionary = journal.duplicate(true)
		drained["steps"][0]["expect"]["updatesPending"] = 0
		f = await replay(drained)
		t.check("negative: a journal that did not drain as recorded fails", _mentions(f, "step 0 (report): updatesPending"), "\n  ".join(f))

	# packs-chunk-range passes only when the SDK reads the exact run: a recorded Content-Range
	# altered to another range must be refused, so the step's `range` fails.
	var chunk = PKeyTestFixtures.transcript("packs-chunk-range")
	if t.check("negative: packs-chunk-range present", chunk is Dictionary):
		var doctored: Dictionary = chunk.duplicate(true)
		for x in doctored["steps"][1]["exchanges"]["items"]:
			x["response"]["headers"]["content-range"] = "bytes 17-40/64"
		f = await replay(doctored)
		t.check("negative: a chunk range with another Content-Range fails", _mentions(f, "step 1 (chunkRange): range"), "\n  ".join(f))


## JSON equality without GDScript's cross-type `==` errors (a String compared with a bool), and
## with every number compared as a number at any depth (JSON parses 600 as 600.0).
static func _same(a: Variant, b: Variant) -> bool:
	if PKeyClaims.is_number(a) and PKeyClaims.is_number(b):
		return float(a) == float(b)
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size():
			return false
		for k in a:
			if not b.has(k) or not _same(a[k], b[k]):
				return false
		return true
	if a is Array and b is Array:
		if a.size() != b.size():
			return false
		for i in a.size():
			if not _same(a[i], b[i]):
				return false
		return true
	return typeof(a) == typeof(b) and a == b


static func _mentions(fails: Array, needle: String) -> bool:
	for line in fails:
		if String(line).contains(needle):
			return true
	return false


# ── updateDecide over synthetic transcripts (beside P3-03's two) ───────────────────────────

## The shape of P3-03's update transcripts (`initial.update`, `action: "updateDecide"`,
## `args.channel`, `expect: {channel, feed, record, errors, decision}`), built from the corpus's
## signed control feed (requested as `latest`, claiming `stable`) and the record it pins.
func _synthetic_update(t: PKeyTestContext) -> void:
	var corpus = PKeyTestFixtures.read_json(PKeyTestFixtures.CASES)
	var feed = null
	var record = null
	if corpus is Dictionary:
		for c in corpus["feedCases"]:
			if c["id"] == "feed-valid-alias-channel":
				feed = c
		for c in corpus["releaseRecordCases"]:
			if c["id"] == "record-valid-app":
				record = c
	if not t.check("synthetic updateDecide: the corpus feed and record are present", feed != null and record != null):
		return
	var hash: String = record["expectedHash"]
	var get_ := func(path: String, body: String) -> Dictionary:
		return {
			"request": {"method": "GET", "path": path, "headers": {"X-PKey-Device": "{deviceId}"}, "requiredHeaders": ["accept"], "body": null},
			"response": {"status": 200, "headers": {"Content-Type": "application/jose"}, "body": body},
		}
	var decision := {
		"action": "binary", "method": "download", "release": {"version": "1.5.0", "seq": 15, "sha256": hash},
		"build": "macos-dmg", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false,
	}
	var tr := {
		"transcriptVersion": 1,
		"id": "synthetic-update-decide",
		"description": "updateDecide over a feed and its pinned record, then the cached record",
		"features": ["update.feed", "release.record", "update.decide"],
		"requires": ["core.store"],
		"product": "djdl",
		"baseUrl": "https://key.plrs.im",
		"now": feed["now"],
		"trust": feed["trust"],
		"initial": {
			"deviceId": "dev_7c1e2d",
			"version": "1.4.0",
			"update": {
				"pinnedReleaseKeys": record["releaseKeys"],
				"outlet": "direct",
				"platform": "macos",
				"arch": "arm64",
				"installed": {"version": "1.4.0"},
				"methods": ["download"],
				"cache": {"feeds": {}, "releaseRecords": {}},
			},
		},
		"steps": [
			{
				"action": "updateDecide",
				"args": {"channel": "latest"},
				"exchanges": {"ordered": false, "items": [
					get_.call("/djdl/update/latest/feed.jws?platform=macos", feed["jws"]),
					get_.call("/djdl/release/records/" + hash, record["jws"]),
				]},
				"expect": {"result": "ok", "channel": "stable", "feed": "network", "record": "network", "errors": [], "decision": decision},
			},
			{
				"action": "updateDecide",
				"args": {"channel": "stable"},
				"exchanges": {"ordered": false, "items": [get_.call("/djdl/update/stable/feed.jws?platform=macos", feed["jws"])]},
				"expect": {"result": "ok", "channel": "stable", "feed": "network", "record": "cache", "errors": []},
			},
		],
	}
	var fails := await replay(tr)
	t.check("synthetic updateDecide: both steps replay (the record fetched once, then read from the carried cache)", fails.is_empty(), "\n  ".join(fails))

	var doctored: Dictionary = tr.duplicate(true)
	doctored["steps"][0]["exchanges"]["items"].pop_back()
	fails = await replay(doctored)
	t.check("synthetic updateDecide: a record request missing from the recording fails", _mentions(fails, "unexpected request: GET /djdl/release/records/"), "\n  ".join(fails))

	var wrong: Dictionary = tr.duplicate(true)
	wrong["steps"][0]["expect"]["channel"] = "latest"
	fails = await replay(wrong)
	t.check("synthetic updateDecide: a different channel fails", _mentions(fails, "step 0 (updateDecide): channel"), "\n  ".join(fails))

	# The rollback shape of P3-03's update-feed-rollback: a committed higher seq for `stable`, a
	# request for `latest`, the Worker answering a lower seq that claims `stable`.
	var high = null
	for c in corpus["feedCases"]:
		if c["id"] == "feed-valid-seq-at-max":
			high = c
	if t.check("synthetic updateDecide: the seq-ceiling feed is present", high != null):
		var rb: Dictionary = tr.duplicate(true)
		rb["id"] = "synthetic-update-rollback"
		rb["initial"]["update"]["cache"] = {"feeds": {"stable": high["jws"]}, "releaseRecords": {}}
		rb["steps"] = [{
			"action": "updateDecide",
			"args": {"channel": "latest"},
			"exchanges": {"ordered": false, "items": [
				get_.call("/djdl/update/latest/feed.jws?platform=macos", feed["jws"]),
				{"request": {"method": "GET", "path": "/djdl/release/records/aaa51d6e196aa0893c266a611272520bee33c7a78636b66ef4dbba8a2ecfcbb6", "headers": {}, "requiredHeaders": [], "body": null},
					"response": {"status": 404, "headers": {"Content-Type": "application/json"}, "body": {"error": {"code": "not_found"}}}},
			]},
			"expect": {"result": "ok", "channel": "stable", "feed": "committed", "record": "none",
				"errors": [{"code": "feed-rollback", "detail": null}, {"code": "not_found", "detail": null}]},
		}]
		fails = await replay(rb)
		t.check("synthetic updateDecide: a lower seq for the canonical channel is a rollback, decided from the committed feed", fails.is_empty(), "\n  ".join(fails))
