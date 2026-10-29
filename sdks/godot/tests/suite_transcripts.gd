extends RefCounted
# @pkey-feature identity.account identity.attach identity.toggle core.discover core.presentation core.sync core.cache config.schema config.mint devices.register devices.report
# @pkey-feature license.activate license.enroll license.deactivate license.reregister identity.devicecode identity.devicelabel
# @pkey-feature release.changelog release.download update.feed release.record update.decide
# @pkey-feature commerce.receipt
# @pkey-feature packs.apply.chunk
# @pkey-feature license.refusals ui.boot release.distribution telemetry.updates
# @pkey-feature license.manage identity.keyentry identity.redirect.web identity.signin.hints identity.choice
# @pkey-feature release.fetch
# @pkey-feature sync.keyring sync.settings
# The Godot transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/, read from the
# generator-owned mirror res://tests/transcripts/ (written by `pnpm gen transcripts`; never edit
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
# `releaseFetch` (SP-25) is PolarisKey.release.fetch({record, build}, to) with a release record
# built from the step's args (one build: id, platform, arch, and one payload artifact of `size`
# and `sha256`), into a fresh scratch directory; the discovered builds template is rebased onto the
# loopback server like `chunkRange`'s. `partial` seeds `<to>.part` with the first bytes of the
# payload an earlier step fetched, so the SDK resumes with Range and If-Range. `result` is `ok`
# (with the verified file's `size` and `sha256`), `refused` for a wire or SDK error code
# (PKeyConstants.ERROR_CODE_VALUES) with its `code`, else `error`.
#
# `discover` reports the result's `kind` as `result` and PolarisKey.presentation() as
# `presentation` (core.presentation: the normalised member, or null when there is none), so
# `discovery-presentation` checks the member and then its removal. Each replay's presentation
# cache is a scratch directory of its own.
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
const SyncTypes := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")


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
	# `cloudsync-cors` has `browser` steps too, but they are plain requests, not a redirect sign-in.
	var redirects: bool = tr["id"] != "cloudsync-cors" and tr["steps"].any(func(st): return st["action"] in ["browser", "redirectComplete"])
	if tr["initial"].get("services") is Array:
		opts.expected_services = PackedStringArray(tr["initial"]["services"])
	elif redirects:
		# The redirect conversations ride a product that runs Identity (their discovery names it).
		opts.expected_services = PackedStringArray(["license", "config", "identity"])
	# PX-W13: `initial.deviceName` stands in for the platform's device name; absent = none.
	opts.send_device_name = tr["initial"].get("deviceName") is String
	opts.device_name = String(tr["initial"].get("deviceName", ""))
	if tr["initial"].get("update") is Dictionary:
		_configure_update(opts, store, tr["initial"]["update"])
	var journal = tr["initial"].get("updateJournal")
	if journal is Array:
		opts.store_root = PKeyTestFixtures.scratch_dir("transcript-journal")
	if tr["steps"].any(func(st): return String(st["action"]).begins_with("keyring")):
		# The key ring's own device keys and vault: scratch files and memory, nothing in the keychain.
		opts.device_keys = PKeyDeviceKeyStore.for_tests(tr["product"], PKeyTestFixtures.scratch_dir("transcript-ring-keys"))
		opts.ring_vault = PKeySyncRingVault.new(tr["product"], "user://pkey", true)
	var sdk := PKeyTestFixtures.new_sdk()
	if tr["id"] == "cloudsync-e2e-settings":
		# The end-to-end transcript runs the real host codec over a ring of its own: its root is not the
		# recorder's, so every recorded `ct` reads `invalid`.
		sdk.set_meta("pkey_sync_codec", await _fixture_codec(tr))
	sdk.set_meta("pkey_sync_mem", {"etag": "", "retry_after": null, "next_id": 1})
	sdk.set_meta("pkey_platform", String(tr["initial"].get("platform", "")))
	sdk.set_meta("pkey_transcript_base", String(tr["baseUrl"]))
	var presentation_dir := PKeyTestFixtures.scratch_dir("transcript-presentation")
	sdk.presentation_source.cache_dir = presentation_dir
	var fails: Array = []
	var cr: PKeyResult = sdk.configure(opts)
	# configure() binds the kit, which fetches a presented icon from the image host: nothing a
	# replay may reach (the recording is the Worker's only).
	PKeyUiTheme.use_presentation(null)
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
		if redirects:
			# The recordings hold the token exchange, not the sync a sign-in triggers after it.
			sdk.identity.redirect_acquisition_sync = false
			sdk.set_meta("pkey_replay", {"tr": tr, "engine": engine, "base": server.base_url()})
		for i in tr["steps"].size():
			var step: Dictionary = engine.begin_step(i)
			clock[0] = step.get("now", tr["now"])
			if step["action"] == "updateDecide" and sdk.core.discovery_manifest == null:
				# The transcript ran no discovery: the Worker's standard templates, as React's replayer.
				sdk.core.discovery_manifest = _standard_discovery(server.base_url(), tr["product"])
			if step["action"] in ["subject", "signOut", "attach"] and sdk.core.discovery_manifest == null:
				# identity.account: the account endpoints at the Worker's standard paths, on the loopback server.
				sdk.core.discovery_manifest = _standard_identity_discovery(server.base_url(), tr["product"])
			if step["action"] in ["browser", "redirectComplete"] and sdk.core.discovery_manifest == null:
				sdk.core.discovery_manifest = _redirect_discovery(server.base_url(), tr)
			if step["action"] in ["chunkRange", "releaseFetch"] and sdk.core.discovery_manifest is Dictionary:
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
	PKeyTestFixtures.remove_tree(presentation_dir)
	# configure() bound the kit to this replay's presentation; the next suite starts without it.
	PKeyUiTheme.use_presentation(null)
	return fails


