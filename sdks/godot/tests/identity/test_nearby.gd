extends RefCounted
# @pkey-feature identity.nearby
# Nearby sign-in on the new device D (I-48.15): `identity.sign_in.start_nearby` over the nearby/start and
# nearby/poll routes and the LAN request (a fake here; the engine is the connect suite's). The token is held
# under the unconfirmed mark until the person confirms the account, and a decline, a cancel, the deadline and
# the next start discard it once. Each group below names the rule it proves.

const B := preload("res://tests/identity/support.gd")

const REQUEST := "nr_pA71hdu4pwET01lPlZ_Pow"
const SUBJECT := "ps_AAAAAAAAAAAAAAAAAAAAAA"
const OLD_SUBJECT := "ps_BBBBBBBBBBBBBBBBBBBBBB"
const NEARBY_TOKEN := "pkeyt_NEARBYNEARBYNEARBYNEARBYNEARBYNEARBYNE0"
const OTHER_TOKEN := "pkeyt_OTHEROTHEROTHEROTHEROTHEROTHEROTHEROTH0"


## A memory store that logs the order of its writes.
class LogStore extends PKeyMemoryStore:
	var log: Array = []

	func set_token(p_token: String) -> bool:
		log.append("token")
		return super.set_token(p_token)

	func write_cache(record: Dictionary) -> bool:
		log.append("cache:mark=%s" % (record.get("tokenUnconfirmed") == true))
		return super.write_cache(record)


## The LAN request D holds: the approvers that answered, a code to show, and counters.
class FakeRequest extends RefCounted:
	signal approvers_changed(list: Array)
	signal result(status: String)
	signal record(record_type: int, body: PackedByteArray)
	signal closed(code: StringName)
	var list: Array = [{"id": "A1", "label": "Living room" + char(0x202E), "platform": "macOS"}]
	var chosen := ""
	var declined := 0
	var closes := 0
	var confirmed := 0

	func approvers() -> Array:
		return list

	func get_result() -> String:
		return ""

	func choose(id: String) -> PKeyResult:
		chosen = id
		return PKeyResult.success({"code": "482 913"})

	func confirm_account() -> PKeyResult:
		confirmed += 1
		return PKeyResult.success()

	func decline_account() -> void:
		declined += 1

	func close() -> void:
		closes += 1


## A key ring that records the wraps it is asked to adopt.
class FakeRing extends RefCounted:
	var adopted: Array = []
	var kind := "unlocked"

	func adopt_wrap(record: Variant) -> PKeyResult:
		adopted.append((record as PackedByteArray).duplicate())
		return PKeyResult.success({"kind": kind})


class FakeLan extends RefCounted:
	var req := FakeRequest.new()
	var supported := true
	var requests: Array = []

	func lane_check(_o := {}) -> PKeyResult:
		if supported:
			return PKeyResult.success()
		return PKeyResult.failure(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "no lane")

	func request(o: Dictionary) -> PKeyResult:
		requests.append(o)
		return PKeyResult.success(req)


## The fake Worker: nearby/start and nearby/poll answers from queues, the sign-out route, the discovery document.
class Bed extends PKeyIdentityTestBed:
	var starts_n: Array = []
	var polls_n: Array = []
	var nearby_requests: Array = []
	var discovery: Dictionary = {}
	var nearby_on := true

	func _answer(req: Dictionary) -> Dictionary:
		var path := String(req["path"])
		if path.ends_with("/.well-known/polaris.json"):
			return json(200, discovery_doc())
		if path.ends_with("/identity/nearby/start") or path.ends_with("/identity/nearby/poll"):
			var parsed := PKeyJson.parse_bytes(req["body"])
			nearby_requests.append({"path": path, "body": parsed["value"] if parsed["ok"] else null, "headers": req["headers"]})
			var q: Array = starts_n if path.ends_with("/start") else polls_n
			if q.is_empty():
				return {"status": 500}
			var a = q[0] if q.size() == 1 else q.pop_front()
			return a.call(req) if a is Callable else a
		return super._answer(req)

	func discovery_doc() -> Dictionary:
		var root := "%s/%s/identity" % [server.base_url(), F["product"]]
		var fragment := {"enabled": true, "configured": true, "account": true, "endpoints": {"signout": root + "/signout", "subject": root + "/subject"}}
		if nearby_on:
			fragment["nearby"] = true
			fragment["endpoints"]["nearbyStart"] = root + "/nearby/start"
			fragment["endpoints"]["nearbyPoll"] = root + "/nearby/poll"
			fragment["endpoints"]["nearbyApprove"] = root + "/nearby/approve"
		return {"product": F["product"], "services": {"license": {"enabled": true}, "config": {"enabled": true}, "connect": {"enabled": true}, "identity": fragment}}

	func sent(suffix: String) -> Array:
		return nearby_requests.filter(func(r): return String(r["path"]).ends_with(suffix))


