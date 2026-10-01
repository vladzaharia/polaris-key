extends RefCounted
# `sync()` against a loopback server that answers like the Worker, with the documents recorded in
# the sync-etag-304 transcript: ETag/304, the half-life refetch, one shared re-acquire for
# parallel 401s, the hard-401 and 403 hints and their clearing, one cache write per pass, the
# post-sync hook, and zero traffic without a token.

var F: Dictionary
var plan := {}
var server: PKeyFakeServer


func run(t: PKeyTestContext) -> void:
	F = PKeyTestFixtures.sync_docs()
	if not t.check("sync: fixtures present", not F.is_empty()):
		return
	server = PKeyTestFixtures.new_server(_answer)
	await _etag_and_half_life(t)
	await _parallel_401s(t)
	await _hints(t)
	await _no_token(t)
	await _odd_answers(t)
	server.queue_free()


## path suffix -> Array of answers; the last one repeats. An answer may be a Callable(req).
func _answer(req: Dictionary) -> Dictionary:
	for suffix in plan:
		if String(req["path"]).ends_with(suffix):
			var q: Array = plan[suffix]
			var a = q[0] if q.size() == 1 else q.pop_front()
			return a.call(req) if a is Callable else a
	return {"status": 404}


func _ok(jws: String, etag := "") -> Dictionary:
	return {"status": 200, "headers": {"ETag": etag} if etag != "" else {}, "body": jws}


func _sdk(store: PKeyMemoryStore, clock: Array, services := PackedStringArray()) -> Node:
	var sdk := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, F["product"], F["trust"], F["version"])
	opts.expected_services = services
	sdk.configure(opts)
	await sdk.start()
	return sdk


func _requests(suffix: String) -> Array:
	return server.requests.filter(func(r): return String(r["path"]).ends_with(suffix))


func _etag_and_half_life(t: PKeyTestContext) -> void:
	server.requests.clear()
	plan = {
		"polaris-trust.jws": [_ok(F["trust_jws"])],
		"/license/document": [_ok(F["license"], F["license_etag"]), {"status": 304}],
		"/config/document": [_ok(F["config"], F["config_etag"]), {"status": 304}],
	}
	var store := PKeyMemoryStore.new(F["device_id"], F["token"])
	var clock := [F["now"]]
	var sdk = await _sdk(store, clock)
	var hooks := [0]
	sdk.core.add_post_sync_hook(func(_c, _r): hooks[0] += 1)
	var finished := [0]
	sdk.sync_finished.connect(func(_r): finished[0] += 1)

	var r: PKeySyncResult = await sdk.sync()
	t.check("sync: the first pass applies both documents", r.ok and r.applied and r.documents == {"license": "applied", "config": "applied"}, str(r.documents))
	t.check("sync: the first pass writes managed.json once", store.cache_writes == 1, str(store.cache_writes))
	t.check("sync: the cache holds both artifacts, ETags and the trust manifest", store.cache["docs"] == {"license": F["license"], "config": F["config"]} \
			and store.cache["etags"] == {"license": F["license_etag"], "config": F["config_etag"]} and store.cache["trustJws"] == F["trust_jws"])
	t.check("sync: status is ok", sdk.status()["status"] == "ok", str(sdk.status()))
	t.check("sync: the post-sync hook ran", hooks[0] == 1)
	t.check("sync: sync_finished was emitted", finished[0] == 1)

	clock[0] = F["now"] + 60
	r = await sdk.sync()
	var lic_reqs := _requests("/license/document")
	t.check("sync: the second pass is conditional", lic_reqs.back()["headers"].get("if-none-match") == F["license_etag"], str(lic_reqs.back()["headers"]))
	t.check("sync: 304 keeps the cached document", r.documents == {"license": "unchanged", "config": "unchanged"} and not r.applied \
			and sdk.core.cache.license["jws"] == F["license"] and store.cache["docs"]["license"] == F["license"], str(r.documents))
	t.check("sync: the second pass writes managed.json once", store.cache_writes == 2, str(store.cache_writes))
	t.check("sync: 304 renews last_verified_at", sdk.get_sync_state()["last_verified_at"] == F["now"] + 60.0, str(sdk.get_sync_state()))

	# Past the half-life (effectiveNow > expiresAt - 1800) a 304 is re-asked unconditionally.
	plan["/config/document"] = [{"status": 304}, _ok(F["config_newer"], "\"newer\"")]
	plan["/license/document"] = [{"status": 304}]
	clock[0] = 1700003600 - 1800 + 1
	var before := _requests("/config/document").size()
	r = await sdk.sync()
	var cfg_reqs := _requests("/config/document").slice(before)
	t.check("sync: past the half-life a 304 is refetched without If-None-Match", cfg_reqs.size() == 2 \
			and cfg_reqs[0]["headers"].has("if-none-match") and not cfg_reqs[1]["headers"].has("if-none-match"), str(cfg_reqs.map(func(x): return x["headers"].get("if-none-match"))))
	t.check("sync: the refetched newer document is applied", r.documents["config"] == "applied" and sdk.core.cache.config["jws"] == F["config_newer"], str(r.documents))
	t.check("sync: a forced re-ask that answers 304 again settles as unchanged", r.documents["license"] == "unchanged")
	t.check("sync: the half-life pass writes managed.json once", store.cache_writes == 3, str(store.cache_writes))

	# A document that does not verify is not applied, and the one held stays.
	plan["/config/document"] = [_ok(_tamper(F["config"]), "\"bad\"")]
	r = await sdk.sync(true)
	t.check("sync: a document that does not verify is an error and changes nothing", r.documents["config"] == "error" and sdk.core.cache.config["jws"] == F["config_newer"] and store.cache["etags"]["config"] == "\"newer\"")
	# The same document again is a replay: not strictly newer than the one held.
	plan["/config/document"] = [_ok(F["config"], "\"older\"")]
	r = await sdk.sync(true)
	t.check("sync: an older document is refused by the anti-replay floor", r.documents["config"] == "error" and sdk.core.cache.config["jws"] == F["config_newer"])
	sdk.queue_free()