## THE mapping from transcript verbs and `expect` keys onto the Godot SDK.
static func _act(sdk: Node, store: PKeyMemoryStore, step: Dictionary) -> Dictionary:
	var out := {}
	match step["action"]:
		"discover":
			var r: PKeyResult = await sdk.discover()
			out["result"] = r.detail.get("kind", "") if r.detail is Dictionary else ""
			var p: Dictionary = sdk.presentation()
			out["presentation"] = p if not p.is_empty() else null
		"subject":
			var r: PKeyResult = await sdk.identity.subject()
			out["subject"] = r.detail.get("subject") if r.ok else "unavailable"
		"signOut":
			var r: PKeyResult = await sdk.identity.sign_out()
			if r.ok and r.detail is Dictionary and r.detail.has("released"):
				out["released"] = r.detail["released"]
			else:
				out["result"] = "unavailable" if r.code == PKeyErrors.SERVICE_UNAVAILABLE else String(r.code)
		"attach":
			var r: PKeyResult = await sdk.identity.attach(PKeyClaims.is_true(step["args"].get("confirm")))
			if r.ok and r.detail["kind"] == "confirm":
				var l: Dictionary = r.detail["license"]
				out["result"] = "confirm"
				out["license"] = {"id": l["id"], "tierId": l["tier_id"], "name": l["name"]}
			elif r.ok:
				out["result"] = "ok"
				out["subject"] = r.detail["subject"] if r.detail["subject"] != "" else null
				out["attached"] = r.detail["attached"] if r.detail["attached"] != "" else null
			elif r.detail is Dictionary and r.detail.get("kind") == "unavailable":
				out["result"] = "unavailable"
			else:
				out["result"] = "refused"
				out["code"] = String(r.code)
			out["tokenHeld"] = store.token != ""
		"fetchSchema":
			out["catalog"] = await sdk.config.fetch_schema()
		"relayTicket":
			await _relay_ticket(sdk, out)
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
			out["result"] = _activation_name(r)
			if not r.ok and r.kind != PKeyActivationResult.KIND_KEY_ENTRY_LIMIT:
				out["code"] = String(r.code)
			_report_activation(out, r)
		"enroll":
			var r: PKeyActivationResult = await sdk.license.enroll()
			out["result"] = _activation_name(r)
			if not r.ok and r.kind != PKeyActivationResult.KIND_KEY_ENTRY_LIMIT:
				out["code"] = String(r.code)
			_report_activation(out, r)
		"boot":
			var view := PKeyBoot.new()
			view.auto_sdk = false
			(Engine.get_main_loop() as SceneTree).root.add_child(view)
			var r: PKeyBootResult = await sdk.boot({"resolve_on_stop": true, "view": view, "host": PKeyBootHost.new(sdk)})
			out["bootOutcome"] = r.outcome
			view.queue_free()
		"keyringGet", "keyringCreate", "keyringReset", "keyringWrap", "keyringUnwrap", "keyringAdopt", "keyringRecoverySet", "keyringRecoveryGet":
			await _keyring(sdk, step, out)
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
		"cloudSyncPull", "cloudSyncPush":
			await _cloud_sync(sdk, step, out)
		"browser":
			if not sdk.has_meta("pkey_replay"):
				await _cors(sdk, step)
				return out
			# The browser's half is the recording's; the SDK's half is the authorize URL it builds for
			# the request the Worker answered with a 303 to the card (hints included).
			var ctx: Dictionary = sdk.get_meta("pkey_replay")
			var engine: PKeyTranscriptReplay = ctx["engine"]
			for item in step["exchanges"]["items"]:
				if item["request"]["method"] == "GET" and int(item["response"]["status"]) == 303 and String(item["request"]["path"]).contains("/identity/authorize?"):
					var started := await _redirect_session(sdk, step)
					var want: String = String(ctx["tr"]["baseUrl"]) + String(item["request"]["path"])
					var got := started.authorize_url.replace(String(ctx["base"]), String(ctx["tr"]["baseUrl"])) if started.ok else "(%s)" % started.code
					if got != want:
						engine.failures.append("authorize URL differs from the recording:\n    want %s\n    got  %s" % [want, got])
			engine.serve_browser_exchanges()
			# Facts the recorder read off the browser's pages; nothing of the SDK's.
			for k in step["expect"]:
				out[k] = step["expect"][k]
		"redirectComplete":
			var s := await _redirect_session(sdk, step)
			if not s.ok:
				out["result"] = "error"
				out["code"] = String(s.code)
			else:
				var o: PKeySignInOutcome = await s.complete(String(step["args"].get("callbackUrl", "")))
				match o.kind:
					PKeySignInOutcome.KIND_SIGNED_IN:
						out["result"] = "ok"
						out["scope"] = o.scope
						out["subject"] = o.subject if o.subject != "" else null
						out["licenseId"] = o.license_id if o.license_id != "" else null
					PKeySignInOutcome.KIND_LICENSE_CHOICE:
						out["result"] = "choose"
					PKeySignInOutcome.KIND_CANCELLED:
						out["result"] = "cancelled"
					_:
						out["result"] = _redirect_result(String(o.code))
						out["code"] = String(o.code)
		"choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel":
			out.merge(await _choice_step(sdk.identity.choice, step), true)
		# The recorded action names stay (plans/I-10-slices.md D-6); they drive the session.
		"beginSignIn":
			var prompt: PKeySignInSession = await sdk.identity.sign_in.start({"device_name": String(step["args"].get("deviceName", ""))})
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
			var p: Dictionary = await (sdk.get_meta("pkey_prompt") as PKeySignInSession)._poll_once()
			out["result"] = _sign_in_status(p["status"])
			if p["status"] == "denied":
				out["code"] = String(PKeyErrors.SIGN_IN_DENIED)
			elif p["status"] == "error" and p.get("code") == PKeyErrors.SIGN_IN_FAILED:
				out["code"] = String(PKeyErrors.SIGN_IN_FAILED)
			elif p["status"] == "transient":
				# I-37d: no answer or a 5xx on the poll; a wait loop keeps polling.
				out["code"] = String(p["code"])
			if p.has("interval"):
				out["interval"] = p["interval"]
		"waitForSignIn":
			# Any wait between polls would be a real timer; the recorded wait starts past expiry.
			sdk.identity.sleeper = func(_s: float) -> void: pass
			var r: PKeySignInOutcome = await (sdk.get_meta("pkey_prompt") as PKeySignInSession).wait()
			out["result"] = "ready" if r.kind == PKeySignInOutcome.KIND_SIGNED_IN else ("confirm" if r.kind == PKeySignInOutcome.KIND_CHOOSE else _sign_in_status(String(r.kind)))
			if String(r.kind) == "denied" or r.code == PKeyErrors.SIGN_IN_FAILED:
				out["code"] = String(r.code)
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
			var r: PKeyResult = await sdk.commerce.binding()
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
		"releaseFetch":
			out.merge(await _release_fetch(sdk, step["args"]), true)
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