static func started_answer() -> Dictionary:
	return B.json(201, {"request": REQUEST, "expiresIn": 300, "interval": 3})


static func ready_answer(token := NEARBY_TOKEN) -> Dictionary:
	return B.json(200, {
		"access_token": token, "token_type": "Bearer", "scope": "email", "subject": SUBJECT, "schemaVersion": 1,
		"device": {"id": "d", "name": "Test"}, "license": {"id": "lic_1", "name": "Ada Lovelace", "email": "ada@example.com"},
	})


static func pending() -> Dictionary:
	return B.json(200, {"status": "pending"})


## A started SDK on the fake Worker with a fixture key port, a fake LAN and a fake timer.
class Rig extends RefCounted:
	var bed: Bed
	var sdk: Node
	var store: LogStore
	var lan := FakeLan.new()
	var keys := PKeyFixtureDeviceKeys.new("transcript-nearby-d-1")
	var timers: Array = []
	var events: Array = []

	func up(token := "") -> void:
		bed = Bed.new()
		bed.device_keys = keys
		store = LogStore.new(bed.F["device_id"], token)
		sdk = await _make()

	func _make() -> Node:
		bed.sdk = null
		var s: Node = PKeyTestFixtures.new_sdk()
		var opts := PKeyTestFixtures.options(bed.server.base_url(), store, bed.clock, bed.F["product"], bed.F["trust"], bed.F["version"])
		opts.expected_services = PackedStringArray(["license", "config", "identity"])
		opts.device_keys = keys
		s.configure(opts)
		await s.start()
		bed.sdk = s
		s.devices.fingerprint_host = PKeyFakeHost.load_host("linux")
		s.identity.sleeper = func(seconds: float) -> void:
			bed.sleeps.append(seconds)
			bed.clock[0] += seconds
			await (Engine.get_main_loop() as SceneTree).process_frame
		s.identity.nearby_lan = lan
		s.identity.nearby_timer = func(seconds: float, fn: Callable) -> Callable:
			var t := {"seconds": seconds, "fn": fn, "live": true}
			timers.append(t)
			return func() -> void: t["live"] = false
		s.core.discovery_manifest = bed.discovery_doc()
		s.event.connect(func(name: String, data: Dictionary) -> void:
			if name == "identity":
				events.append(data))
		return s

	func restart() -> void:
		sdk.queue_free()
		sdk = await _make()

	func fire_deadline() -> void:
		for t: Dictionary in timers:
			if t["live"]:
				t["live"] = false
				t["fn"].call()

	func live_timers() -> int:
		return timers.filter(func(t): return t["live"]).size()

	func free_all() -> void:
		bed.free_all()


## The proof a route sent, as the verifier takes it.
static func _proof_of(r: Rig, purpose: String, value: String, sig: String) -> Dictionary:
	var keys: Dictionary = r.keys.public_keys().detail
	return {
		"purpose": purpose, "product": r.bed.F["product"], "device_id": r.bed.F["device_id"], "value": value,
		"token_hash": "-", "sign_key": keys["sign_key"], "sig": sig,
	}


func run(t: PKeyTestContext) -> void:
	await _start_rules(t)
	await _unconfirmed_token(t)
	await _confirm_and_decline(t)
	await _triggers(t)
	await _races(t)
	await _poll_rules(t)


