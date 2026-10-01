extends RefCounted
# @pkey-feature core.discover core.sync core.cache devices.register devices.report
# @pkey-feature license.activate license.enroll license.deactivate license.reregister
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
	var sdk := PKeyTestFixtures.new_sdk()
	var fails: Array = []
	var cr: PKeyResult = sdk.configure(opts)
	if not cr.ok:
		fails.append("configure: %s" % cr)
	else:
		await sdk.start()
		for i in tr["steps"].size():
			var step: Dictionary = engine.begin_step(i)
			clock[0] = step.get("now", tr["now"])
			var observed := await _act(sdk, store, step)
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
		"enroll":
			var r: PKeyActivationResult = await sdk.license.enroll()
			out["result"] = String(r.kind)
		"deactivate":
			var r: PKeyResult = await sdk.license.deactivate()
			out["result"] = "ok" if r.ok else String(r.code)
		"register":
			var r: PKeyResult = await sdk.devices.register()
			out["result"] = r.detail.get("kind", "") if r.detail is Dictionary else ""
		"report":
			out["result"] = await sdk.devices.report()
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


## JSON equality without GDScript's cross-type `==` errors (a String compared with a bool).
static func _same(a: Variant, b: Variant) -> bool:
	if PKeyClaims.is_number(a) and PKeyClaims.is_number(b):
		return float(a) == float(b)
	return typeof(a) == typeof(b) and a == b


static func _mentions(fails: Array, needle: String) -> bool:
	for line in fails:
		if String(line).contains(needle):
			return true
	return false