## `releaseFetch`: the step's target as a release record, fetched into a fresh directory (see the
## header). The whole payload a step fetched is kept on the SDK node for a later `partial` seed.
## `connect.relay_ticket()` (CC-14.4, `connect.relay`). A refusal reads as `result: "refused"` with
## the status, the code and, where the Worker answers them, `retryAfter` and `scope`. The relay URL
## is checked against the recorded host, not the loopback server's.
static func _relay_ticket(sdk: Node, out: Dictionary) -> void:
	var state := PKeyConnectState.new(sdk.core.product, "user://pkey", true)
	var client := PKeyConnectClient.new(sdk.core, state)
	client.home_url = String(sdk.get_meta("pkey_transcript_base", ""))
	var r: PKeyResult = await client.relay_ticket()
	if r.ok:
		var grant: PKeyConnectClient.Grant = r.detail
		out["result"] = "ok"
		out["protocol"] = grant.protocol
		out["url"] = grant.url
		out["expiresIn"] = grant.expires_at - int(sdk.core.clock.now())
		return
	out["result"] = "refused"
	out["code"] = String(r.code)
	if r.detail is Dictionary:
		var d: Dictionary = r.detail
		out["status"] = d.get("status")
		if d.has("retry_after_seconds"):
			out["retryAfter"] = d["retry_after_seconds"]
		if d.has("scope"):
			out["scope"] = d["scope"]


