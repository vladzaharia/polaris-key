extends RefCounted
# The setup dock's logic (PKeySetupCheck) against PKeyFakeServer: pasted pins in every form
# `pkey trust` prints, "Check" accepting the recorded trust manifest under its own pin and
# refusing it under another key or for another product, discovery's keys offered only as
# candidates, and "Save" refusing without the confirmation and keeping the rest of the file.

const OTHER_KEY := "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U"

var F: Dictionary
var disc: Dictionary
var answers := {}


func run(t: PKeyTestContext) -> void:
	_pins(t)
	F = PKeyTestFixtures.sync_docs()
	var tr = PKeyTestFixtures.transcript("discovery-capabilities")
	if not t.check("dock: fixtures present", not F.is_empty() and tr is Dictionary):
		return
	disc = tr["steps"][0]["exchanges"]["items"][0]["response"]["body"]
	await _check(t)
	_save(t)


func _pins(t: PKeyTestContext) -> void:
	var kid := "pkey-test-prod-2026"
	var key := "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"
	var forms := {
		"json": '{\n  "%s": "%s"\n}' % [kid, key],
		"gdscript": 'const PINNED_TRUST_KEYS := {"%s": "%s"}' % [kid, key],
		"node": 'trust: { pinnedKeys: {\n  "%s": "%s"\n} }' % [kid, key],
		"python": 'trusted_keys = {\n  "%s": "%s"\n}' % [kid, key],
		"whole output": "JSON trust set:\n{\n  \"%s\": \"%s\"\n}\n\nNode/React:\ntrust: { pinnedKeys: {} }" % [kid, key],
	}
	for name in forms:
		var p := PKeySetupCheck.parse_pins(forms[name])
		t.check("pins: the %s form parses" % name, p["ok"] and p["pins"] == {kid: key}, str(p))
	t.check("pins: empty text asks for pins", not PKeySetupCheck.parse_pins("  ")["ok"])
	t.check("pins: text without an object is refused", not PKeySetupCheck.parse_pins("pkey trust")["ok"])
	var short := PKeySetupCheck.parse_pins('{"kid": "AAAA"}')
	t.check("pins: a key that is not 32 bytes is refused", not short["ok"] and short["message"].contains("kid"), str(short))
	t.check("pins: a non-string key is refused", not PKeySetupCheck.parse_pins('{"kid": 5}')["ok"])
	var fp := PKeySetupCheck.fingerprint(key)
	t.check("fingerprint: 16 colon-separated hex bytes", RegEx.create_from_string("\\A[0-9a-f]{2}(:[0-9a-f]{2}){15}\\z").search(fp) != null, fp)
	t.check("fingerprint: differs per key and is stable", fp != PKeySetupCheck.fingerprint(OTHER_KEY) and fp == PKeySetupCheck.fingerprint(key))
	t.check("fingerprint: an undecodable key has none", PKeySetupCheck.fingerprint("!!") == "")


func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	for suffix in answers:
		if path.ends_with(suffix):
			return answers[suffix]
	return {"status": 404, "body": "{\"error\":{\"code\":\"not_found\"}}"}


