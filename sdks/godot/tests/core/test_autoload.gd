extends RefCounted
# The `PolarisKey` root: configure refuses what it must, capabilities are fail-closed (D-21),
# discovery installs a capability map without ever pinning from it, every product-scoped call
# carries the seven X-PKey-* headers, and the refresh loop syncs on its timer and on resume.


func run(t: PKeyTestContext) -> void:
	await _configure(t)
	await _capabilities(t)
	await _headers_and_refresh(t)


func _opts(product := "djdl", version := "1.0.0") -> PKeyOptions:
	var o := PKeyOptions.new()
	o.product = product
	o.version = version
	o.store = PKeyMemoryStore.new()
	return o


func _configure(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	t.check("autoload: status before configure needs activation", sdk.status() == {"status": "needs-activation"} and not sdk.is_licensed())
	var early: PKeyResult = await sdk.start()
	t.check("autoload: start before configure is refused", early.code == PKeyErrors.NOT_CONFIGURED)
	early = await sdk.sync()
	t.check("autoload: sync before configure is refused", early.code == PKeyErrors.NOT_CONFIGURED)
	t.check("autoload: configure(null) is refused", sdk.configure(null).code == PKeyErrors.INVALID_OPTIONS)
	t.check("autoload: a bad product slug is refused", sdk.configure(_opts("Dice Roll")).code == PKeyErrors.INVALID_OPTIONS)
	for bad in ["1.0", "v1.0.0", "latest"]:
		t.check("autoload: version %s is refused (semver only)" % bad, sdk.configure(_opts("djdl", bad)).code == PKeyErrors.INVALID_OPTIONS)
	var unset := _opts("djdl", "")
	var project_version := str(ProjectSettings.get_setting("application/config/version", ""))
	t.check("autoload: an empty version falls back to application/config/version", sdk.configure(unset).ok == PKeySemver.is_valid(project_version), project_version)
	var services := _opts()
	services.expected_services = PackedStringArray(["config", "nope"])
	t.check("autoload: an unknown expected service is refused", sdk.configure(services).code == PKeyErrors.INVALID_OPTIONS)
	var pins := _opts()
	pins.pinned_trust_keys = {"kid": 5}
	t.check("autoload: malformed pins are refused", sdk.configure(pins).code == PKeyErrors.INVALID_OPTIONS)
	var good := _opts("djdl", "0.0.0-dev.4")
	t.check("autoload: configure accepts valid options", sdk.configure(good).ok)
	t.check("autoload: the channel derives from a dev version", sdk.core.channel == "dev")
	var beta := _opts("djdl", "0.0.0-beta.2")
	sdk.configure(beta)
	t.check("autoload: the channel derives beta from a beta version", sdk.core.channel == "beta")
	good.default_channel = "beta"
	sdk.configure(good)
	t.check("autoload: default_channel wins until the build stamp supplies one", sdk.core.channel == "beta")
	var started: PKeyResult = await sdk.start()
	t.check("autoload: start", started.ok)
	t.check("autoload: get_sync_state has the bridge keys", sdk.get_sync_state().keys() == ["activation", "doc", "last_sync_unauthorized", "blocked", "last_verified_at", "high_water_mark"], str(sdk.get_sync_state().keys()))
	t.check("autoload: store_status comes from the store", sdk.store_status() == {"backend": "memory"})
	sdk.queue_free()


func _capabilities(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	# Derived from the generated service table, so a new slug cannot break this test.
	var def := {}
	for slug in PKeyServices.SLUGS:
		def[slug] = {"enabled": slug in PKeyServices.DEFAULT_ENABLED}
	t.check("autoload: the generated table includes distribution", "distribution" in PKeyServices.SLUGS)
	t.check("autoload: the default map is licence and config", PKeyServices.DEFAULT_ENABLED == ["license", "config"])
	t.check("autoload: capabilities before configure are licence and config only", sdk.capabilities() == def, str(sdk.capabilities()))
	t.check("autoload: the service order is the generated table's", sdk.capabilities().keys() == PKeyServices.SLUGS)
	var o := _opts()
	o.expected_services = PackedStringArray(["config", "update"])
	sdk.configure(o)
	var caps: Dictionary = sdk.capabilities()
	t.check("autoload: expected_services replaces the default", caps["config"]["enabled"] and caps["update"]["enabled"] and not caps["license"]["enabled"], str(caps))

	var tr = PKeyTestFixtures.transcript("discovery-capabilities")
	var doc: Dictionary = tr["steps"][0]["exchanges"]["items"][0]["response"]["body"]
	var answers := [{"status": 200, "body": JSON.stringify(doc)}]
	var server := PKeyTestFixtures.new_server(func(_r): return answers[0])
	o = _opts()
	o.base_url = server.base_url()
	o.pinned_trust_keys = {"my-pin": "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U"}
	sdk.configure(o)
	await sdk.start()
	var d: PKeyResult = await sdk.discover()
	caps = sdk.capabilities()
	t.check("autoload: discovery installs the product's map", d.ok and d.detail["kind"] == "ok" and caps["config"]["enabled"] and not caps["license"]["enabled"], str(caps))
	t.check("autoload: discovery wins over expected_services", not sdk.capabilities()["update"]["enabled"])
	t.check("autoload: discovery never pins its trust.pinnedKeys", sdk.core.trust.pinned() == {"my-pin": "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U"})
	t.check("autoload: a product without the licence service is not-applicable", sdk.status()["status"] == "not-applicable")

	var broken := doc.duplicate(true)
	broken["services"]["license"] = {"enabled": "true"}
	answers[0] = {"status": 200, "body": JSON.stringify(broken)}
	d = await sdk.discover()
	t.check("autoload: enabled must be the boolean true", d.ok and not sdk.capabilities()["license"]["enabled"])
	broken["services"]["license"] = "on"
	answers[0] = {"status": 200, "body": JSON.stringify(broken)}
	d = await sdk.discover()
	t.check("autoload: a malformed services map is an invalid document", not d.ok and d.detail["kind"] == "invalid")
	var foreign := doc.duplicate(true)
	foreign["product"] = "other"
	answers[0] = {"status": 200, "body": JSON.stringify(foreign)}
	d = await sdk.discover()
	t.check("autoload: another product's document is invalid", not d.ok and d.detail["kind"] == "invalid")
	var missing := doc.duplicate(true)
	missing["services"].erase("config")
	answers[0] = {"status": 200, "body": JSON.stringify(missing)}
	d = await sdk.discover()
	t.check("autoload: a slug the document omits is disabled", d.ok and not sdk.capabilities()["config"]["enabled"])
	answers[0] = {"status": 404, "body": "{\"error\":\"not_found\"}"}
	d = await sdk.discover()
	t.check("autoload: a 404 is not-found and keeps the last map", not d.ok and d.detail["kind"] == "not-found" and not sdk.capabilities()["config"]["enabled"])
	sdk.queue_free()
	server.queue_free()


func _headers_and_refresh(t: PKeyTestContext) -> void:
	var server := PKeyTestFixtures.new_server(func(_r): return {"status": 404, "body": "{\"error\":\"not_found\"}"})
	var sdk := PKeyTestFixtures.new_sdk()
	var o := _opts()
	o.base_url = server.base_url()
	o.store = PKeyMemoryStore.new("", "pkeyt_x")
	o.refresh_interval_seconds = 0.25
	sdk.configure(o)
	await sdk.start()
	var r: PKeyResult = await sdk.core.request("GET", "release/changelog", null, true)
	var h: Dictionary = server.requests.back()["headers"]
	var want := {
		"x-pkey-device": sdk.core.device_id,
		"x-pkey-version": "1.0.0",
		"x-pkey-channel": "stable",
		"x-pkey-sdk": "polaris-key-godot",
		"x-pkey-sdk-version": "0.1.0",
		"authorization": "Bearer pkeyt_x",
	}
	var all := true
	for k in want:
		all = all and h.get(k) == want[k]
	t.check("autoload: a product-scoped call carries the X-PKey-* headers and the bearer", all, str(h))
	if PKeyHeaders.platform() != "" and PKeyHeaders.arch() != "":
		t.check("autoload: platform and arch come from the one table", h.get("x-pkey-platform") == PKeyHeaders.platform() and h.get("x-pkey-arch") == PKeyHeaders.arch(), str(h))
	t.check("autoload: a 404 with a flat body is a failure with the wire code", not r.ok and r.code == &"not_found" and r.detail["status"] == 404, str(r))

	server.requests.clear()
	var t0 := Time.get_ticks_msec()
	while server.requests.is_empty() and Time.get_ticks_msec() - t0 < 3000:
		await PKeyTestFixtures.frames(1)
	t.check("autoload: the refresh timer syncs", not server.requests.is_empty())

	# Resume syncs while the refresh loop is on.
	sdk.core.options.refresh_interval_seconds = 60.0
	sdk._start_timer()
	while sdk._syncing:
		await PKeyTestFixtures.frames(1)
	server.requests.clear()
	sdk.notification(Node.NOTIFICATION_APPLICATION_RESUMED)
	t0 = Time.get_ticks_msec()
	while server.requests.is_empty() and Time.get_ticks_msec() - t0 < 3000:
		await PKeyTestFixtures.frames(1)
	t.check("autoload: resuming the application syncs", not server.requests.is_empty())
	while sdk._syncing:
		await PKeyTestFixtures.frames(1)

	# Off (the default): no timer, and resume does nothing.
	sdk.core.options.refresh_interval_seconds = 0
	sdk._start_timer()
	t.check("autoload: refresh_interval_seconds = 0 starts no timer", sdk._timer == null)
	server.requests.clear()
	sdk.notification(Node.NOTIFICATION_APPLICATION_RESUMED)
	await PKeyTestFixtures.frames(20)
	t.check("autoload: resume does nothing with the loop off", server.requests.is_empty())
	sdk.queue_free()
	server.queue_free()