static func _release_fetch(sdk: Node, a: Dictionary) -> Dictionary:
	var record := {
		"schemaVersion": 1, "aud": sdk.core.product, "deliverable": "app", "kind": "app",
		"version": String(a["version"]), "seq": 1, "issuedAt": 1,
		"builds": [{
			"id": String(a["build"]), "platform": String(a["platform"]), "arch": String(a["arch"]), "format": "tar.gz",
			"artifacts": [{"name": "payload", "role": "payload", "sha256": String(a["sha256"]), "size": int(a["size"])}],
		}],
	}
	var to := PKeyTestFixtures.scratch_dir("transcript-fetch").path_join("payload")
	var partial = a.get("partial")
	if PKeyClaims.is_number(partial) and int(partial) > 0:
		var whole = sdk.get_meta("pkey_payload", null)
		if not (whole is PackedByteArray):
			return {"result": "error", "code": "a partial releaseFetch needs an earlier whole fetch"}
		var f := FileAccess.open(to + ".part", FileAccess.WRITE)
		f.store_buffer((whole as PackedByteArray).slice(0, int(partial)))
		f.close()
	var r: PKeyResult = await sdk.release.fetch({"record": record, "build": String(a["build"])}, to)
	if not r.ok:
		return {"result": "refused" if PKeyConstants.ERROR_CODE_VALUES.has(String(r.code)) else "error", "code": String(r.code), "fileLeft": FileAccess.file_exists(to)}
	var data := FileAccess.get_file_as_bytes(String(r.detail["path"]))
	sdk.set_meta("pkey_payload", data)
	return {"result": "ok", "size": data.size(), "sha256": PKeyReleaseRecord.sha256_hex(data), "path": r.detail["path"]}


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


## The identity fragment's account endpoints (WIRE-CONTRACT-V4 §12.6) at the Worker's standard paths.
static func _standard_identity_discovery(base: String, product: String) -> Dictionary:
	var root := "%s/%s/identity" % [base, product]
	return {
		"product": product,
		"services": {
			"identity": {
				"enabled": true,
				"account": true,
				"endpoints": {"attach": root + "/attach", "subject": root + "/subject", "signout": root + "/signout", "accountPortal": "%s/#/p/%s" % [base, product]},
			},
		},
	}


## The recorder's constants for a redirect conversation (packages/worker/test/transcripts).
const RECORDED_STATE := "tidewater-state-0123456789"
const RECORDED_VERIFIER := "transcript-verifier-0123456789-abcdefghijklmnopqrst"
const RECORDED_REDIRECT := "https://app.example/auth/callback"


## A redirect session the way the step's `args` ask for one: the recorded `state` and verifier (a
## step may name its own), the hints it carries, the recorded redirect URI.
static func _redirect_session(sdk: Node, step: Dictionary) -> PKeySignInSession:
	var a: Dictionary = step["args"]
	sdk.identity.redirect_entropy = {"state": String(a.get("state", RECORDED_STATE)), "code_verifier": String(a.get("codeVerifier", RECORDED_VERIFIER))}
	var opts := {"channel": "redirect", "redirect_uri": String(a.get("redirectUri", RECORDED_REDIRECT))}
	# The recorded authorize request asked the app to show the licence choice.
	var ctx = sdk.get_meta("pkey_replay", null)
	if ctx is Dictionary and _asks_app_choice(ctx["tr"]):
		opts["license_choice"] = "app"
	for pair in [["loginHint", "login_hint"], ["nameHint", "name_hint"], ["purpose", "purpose"]]:
		if a.get(pair[0]) is String:
			opts[pair[1]] = a[pair[0]]
	return await sdk.identity.sign_in.start(opts)


static func _asks_app_choice(tr: Dictionary) -> bool:
	for step in tr["steps"]:
		for item in step["exchanges"]["items"]:
			if String(item["request"]["path"]).contains("license_choice=app"):
				return true
	return false


