extends RefCounted
# @pkey-feature release.changelog release.download
# PolarisKey.release against a loopback server answering like the Worker's
# /release/changelog: the entries verbatim (a null summary stays null), an empty list for a body
# without entries, the bearer forwarded only when held, a 401/403 by the body's own code in either
# spelling, anything else not_found; and with Release off, nothing sent and no URL built.

const CHANGELOG := {
	"entries": [
		{"version": "1.3.0", "tag": "v1.3.0", "date": "2026-08-01T00:00:00Z", "summary": "Stems.", "url": "https://github.com/x/y/releases/tag/v1.3.0"},
		{"version": "1.2.3", "tag": "v1.2.3", "date": null, "summary": null, "url": "https://github.com/x/y/releases/tag/v1.2.3"},
	],
}

var sup: PKeyUpdateTestSupport


func run(t: PKeyTestContext) -> void:
	sup = PKeyUpdateTestSupport.new()
	if not t.check("release: fixtures and server", sup.ready()):
		return
	await _changelog(t)
	await _bearer(t)
	await _errors(t)
	await _disabled(t)
	sup.free_server()


func _changelog(t: PKeyTestContext) -> void:
	sup.server.requests.clear()
	sup.plan = {"/release/changelog": [PKeyUpdateTestSupport.json(200, CHANGELOG)]}
	var sdk = await sup.sdk(PackedStringArray(["release"]))
	var r: PKeyChangelogResult = await sdk.release.changelog()
	t.check("changelog: ok with both entries", r.ok and r.status == 200 and r.entries.size() == 2, str(r))
	if r.entries.size() == 2:
		var a: PKeyChangelogEntry = r.entries[0]
		var b: PKeyChangelogEntry = r.entries[1]
		t.check("changelog: fields kept, newest first", a.version == "1.3.0" and a.tag == "v1.3.0" and a.date == "2026-08-01T00:00:00Z" and a.summary == "Stems." and a.url.ends_with("v1.3.0"))
		t.check("changelog: a null summary and date stay null", b.summary == null and b.date == null and b.version == "1.2.3")
	t.check("changelog: to_array() is the Worker's entries verbatim", JSON.stringify(r.to_array()) == JSON.stringify(CHANGELOG["entries"]), JSON.stringify(r.to_array()))
	var reqs := sup.requests("/release/changelog")
	t.check("changelog: one GET of the canonical /<p>/release/changelog", reqs.size() == 1 and reqs[0]["method"] == "GET" and reqs[0]["path"] == "/%s/release/changelog" % sup.F["product"])
	t.check("changelog: carries the X-PKey-* metadata", reqs.size() == 1 and reqs[0]["headers"].get("x-pkey-version") == "1.2.3" and reqs[0]["headers"].get("x-pkey-channel") == "stable" and reqs[0]["headers"].get("x-pkey-device") == sup.F["device_id"])

	for body in [{}, {"entries": "nope"}, {"entries": []}, {"entries": [1, "x", null]}]:
		sup.plan = {"/release/changelog": [PKeyUpdateTestSupport.json(200, body)]}
		r = await sdk.release.changelog()
		t.check("changelog: %s -> ok, no entries" % JSON.stringify(body), r.ok and r.entries.is_empty(), str(r))
	sdk.queue_free()


func _bearer(t: PKeyTestContext) -> void:
	sup.plan = {"/release/changelog": [PKeyUpdateTestSupport.json(200, CHANGELOG)]}
	sup.server.requests.clear()
	var anon = await sup.sdk(PackedStringArray(["release"]))
	await anon.release.changelog()
	var reqs := sup.requests("/release/changelog")
	t.check("bearer: no Authorization without a token", reqs.size() == 1 and not reqs[0]["headers"].has("authorization"))
	anon.queue_free()

	sup.server.requests.clear()
	var held = await sup.sdk(PackedStringArray(["release"]), "1.2.3", PKeyUpdateTestSupport.TOKEN)
	var r: PKeyChangelogResult = await held.release.changelog()
	reqs = sup.requests("/release/changelog")
	t.check("bearer: the held token is forwarded (entitled mode)", r.ok and reqs.size() == 1 and reqs[0]["headers"].get("authorization") == "Bearer " + PKeyUpdateTestSupport.TOKEN)
	held.queue_free()


