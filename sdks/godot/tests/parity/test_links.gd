extends RefCounted
# Portal links (SDK parity §3.5) and crash tags (§3.14): pure builders over the configured base
# URL and product, and the release/environment/outlet tags W/services/distribution/sentry.ts maps.

const S := preload("res://tests/license/support.gd")


func run(t: PKeyTestContext) -> void:
	var b := "https://key.example"
	var cases := [
		["account", {}, b + "/#/account"],
		["library", {}, b + "/#/"],
		["activate", {"key": "pkey_djdl_A b"}, b + "/#/?activate=pkey_djdl_A+b"],
		["devices", {}, b + "/#/p/djdl/devices"],
		["free-device", {"for": "Ada's Steam Deck", "return_to": "mygame://back"}, b + "/#/p/djdl/free-device?for=Ada%27s+Steam+Deck&return=mygame%3A%2F%2Fback"],
		["freeDevice", {"return_to": "javascript:alert(1)"}, b + "/#/p/djdl/free-device"],
		["free-device", {"return_to": "/relative"}, b + "/#/p/djdl/free-device"],
		["download", {"platform": "windows"}, b + "/#/p/djdl/download?platform=windows"],
		["download", {}, b + "/#/p/djdl/download"],
		["nope", {}, ""],
	]
	for c in cases:
		var got := PKeyPortal.build(b + "/", "djdl", c[0], c[1])
		t.check("portal: %s %s" % [c[0], JSON.stringify(c[1])], got == c[2], got)
	t.check("portal: a long device label is cut to 64 characters", PKeyPortal.build(b, "djdl", "free-device", {"for": "x".repeat(100)}).ends_with("for=" + "x".repeat(64)))
	t.check("portal: an https return is kept", PKeyPortal.acceptable_return("https://game.example/back") and not PKeyPortal.acceptable_return("https:/x") and not PKeyPortal.acceptable_return("data:text/html,x"))

	var cold := PKeyTestFixtures.new_sdk()
	t.check("portal: '' before configure()", cold.portal.url("account") == "")
	var tags: Dictionary = cold.crash_tags()
	t.check("crash tags: before configure() the build fallback still names the release", String(tags.get("release", "")).begins_with("app@") and tags.has("environment"), str(tags))
	cold.queue_free()

	var h := PKeyLicenseTestSupport.new()
	var sdk = await h.sdk(PKeyMemoryStore.new(h.F["device_id"]))
	t.check("portal: built from the configured base and product", sdk.portal.url("devices") == "%s/#/p/%s/devices" % [h.server.base_url(), h.F["product"]], sdk.portal.url("devices"))
	tags = sdk.crash_tags()
	t.check("crash tags: release is app@<version> (no +0 in the editor)", tags["release"] == "app@%s" % h.F["version"], str(tags))
	t.check("crash tags: environment is the update channel", tags["environment"] == sdk.update.get_channel() and tags["environment"] != "")
	t.check("crash tags: no outlet tag when the outlet is unknown", not tags.has("pkey.outlet") or tags["pkey.outlet"] == sdk.core.reported_outlet())
	sdk.core.options.update_outlet = "steam"
	t.check("crash tags: the reported outlet rides as pkey.outlet", sdk.crash_tags().get("pkey.outlet") == "steam", str(sdk.crash_tags()))
	t.check("crash tags: a deliverable can be named", sdk.crash_tags("dlc.soundtrack")["release"].begins_with("dlc.soundtrack@"))
	sdk.queue_free()
	h.free_server()