## The grant routes: `identity.choice.*`, a refusal being a result. `choiceComplete` sends the
## `choice` the recording's request carries; a recording with none is the Worker's 409
## `license_choice_required`, sent as recorded (no `choice`).
static func _choice_step(choice: PKeyIdentityChoice, step: Dictionary) -> Dictionary:
	var out := {}
	var grant := String(step["args"].get("grant", ""))
	var r: PKeyChoiceResult
	match step["action"]:
		"choiceLicenses":
			r = await choice.licenses(grant)
			if r.ok:
				out["state"] = r.view["state"]
				out["licenses"] = r.view["choices"].map(func(c): return c.get("id"))
		"choiceDevices":
			r = await choice.devices(grant, String(step["args"].get("licenseId", "")))
			if r.ok:
				out["devices"] = r.view["devices"].map(func(d): return d.get("id"))
		"choiceComplete":
			var recorded = null
			var items: Array = step["exchanges"]["items"]
			if not items.is_empty() and items[0]["request"]["body"] is Dictionary:
				recorded = items[0]["request"]["body"]["json"].get("choice")
			r = await choice._complete(grant, recorded)
			if r.ok:
				out["licenseId"] = r.license_id if r.license_id != "" else null
				out["subject"] = r.subject
				if not r.key_entries.is_empty():
					out["keyEntries"] = r.key_entries
		_:
			r = await choice.cancel(grant)
	out["result"] = "ok" if r.ok else ("refused" if r.kind == PKeyChoiceResult.KIND_REFUSED else "failed")
	if not r.ok:
		out["code"] = String(r.code)
	return out


## `redirectComplete`'s `result` for a refusal's code (format.ts).
static func _redirect_result(code: String) -> String:
	if code in ["invalid_grant", "invalid_request", "invalid_client", "license_choice_required", "rate_limited"]:
		return code.replace("_", "-")
	return "error"


## Discovery for the redirect conversations: Identity on, the authorize and token endpoints at the
## Worker's standard paths on the loopback server, and the issuer the recorded callback carries
## (RFC 9207), else the Worker's own `<base>/<product>/identity`.
static func _redirect_discovery(base: String, tr: Dictionary) -> Dictionary:
	var root := "%s/%s/identity" % [base, tr["product"]]
	var issuer := root
	for step in tr["steps"]:
		if step["action"] == "redirectComplete":
			var url := String(step["args"].get("callbackUrl", ""))
			var m := RegEx.create_from_string("[?&]iss=([^&#]*)").search(url)
			if m != null:
				issuer = m.get_string(1).uri_decode()
				break
	var endpoints := {
		"authorize": root + "/authorize", "token": root + "/token",
		"choiceLicenses": root + "/choice/licenses", "choiceDevices": root + "/choice/devices",
		"choiceComplete": root + "/choice/complete", "choiceCancel": root + "/choice/cancel",
	}
	var identity := {"enabled": true, "configured": true, "issuer": issuer, "endpoints": endpoints}
	var services := {"identity": identity}
	# A transcript that attaches after a redirect sign-in (holders-add-to-account) also runs
	# Licence and Config, and names the account endpoints beside the redirect ones.
	if tr["steps"].any(func(st): return st["action"] in ["subject", "signOut", "attach"]):
		identity["account"] = true
		endpoints.merge({"attach": root + "/attach", "subject": root + "/subject", "signout": root + "/signout", "accountPortal": "%s/#/p/%s" % [base, tr["product"]]})
		services["license"] = {"enabled": true}
		services["config"] = {"enabled": true}
	return {"product": tr["product"], "services": services}


## `manifest` with its distribution and release blobs and builds templates moved from `from` (the
## recorded base) to `to` (the loopback server).
static func _rebased(manifest: Dictionary, from: String, to: String) -> Dictionary:
	var m: Dictionary = manifest.duplicate(true)
	for service in ["distribution", "release"]:
		var frag = m.get("services", {}).get(service)
		if not (frag is Dictionary) or not (frag.get("endpoints") is Dictionary):
			continue
		for name in ["blobs", "builds"]:
			var t = frag["endpoints"].get(name)
			if t is String and (t as String).begins_with(from + "/"):
				frag["endpoints"][name] = to + (t as String).substr(from.length())
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

	# release-fetch-gated passes only when the resume really sends the recorded If-Range, and the
	# record's hash is really checked: a doctored validator fails the request match, and a doctored
	# SHA-256 is payload-mismatch with no file left at `to`.
	var gated = PKeyTestFixtures.transcript("release-fetch-gated")
	if t.check("negative: release-fetch-gated present", gated is Dictionary):
		var validator: Dictionary = gated.duplicate(true)
		for x in validator["steps"][2]["exchanges"]["items"]:
			x["request"]["headers"]["if-range"] = "\"doctored\""
		f = await replay(validator)
		t.check("negative: a resume without the recorded If-Range fails", _mentions(f, "header if-range: expected"), "\n  ".join(f))
		var hashed: Dictionary = gated.duplicate(true)
		hashed["steps"][1]["args"]["sha256"] = "0".repeat(64)
		hashed["steps"][1]["expect"] = {"result": "refused", "code": "payload-mismatch", "fileLeft": false}
		hashed["steps"].resize(2)
		f = await replay(hashed)
		t.check("negative: bytes that miss the record's SHA-256 are payload-mismatch and leave no file", f.is_empty(), "\n  ".join(f))


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