## Start: the probe before any route, the typed N/A, the proofs and the LAN request.
func _start_rules(t: PKeyTestContext) -> void:
	var r := Rig.new()
	await r.up()
	r.lan.supported = false
	var off: PKeyResult = await r.sdk.identity.sign_in.start_nearby()
	t.check("nearby: a runtime that cannot browse answers nearby-unsupported before any route", not off.ok and off.code == &"nearby-unsupported" and r.bed.nearby_requests.is_empty(), str(off))
	r.lan.supported = true
	# Without a seam the host's Cloud Connect is the LAN half; on the web it has no lane, and no route is called.
	r.sdk.identity.nearby_lan = null
	t.check("nearby: without a seam the LAN half is cloud_connect.nearby", r.sdk.identity._nearby_lan() == r.sdk.cloud_connect.nearby)
	r.sdk.cloud_connect.nearby._o["has_feature"] = func(f: String) -> bool: return f == "web"
	var web: PKeyResult = await r.sdk.identity.sign_in.start_nearby()
	t.check(
		"nearby: the web answers nearby-unsupported before any route",
		not web.ok and web.code == &"nearby-unsupported" and r.bed.nearby_requests.is_empty() and not r.sdk.identity.nearby_available(),
		str(web))
	r.sdk.cloud_connect.nearby._o.erase("has_feature")
	r.sdk.identity.nearby_lan = r.lan
	r.bed.nearby_on = false
	r.sdk.core.discovery_manifest = r.bed.discovery_doc()
	off = await r.sdk.identity.sign_in.start_nearby()
	t.check(
		"nearby: a product whose discovery names no nearby approval answers service-unavailable, nothing sent",
		not off.ok and off.code == &"service-unavailable" and off.detail["feature"] == "identity.nearby" and r.bed.nearby_requests.is_empty(),
		str(off))
	t.check("nearby: available() reads the last discovery without a request", not r.sdk.identity.nearby_available())
	r.bed.nearby_on = true
	r.sdk.core.discovery_manifest = r.bed.discovery_doc()
	t.check("nearby: available() is true when the lane and the discovery are there", r.sdk.identity.nearby_available())

	r.bed.starts_n = [B.json(400, {"error": {"code": "invalid_grant"}})]
	var bad: PKeyResult = await r.sdk.identity.sign_in.start_nearby({"device_name": "Living-room console"})
	t.check(
		"nearby: a refused start keeps the Worker's code and status and opens no LAN request",
		not bad.ok and bad.code == &"invalid_grant" and bad.detail["status"] == 400 and r.lan.requests.is_empty(),
		str(bad))
	r.bed.starts_n = [B.json(404, {"error": {"code": "not_found"}})]
	bad = await r.sdk.identity.sign_in.start_nearby()
	t.check("nearby: a 404 start is the typed N/A", not bad.ok and bad.code == &"service-unavailable", str(bad))
	r.bed.starts_n = [B.json(201, {"request": "short"})]
	bad = await r.sdk.identity.sign_in.start_nearby()
	t.check("nearby: an incomplete start answer is invalid-response", not bad.ok and bad.code == &"invalid-response", str(bad))

	r.bed.nearby_requests.clear()
	r.bed.starts_n = [started_answer()]
	var made: PKeyResult = await r.sdk.identity.sign_in.start_nearby({"device_name": "Living-room console"})
	t.check("nearby: start returns a session", made.ok and made.detail is PKeyNearbySignIn, str(made))
	var s: PKeyNearbySignIn = made.detail
	var start_req: Dictionary = r.bed.sent("/start")[0]
	var keys: Dictionary = r.keys.public_keys().detail
	var body: Dictionary = start_req["body"]
	t.check(
		"nearby: start sends both public keys and the label, and no bearer for a device without a credential",
		body["signKey"] == keys["sign_key"] and body["agreeKey"] == keys["agree_key"] and body["deviceName"] == "Living-room console" and not (start_req["headers"] as Dictionary).has("authorization"),
		str(body.keys()))
	var proof := _proof_of(r, "nearby-start", "%s.%s" % [keys["sign_key"], keys["agree_key"]], body["proof"])
	t.check("nearby: the start proof verifies for purpose nearby-start over the two keys", PKeyDeviceProof.verify(proof))
	var lan_o: Dictionary = r.lan.requests[0]
	t.check(
		"nearby: the LAN request gets the handle, the lifetime and the label",
		lan_o["request"] == REQUEST and lan_o["expires_in"] == 300 and lan_o["label"] == "Living-room console",
		str(lan_o.keys()))
	var list := s.approvers()
	t.check("nearby: approvers are listed with cleaned labels", list.size() == 1 and list[0]["id"] == "A1" and list[0]["label"] == "Living room" and list[0]["platform"] == "macOS", str(list))
	var chosen: PKeyResult = await s.choose("A1")
	t.check("nearby: choose answers the code to show", chosen.ok and chosen.detail["code"] == "482 913" and s.code == "482 913" and r.lan.req.chosen == "A1")
	t.check("nearby: str() holds no handle", not str(s).contains(REQUEST) and not str(s._started).contains(REQUEST))
	r.lan.req.closed.emit(&"peer_bye")
	t.check("nearby: the peer closing the LAN session is not an end", not s.is_ended() and r.lan.req.closes == 0)
	s.cancel()

	# The bearer D holds goes with the start (a credential it already has).
	var held := Rig.new()
	await held.up(OTHER_TOKEN)
	held.bed.starts_n = [started_answer()]
	var m2: PKeyResult = await held.sdk.identity.sign_in.start_nearby()
	var h2: Dictionary = held.bed.sent("/start")[0]["headers"]
	t.check("nearby: start sends the bearer when D holds a credential", m2.ok and String(h2.get("authorization", "")) == "Bearer " + OTHER_TOKEN, str(h2.keys()))
	if m2.ok:
		m2.detail.cancel()
	held.sdk.queue_free()
	held.free_all()
	r.sdk.queue_free()
	r.free_all()