func _parallel_401s(t: PKeyTestContext) -> void:
	server.requests.clear()
	var authorized := func(req: Dictionary, body: String) -> Dictionary:
		if req["headers"].get("authorization") == "Bearer pkeyt_new":
			return _ok(body)
		return {"status": 401, "body": "{\"error\":{\"code\":\"unauthorized\"}}"}
	plan = {
		"polaris-trust.jws": [_ok(F["trust_jws"])],
		"/license/document": [func(req): return authorized.call(req, F["license"])],
		"/config/document": [func(req): return authorized.call(req, F["config"])],
	}
	var store := PKeyMemoryStore.new(F["device_id"], F["token"])
	var sdk = await _sdk(store, [F["now"]])
	var calls := [0]
	sdk.core.tokens.set_reacquire(func(_c: PKeyCore, _current: String) -> String:
		calls[0] += 1
		await PKeyTestFixtures.frames(3)  # keep the attempt in flight while the other 401 lands
		return "pkeyt_new")
	var r: PKeySyncResult = await sdk.sync()
	var unauth := server.requests.filter(func(x): return String(x["path"]).ends_with("/document") and x["headers"].get("authorization") != "Bearer pkeyt_new")
	t.check("sync: both documents were refused in parallel first", unauth.size() == 2, str(unauth.size()))
	t.check("sync: parallel 401s cause exactly one re-acquire", calls[0] == 1 and sdk.core.tokens.attempts == 1, "%d calls" % calls[0])
	t.check("sync: both fetches retry once with the new token and apply", r.documents == {"license": "applied", "config": "applied"} and not r.unauthorized, str(r.documents))
	t.check("sync: the new token is stored", store.token == "pkeyt_new")
	t.check("sync: the re-acquire pass writes managed.json once", store.cache_writes == 1)
	sdk.queue_free()


