extends RefCounted
# @pkey-feature update.feed release.record update.decide
# PolarisKey.update.decide(), feed() and release_record() (wire v4, P3-08) against a loopback
# server answering like the Worker's discovery, `/update/{channel}/feed.jws` and
# `/release/records/{sha256}`, with the corpus's signed feeds and records (the SDK has no signer):
#
#   - the option refusals: not-configured before configure() and with no release pins,
#     invalid-options for a release key that is also a trust pin (two spellings of one key
#     included), a bad host outlet or a bad update method; service-unavailable for a Worker
#     whose discovery has no signed feed, before any feed request;
#   - the decision from the build stamp's inputs, the requests it sends, the slices it writes,
#     update_available, and a second call that reads the record from the cache;
#   - the canonical channel: `latest` answers and is stored as `stable`;
#   - the floor: a committed feed with a higher `seq`, re-verified from the cache, refuses a
#     lower one (feed-rollback, decided from the committed copy); a tampered committed feed is
#     dropped with its floor;
#   - hash before signature: a record whose hash is not the pin is refused at step `hash`
#     without any Ed25519 work, and an 88 845-byte body whose hash IS the pin is refused at the
#     same step, unhashed, both directly and through the transport's cap;
#   - offline: a transport failure decides from the committed feed; nothing committed raises;
#   - a restart on the file store reloads both slices and the floor.

const NOW := 1700000100.0
const STAMP := "res://tests/fixtures/build_stamp_update.json"
const BASE_RECORD := "12370b92b6b49bea1753bd4611098b7889a380ace9af4a46b56b4fd2db536620"

var feeds := {}
var records := {}
var plan := {}
var server: PKeyFakeServer
var trust := {}
var release_keys := {}


func run(t: PKeyTestContext) -> void:
	var corpus = PKeyTestFixtures.read_json(PKeyTestFixtures.CASES)
	if not t.check("decide: the corpus is present", corpus is Dictionary):
		return
	for c in corpus["feedCases"]:
		feeds[c["id"]] = c
	for c in corpus["releaseRecordCases"]:
		records[c["id"]] = c
	if not t.check("decide: the control feed and record are present", feeds.has("feed-valid") and records.has("record-valid-app") and feeds.has("feed-valid-seq-at-max")):
		return
	trust = feeds["feed-valid"]["trust"]
	release_keys = records["record-valid-app"]["releaseKeys"]
	server = PKeyTestFixtures.new_server(_answer)
	await _refusals(t)
	await _happy(t)
	await _alias(t)
	await _floor(t)
	await _hash_first(t)
	await _offline(t)
	await _restart(t)
	server.queue_free()


# ── plumbing ────────────────────────────────────────────────────────────────────────────────

func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	for prefix in plan:
		if path.begins_with(prefix):
			var q: Array = plan[prefix]
			var a = q[0] if q.size() == 1 else q.pop_front()
			return a.call(req) if a is Callable else a
	return {"status": 404, "headers": {"Content-Type": "application/json"}, "body": "{\"error\":{\"code\":\"not_found\"}}"}


func _discovery(with_endpoints := true) -> Dictionary:
	var base := server.base_url() + "/djdl"
	var services := {"update": {"enabled": true}, "release": {"enabled": true}, "distribution": {"enabled": true}}
	if with_endpoints:
		services["update"]["endpoints"] = {"feed": base + "/update/{channel}/feed.jws"}
		services["release"]["endpoints"] = {"record": base + "/release/records/{sha256}"}
	return {"status": 200, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify({"product": "djdl", "services": services})}


static func _jose(body: Variant) -> Dictionary:
	return {"status": 200, "headers": {"Content-Type": "application/jose"}, "body": body}


## The standard plan: discovery, the feed for every channel, the control record.
func _serve(feed_jws: String, record_body: Variant = null) -> void:
	plan = {
		"/djdl/.well-known/polaris.json": [_discovery()],
		"/djdl/update/": [_jose(feed_jws)],
		"/djdl/release/records/": [_jose(record_body if record_body != null else records["record-valid-app"]["jws"])],
	}