func _errors(t: PKeyTestContext) -> void:
	var sdk = await sup.sdk(PackedStringArray(["release"]))
	# [answer, expected code, expected status]
	var rows := [
		[PKeyUpdateTestSupport.json(401, {"error": {"code": "unauthorized"}}), "unauthorized", 401],
		[PKeyUpdateTestSupport.json(401, {"error": "download_auth_required"}), "download_auth_required", 401],
		[PKeyUpdateTestSupport.json(401, {}), "unauthorized", 401],
		[PKeyUpdateTestSupport.json(403, {"error": {"code": "channel_not_allowed"}}), "channel_not_allowed", 403],
		[PKeyUpdateTestSupport.json(403, {}), "forbidden", 403],
		[PKeyUpdateTestSupport.json(404, {"error": {"code": "not_found"}}), "not_found", 404],
		[PKeyUpdateTestSupport.json(500, {}), "not_found", 500],
		[PKeyUpdateTestSupport.raw(200, "<html>"), "invalid-response", 200],
		[PKeyUpdateTestSupport.json(200, [1, 2]), "invalid-response", 200],
	]
	for row in rows:
		sup.plan = {"/release/changelog": [row[0]]}
		var r: PKeyChangelogResult = await sdk.release.changelog()
		t.check("errors: %d %s -> %s" % [row[2], row[0]["body"].left(40), row[1]], not r.ok and String(r.code) == row[1] and r.status == row[2] and r.entries.is_empty(), str(r))
	sdk.queue_free()


func _disabled(t: PKeyTestContext) -> void:
	sup.server.requests.clear()
	sup.plan = {"/release/changelog": [PKeyUpdateTestSupport.json(200, CHANGELOG)]}
	var sdk = await sup.sdk(PackedStringArray(["license", "config", "update"]))
	var r: PKeyChangelogResult = await sdk.release.changelog()
	t.check("disabled: changelog is service-unavailable, no request", not r.ok and r.code == PKeyErrors.SERVICE_UNAVAILABLE and sup.server.requests.is_empty(), str(r))
	t.check("disabled: install_url and download_url build nothing", sdk.release.install_url() == "" and sdk.release.download_url("1.2.3", "djdl", "arm64", true) == "")
	sdk.queue_free()

	# A discovery document that turns Release on makes it reachable.
	var doc := {"product": sup.F["product"], "services": {"release": {"enabled": true}, "distribution": {"enabled": false}, "update": {"enabled": false}}}
	sup.plan = {".well-known/polaris.json": [PKeyUpdateTestSupport.json(200, doc)], "/release/changelog": [PKeyUpdateTestSupport.json(200, CHANGELOG)]}
	sdk = await sup.sdk(PackedStringArray())
	r = await sdk.release.changelog()
	var before := r.code
	await sdk.discover()
	r = await sdk.release.changelog()
	t.check("discovery: Release off by default, reachable once discovery turns it on", before == PKeyErrors.SERVICE_UNAVAILABLE and r.ok and r.entries.size() == 2, "%s then %s" % [before, r])
	var u: PKeyVersionCheck = await sdk.update.check()
	t.check("discovery: Update, which the document leaves off, still refuses", u.code == PKeyErrors.SERVICE_UNAVAILABLE)
	sdk.queue_free()

	var bare := PKeyRelease.new()
	var c: PKeyChangelogResult = await bare.changelog()
	t.check("unconfigured: not-configured, and no URL", c.code == PKeyErrors.NOT_CONFIGURED and bare.install_url() == "" and bare.download_url("1", "b", "arm64") == "")