func _hints(t: PKeyTestContext) -> void:
	var refused := {"status": 401, "body": "{\"error\":\"unauthorized\"}"}
	plan = {
		"polaris-trust.jws": [_ok(F["trust_jws"])],
		"/license/document": [refused],
		"/config/document": [refused],
	}
	var store := PKeyMemoryStore.new(F["device_id"], F["token"])
	var sdk = await _sdk(store, [F["now"]])
	var calls := [0]
	sdk.core.tokens.set_reacquire(func(_c: PKeyCore, _current: String) -> String:
		calls[0] += 1
		return "")
	var hooks := [0]
	sdk.core.add_post_sync_hook(func(_c, _r): hooks[0] += 1)
	var states: Array = []
	sdk.state_changed.connect(func(s): states.append(s["status"]))

	var r: PKeySyncResult = await sdk.sync()
	t.check("sync: a hard 401 is reported", r.unauthorized and r.documents == {"license": "unauthorized", "config": "unauthorized"}, str(r.documents))
	t.check("sync: a hard 401 sets lastSyncUnauthorized", PKeyClaims.is_true(store.cache.get("lastSyncUnauthorized")), str(store.cache))
	t.check("sync: a failed re-acquire is attempted once per pass", calls[0] == 1)
	t.check("sync: a hard 401 makes the licence revoked", sdk.status()["status"] == "revoked", str(sdk.status()))
	t.check("sync: state_changed reports revoked", states.back() == "revoked", str(states))
	t.check("sync: no post-sync hook after a hard 401 with nothing applied", hooks[0] == 0)
	t.check("sync: the 401 pass writes managed.json once", store.cache_writes == 1)

	plan["/license/document"] = [{"status": 403, "body": "{\"error\":{\"code\":\"version_blocked\",\"reason\":\"version-too-old\"},\"allowedRange\":{\"min\":\"2.0.0\",\"max\":\"99.0.0\"}}"}]
	r = await sdk.sync()
	t.check("sync: a 403 block is reported", r.blocked and r.documents["license"] == "blocked", str(r.documents))
	t.check("sync: a 403 block sets blocked", store.cache.get("blocked") == {"reason": "version-too-old", "allowedRange": {"min": "2.0.0", "max": "99.0.0"}}, str(store.cache.get("blocked")))
	t.check("sync: lastSyncUnauthorized holds while the config still 401s", PKeyClaims.is_true(store.cache.get("lastSyncUnauthorized")))
	var st: Dictionary = sdk.status()
	t.check("sync: the block wins in the gate, with its allowed range", st["status"] == "version-too-old" and st.get("allowed_range") == {"min": "2.0.0", "max": "99.0.0"}, str(st))
	t.check("sync: the 403 pass writes managed.json once", store.cache_writes == 2)

	plan["/license/document"] = [_ok(F["license"], F["license_etag"])]
	plan["/config/document"] = [_ok(F["config"], F["config_etag"])]
	r = await sdk.sync()
	t.check("sync: a later 200 applies", r.applied and not r.unauthorized and not r.blocked, str(r.documents))
	t.check("sync: a later 200 clears both hints", not store.cache.has("lastSyncUnauthorized") and not store.cache.has("blocked"), str(store.cache.keys()))
	t.check("sync: the licence is ok again", sdk.status()["status"] == "ok", str(sdk.status()))
	t.check("sync: the 200 pass writes managed.json once", store.cache_writes == 3)

	# The flat 403 spelling and a body with no reason both read as a block.
	plan["/license/document"] = [{"status": 403, "body": "{\"error\":\"channel_not_allowed\",\"message\":\"no\"}"}]
	r = await sdk.sync()
	t.check("sync: the flat error spelling is read", store.cache.get("blocked", {}).get("reason") == "channel-not-entitled", str(store.cache.get("blocked")))
	sdk.queue_free()


func _no_token(t: PKeyTestContext) -> void:
	server.requests.clear()
	var store := PKeyMemoryStore.new(F["device_id"], "")
	var sdk = await _sdk(store, [F["now"]])
	var r: PKeySyncResult = await sdk.sync()
	t.check("sync: without a token a pass makes zero network calls", r.ok and r.documents.is_empty() and server.requests.is_empty() and store.cache_writes == 0)
	t.check("sync: without a token the licence needs activation", sdk.status()["status"] == "needs-activation")
	sdk.queue_free()


func _odd_answers(t: PKeyTestContext) -> void:
	server.requests.clear()
	plan = {
		"polaris-trust.jws": [{"status": 500, "body": "down"}],
		"/license/document": [{"status": 429, "body": "{\"error\":\"rate_limited\"}"}],
		"/config/document": [_ok(F["config"], F["config_etag"])],
	}
	var store := PKeyMemoryStore.new(F["device_id"], F["token"])
	var sdk = await _sdk(store, [F["now"]])
	var r: PKeySyncResult = await sdk.sync()
	t.check("sync: a 429 surfaces as rate-limited, with no retry", r.rate_limited and r.documents["license"] == "rate-limited" and _requests("/license/document").size() == 1, str(r.documents))
	t.check("sync: a failed trust refresh keeps the pinned set and the pass goes on", r.documents["config"] == "applied" and not store.cache.has("trustJws"))
	sdk.queue_free()

	server.requests.clear()
	plan = {
		"polaris-trust.jws": [_ok(F["trust_jws"])],
		"/config/document": [_ok(F["config"], F["config_etag"])],
	}
	store = PKeyMemoryStore.new(F["device_id"], F["token"])
	sdk = await _sdk(store, [F["now"]], PackedStringArray(["config"]))
	r = await sdk.sync()
	t.check("sync: only the enabled documents are fetched", r.documents == {"config": "applied"} and _requests("/license/document").is_empty(), str(r.documents))
	t.check("sync: a product without the licence service is not-applicable", sdk.status()["status"] == "not-applicable")
	sdk.queue_free()


static func _tamper(jws: String) -> String:
	var parts := jws.split(".")
	var p: PackedByteArray = PKeyB64Url.decode_strict(parts[1])
	p[10] = p[10] ^ 0x02
	parts[1] = PKeyB64Url.encode(p)
	return ".".join(parts)