func _requests(prefix: String) -> Array:
	return server.requests.filter(func(r): return String(r["path"]).begins_with(prefix))


## A started SDK on `store`, configured as a macOS `direct` 1.4.0 build (the fixture stamp) with
## the corpus's product pin and release pin. `tweak(opts)` adjusts the options first.
func _sdk(store: PKeyStore, tweak := Callable()) -> Array:
	var s := PKeyTestFixtures.new_sdk()
	var clock := [NOW]
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, "djdl", trust, "1.4.0")
	opts.build_stamp_path = STAMP
	opts.pinned_release_keys = release_keys
	opts.expected_services = PackedStringArray(["update", "release", "distribution"])
	if tweak.is_valid():
		tweak.call(opts)
	var r: PKeyResult = s.configure(opts)
	if r.ok:
		await s.start()
	return [s, r]


static func _store() -> PKeyMemoryStore:
	return PKeyMemoryStore.new("dev_7c1e2d")


# ── refusals ────────────────────────────────────────────────────────────────────────────────

func _refusals(t: PKeyTestContext) -> void:
	var bare := PKeyUpdate.new()
	var r: PKeyUpdateCheck = await bare.decide()
	t.check("decide: before configure() -> not-configured", not r.ok and r.code == PKeyErrors.NOT_CONFIGURED, str(r))
	var f: PKeyUpdateFeed = await bare.feed()
	var rr: PKeyReleaseRecordResult = await bare.release_record(BASE_RECORD)
	t.check("decide: feed() and release_record() before configure() -> not-configured", f.code == PKeyErrors.NOT_CONFIGURED and rr.code == PKeyErrors.NOT_CONFIGURED)

	_serve(feeds["feed-valid"]["jws"])
	server.requests.clear()
	var got := await _sdk(_store(), func(o): o.pinned_release_keys = {})
	r = await got[0].update.decide()
	t.check("decide: empty pinned_release_keys -> not-configured, nothing sent", not r.ok and r.code == PKeyErrors.NOT_CONFIGURED and server.requests.is_empty(), "%s, %d requests" % [r, server.requests.size()])
	got[0].queue_free()

	var pin_kid: String = trust.keys()[0]
	var pin_key: String = trust[pin_kid]
	var rows := [
		["a release key equal to a trust pin", func(o): o.pinned_release_keys = {"rk": pin_key}],
		["a release key that spells a trust pin with padding", func(o): o.pinned_release_keys = {"rk": pin_key + "="}],
		["a release pin that is not a string", func(o): o.pinned_release_keys = {"rk": 7}],
		["an outlet outside the 17 kinds", func(o): o.update_outlet = "epic"],
		["an outlet id outside the pattern", func(o):
			o.update_outlet = "direct"
			o.update_outlet_id = "Direct Build"],
		["a subkind outside the vocabulary", func(o):
			o.update_outlet = "direct"
			o.update_outlet_subkind = "brew"],
		["an update method outside the vocabulary", func(o): o.update_methods = PackedStringArray(["download", "torrent"])],
	]
	for row in rows:
		var s := PKeyTestFixtures.new_sdk()
		var opts := PKeyTestFixtures.options(server.base_url(), _store(), [NOW], "djdl", trust, "1.4.0")
		opts.pinned_release_keys = release_keys
		row[1].call(opts)
		var cr: PKeyResult = s.configure(opts)
		t.check("decide: configure refuses %s (invalid-options)" % row[0], not cr.ok and cr.code == PKeyErrors.INVALID_OPTIONS, str(cr))
		s.queue_free()
	var ok_sdk := PKeyTestFixtures.new_sdk()
	var ok_opts := PKeyTestFixtures.options(server.base_url(), _store(), [NOW], "djdl", trust, "1.4.0")
	ok_opts.pinned_release_keys = release_keys
	ok_opts.update_outlet = "altstore"
	ok_opts.update_outlet_id = "altstore-beta"
	ok_opts.update_methods = PackedStringArray(["native", "download", "sidecar-pck"])
	t.check("decide: configure accepts an outlet id with its kind and every method", (ok_sdk.configure(ok_opts) as PKeyResult).ok and ok_opts.host_outlet() == {"id": "altstore-beta", "kind": "altstore", "subkind": null})
	ok_sdk.queue_free()

	plan = {"/djdl/.well-known/polaris.json": [_discovery(false)], "/djdl/update/": [_jose(feeds["feed-valid"]["jws"])]}
	server.requests.clear()
	got = await _sdk(_store())
	r = await got[0].update.decide()
	t.check("decide: discovery without the signed feed -> service-unavailable, no feed request", not r.ok and r.code == PKeyErrors.SERVICE_UNAVAILABLE and _requests("/djdl/update/").is_empty(), str(r))
	got[0].queue_free()