## The transcript's name for an activation outcome: license_owned is a plain `refused` there.
# ── Cloud Sync settings (U-21.10, `sync.settings`) ────────────────────────────────────────────

const SYNC_DECLARED := ["ui.theme", "audio.volume"]
const SYNC_E2E_NAMES := ["ui.theme", "my.open.key", "game.best"]
const SYNC_E2E_ROUTES := [{"key": "ui.theme"}, {"key": "game.best"}]
const SYNC_CLIENT_ID := "c_AAAAAAAAAAAAAAAAAAAAAA"
const SYNC_HLC := "018bcfe56418:0000"


## The host codec over a ring made for this replay (a root of its own).
static func _fixture_codec(tr: Dictionary) -> PKeySyncHostCodec:
	var keys := PKeyDeviceKeyStore.for_tests(tr["product"], PKeyTestFixtures.scratch_dir("transcript-sync-keys"))
	var vault := PKeySyncRingVault.new(tr["product"], "user://pkey", true)
	var ring := PKeySyncRing.new(tr["product"], "dev_replay", func(_m: String, _p: String, _b: Variant) -> PKeyResult: return PKeyResult.success({"status": 201, "body": PackedByteArray()}), keys, vault)
	await ring.create(false)
	return PKeySyncHostCodec.new(ring)


## One label per mutation result, in the transcript format's words.
static func _result_label(r: Dictionary) -> String:
	match r.get("status"):
		"ok":
			if r.get("renamedTo") is String:
				return "ok:renamedTo:%s" % r["renamedTo"]
			return "ok:dropped" if r.get("dropped") == true else "ok"
		"rejected":
			return "rejected:%s:%s" % [r.get("code"), r["scope"]] if r.get("scope") is String else "rejected:%s" % r.get("code")
	return String(r.get("status"))