## The unconfirmed mark: before the token, no sign-in, dropped at load, replaced token first.
func _unconfirmed_token(t: PKeyTestContext) -> void:
	var r := Rig.new()
	await r.up()
	r.sdk.core.cache.set_subject(OLD_SUBJECT)
	r.sdk.core.cache.set_explicit_sign_out(true)
	r.store.log.clear()
	r.bed.starts_n = [started_answer()]
	r.bed.polls_n = [pending(), ready_answer()]
	var s: PKeyNearbySignIn = (await r.sdk.identity.sign_in.start_nearby()).detail
	var o: PKeySignInOutcome = await s.wait()
	var core: PKeyCore = r.sdk.core
	t.check("nearby: the first poll comes one interval after start", r.bed.sleeps.size() >= 2 and r.bed.sleeps[0] == 3.0, str(r.bed.sleeps))
	t.check(
		"nearby: a ready poll is signed_in with the subject and scope",
		o.kind == PKeySignInOutcome.KIND_SIGNED_IN and o.subject == SUBJECT and o.scope == "email" and o.license_id == "lic_1" and o.identity.get("email") == "ada@example.com",
		str(o))
	var mark_first: bool = r.store.log.find("cache:mark=true") >= 0 and r.store.log.find("cache:mark=true") < r.store.log.find("token")
	t.check("nearby: the unconfirmed mark is written before the token", mark_first, str(r.store.log))
	t.check("nearby: the token is held but unconfirmed, with no origin", r.store.token == NEARBY_TOKEN and core.tokens.unconfirmed() and core.tokens.origin() == "" and core.cache.token_unconfirmed)
	t.check(
		"nearby: unconfirmed is not a sign-in: no current identity, no subject, no event, the signed-out state stays",
		r.sdk.identity.current() == null and core.cache.subject == "" and r.events.is_empty() and core.cache.explicit_sign_out,
		str(r.events))
	var gate: PKeyResult = r.sdk.connect_client._gate()
	t.check("nearby: Connect treats the device as signed out while the token is unconfirmed", not gate.ok and gate.code == PKeyErrors.NO_TOKEN, str(gate))
	t.check("nearby: the ladder's rung 1 never counts it", core.tokens.origin() != PKeyTokenManager.ORIGIN_SIGN_IN)
	t.check("nearby: the confirm deadline is armed for the request's lifetime", r.live_timers() == 1 and r.timers[0]["seconds"] == 300.0)
	var again: PKeySignInOutcome = await s.wait()
	t.check("nearby: wait() answers the same outcome again", again == o)

	# Dropped at load: the process ended on the confirm screen.
	await r.restart()
	t.check(
		"nearby: a start that finds the mark drops the token and the mark",
		r.store.token == "" and not r.sdk.core.cache.token_unconfirmed and not r.sdk.core.tokens.has_token(),
		str(r.store.cache))
	t.check("nearby: nothing of it is cached after the drop", r.sdk.core.cache.license == null)

	# A token that replaces an unconfirmed one is written before the mark goes.
	r.sdk.core.tokens.set_unconfirmed_token(NEARBY_TOKEN)
	r.store.log.clear()
	r.sdk.core.tokens.set_token(OTHER_TOKEN, PKeyTokenManager.SOURCE_SIGNIN, true)
	var token_at: int = r.store.log.find("token")
	var unmarked_at: int = r.store.log.find("cache:mark=false")
	t.check("nearby: the replacing token is written before the mark is dropped", token_at >= 0 and unmarked_at > token_at and not r.sdk.core.tokens.unconfirmed(), str(r.store.log))
	# A re-acquire keeps the mark.
	r.sdk.core.tokens.set_unconfirmed_token(NEARBY_TOKEN)
	r.sdk.core.tokens.set_token(OTHER_TOKEN, PKeyTokenManager.SOURCE_REACQUIRE)
	t.check("nearby: a re-acquire keeps the mark", r.sdk.core.tokens.unconfirmed())
	# The token clear removes the token before the mark.
	r.store.log.clear()
	r.sdk.core.tokens.clear()
	t.check("nearby: clearing removes the token and then the mark", r.store.token == "" and not r.sdk.core.cache.token_unconfirmed)

	s.cancel()
	r.sdk.queue_free()
	r.free_all()