# ── the decision ────────────────────────────────────────────────────────────────────────────

func _happy(t: PKeyTestContext) -> void:
	_serve(feeds["feed-valid"]["jws"])
	server.requests.clear()
	var store := _store()
	var got := await _sdk(store)
	var sdk: Node = got[0]
	var seen: Array = []
	sdk.update.update_available.connect(func(c): seen.append(c))
	var r: PKeyUpdateCheck = await sdk.update.decide()
	var want := {
		"action": "binary", "method": "download",
		"release": {"version": "1.5.0", "seq": 15, "sha256": BASE_RECORD},
		"build": "macos-dmg", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false,
	}
	t.check("decide: a macOS direct 1.4.0 build is offered the 1.5.0 dmg by download", r.ok and _same(r.decision, want), str(r))
	t.check("decide: the UpdateCheck names the canonical channel and both sources", r.ok and r.channel == "stable" and r.feed == "network" and r.record == "network" and r.errors.is_empty() and r.boot == "optional" and not r.undismissable)
	t.check("decide: to_dictionary() carries the five UpdateCheck members", r.ok and _same(r.to_dictionary(), {"channel": "stable", "decision": want, "feed": "network", "record": "network", "errors": []}))
	t.check("decide: update_available fired once with the check", seen.size() == 1 and seen[0] == r, str(seen.size()))
	var feed_reqs := _requests("/djdl/update/")
	t.check("decide: one feed GET of /djdl/update/stable/feed.jws?platform=macos", feed_reqs.size() == 1 and feed_reqs[0]["path"] == "/djdl/update/stable/feed.jws?platform=macos", str(feed_reqs.map(func(q): return q["path"])))
	t.check("decide: the feed request asks for application/jose and carries X-PKey-Device", feed_reqs.size() == 1 and feed_reqs[0]["headers"].get("accept") == "application/jose" and feed_reqs[0]["headers"].get("x-pkey-device") == "dev_7c1e2d")
	var rec_reqs := _requests("/djdl/release/records/")
	t.check("decide: one record GET by the pinned hash", rec_reqs.size() == 1 and rec_reqs[0]["path"] == "/djdl/release/records/" + BASE_RECORD)
	var rec = store.cache
	t.check("decide: managed.json holds the feed under its claim and the pinned record", rec is Dictionary and rec.get("feeds") is Dictionary and rec["feeds"].keys() == ["stable"] \
			and rec["feeds"]["stable"] == feeds["feed-valid"]["jws"] and rec.get("releaseRecords") is Dictionary and rec["releaseRecords"].keys() == [BASE_RECORD], str(rec.keys() if rec is Dictionary else rec))
	t.check("decide: the in-memory floor comes from the committed feed", sdk.core.cache.feed_floors.get("stable", {}).get("seq") == 7.0)

	server.requests.clear()
	seen.clear()
	r = await sdk.update.decide("stable")
	t.check("decide: the same feed again reads the record from the cache", r.ok and r.feed == "network" and r.record == "cache" and r.errors.is_empty() and _requests("/djdl/release/records/").is_empty() and _requests("/djdl/.well-known/").is_empty(), str(r))

	# A staged update on the same channel and version is code-ready only where code updates are
	# allowed; on this binary outlet with no code pack it stays a binary offer and discards it.
	r = await sdk.update.decide("stable", {"version": "1.5.0", "channel": "beta"})
	t.check("decide: a staged update from another channel is discarded", r.ok and r.decision.get("discardStaged") == true, str(r))

	var f: PKeyUpdateFeed = await sdk.update.feed("stable")
	t.check("decide: feed() answers the committed feed for its canonical channel", f.ok and f.channel == "stable" and f.source == "network" and _same(f.feed_doc.get("seq"), 7), str(f))
	var rr: PKeyReleaseRecordResult = await sdk.update.release_record(BASE_RECORD)
	t.check("decide: release_record() answers the pinned record from the cache", rr.ok and rr.source == "cache" and rr.pinned and rr.record_doc.get("version") == "1.5.0", str(rr))
	sdk.queue_free()

	# A steam build on the same feed: the platform installs it, so nothing is shown.
	_serve(feeds["feed-valid"]["jws"])
	got = await _sdk(_store(), func(o): o.update_outlet = "steam")
	seen.clear()
	got[0].update.update_available.connect(func(c): seen.append(c))
	r = await got[0].update.decide()
	t.check("decide: a host outlet wins over the stamp (steam is not on the macOS target here: not-available)", r.ok and r.decision.get("action") == "none" and r.decision.get("reason") == "not-available" and seen.is_empty(), str(r))
	got[0].queue_free()