func _check(t: PKeyTestContext) -> void:
	var server := PKeyTestFixtures.new_server(_answer)
	var host: Node = server
	answers = {
		"/djdl/.well-known/polaris.json": {"status": 200, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify(disc)},
		"/djdl/.well-known/polaris-trust.jws": {"status": 200, "headers": {"Content-Type": "application/jose"}, "body": F["trust_jws"]},
	}
	var r: Dictionary = await PKeySetupCheck.check(host, server.base_url(), "djdl", F["trust"], float(F["now"]))
	t.check("check: a manifest signed by the pasted key is accepted", r["ok"], r["message"])
	var kids: Array = r["keys"].map(func(k): return k["kid"])
	t.check("check: each published kid is listed", kids.has(F["trust"].keys()[0]), str(kids))
	t.check("check: with a fingerprint, marked pinned", r["keys"].all(func(k): return k["fingerprint"] != "") and r["keys"].any(func(k): return k["pinned"]))
	t.check("check: discovery's keys come back only as candidates", r["candidates"] == disc["trust"]["pinnedKeys"])

	r = await PKeySetupCheck.check(host, server.base_url(), "djdl", {"some-other-kid": OTHER_KEY}, float(F["now"]))
	t.check("check: a manifest not signed by the pasted key is refused", not r["ok"] and r["message"].contains("not signed"), r["message"])
	t.check("check: a refusal lists no keys", r["keys"].is_empty())
	var kid: String = F["trust"].keys()[0]
	r = await PKeySetupCheck.check(host, server.base_url(), "djdl", {kid: OTHER_KEY}, float(F["now"]))
	t.check("check: the pinned kid with other bytes is refused", not r["ok"], r["message"])

	var foreign := disc.duplicate(true)
	foreign["product"] = "other"
	foreign["slug"] = "other"
	answers["/other/.well-known/polaris.json"] = {"status": 200, "body": JSON.stringify(foreign)}
	answers["/other/.well-known/polaris-trust.jws"] = {"status": 200, "body": F["trust_jws"]}
	r = await PKeySetupCheck.check(host, server.base_url(), "other", F["trust"], float(F["now"]))
	t.check("check: a manifest for another product is refused", not r["ok"] and r["message"].contains("'djdl'"), r["message"])

	r = await PKeySetupCheck.check(host, server.base_url(), "djdl", F["trust"], float(F["now"]) + 100.0 * 365.0 * 86400.0)
	t.check("check: an expired manifest is refused", not r["ok"], r["message"])
	r = await PKeySetupCheck.check(host, server.base_url(), "missing", F["trust"], float(F["now"]))
	t.check("check: an unknown product reports discovery's status", not r["ok"] and r["message"].contains("404"), r["message"])
	r = await PKeySetupCheck.check(host, server.base_url(), "djdl", {}, float(F["now"]))
	t.check("check: no pins, no check (candidates still offered)", not r["ok"] and not r["candidates"].is_empty())
	r = await PKeySetupCheck.check(host, "http://example.com", "djdl", F["trust"])
	t.check("check: an insecure base URL is refused before dialling", not r["ok"])
	r = await PKeySetupCheck.check(host, server.base_url(), "Dice Roll", F["trust"])
	t.check("check: a bad slug is refused", not r["ok"] and r["message"].contains("slug"))
	server.queue_free()


func _save(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("dock")
	var path := dir.path_join("polaris_key.tres")
	var refused := PKeySetupCheck.save(path, "djdl", "https://key.plrs.im", F["trust"], "dev", false)
	t.check("save: refused without the confirmation", not refused["ok"] and not FileAccess.file_exists(path))
	var existing := PKeyOptions.new()
	existing.refresh_interval_seconds = 120.0
	existing.default_channel = "beta"
	ResourceSaver.save(existing, path)
	var r := PKeySetupCheck.save(path, "djdl", "https://key.plrs.im", F["trust"], "dev", true)
	t.check("save: confirmed, written", r["ok"], r["message"])
	var back = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	t.check("save: the four fields", back is PKeyOptions and back.product == "djdl" and back.base_url == "https://key.plrs.im" and back.pinned_trust_keys == F["trust"] and back.default_channel == "dev")
	t.check("save: the rest of the file survives", back is PKeyOptions and back.refresh_interval_seconds == 120.0)
	t.check("save: a bad channel is refused", not PKeySetupCheck.save(path, "djdl", "https://key.plrs.im", {}, "Beta", true)["ok"])
	t.check("save: an insecure base URL is refused", not PKeySetupCheck.save(path, "djdl", "http://example.com", {}, "", true)["ok"])
	PKeyTestFixtures.remove_tree(dir)