## `cloudSyncPull` / `cloudSyncPush` (WIRE-CONTRACT-V4 section 13.3, 13.4, V5 13.10): the request goes
## through Core's own transport (the bearer and the X-PKey headers). A pull sends the last ETag it saw
## as If-None-Match, as a cache would. The end-to-end transcript is sealed by `seal_push` and opened by
## `open_pull`, so every recorded `ct` reads `invalid`.
static func _cloud_sync(sdk: Node, step: Dictionary, out: Dictionary) -> void:
	var mem: Dictionary = sdk.get_meta("pkey_sync_mem")
	var e2e: bool = sdk.has_meta("pkey_sync_codec")
	var codec: PKeySyncHostCodec = sdk.get_meta("pkey_sync_codec") if e2e else null
	var args: Dictionary = step["args"]
	var cursor := int(args["cursor"])
	var mutations: Array = []
	var method := "GET"
	var path := "sync?cursor=%d" % cursor
	var body: Variant = null
	var extra := {}
	if step["action"] == "cloudSyncPull":
		if mem["etag"] != "":
			extra["if-none-match"] = mem["etag"]
	else:
		method = "POST"
		path = "sync/ops"
		var names: Array = SYNC_E2E_NAMES if e2e else SYNC_DECLARED
		for i in int(args["mutations"]):
			mutations.append({"mutationId": int(mem["next_id"]) + i, "target": {"setting": names[i % names.size()], "scope": "user"}, "op": "set", "value": "generated-%d" % (int(mem["next_id"]) + i), "editedHlc": SYNC_HLC})
		body = {"clientId": SYNC_CLIENT_ID, "cursor": cursor, "mutations": mutations}
		if args.get("atomic") == true:
			body["atomic"] = true
		if e2e:
			var sealed := codec.seal_push(body, SYNC_E2E_ROUTES)
			if not sealed["ok"]:
				out["result"] = "sealed-refused"
				return
			body = sealed["body"]
	mem["retry_after"] = null
	var r: PKeyResult = await sdk.core.request(method, path, body, true, extra)
	var detail: Dictionary = r.detail if r.detail is Dictionary else {}
	var status := int(detail.get("status", 0))
	var headers: Dictionary = detail.get("headers", {})
	if status == 0:
		out["result"] = String(r.code)
		return
	if step["action"] == "cloudSyncPull" and headers.has("etag"):
		mem["etag"] = headers["etag"]
	if status == 304:
		out["result"] = "not-modified"
		return
	if status < 200 or status >= 300:
		out["result"] = "refused"
		out["status"] = status
		var e: Variant = detail.get("error")
		if e is Dictionary and String(e.get("code", "")) != "":
			out["code"] = String(e["code"])
		if headers.has("retry-after"):
			out["retryAfter"] = int(String(headers["retry-after"]))
		return
	var parsed := PKeyJson.parse_bytes(detail["body"])
	var served: Variant = parsed["value"] if parsed["ok"] else null
	if e2e and served is Dictionary:
		var opened := codec.open_pull(served, mutations, {}, [])
		if not opened["ok"]:
			out["result"] = "open-refused"
			return
		served = opened["body"]
		var rows: Array = (opened["opened"].get("changes", []) as Array).duplicate()
		for row in (opened["opened"].get("conflicts", {}) as Dictionary).values():
			rows.append(row)
		for row in rows:
			if row != {"invalid": true}:
				out["result"] = "a fixture ct opened"
				return
	out["result"] = "ok"
	if not (served is Dictionary):
		return
	var b: Dictionary = served
	if SyncTypes.is_number(b.get("cursor")):
		out["cursor"] = b["cursor"]
	if b.get("more") is bool:
		out["more"] = b["more"]
	out["empty"] = b.get("empty") == true
	var names_out: Array = []
	for c in (b.get("changes", []) as Array if b.get("changes") is Array else []):
		if c is Dictionary and c.get("setting") is String:
			names_out.append(c["setting"])
	names_out.sort()
	out["settings"] = names_out
	if b.get("quota") is Dictionary:
		if SyncTypes.is_number(b["quota"].get("bytes")):
			out["quotaBytes"] = b["quota"]["bytes"]
		if b["quota"].get("files") is bool:
			out["files"] = b["quota"]["files"]
	if b.get("encryption") is String:
		out["encryption"] = b["encryption"]
	if SyncTypes.is_number(b.get("encryptionSince")):
		out["encryptionSince"] = b["encryptionSince"]
	if b.get("aliases") is Dictionary:
		out["aliases"] = b["aliases"]
	if step["action"] == "cloudSyncPush":
		if SyncTypes.is_number(b.get("lastMutationId")):
			out["lastMutationId"] = b["lastMutationId"]
			mem["next_id"] = int(b["lastMutationId"]) + 1
		var labels: Array = []
		for x in (b.get("results", []) as Array if b.get("results") is Array else []):
			labels.append(_result_label(x) if x is Dictionary else "?")
		out["results"] = labels


## A CORS exchange (`cloudsync-cors`): the browser's own. The preflight is played as recorded; the
## request carries the SDK's own headers and the device bearer under the recorded origin.
static func _cors(sdk: Node, step: Dictionary) -> void:
	for item in step["exchanges"]["items"]:
		var req: Dictionary = item["request"]
		var url: String = sdk.core.base_url + String(req["path"])
		var headers: Dictionary = {}
		var body := PackedByteArray()
		if req["method"] == "OPTIONS":
			# The preflight is the browser's, not the SDK's: the SDK's transport has no OPTIONS, so a bare
			# HTTPClient plays it as recorded.
			await _options(url, (req["headers"] as Dictionary).duplicate())
			continue
		else:
			headers = sdk.core.headers({"authorization": "Bearer %s" % sdk.core.tokens.current(), "content-type": "application/json", "origin": req["headers"]["origin"]})
			if req.get("body") is Dictionary and (req["body"] as Dictionary).has("json"):
				body = JSON.stringify(req["body"]["json"]).to_utf8_buffer()
		await sdk.core.transport.request(req["method"], url, headers, body)