func _alias(t: PKeyTestContext) -> void:
	_serve(feeds["feed-valid-alias-channel"]["jws"])
	server.requests.clear()
	var store := _store()
	var got := await _sdk(store)
	var r: PKeyUpdateCheck = await got[0].update.decide("latest")
	t.check("decide: `latest` is requested as latest and answered as the canonical stable", r.ok and r.channel == "stable" and _requests("/djdl/update/latest/feed.jws").size() == 1, str(r))
	t.check("decide: the feed is stored under stable, never latest", store.cache is Dictionary and store.cache["feeds"].keys() == ["stable"], str(store.cache.get("feeds", {}).keys() if store.cache is Dictionary else null))
	got[0].queue_free()


# ── the floor ───────────────────────────────────────────────────────────────────────────────

func _floor(t: PKeyTestContext) -> void:
	var high: String = feeds["feed-valid-seq-at-max"]["jws"]
	var low: String = feeds["feed-valid"]["jws"]
	var store := _store()
	store.cache = {"v": 3, "feeds": {"stable": high}}
	_serve(low)
	var got := await _sdk(store)
	var sdk: Node = got[0]
	t.check("floor: the committed feed survives the reload path and sets the floor", sdk.core.cache.feed_floors.has("stable") and sdk.core.cache.feed_floors["stable"]["seq"] == float(PKeyClaims.MAX_WIRE_INTEGER))
	var r: PKeyUpdateCheck = await sdk.update.decide()
	# (The committed feed pins a record the corpus does not carry, so the record step adds its own
	# refusal after the rollback.)
	t.check("floor: a lower seq is refused (feed-rollback) and the committed feed decides", r.ok and r.feed == "committed" and r.errors.size() >= 1 and _same(r.errors[0], {"code": "feed-rollback", "detail": null}) and _same(r.feed_doc.get("seq"), PKeyClaims.MAX_WIRE_INTEGER), str(r))
	t.check("floor: the committed feed is still the one stored", store.cache["feeds"]["stable"] == high)
	sdk.queue_free()

	# A committed feed that no longer verifies is dropped, and its floor with it.
	var parts := high.split(".")
	var sig: String = parts[2]
	var flipped := ("A" if sig[0] != "A" else "B") + sig.substr(1)
	store = _store()
	store.cache = {"v": 3, "feeds": {"stable": "%s.%s.%s" % [parts[0], parts[1], flipped]}}
	_serve(low)
	got = await _sdk(store)
	sdk = got[0]
	t.check("floor: a tampered committed feed is absent after load", not sdk.core.cache.feeds.has("stable"))
	r = await sdk.update.decide()
	t.check("floor: with no floor left the lower seq is committed", r.ok and r.feed == "network" and r.errors.is_empty() and store.cache["feeds"]["stable"] == low, str(r))
	sdk.queue_free()

	# A cached feed stored under a name other than its claim fails the reload path.
	store = _store()
	store.cache = {"v": 3, "feeds": {"beta": high}}
	got = await _sdk(store)
	t.check("floor: a feed cached under another channel's key is dropped on load", got[0].core.cache.feeds.is_empty())
	got[0].queue_free()