## Confirm: the subject, the event, the signed-out state, the records; decline: sign-out and drop.
func _confirm_and_decline(t: PKeyTestContext) -> void:
	var r := Rig.new()
	await r.up()
	r.sdk.core.cache.set_explicit_sign_out(true)
	r.bed.starts_n = [started_answer()]
	r.bed.polls_n = [ready_answer()]
	var s: PKeyNearbySignIn = (await r.sdk.identity.sign_in.start_nearby()).detail
	await s.wait()
	var core: PKeyCore = r.sdk.core
	await r.sdk.sync()
	t.check(
		"nearby: a sync while the token is unconfirmed fetches nothing: the account's licence is not the device's yet",
		r.bed.count("GET", "/license/document") == 0 and core.cache.license == null and r.sdk.identity.current() == null)
	t.check("nearby: records are held until the confirmation", s.take_wrap_record().is_empty())
	var held_wrap := PackedByteArray([1, 2, 3])
	r.lan.req.record.emit(0x0030, held_wrap)
	t.check("nearby: a wrap that arrives is still held before the confirmation", s.take_wrap_record().is_empty())
	var c: PKeyResult = await s.confirm_account()
	t.check(
		"nearby: confirm makes the token a sign-in",
		c.ok and not core.tokens.unconfirmed() and core.tokens.origin() == PKeyTokenManager.ORIGIN_SIGN_IN and core.cache.token_origin == "sign_in",
		str(c))
	t.check(
		"nearby: confirm stores the subject, raises signedIn and ends the signed-out state",
		core.cache.subject == SUBJECT and r.events.size() == 1 and r.events[0].get("kind") == "signedIn" and r.events[0].get("subject") == SUBJECT and not core.cache.explicit_sign_out,
		str(r.events))
	t.check("nearby: confirm releases the LAN records once and stops the deadline", r.lan.req.confirmed == 1 and r.live_timers() == 0)
	t.check("nearby: confirm fetches the account's licence", r.bed.count("GET", "/license/document") >= 1 and core.cache.license != null and r.sdk.identity.current() != null)
	t.check("nearby: Connect's signed-in gate no longer refuses it", core.tokens.has_token() and not core.tokens.unconfirmed())
	var again: PKeyResult = await s.confirm_account()
	t.check("nearby: confirming twice is a no-op", again.ok and r.events.size() == 1 and r.lan.req.confirmed == 1)
	var ring := FakeRing.new()
	r.sdk.identity.nearby_keyring = ring
	r.lan.req.record.emit(0x0030, held_wrap)
	for i in 5:
		await (Engine.get_main_loop() as SceneTree).process_frame
	t.check("nearby: the wrap handed over after the confirmation is adopted at once, and not kept", ring.adopted == [held_wrap] and s.take_wrap_record().is_empty() and s.wrap == "applied")
	r.bed.signout_requests.clear()
	await s.decline_account()
	t.check("nearby: a decline after the confirmation is a no-op", r.bed.signout_requests.is_empty() and r.store.token == NEARBY_TOKEN and not s.is_ended() and r.lan.req.declined == 0)
	s.cancel()
	t.check("nearby: cancel after the confirmation leaves the sign-in", r.store.token == NEARBY_TOKEN and r.bed.signout_requests.is_empty())
	r.sdk.queue_free()
	r.free_all()

	# Decline: the Worker is asked, and the credential, its mark and its documents go.
	var d := Rig.new()
	await d.up()
	d.bed.starts_n = [started_answer()]
	d.bed.polls_n = [ready_answer()]
	var ds: PKeyNearbySignIn = (await d.sdk.identity.sign_in.start_nearby()).detail
	await ds.wait()
	var ends := [0]
	ds.ended.connect(func() -> void: ends[0] += 1)
	d.bed.signout_requests.clear()
	d.bed.signouts = [B.json(200, {"released": true})]
	await ds.decline_account()
	await ds.decline_account()
	var dcore: PKeyCore = d.sdk.core
	t.check("nearby: a decline asks the Worker to sign out, once", d.bed.signout_requests.size() == 1, str(d.bed.signout_requests.size()))
	t.check(
		"nearby: a decline clears the token, the mark and the documents, then raises the signed-out state",
		d.store.token == "" and not dcore.cache.token_unconfirmed and dcore.cache.license == null and dcore.cache.explicit_sign_out,
		str(d.store.cache))
	t.check("nearby: a decline declines and closes the LAN request once and ends the session", d.lan.req.declined == 1 and d.lan.req.closes == 1 and ends[0] == 1 and ds.is_ended())
	var late: PKeyResult = await ds.confirm_account()
	t.check(
		"nearby: confirm after the end fails with sign-in-failed and stores nothing",
		not late.ok and late.code == PKeyErrors.SIGN_IN_FAILED and dcore.cache.subject == "" and d.events.is_empty(),
		str(late))
	t.check("nearby: no signedIn event for a declined account", d.events.is_empty())
	d.sdk.queue_free()
	d.free_all()

	# The Worker unreachable at the sign-out: the credential still goes locally.
	var f := Rig.new()
	await f.up()
	f.bed.starts_n = [started_answer()]
	f.bed.polls_n = [ready_answer()]
	f.bed.signouts = [{"status": 500}]
	var fs: PKeyNearbySignIn = (await f.sdk.identity.sign_in.start_nearby()).detail
	await fs.wait()
	await fs.decline_account()
	t.check("nearby: whatever the Worker answers, the credential goes locally", f.store.token == "" and not f.sdk.core.cache.token_unconfirmed and f.sdk.core.cache.explicit_sign_out)
	f.sdk.queue_free()
	f.free_all()


