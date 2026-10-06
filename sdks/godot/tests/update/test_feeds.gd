extends RefCounted
# @pkey-feature update.feeds
# The app-updater feed URLs (plans/SP-00.md D5, SDK parity pass §3.7): every row of the corpus's
# res://tests/corpus/v2/feed-url-matrix.json through PolarisKey.update.feed_url(), against a
# discovery document carrying the row's endpoint set and served by the loopback server (the
# same shape sdk-node's feedUrlMatrix.test.ts serves). Then what the matrix does not pin: the
# answer before discovery, the caller errors, and PKeyUpdater.feed_url's bridge names over it.

const MATRIX := "res://tests/corpus/v2/feed-url-matrix.json"
const PRODUCT := "full"

var sup: PKeyUpdateTestSupport


func run(t: PKeyTestContext) -> void:
	var m = PKeyTestFixtures.read_json(MATRIX)
	if not t.check("feeds: matrix present", m is Dictionary and m.get("rows") is Array and m.get("endpointSets") is Dictionary and m["rows"].size() > 0, MATRIX):
		return
	sup = PKeyUpdateTestSupport.new()
	if not t.check("feeds: fixtures and server", sup.ready()):
		return
	var evaluated := 0
	for set_name in m["endpointSets"]:
		var rows: Array = m["rows"].filter(func(r): return r["endpoints"] == set_name)
		if rows.is_empty():
			continue
		var sdk = await _sdk_for(m["endpointSets"][set_name])
		var d: PKeyResult = await sdk.discover()
		if not t.check("feeds: discovery for %s" % set_name, d.ok, str(d)):
			sdk.queue_free()
			continue
		for row in rows:
			var input: Dictionary = row["input"]
			var opts := {}
			if input.has("channel"):
				opts["channel"] = input["channel"]
			if input.has("velopackChannel"):
				opts["velopack_channel"] = input["velopackChannel"]
			if input.has("buildId"):
				opts["build_id"] = input["buildId"]
			var got: PKeyResult = sdk.update.feed_url(input["kind"], opts)
			var expect: Dictionary = row["expect"]
			if expect.has("url"):
				t.check("feeds: %s" % row["name"], got.ok and got.detail["url"] == expect["url"], "got %s, want %s" % [got.detail.get("url") if got.ok else str(got), expect["url"]])
			else:
				t.check("feeds: %s" % row["name"], not got.ok and got.code == PKeyErrors.UNSUPPORTED and got.detail["reason"] == expect["unsupported"] and got.detail["feature"] == PKeyConstants.Feature.UPDATE_DRIVER, str(got))
			evaluated += 1
		if set_name == "everything":
			_beyond_matrix(t, sdk)
		sdk.queue_free()
	t.check("feeds: coverage", evaluated == m["rows"].size(), "%d/%d" % [evaluated, m["rows"].size()])
	await _before_discovery(t)
	sup.free_server()


func _sdk_for(endpoints: Dictionary) -> Node:
	var update := {"enabled": true, "endpoints": endpoints} if not endpoints.is_empty() else {"enabled": false}
	sup.server.requests.clear()
	sup.plan = {".well-known/polaris.json": [PKeyUpdateTestSupport.json(200, {"product": PRODUCT, "services": {"update": update}})]}
	return await sup.sdk(PackedStringArray(["update"]), "1.2.3", "", PRODUCT)


## Caller errors and the updater's bridge names, over the `everything` set.
func _beyond_matrix(t: PKeyTestContext, sdk: Node) -> void:
	var bad: PKeyResult = sdk.update.feed_url("sparkle")
	t.check("feeds: an unknown kind is invalid-options", not bad.ok and bad.code == PKeyErrors.INVALID_OPTIONS, str(bad))
	var no_build: PKeyResult = sdk.update.feed_url("zsync", {"channel": "beta"})
	t.check("feeds: zsync without build_id is invalid-options", not no_build.ok and no_build.code == PKeyErrors.INVALID_OPTIONS, str(no_build))
	var arch: PKeyResult = sdk.update.feed_url("appcast", {"channel": "beta", "arch": "arm64"})
	t.check("feeds: appcast carries ?arch=", arch.ok and arch.detail["url"] == "https://key.plrs.im/full/update/beta/appcast.xml?arch=arm64", str(arch.detail))
	var u: PKeyUpdater = sdk.update.updater
	t.check("feeds: the updater's WinSparkle feed is this build's channel (stable)", u.feed_url("winsparkle") == "https://key.plrs.im/full/update/stable/winsparkle.xml", u.feed_url("winsparkle"))
	t.check("feeds: the updater's Velopack feed is the directory", u.feed_url("velopack") == "https://key.plrs.im/full/update/stable/velopack/", u.feed_url("velopack"))
	t.check("feeds: the updater's Sparkle feed is the appcast for this arch", u.feed_url("sparkle").begins_with("https://key.plrs.im/full/update/appcast.xml?arch="), u.feed_url("sparkle"))
	t.check("feeds: the updater reaches App Installer and zsync", u.feed_url("appInstaller", {"channel": "latest"}) == "https://key.plrs.im/full/update/stable/app.appinstaller" and u.feed_url("zsync", {"build_id": "linux-arm64"}) == "https://key.plrs.im/full/update/stable/linux-arm64.AppImage.zsync")
	t.check("feeds: the updater answers \"\" where feed_url refuses", u.feed_url("zsync") == "" and u.feed_url("nope") == "")


func _before_discovery(t: PKeyTestContext) -> void:
	var sdk = await _sdk_for({})
	var got: PKeyResult = sdk.update.feed_url("winsparkle")
	t.check("feeds: before discover() is unsupported (product)", not got.ok and got.code == PKeyErrors.UNSUPPORTED and got.detail["reason"] == PKeyConstants.UnsupportedReason.PRODUCT, str(got))
	sdk.queue_free()