# ── hash before signature ───────────────────────────────────────────────────────────────────

func _hash_first(t: PKeyTestContext) -> void:
	var rec: Dictionary = records["record-valid-app"]
	var opts := {"release_keys": rec["releaseKeys"], "product_trust": rec["productTrust"], "expected_aud": "djdl", "expected_hash": "0".repeat(64), "pin": rec["pin"]}
	# A broken signature as well: the hash step must come first.
	var parts: PackedStringArray = (rec["jws"] as String).split(".")
	var broken := "%s.%s.%s" % [parts[0], parts[1], parts[2].reverse()]
	PKeyJws.clear_key_cache()
	var r := await PKeyReleaseRecord.verify_release_record(broken, opts)
	t.check("hash: a record whose hash is not the pin is refused at step hash", not r["ok"] and r["step"] == "hash", str(r))
	t.check("hash: no Ed25519 work ran (no release key was ever prepared)", PKeyJws._keys.is_empty())

	var big := PackedByteArray()
	big.resize(PKeyReleaseRecord.MAX_RECORD_JWS_BYTES + 1)
	big.fill(0x41)
	opts["expected_hash"] = PKeyReleaseRecord.record_hash(big)
	r = await PKeyReleaseRecord.verify_release_record(big, opts)
	t.check("hash: an 88 845-byte body whose hash IS the pin is refused at step hash", not r["ok"] and r["step"] == "hash", str(r))
	var non_ascii := (rec["jws"] as String).to_utf8_buffer()
	non_ascii.append(0xC3)
	non_ascii.append(0xA9)
	opts["expected_hash"] = PKeyReleaseRecord.record_hash(non_ascii)
	r = await PKeyReleaseRecord.verify_release_record(non_ascii, opts)
	t.check("hash: a body with a byte outside ASCII is refused at step hash", not r["ok"] and r["step"] == "hash", str(r))

	# Through the service: a mismatched body is record-rejected (hash) and the decision goes on
	# without a record; an oversized body is cut by the transport and refused the same way.
	_serve(feeds["feed-valid"]["jws"], records["record-valid-app"]["jws"] + "x")
	var got := await _sdk(_store())
	var u: PKeyUpdateCheck = await got[0].update.decide()
	t.check("hash: a fetched record that is not the pin -> record-rejected (hash), no record, none not-available", u.ok and u.record == "none" \
			and _same(u.errors, [{"code": "record-rejected", "detail": "hash"}]) and u.decision.get("action") == "none" and u.decision.get("reason") == "not-available", str(u))
	got[0].queue_free()
	var huge := PackedByteArray()
	huge.resize(PKeyReleaseRecord.MAX_RECORD_JWS_BYTES + 1)
	huge.fill(0x41)
	_serve(feeds["feed-valid"]["jws"], huge)
	got = await _sdk(_store())
	u = await got[0].update.decide()
	t.check("hash: an 88 845-byte answer stops at the transport's cap -> record-rejected (hash)", u.ok and _same(u.errors, [{"code": "record-rejected", "detail": "hash"}]), str(u))
	got[0].queue_free()

	# A record that verifies but names another release: record-mismatch.
	var other = records.get("record-version-mismatches-pin")
	if t.check("hash: a cross-check case is present", other is Dictionary):
		var r2 := await PKeyReleaseRecord.verify_release_record(other["jws"], {
			"release_keys": other["releaseKeys"], "product_trust": other["productTrust"], "expected_aud": other["expectedAud"],
			"expected_hash": other["expectedHash"], "pin": other["pin"],
		})
		t.check("hash: a record that names another release is refused at cross-check", not r2["ok"] and r2["step"] == "cross-check", str(r2))