## The four triggers (decline, host end, the deadline, the next start) and one discard.
func _triggers(t: PKeyTestContext) -> void:
	# The host ends it: cancel() after signed_in discards, once.
	var r := Rig.new()
	await r.up()
	r.bed.starts_n = [started_answer()]
	r.bed.polls_n = [ready_answer()]
	var s: PKeyNearbySignIn = (await r.sdk.identity.sign_in.start_nearby()).detail
	await s.wait()
	r.bed.signout_requests.clear()
	s.cancel()
	s.cancel()
	await s.decline_account()
	t.check("nearby: cancel then decline is one idempotent discard", r.bed.signout_requests.size() == 1 and r.store.token == "" and r.lan.req.declined == 1, str(r.bed.signout_requests.size()))

	# The deadline: 300 s from the poll's answer discards, and a confirm that follows fails.
	var d := Rig.new()
	await d.up()
	d.bed.starts_n = [started_answer()]
	d.bed.polls_n = [ready_answer()]
	var ds: PKeyNearbySignIn = (await d.sdk.identity.sign_in.start_nearby()).detail
	await ds.wait()
	var ended := [0]
	ds.ended.connect(func() -> void: ended[0] += 1)
	d.bed.signout_requests.clear()
	d.fire_deadline()
	await B.until(func(): return d.store.token == "")
	t.check("nearby: the deadline discards the unconfirmed sign-in", d.store.token == "" and ds.is_ended() and ended[0] == 1 and d.bed.signout_requests.size() == 1, str(d.store.token))
	var late: PKeyResult = await ds.confirm_account()
	t.check("nearby: a confirm after the deadline fails and signs nobody in", not late.ok and d.sdk.core.cache.subject == "" and d.events.is_empty())

	# Confirm wins over the deadline.
	var w := Rig.new()
	await w.up()
	w.bed.starts_n = [started_answer()]
	w.bed.polls_n = [ready_answer()]
	var ws: PKeyNearbySignIn = (await w.sdk.identity.sign_in.start_nearby()).detail
	await ws.wait()
	var live_before: Callable = w.timers[0]["fn"]
	await ws.confirm_account()
	live_before.call()
	t.check("nearby: a deadline that fires after the confirmation does nothing", w.store.token == NEARBY_TOKEN and not ws.is_ended() and w.bed.signout_requests.is_empty())

	# The next start ends the previous unconfirmed session.
	var n := Rig.new()
	await n.up()
	n.bed.starts_n = [started_answer()]
	n.bed.polls_n = [ready_answer()]
	var first: PKeyNearbySignIn = (await n.sdk.identity.sign_in.start_nearby()).detail
	await first.wait()
	var second: PKeyResult = await n.sdk.identity.sign_in.start_nearby()
	await B.until(func(): return n.store.token == "")
	t.check("nearby: the next start discards the previous unconfirmed session", first.is_ended() and n.store.token == "" and second.ok, str(second))
	if second.ok:
		second.detail.cancel()

	for rig: Rig in [r, d, w, n]:
		rig.sdk.queue_free()
		rig.free_all()


