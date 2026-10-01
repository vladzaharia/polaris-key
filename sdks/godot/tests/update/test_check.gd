extends RefCounted
# @pkey-feature update.check
# PolarisKey.update.check against a loopback server answering like the Worker's
# /update/version: the comparison is PKeySemver's (the gate's) against PKeyOptions.version,
# update_available fires only when this build is behind, the channel goes out canonically or not
# at all, a 403 keeps the body's code, anything else is not_found, and a disabled service sends
# nothing.

const NEWEST := {"version": "1.3.0", "tag": "v1.3.0", "url": "https://github.com/acme/djdl/releases/tag/v1.3.0"}

var sup: PKeyUpdateTestSupport


func run(t: PKeyTestContext) -> void:
	sup = PKeyUpdateTestSupport.new()
	if not t.check("check: fixtures and server", sup.ready()):
		return
	await _compare(t)
	await _channel(t)
	await _errors(t)
	await _disabled(t)
	await _bearer(t)
	await _unconfigured(t)
	sup.free_server()


## Runs one check against `served` with the host at `version`; returns [result, emitted checks].
func _check_once(served: Dictionary, version: String, channel := "") -> Array:
	sup.plan = {"/update/version": [PKeyUpdateTestSupport.json(200, served)]}
	var sdk = await sup.sdk(PackedStringArray(["update"]), version)
	var seen: Array = []
	sdk.update.update_available.connect(func(c): seen.append(c))
	var r: PKeyVersionCheck = await sdk.update.check(channel)
	sdk.queue_free()
	return [r, seen]


func _compare(t: PKeyTestContext) -> void:
	sup.server.requests.clear()
	var got := await _check_once(NEWEST, "1.2.3")
	var r: PKeyVersionCheck = got[0]
	t.check("check: newer served -> update_available", r.ok and r.update_available and r.version == "1.3.0" and r.tag == "v1.3.0" and r.url == NEWEST["url"] and r.status == 200, str(r))
	t.check("check: newer served -> the signal fires once with the result", got[1].size() == 1 and got[1][0] == r, str(got[1]))
	var reqs := sup.requests("/update/version")
	t.check("check: one GET of the canonical /<p>/update/version, no query", reqs.size() == 1 and reqs[0]["method"] == "GET" and reqs[0]["path"] == "/%s/update/version" % sup.F["product"], str(reqs.map(func(q): return q["path"])))
	t.check("check: the X-PKey-Version header is the host's version", reqs.size() == 1 and reqs[0]["headers"].get("x-pkey-version") == "1.2.3")

	# [served, host version, expected update_available]
	var rows := [
		[NEWEST, "1.3.0", false],
		[NEWEST, "1.4.0", false],
		[NEWEST, "1.3.0-beta.1", true],
		[{"version": "1.3.0-beta.10", "tag": "v1.3.0-beta.10", "url": ""}, "1.3.0-beta.9", true],
		[{"version": "1.3.0-beta.2", "tag": "", "url": ""}, "1.3.0-beta.2", false],
		[{"version": "1.3.0-alpha.1", "tag": "", "url": ""}, "1.3.0-beta.1", false],
		[{"version": "1.3.0-beta.1", "tag": "", "url": ""}, "1.3.0-beta", true],
		[{"version": "1.3.0+build.9", "tag": "", "url": ""}, "1.3.0+build.1", false],
		[{"version": "2.0.0", "tag": "", "url": ""}, "1.99.99", true],
	]
	for row in rows:
		got = await _check_once(row[0], row[1])
		r = got[0]
		var label: String = "check: %s served, host %s -> %s" % [row[0]["version"], row[1], row[2]]
		t.check(label, r.ok and r.update_available == row[2] and r.update_available == (PKeySemver.compare(row[1], row[0]["version"]) < 0), str(r))
		t.check(label + " (signal %s)" % ("once" if row[2] else "never"), got[1].size() == (1 if row[2] else 0), str(got[1].size()))


func _channel(t: PKeyTestContext) -> void:
	# [argument, the query sent ("" = none), or null when nothing may be sent]
	var rows := [
		["", ""],
		["beta", "?channel=beta"],
		["stable", "?channel=stable"],
		["staging", "?channel=beta"],
		["latest", "?channel=stable"],
		["pr7", "?channel=pr-7"],
		["pr-12", "?channel=pr-12"],
		["my-channel", "?channel=my-channel"],
		["1.2.3", null],
		["Beta", null],
		["beta\n", null],
		["a b", null],
	]
	for row in rows:
		sup.server.requests.clear()
		var got := await _check_once(NEWEST, "1.2.3", row[0])
		var r: PKeyVersionCheck = got[0]
		var reqs := sup.requests("/update/version")
		if row[1] == null:
			t.check("channel %s: refused as invalid-options, nothing sent" % JSON.stringify(row[0]), not r.ok and r.code == PKeyErrors.INVALID_OPTIONS and reqs.is_empty() and got[1].is_empty(), "%s, %d requests" % [r, reqs.size()])
		else:
			var want := "/%s/update/version%s" % [sup.F["product"], row[1]]
			t.check("channel %s: sends %s" % [JSON.stringify(row[0]), want], r.ok and reqs.size() == 1 and reqs[0]["path"] == want, str(reqs.map(func(q): return q["path"])))