# ── offline ─────────────────────────────────────────────────────────────────────────────────

func _offline(t: PKeyTestContext) -> void:
	var store := _store()
	store.cache = {"v": 3, "feeds": {"stable": feeds["feed-valid"]["jws"]}, "releaseRecords": {BASE_RECORD: records["record-valid-app"]["jws"]}}
	plan = {"/djdl/.well-known/polaris.json": [_discovery()], "/djdl/update/": [{"status": 503, "headers": {"Content-Type": "application/json"}, "body": "{\"error\":{\"code\":\"feed_not_composable\"}}"}]}
	var got := await _sdk(store)
	var r: PKeyUpdateCheck = await got[0].update.decide()
	t.check("offline: a refused fetch decides from the committed feed, the Worker's code in errors", r.ok and r.feed == "committed" and r.record == "cache" \
			and _same(r.errors, [{"code": "feed_not_composable", "detail": null}]) and r.decision.get("action") == "binary", str(r))
	got[0].queue_free()

	plan = {"/djdl/.well-known/polaris.json": [_discovery()], "/djdl/update/": [{"status": 500, "headers": {}, "body": ""}]}
	got = await _sdk(_store())
	r = await got[0].update.decide()
	t.check("offline: nothing committed and a failed fetch raises (http-error)", not r.ok and r.code == PKeyErrors.HTTP_ERROR, str(r))
	got[0].queue_free()

	_serve(feeds["feed-wrong-channel"]["jws"])
	got = await _sdk(_store())
	r = await got[0].update.decide()
	t.check("offline: a refused feed with nothing committed raises feed-rejected (channel)", not r.ok and r.code == PKeyErrors.FEED_REJECTED and r.detail is Dictionary and r.detail.get("detail") == "channel", str(r))
	got[0].queue_free()

	# Local-only: discovery cannot be dialled, and a build that expects Update decides offline.
	store = _store()
	store.cache = {"v": 3, "feeds": {"stable": feeds["feed-valid"]["jws"]}, "releaseRecords": {BASE_RECORD: records["record-valid-app"]["jws"]}}
	got = await _sdk(store, func(o): o.local_only = true)
	r = await got[0].update.decide()
	t.check("offline: local-only decides from the committed slices (local-only in errors)", r.ok and r.feed == "committed" and r.record == "cache" and _same(r.errors, [{"code": "local-only", "detail": null}]), str(r))
	got[0].queue_free()


# ── restart on the file store ───────────────────────────────────────────────────────────────

func _restart(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("decide-restart")
	_serve(feeds["feed-valid"]["jws"])
	var got := await _sdk(PKeyFileStore.new("djdl", dir))
	var r: PKeyUpdateCheck = await got[0].update.decide()
	t.check("restart: the first decision commits both slices", r.ok and r.record == "network", str(r))
	got[0].queue_free()
	got = await _sdk(PKeyFileStore.new("djdl", dir))
	var cache: PKeyCache = got[0].core.cache
	t.check("restart: managed.json reloads the feed, its floor and the pinned record", cache.feeds.has("stable") and cache.feed_floors.get("stable", {}).get("seq") == 7.0 and cache.release_records.has(BASE_RECORD))
	server.requests.clear()
	r = await got[0].update.decide()
	t.check("restart: the next decision reads the record from the cache", r.ok and r.record == "cache" and _requests("/djdl/release/records/").is_empty(), str(r))
	got[0].queue_free()
	PKeyTestFixtures.remove_tree(dir)


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