## Races: a late ready after the end, another sign-in's token, an empty subject.
func _races(t: PKeyTestContext) -> void:
	# A cancel while the poll is in flight: the late ready discards at once; no token is orphaned.
	var r := Rig.new()
	await r.up()
	r.bed.starts_n = [started_answer()]
	var holder := []
	r.bed.polls_n = [func(_req) -> Dictionary:
		holder[0].cancel()
		return ready_answer()]
	var s: PKeyNearbySignIn = (await r.sdk.identity.sign_in.start_nearby()).detail
	holder.append(s)
	var o: PKeySignInOutcome = await s.wait()
	t.check(
		"nearby: a ready poll that lands after the end answers cancelled and discards at once",
		o.kind == PKeySignInOutcome.KIND_CANCELLED and r.store.token == "" and not r.sdk.core.cache.token_unconfirmed,
		str(o))
	t.check("nearby: a cancelled wait never orphans a stored token", r.sdk.core.tokens.current() == "" and r.live_timers() == 0)

	# Cancel while sleeping: wait() answers cancelled, no poll goes out.
	var c := Rig.new()
	await c.up()
	c.bed.starts_n = [started_answer()]
	var cs: PKeyNearbySignIn = (await c.sdk.identity.sign_in.start_nearby()).detail
	c.sdk.identity.sleeper = func(seconds: float) -> void:
		cs.cancel()
		c.bed.clock[0] += seconds
	var co: PKeySignInOutcome = await cs.wait()
	t.check("nearby: cancel during the pause answers cancelled and sends no poll", co.kind == PKeySignInOutcome.KIND_CANCELLED and c.bed.sent("/poll").is_empty())

	# Another sign-in replaced the token: the confirm checks the held token, and nothing of the other is touched.
	var x := Rig.new()
	await x.up()
	x.bed.starts_n = [started_answer()]
	x.bed.polls_n = [ready_answer()]
	var xs: PKeyNearbySignIn = (await x.sdk.identity.sign_in.start_nearby()).detail
	await xs.wait()
	x.sdk.core.tokens.set_token(OTHER_TOKEN, PKeyTokenManager.SOURCE_SIGNIN, true)
	x.bed.signout_requests.clear()
	var cf: PKeyResult = await xs.confirm_account()
	t.check(
		"nearby: confirm compares the held token in one step and confirms nothing of a later sign-in",
		not cf.ok and x.store.token == OTHER_TOKEN and x.sdk.core.cache.subject == "" and x.events.is_empty() and x.bed.signout_requests.is_empty(),
		str(cf))
	await xs.decline_account()
	t.check("nearby: a discard never signs out a later sign-in's token", x.store.token == OTHER_TOKEN and x.bed.signout_requests.is_empty())

	# A later unconfirmed token (another nearby sign-in) keeps the mark: the confirm still names its own token.
	var y := Rig.new()
	await y.up()
	y.bed.starts_n = [started_answer()]
	y.bed.polls_n = [ready_answer()]
	var ys: PKeyNearbySignIn = (await y.sdk.identity.sign_in.start_nearby()).detail
	await ys.wait()
	y.sdk.core.tokens.set_unconfirmed_token(OTHER_TOKEN)
	var yf: PKeyResult = await ys.confirm_account()
	t.check(
		"nearby: confirm compares the held token even when another unconfirmed token holds the mark",
		not yf.ok and y.sdk.core.tokens.unconfirmed() and y.store.token == OTHER_TOKEN and y.events.is_empty() and y.sdk.core.cache.subject == "")
	y.sdk.queue_free()
	y.free_all()

	# An empty session subject is never the same person.
	var e := Rig.new()
	await e.up()
	e.bed.starts_n = [started_answer()]
	e.bed.polls_n = [ready_answer()]
	var es: PKeyNearbySignIn = (await e.sdk.identity.sign_in.start_nearby()).detail
	await es.wait()
	es._subject = ""
	var ef: PKeyResult = await es.confirm_account()
	t.check("nearby: an empty session subject is not a sign-in to confirm", not ef.ok and e.sdk.core.tokens.unconfirmed() and e.events.is_empty())

	# A late ready from a poll another token overtook stores nothing.
	var m := Rig.new()
	await m.up()
	m.bed.starts_n = [started_answer()]
	m.bed.polls_n = [func(_req) -> Dictionary:
		m.sdk.core.tokens.set_token(OTHER_TOKEN, PKeyTokenManager.SOURCE_SIGNIN, true)
		return ready_answer()]
	var ms: PKeyNearbySignIn = (await m.sdk.identity.sign_in.start_nearby()).detail
	var mo: PKeySignInOutcome = await ms.wait()
	t.check("nearby: a late ready never replaces a newer token", mo.kind == PKeySignInOutcome.KIND_ERROR and m.store.token == OTHER_TOKEN and not m.sdk.core.tokens.unconfirmed(), str(mo))

	for rig: Rig in [r, c, x, e, m]:
		rig.sdk.queue_free()
		rig.free_all()