func _errors(t: PKeyTestContext) -> void:
	var sdk = await sup.sdk(PackedStringArray(["update"]))
	var seen: Array = []
	sdk.update.update_available.connect(func(c): seen.append(c))
	# [answer, expected code, expected status]
	var rows := [
		[PKeyUpdateTestSupport.json(403, {"error": {"code": "channel_not_allowed"}}), "channel_not_allowed", 403],
		[PKeyUpdateTestSupport.json(403, {"error": "channel_not_allowed"}), "channel_not_allowed", 403],
		[PKeyUpdateTestSupport.json(403, {}), "forbidden", 403],
		[PKeyUpdateTestSupport.raw(403, "<html>"), "forbidden", 403],
		[PKeyUpdateTestSupport.json(404, {"error": {"code": "not_found"}}), "not_found", 404],
		[PKeyUpdateTestSupport.json(401, {"error": {"code": "unauthorized"}}), "not_found", 401],
		[PKeyUpdateTestSupport.json(500, {}), "not_found", 500],
		[PKeyUpdateTestSupport.json(200, {"tag": "v1"}), "invalid-response", 200],
		[PKeyUpdateTestSupport.json(200, {"version": 3}), "invalid-response", 200],
		[PKeyUpdateTestSupport.raw(200, "not json"), "invalid-response", 200],
	]
	for row in rows:
		sup.plan = {"/update/version": [row[0]]}
		var r: PKeyVersionCheck = await sdk.update.check("beta")
		t.check("errors: %d %s -> %s" % [row[2], row[0]["body"].left(40), row[1]], not r.ok and String(r.code) == row[1] and r.status == row[2] and not r.update_available and r.version == "", str(r))
	t.check("errors: update_available never fired for a failure", seen.is_empty())
	sdk.queue_free()

	# Nothing answered: the transport's own code survives (here local-only, which sends nothing).
	sup.server.requests.clear()
	var local = await sup.sdk(PackedStringArray(["update"]), "1.2.3", "", "", func(o): o.local_only = true)
	var lr: PKeyVersionCheck = await local.update.check()
	t.check("errors: local-only keeps the transport's code, status 0, nothing sent", not lr.ok and lr.code == PKeyErrors.LOCAL_ONLY and lr.status == 0 and sup.server.requests.is_empty(), str(lr))
	local.queue_free()


func _disabled(t: PKeyTestContext) -> void:
	sup.server.requests.clear()
	sup.plan = {"/update/version": [PKeyUpdateTestSupport.json(200, NEWEST)]}
	var sdk = await sup.sdk(PackedStringArray(["license", "config"]))
	var r: PKeyVersionCheck = await sdk.update.check()
	t.check("disabled (expected services): service-unavailable, no request", not r.ok and r.code == PKeyErrors.SERVICE_UNAVAILABLE and sup.server.requests.is_empty(), str(r))
	sdk.queue_free()

	# Update off in this session's discovery document, although expected_services named it.
	var doc := {"product": sup.F["product"], "services": {"license": {"enabled": true}, "config": {"enabled": true}, "release": {"enabled": true}, "distribution": {"enabled": true}, "update": {"enabled": false}, "identity": {"enabled": false}}}
	sup.plan = {".well-known/polaris.json": [PKeyUpdateTestSupport.json(200, doc)], "/update/version": [PKeyUpdateTestSupport.json(200, NEWEST)]}
	sdk = await sup.sdk(PackedStringArray(["update"]))
	var d: PKeyResult = await sdk.discover()
	sup.server.requests.clear()
	r = await sdk.update.check("beta")
	t.check("disabled in discovery: service-unavailable and the server records no request", d.ok and not r.ok and r.code == PKeyErrors.SERVICE_UNAVAILABLE and sup.server.requests.is_empty(), "%s / %s / %d" % [d, r, sup.server.requests.size()])
	sdk.queue_free()


func _bearer(t: PKeyTestContext) -> void:
	sup.plan = {"/update/version": [PKeyUpdateTestSupport.json(200, NEWEST)]}
	sup.server.requests.clear()
	var anon = await sup.sdk(PackedStringArray(["update"]))
	await anon.update.check()
	var reqs := sup.requests("/update/version")
	t.check("bearer: none sent without a token", reqs.size() == 1 and not reqs[0]["headers"].has("authorization"))
	anon.queue_free()

	sup.server.requests.clear()
	var held = await sup.sdk(PackedStringArray(["update"]), "1.2.3", PKeyUpdateTestSupport.TOKEN)
	await held.update.check("beta")
	reqs = sup.requests("/update/version")
	t.check("bearer: the held token is forwarded", reqs.size() == 1 and reqs[0]["headers"].get("authorization") == "Bearer " + PKeyUpdateTestSupport.TOKEN)
	held.queue_free()


func _unconfigured(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	var seen: Array = []
	var connected: bool = sdk.update.update_available.connect(func(c): seen.append(c)) == OK
	var r: PKeyVersionCheck = await sdk.update.check()
	t.check("unconfigured: the sub-object exists and refuses with not-configured", connected and not r.ok and r.code == PKeyErrors.NOT_CONFIGURED, str(r))
	t.check("unconfigured: appcast_url is empty", sdk.update.appcast_url("beta", "arm64") == "")
	# A connection made before configure() survives it.
	sup.plan = {"/update/version": [PKeyUpdateTestSupport.json(200, NEWEST)]}
	var opts := PKeyTestFixtures.options(sup.server.base_url(), PKeyMemoryStore.new(sup.F["device_id"]), [sup.F["now"]], sup.F["product"], sup.F["trust"], "1.2.3")
	opts.expected_services = PackedStringArray(["update"])
	sdk.configure(opts)
	await sdk.start()
	r = await sdk.update.check()
	t.check("unconfigured: a signal connected before configure() still fires", r.ok and seen.size() == 1, "%s, %d" % [r, seen.size()])
	sdk.queue_free()