static func _options(url: String, headers: Dictionary) -> void:
	var parts := url.trim_prefix("http://").split("/", true, 1)
	var hp := parts[0].split(":")
	var client := HTTPClient.new()
	if client.connect_to_host(hp[0], int(hp[1])) != OK:
		return
	var tree := Engine.get_main_loop() as SceneTree
	while client.get_status() in [HTTPClient.STATUS_CONNECTING, HTTPClient.STATUS_RESOLVING]:
		client.poll()
		await tree.process_frame
	var lines := PackedStringArray()
	for k in headers:
		lines.append("%s: %s" % [k, headers[k]])
	client.request(HTTPClient.METHOD_OPTIONS, "/" + parts[1], lines)
	while client.get_status() == HTTPClient.STATUS_REQUESTING:
		client.poll()
		await tree.process_frame
	while client.get_status() == HTTPClient.STATUS_BODY:
		client.poll()
		client.read_response_body_chunk()
		await tree.process_frame
	client.close()


## The key ring verbs (U-40.7, `sync.keyring`) over `PolarisKey.keyring`. The transcripts hold no key
## material the client could use, so the client makes its own: create and reset draw a root, wrap
## seals it to a fresh agreement key for the named device (`deviceId` is the TARGET), and adopt takes
## the root of the first ring this conversation created. A refusal reads as `refused` with the status
## and the code.
static func _keyring(sdk: Node, step: Dictionary, out: Dictionary) -> void:
	var k: PKeySyncRing = sdk.keyring
	var action: String = step["action"]
	var args: Dictionary = step["args"]
	var r: PKeyResult
	match action:
		"keyringGet":
			r = await k.read()
			if r.ok:
				var g: Variant = r.detail["ring"]
				out["ring"] = null if g == null else {"ringId": g["ring_id"], "epoch": g["epoch"], "rootKid": g["root_kid"], "state": g["state"], "recoverySet": g["recovery_set"], "previous": g["previous"]["ring_id"] if g["previous"] != null else null, "adopted": (g["adopted"] as Array).map(func(a: Dictionary) -> String: return a["ring_id"])}
				var w: Variant = r.detail["wrap"]
				out["wrap"] = null if w == null else {"epoch": w["epoch"], "kid": w["kid"], "by": w["by"]}
		"keyringCreate", "keyringReset":
			if action == "keyringCreate":
				r = await k.create()
			else:
				r = await k.reset()
			if r.ok:
				if action == "keyringCreate" and not sdk.has_meta("pkey_first_ring"):
					sdk.set_meta("pkey_first_ring", r.detail["ring_id"])
				# The ring id is the client's own draw and the recording's is a fixture: both must be a well
				# formed id, and the replay reports the recorded one when ours is.
				var well := RegEx.create_from_string("\\Arg_[A-Za-z0-9_-]{22}\\z").search(r.detail["ring_id"]) != null
				out["ringId"] = step["expect"].get("ringId", r.detail["ring_id"]) if well else r.detail["ring_id"]
				out["epoch"] = r.detail["epoch"]
		"keyringWrap":
			var fresh := PKeyDeviceKeyStore.for_tests("djdl", PKeyTestFixtures.scratch_dir("transcript-ring-peer")).ensure()
			r = await k.wrap_to(String(args.get("deviceId", "")), fresh.detail["agree_key"])
		"keyringUnwrap":
			r = await k.remove_wrap(String(args.get("deviceId", "")))
		"keyringAdopt":
			r = await k.adopt(String(sdk.get_meta("pkey_first_ring", "")))
		"keyringRecoverySet":
			r = await k.set_recovery_code()
		_:
			r = await k.recovery_blob()
			if r.ok:
				out["ct"] = r.detail["ct"]
	out["result"] = "ok" if r.ok else "refused"
	if not r.ok:
		if r.detail is Dictionary and r.detail.get("status") != null:
			out["status"] = r.detail["status"]
		out["code"] = String(r.code)


static func _activation_name(r: PKeyActivationResult) -> String:
	return "refused" if r.kind == PKeyActivationResult.KIND_LICENSE_OWNED else String(r.kind)


## PX-W8 / identity.keyentry: the refusal link and the key entries, exactly as served; null when
## the result carries none.
static func _report_activation(out: Dictionary, r: PKeyActivationResult) -> void:
	if r.kind == PKeyActivationResult.KIND_DEVICE_LIMIT or r.kind == PKeyActivationResult.KIND_KEY_ENTRY_LIMIT:
		out["manageUrl"] = r.manage_url
	if r.kind == PKeyActivationResult.KIND_OK or r.kind == PKeyActivationResult.KIND_KEY_ENTRY_LIMIT:
		out["keyEntries"] = r.key_entries
	if r.kind == PKeyActivationResult.KIND_LICENSE_OWNED:
		out["signInUrl"] = r.sign_in_url