## The poll's answers: denied, expired, slow-down, transient, N11.
func _poll_rules(t: PKeyTestContext) -> void:
	var r := Rig.new()
	await r.up()
	r.bed.starts_n = [started_answer()]
	r.bed.polls_n = [B.json(200, {"status": "error", "reason": "access_denied"})]
	var s: PKeyNearbySignIn = (await r.sdk.identity.sign_in.start_nearby()).detail
	var o: PKeySignInOutcome = await s.wait()
	t.check(
		"nearby: access_denied is a denial and holds no token",
		o.kind == PKeySignInOutcome.KIND_DENIED and o.code == PKeyErrors.SIGN_IN_DENIED and r.store.token == "" and r.lan.req.closes == 1,
		str(o))
	var poll_body: Dictionary = r.bed.sent("/poll")[0]["body"]
	var keys: Dictionary = r.keys.public_keys().detail
	var proof := _proof_of(r, "nearby-poll", REQUEST, poll_body["proof"])
	t.check("nearby: the poll proof verifies for purpose nearby-poll over the handle", poll_body["request"] == REQUEST and PKeyDeviceProof.verify(proof))
	t.check("nearby: the poll sends no bearer", not (r.bed.sent("/poll")[0]["headers"] as Dictionary).has("authorization"))

	var x := Rig.new()
	await x.up()
	x.bed.starts_n = [started_answer()]
	x.bed.polls_n = [B.json(200, {"status": "timeout"})]
	var xs: PKeyNearbySignIn = (await x.sdk.identity.sign_in.start_nearby()).detail
	var xo: PKeySignInOutcome = await xs.wait()
	t.check("nearby: timeout is expired and closes the LAN request", xo.kind == PKeySignInOutcome.KIND_EXPIRED and x.lan.req.closes == 1)

	var p := Rig.new()
	await p.up()
	p.bed.starts_n = [started_answer()]
	p.bed.polls_n = [B.json(429, {"interval": 8}), {"status": 503, "headers": {"Retry-After": "11"}}, pending(), B.json(200, {"status": "timeout"})]
	var ps: PKeyNearbySignIn = (await p.sdk.identity.sign_in.start_nearby()).detail
	await ps.wait()
	t.check(
		"nearby: slow_down lengthens the interval and a 5xx rides out at the Retry-After",
		p.bed.sleeps.size() >= 4 and p.bed.sleeps[0] == 3.0 and p.bed.sleeps[1] == 8.0 and p.bed.sleeps[2] == 11.0 and p.bed.sleeps[3] == 8.0,
		str(p.bed.sleeps))

	# N11: a 404 poll is unavailable only after a fresh discovery lost nearby.
	var n := Rig.new()
	await n.up()
	n.bed.starts_n = [started_answer()]
	n.bed.polls_n = [B.json(404, {"error": {"code": "not_found"}})]
	var ns: PKeyNearbySignIn = (await n.sdk.identity.sign_in.start_nearby()).detail
	var no: PKeySignInOutcome = await ns.wait()
	t.check("nearby: a 404 poll while discovery still names nearby is a refusal, not unavailable", no.kind == PKeySignInOutcome.KIND_ERROR and no.code == &"not_found" and no.status == 404, str(no))
	var g := Rig.new()
	await g.up()
	g.bed.starts_n = [started_answer()]
	g.bed.polls_n = [func(_req) -> Dictionary:
		g.bed.nearby_on = false
		return B.json(404, {"error": {"code": "not_found"}})]
	var gs: PKeyNearbySignIn = (await g.sdk.identity.sign_in.start_nearby()).detail
	var go: PKeySignInOutcome = await gs.wait()
	t.check("nearby: a 404 poll after a fresh discovery lost nearby is service-unavailable", go.kind == PKeySignInOutcome.KIND_SERVICE_UNAVAILABLE and go.code == &"service-unavailable", str(go))

	for rig: Rig in [r, x, p, n, g]:
		rig.sdk.queue_free()
		rig.free_all()
