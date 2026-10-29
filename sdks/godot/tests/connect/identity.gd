extends RefCounted
# @pkey-feature connect.identity
# The Connect identity client (CC-14.1b): `identity()` registers the device keys on first need (one
# retry after `device_keys_required`), fetches `GET connect/identity`, verifies the roster and the
# certificate against the effective set and stores them; `list_devices`; the previous K_disc kept for
# 24 hours; a pushed roster that arrives while the answer is on its way; the gate (discovery, token,
# durable keys). The recorded conversations replay in suite_transcripts (connect-identity*).
# Rosters and certificates are signed here with a throwaway product key.

const PRODUCT := "djdl"
const NOW := 1700000000
const SUB := "ps_AbCdEfGhIjKlMnOpQrStUv"
const OTHER_SUB := "ps_ZyXwVuTsRqPoNmLkJiHgFe"
const ME := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const TOKEN := "pkeyt_UnclYEPDsJKnBWqtUuw8kAHjjIn5ym9GDrR1UHdxVZI"
const KID := "test-product-2026"
const X := {
	"device_id": "J0VOdxiMbiwlR1IacWJby71aZqm9KNqx", "sign_key": "fsLskZbwiyNDAOcvWdzjPaWTBxTRCkoUQnCQhe8eJBQ",
	"agree_key": "Wgw9iFMiWpAYEM9g92J1fq928473Y_Xws075igVAJDA",
}
const Y := {
	"device_id": "Whz-NHBvQacOwY6JwDk-DsBtdaz-WMgX", "sign_key": "5ZLajJkgtNiLNr5xhXSqncSGDOyxNIH5qIZb1ePKxxQ",
	"agree_key": "PoJ7eiXVU43cuNAZVTks5zTHZXiOU75AoiYXAGfKaAQ",
}
const HEADERS := {"content-type": "application/json"}

var _seed := PackedByteArray()
var _trust := {}
var _host: Node
var _scratch := ""
var _keys: PKeyDeviceKeyStore
var _mine := {}
var _clock := [NOW]
var _server: PKeyFakeServer
# What the fake Worker answers: a Callable per route, set by each case.
var _put := {"status": 200, "headers": HEADERS, "body": '{"keySeq":1}'}
var _identity_reply: Callable
var _devices_reply := {"status": 200, "headers": HEADERS, "body": ""}


func run(t: PKeyTestContext) -> void:
	_scratch = PKeyTestFixtures.scratch_dir("connect-identity")
	_setup()
	_server = PKeyTestFixtures.new_server(_route)
	_host = Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	var core := await _core(TOKEN)
	await _first(t, core)
	await _fresh_and_refresh(t, core)
	await _previous_key(t, core)
	await _refusals(t, core)
	await _answer_shapes(t, core)
	await _retry(t, core)
	await _rotation(t, core)
	await _pushed_meanwhile(t, core)
	await _serial(t, core)
	await _gate(t, core)
	await _devices(t, core)
	await _facade(t)
	_server.queue_free()
	_host.queue_free()
	PKeyTestFixtures.remove_tree(_scratch)


# ── fixtures ─────────────────────────────────────────────────────────────────────────────

func _setup() -> void:
	_seed = PackedByteArray()
	for i in 32:
		_seed.append(i + 1)
	_trust = {KID: PKeyB64Url.encode(PKeyTestSigner.public_key(_seed))}
	_keys = PKeyDeviceKeyStore.for_tests(PRODUCT, _scratch.path_join("keys"))
	_mine = _public(_keys)


static func _public(keys: Object) -> Dictionary:
	var pub: Dictionary = keys.ensure().detail
	return {"device_id": ME, "sign_key": pub["sign_key"], "agree_key": pub["agree_key"]}


func _core(token: String) -> PKeyCore:
	var opts := PKeyTestFixtures.options(_server.base_url(), PKeyMemoryStore.new(ME, token), _clock, PRODUCT, _trust)
	var core: PKeyCore = PKeyCore.create(opts, _host, "0.0.0").detail
	await core.start()
	return core


func _client(core: PKeyCore, keys: Object = null) -> PKeyConnectClient:
	var c := PKeyConnectClient.new(core, PKeyConnectState.new(PRODUCT, _scratch, true), keys if keys != null else _keys)
	c.devices = PKeyDevices.new(core)
	return c


func _route(req: Dictionary) -> Dictionary:
	var path: String = req["path"]
	if req["method"] == "PUT" and path.ends_with("/devices/keys"):
		return _put.duplicate(true)
	if req["method"] == "GET" and path.ends_with("/connect/identity"):
		return _identity_reply.call(req)
	if req["method"] == "GET" and path.ends_with("/connect/devices"):
		return _devices_reply.duplicate(true)
	return {"status": 599}


static func _dev(d: Dictionary) -> String:
	return '{"deviceId":"%s","signKey":"%s","agreeKey":"%s"}' % [d["device_id"], d["sign_key"], d["agree_key"]]


func _ring(sub: String, epoch: int, devices: Array, iat := NOW - 100, exp := NOW + 600000) -> String:
	var list := ",".join(devices.map(_dev))
	var body := '{"iss":"key.plrs.im","aud":"%s","sub":"%s","epoch":%d,"issuedAt":%d,"expiresAt":%d,"devices":[%s]}' % [PRODUCT, sub, epoch, iat, exp, list]
	return PKeyTestSigner.sign_jws(body, _seed, KID, "pkey-ring+jws")


func _cert(epoch: int, sub := SUB, device := ME, pub := {}, iat := NOW - 100) -> String:
	var sign_key: String = pub.get("sign_key", _mine["sign_key"])
	var agree_key: String = pub.get("agree_key", _mine["agree_key"])
	var body := '{"iss":"key.plrs.im","aud":"%s","sub":"%s","deviceId":"%s","signKey":"%s",' % [PRODUCT, sub, device, sign_key]
	body += '"agreeKey":"%s","ringEpoch":%d,"issuedAt":%d,"expiresAt":%d}' % [agree_key, epoch, iat, iat + PKeyPeerCert.MAX_PEER_CERT_SECONDS]
	return PKeyTestSigner.sign_jws(body, _seed, KID, "pkey-peer+jws")


static func _filled(v: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(32)
	b.fill(v)
	return b


static func _k(v: int) -> String:
	return PKeyB64Url.encode(_filled(v))


## The Worker's answer for a roster at `epoch` with `devices`, this device's certificate, `keys` K_disc.
func _answer(epoch: int, devices: Array, keys: Array, cert_override := "", ring_override := "") -> Dictionary:
	var body := {
		"ring": ring_override if ring_override != "" else _ring(SUB, epoch, devices),
		"certificate": cert_override if cert_override != "" else _cert(epoch),
		"discKeys": keys,
	}
	return {"status": 200, "headers": HEADERS, "body": JSON.stringify(body)}


func _serve(reply: Dictionary) -> void:
	_identity_reply = func(_req: Dictionary) -> Dictionary: return reply.duplicate(true)


func _reset() -> void:
	_server.requests.clear()
	_put = {"status": 200, "headers": HEADERS, "body": '{"keySeq":1}'}


func _calls() -> Array:
	return _server.requests.map(func(q: Dictionary) -> String: return "%s %s" % [q["method"], String(q["path"]).trim_prefix("/" + PRODUCT)])


# ── the first call, a fresh identity, a refresh ───────────────────────────────────────────

func _first(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var c := _client(core)
	var roster := [_mine, X]
	_serve(_answer(1, roster, [_k(1)]))
	var r := await c.identity()
	t.check("the first call: the keys are registered, then the identity is fetched", \
			r.ok and _calls() == ["PUT /devices/keys", "GET /connect/identity"], str(_calls()))
	var put: Dictionary = _server.requests[0]
	var put_body: Dictionary = JSON.parse_string(put["body"].get_string_from_utf8())
	t.check("PUT devices/keys: the bearer, the device, the keys proof at the SDK clock", \
			put["headers"].get("authorization") == "Bearer " + TOKEN and put["headers"].get("x-pkey-device") == ME \
			and put_body["signKey"] == _mine["sign_key"] and put_body["agreeKey"] == _mine["agree_key"] \
			and int(put_body["issuedAt"]) == NOW)
	var fetched: Dictionary = _server.requests[1]
	t.check("GET connect/identity: the bearer and the device", \
			fetched["headers"].get("authorization") == "Bearer " + TOKEN and fetched["headers"].get("x-pkey-device") == ME)
	var id: Dictionary = r.detail
	t.check("the identity: subject, device, epoch, roster, documents", \
			id["sub"] == SUB and id["device_id"] == ME and id["epoch"] == 1 and (id["devices"] as Array).size() == 2 \
			and (id["devices"] as Array)[0]["device_id"] == ME and id["certificate_expires_at"] == NOW - 100 + PKeyPeerCert.MAX_PEER_CERT_SECONDS \
			and id["ring_expires_at"] == NOW + 600000 and id["ring"] != "" and id["certificate"] != "")
	var held: PKeyConnectState.Record = c.held().detail
	t.check("it is stored: K_disc, the registered keys, the epoch", \
			held != null and held.disc_keys == [_k(1)] and held.prev_until == -1 and held.epoch == 1 \
			and held.registered_sign == _mine["sign_key"] and held.registered_agree == _mine["agree_key"] \
			and held.stored_at == NOW and not held.keys_stale)
	var cur: Variant = c.current()
	t.check("current() reads the same identity", cur != null and cur["epoch"] == 1 and cur["certificate"] == id["certificate"])
	t.check("discovery_keys() hands out the stored key", c.discovery_keys()["current"] == _filled(1) and c.discovery_keys()["previous"] == null)
	t.check("nothing prints the key or the token", \
			str(r).find(_k(1)) == -1 and r.message.find("pkey") == -1 and str(c) == "PKeyConnectClient")
	t.check("leave() forgets it, and a new call fetches again", c.leave().ok and c.current() == null and c.discovery_keys() == null)
	_server.requests.clear()
	var again := await c.identity()
	t.check("after leave, the keys are registered again (the record said so)", again.ok and _calls() == ["PUT /devices/keys", "GET /connect/identity"])


func _fresh_and_refresh(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var c := _client(core)
	_serve(_answer(1, [_mine, X], [_k(1)]))
	await c.identity()
	_server.requests.clear()
	var r := await c.identity()
	t.check("a fresh identity is served from the record: nothing is sent", r.ok and _server.requests.is_empty() and r.detail["epoch"] == 1)
	r = await c.identity(true)
	t.check("refresh asks again, without registering again", r.ok and _calls() == ["GET /connect/identity"])
	# The certificate is nearing its end: less than half its week left.
	_clock[0] = NOW - 100 + PKeyPeerCert.MAX_PEER_CERT_SECONDS - PKeyPeerCert.PEER_CERT_RENEW_SECONDS + 1
	var renewed_at: int = _clock[0]
	_server.requests.clear()
	_serve(_answer(1, [_mine, X], [_k(1)], _cert(1, SUB, ME, {}, renewed_at)))
	r = await c.identity()
	t.check("a certificate with less than half its life left is renewed", r.ok and _calls() == ["GET /connect/identity"] \
			and r.detail["certificate_expires_at"] == renewed_at + PKeyPeerCert.MAX_PEER_CERT_SECONDS)
	_clock[0] = NOW
	# The roster expired.
	var old := _client(core)
	old.hold(_held_record(_ring(SUB, 1, [_mine, X], NOW - 1000000, NOW - 500000), _cert(1), [_k(1)]))
	_server.requests.clear()
	_serve(_answer(2, [_mine, X], [_k(1)]))
	r = await old.identity()
	t.check("an expired held roster counts as none: the new one is stored", r.ok and r.detail["epoch"] == 2 and _calls() == ["GET /connect/identity"])


func _held_record(ring: String, cert: String, keys: Array, prev_until := -1) -> PKeyConnectState.Record:
	var rec := PKeyConnectState.Record.new()
	rec.product = PRODUCT
	rec.device_id = ME
	rec.ring = ring
	rec.certificate = cert
	var typed: Array[String] = []
	typed.assign(keys)
	rec.disc_keys = typed
	rec.prev_until = prev_until
	rec.epoch = 1
	rec.registered_sign = _mine["sign_key"]
	rec.registered_agree = _mine["agree_key"]
	rec.stored_at = NOW - 10
	return rec


# ── K_disc over a person's changes ───────────────────────────────────────────────────────

func _previous_key(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var c := _client(core)
	_serve(_answer(1, [_mine, X], [_k(1)]))
	await c.identity()
	# A device joins: the epoch rises, a new K_disc, the old one beside it for 24 hours.
	_clock[0] = NOW + 10
	_serve(_answer(2, [_mine, X, Y], [_k(2), _k(1)]))
	var r := await c.identity(true)
	var held: PKeyConnectState.Record = c.held().detail
	t.check("two keys: the previous one is kept for 24 hours from now", \
			r.ok and held.disc_keys == [_k(2), _k(1)] and held.prev_until == NOW + 10 + PKeyConnectClient.PREV_DISC_KEY_SECONDS)
	var keys: Variant = c.discovery_keys()
	t.check("discovery_keys: current and previous", keys["current"] == _filled(2) and keys["previous"] == _filled(1))
	# The same epoch again: the 24 hours run from the first sighting, not from this answer.
	_clock[0] = NOW + 600
	r = await c.identity(true)
	held = c.held().detail
	t.check("the same previous key keeps its first deadline", r.ok and held.prev_until == NOW + 10 + PKeyConnectClient.PREV_DISC_KEY_SECONDS)
	# 24 hours pass: the previous key is left out.
	_clock[0] = NOW + 10 + PKeyConnectClient.PREV_DISC_KEY_SECONDS + 1
	t.check("after 24 hours the previous key is left out", c.discovery_keys()["previous"] == null and c.discovery_keys()["current"] == _filled(2))
	_clock[0] = NOW + 700
	# A device leaves: a roster missing one of the held devices drops the previous key, whatever the answer says.
	_serve(_answer(3, [_mine, X], [_k(3), _k(2)]))
	r = await c.identity(true)
	held = c.held().detail
	t.check("a device left: the previous key is dropped", r.ok and held.disc_keys == [_k(3)] and held.prev_until == -1 and c.discovery_keys()["previous"] == null)
	# A stale flag is cleared by a successful fetch.
	var stale: PKeyConnectState.Record = (c.held().detail as PKeyConnectState.Record).duplicate_record()
	stale.keys_stale = true
	c.hold(stale)
	t.check("a stale K_disc is not handed out", c.discovery_keys() == null)
	_serve(_answer(4, [_mine, X], [_k(4)]))
	r = await c.identity(true)
	t.check("the fetch clears keys_stale", r.ok and not c.keys_stale() and c.discovery_keys()["current"] == _filled(4))
	_clock[0] = NOW


# ── a roster or certificate that must not be stored ──────────────────────────────────────

func _refusals(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var c := _client(core)
	_serve(_answer(5, [_mine, X], [_k(1)]))
	await c.identity()
	var before: PKeyConnectState.Record = c.held().detail
	var other_keys := {"sign_key": X["sign_key"], "agree_key": X["agree_key"]}
	var tampered := _ring(SUB, 6, [_mine, X])
	tampered = tampered.left(tampered.length() - 4) + "AAAA"
	var cases := {
		"a roster that does not verify": [_answer(6, [_mine, X], [_k(1)], "", tampered), "peer-cert-invalid"],
		"a certificate that does not verify": [_answer(6, [_mine, X], [_k(1)], _cert(6).left(40) + "AAAA"), "peer-cert-invalid"],
		"an expired roster": [_answer(6, [_mine, X], [_k(1)], "", _ring(SUB, 6, [_mine, X], NOW - 1000000, NOW - 500000)), "peer-cert-invalid"],
		"a certificate and roster of different subjects": [_answer(6, [_mine, X], [_k(1)], _cert(6, OTHER_SUB)), "peer-cert-invalid"],
		"a certificate for another device": [_answer(6, [_mine, X], [_k(1)], _cert(6, SUB, X["device_id"])), "peer-cert-invalid"],
		"a certificate for other keys than this device's": [_answer(6, [_mine, X], [_k(1)], _cert(6, SUB, ME, other_keys)), "peer-cert-invalid"],
		"a certificate and roster at different epochs": [_answer(6, [_mine, X], [_k(1)], _cert(7)), "peer-cert-invalid"],
		"a roster that does not list this device": [_answer(6, [X, Y], [_k(1)]), "peer-cert-invalid"],
		"a stale roster (a lower epoch)": [_answer(4, [_mine, X], [_k(1)]), "peer-cert-invalid"],
		"a roster of another subject": [_answer(6, [_mine, X], [_k(1)], _cert(6, OTHER_SUB), _ring(OTHER_SUB, 6, [_mine, X])), "peer-cert-invalid"],
		"another roster at the held epoch": [_answer(5, [_mine, X, Y], [_k(1)]), "peer-cert-invalid"],
	}
	for name in cases:
		_serve(cases[name][0])
		var r := await c.identity(true)
		var held: PKeyConnectState.Record = c.held().detail
		t.check("refused: %s" % name, not r.ok and String(r.code) == cases[name][1] and held.encode() == before.encode(), "%s %s" % [r.code, r.message])
	t.check("a refusal says nothing of the documents", not str(await c.identity(true)).contains("eyJ"))
	# The same epoch with the same roster refreshes the record.
	_serve(_answer(5, [_mine, X], [_k(7)]))
	var ok := await c.identity(true)
	t.check("the same roster at the held epoch is accepted (K_disc as delivered)", ok.ok and c.held().detail.disc_keys == [_k(7)])


func _answer_shapes(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var c := _client(core)
	var good: Dictionary = JSON.parse_string(_answer(1, [_mine, X], [_k(1)])["body"])
	var bads := {
		"no ring": _without(good, "ring"), "ring not a string": _with(good, "ring", 1), "no certificate": _without(good, "certificate"),
		"no discKeys": _without(good, "discKeys"), "empty discKeys": _with(good, "discKeys", []),
		"three discKeys": _with(good, "discKeys", [_k(1), _k(2), _k(3)]), "equal discKeys": _with(good, "discKeys", [_k(1), _k(1)]),
		"short discKey": _with(good, "discKeys", ["abc"]), "discKey not a string": _with(good, "discKeys", [1]),
		"non-canonical discKey": _with(good, "discKeys", [_k(1).left(42) + "B"]), "not an object": "[]", "not json": "pong",
		"a duplicate member": JSON.stringify(good).insert(1, '"ring":"x",'),
	}
	for name in bads:
		_serve({"status": 200, "headers": HEADERS, "body": bads[name]})
		var r := await c.identity(true)
		t.check("an answer is refused: %s" % name, not r.ok and String(r.code) == "invalid-response" and c.held().detail == null, "%s" % r.code)


static func _with(good: Dictionary, key: String, value: Variant) -> String:
	var d := good.duplicate(true)
	d[key] = value
	return JSON.stringify(d)


static func _without(good: Dictionary, key: String) -> String:
	var d := good.duplicate(true)
	d.erase(key)
	return JSON.stringify(d)


# ── the Worker forgot the keys ───────────────────────────────────────────────────────────

func _retry(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var c := _client(core)
	_serve(_answer(1, [_mine, X], [_k(1)]))
	await c.identity()
	var calls := []
	var replies := [{"status": 409, "headers": HEADERS, "body": '{"error":{"code":"device_keys_required"}}'}, _answer(1, [_mine, X], [_k(1)])]
	_identity_reply = func(_req: Dictionary) -> Dictionary: return (replies.pop_front() as Dictionary).duplicate(true)
	_server.requests.clear()
	var r := await c.identity(true)
	calls = _calls()
	t.check("device_keys_required: register once more, ask again", r.ok and calls == ["GET /connect/identity", "PUT /devices/keys", "GET /connect/identity"], str(calls))
	# Twice is an answer: one retry only.
	var always := {"status": 409, "headers": HEADERS, "body": '{"error":{"code":"device_keys_required"}}'}
	_serve(always)
	_server.requests.clear()
	r = await c.identity(true)
	t.check("a second device_keys_required is the answer", not r.ok and String(r.code) == "device_keys_required" \
			and _calls() == ["GET /connect/identity", "PUT /devices/keys", "GET /connect/identity"], str(_calls()))
	# Keys registered a moment ago are not registered again for the same refusal.
	var fresh := _client(core)
	_server.requests.clear()
	r = await fresh.identity()
	t.check("keys registered in this very call get no second registration", not r.ok and _calls() == ["PUT /devices/keys", "GET /connect/identity"], str(_calls()))
	# The registration itself is refused: its refusal is the answer and no identity is asked for.
	_put = {"status": 400, "headers": HEADERS, "body": '{"error":{"code":"device_keys_invalid"}}'}
	_server.requests.clear()
	r = await _client(core).identity()
	t.check("a refused registration stops the call", not r.ok and String(r.code) == "device_keys_invalid" and _calls() == ["PUT /devices/keys"])
	# The Worker's other refusals pass through with their codes.
	_reset()
	for pair in [[403, "account_required"], [409, "ring_too_large"], [404, "not_found"]]:
		_serve({"status": pair[0], "headers": HEADERS, "body": '{"error":{"code":"%s"}}' % pair[1]})
		r = await _client(core).identity(true)
		t.check("%s passes through" % pair[1], not r.ok and String(r.code) == pair[1] and r.detail["status"] == pair[0])


# ── this device rotated its keys ─────────────────────────────────────────────────────────

func _rotation(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var keys_a := PKeyDeviceKeyStore.for_tests(PRODUCT, _scratch.path_join("rot-a"))
	var pub_a := _public(keys_a)
	var c := _client(core, keys_a)
	var answer := func(pub: Dictionary, epoch: int) -> Dictionary:
		var body := {"ring": _ring(SUB, epoch, [pub, X]), "certificate": _cert(epoch, SUB, ME, pub), "discKeys": [_k(1)]}
		return {"status": 200, "headers": HEADERS, "body": JSON.stringify(body)}
	_serve(answer.call(pub_a, 1))
	var r := await c.identity()
	t.check("keys A: registered and stored", r.ok and c.held().detail.registered_sign == pub_a["sign_key"])
	var keys_b := PKeyDeviceKeyStore.for_tests(PRODUCT, _scratch.path_join("rot-b"))
	var pub_b := _public(keys_b)
	c.use_device_keys(keys_b)
	_serve(answer.call(pub_b, 2))
	_server.requests.clear()
	r = await c.identity()
	t.check("new keys: the identity is not fresh, the keys are registered, the roster is replaced", \
			r.ok and _calls() == ["PUT /devices/keys", "GET /connect/identity"] and r.detail["epoch"] == 2 \
			and c.held().detail.registered_sign == pub_b["sign_key"], str(_calls()))
	# A certificate for the old keys is refused for the new ones.
	_serve(answer.call(pub_a, 3))
	r = await c.identity(true)
	t.check("a certificate for the old keys is refused", not r.ok and String(r.code) == "peer-cert-invalid" and c.held().detail.epoch == 2)


# ── a roster a peer pushed while the answer was on its way ───────────────────────────────

func _pushed_meanwhile(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var c := _client(core)
	_serve(_answer(1, [_mine, X], [_k(1)]))
	await c.identity()
	var pushed := _ring(SUB, 3, [_mine, X, Y])
	var stale_answer := _answer(2, [_mine, X], [_k(2)])
	_identity_reply = func(_req: Dictionary) -> Dictionary:
		c.adopt_ring(pushed)
		return stale_answer.duplicate(true)
	var r := await c.identity(true)
	var held: PKeyConnectState.Record = c.held().detail
	t.check("the answer is judged against what is held now: a lower epoch is stale", \
			not r.ok and String(r.code) == "peer-cert-invalid" and held.epoch == 3 and held.ring == pushed)
	_identity_reply = func(_req: Dictionary) -> Dictionary:
		return _answer(4, [_mine, X, Y], [_k(4)])
	r = await c.identity(true)
	t.check("a newer answer after the push is stored", r.ok and r.detail["epoch"] == 4 and not c.keys_stale())


func _serial(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var c := _client(core)
	_serve(_answer(1, [_mine, X], [_k(1)]))
	var results := []
	var go := func() -> void: results.append(await c.identity())
	go.call()
	go.call()
	while results.size() < 2:
		await (Engine.get_main_loop() as SceneTree).process_frame
	t.check("two calls at once ask once: the second finds the first's record", \
			results[0].ok and results[1].ok and _calls() == ["PUT /devices/keys", "GET /connect/identity"], str(_calls()))


# ── the gate ─────────────────────────────────────────────────────────────────────────────

func _gate(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	_serve(_answer(1, [_mine, X], [_k(1)]))
	var c := _client(core)
	core.discovery_manifest = {"product": PRODUCT, "services": {"connect": {"enabled": false}}}
	var r := await c.identity()
	t.check("Connect off in discovery: connect-unavailable, nothing sent", \
			not r.ok and String(r.code) == "connect-unavailable" and r.detail["reason"] == "product" and _server.requests.is_empty())
	t.check("the same for the device list", String((await c.list_devices()).code) == "connect-unavailable" and _server.requests.is_empty())
	core.discovery_manifest = {"product": PRODUCT, "services": {}}
	t.check("no connect fragment: unavailable", String((await c.identity()).code) == "connect-unavailable")
	core.discovery_manifest = {"product": PRODUCT, "services": {"connect": {"enabled": true, "endpoints": {"identity": null}}}}
	t.check("a null identity endpoint: unavailable", String((await c.identity()).code) == "connect-unavailable" and _server.requests.is_empty())
	core.discovery_manifest = {"product": PRODUCT, "services": {"connect": {"enabled": "yes"}}}
	t.check("enabled must be the boolean true", String((await c.identity()).code) == "connect-unavailable")
	core.discovery_manifest = {"product": PRODUCT, "services": {"connect": {"enabled": true, "endpoints": {"identity": "https://key.plrs.im/djdl/connect/identity"}}}}
	t.check("Connect on in discovery: the call goes ahead", (await c.identity()).ok)
	core.discovery_manifest = null
	var bare := await _core("")
	_server.requests.clear()
	var nt := await _client(bare).identity()
	t.check("no token: no-token, nothing sent", not nt.ok and nt.code == PKeyErrors.NO_TOKEN and _server.requests.is_empty())
	# A memory-only key store.
	var mem := PKeyDeviceKeyStore.memory_only()
	var m := _client(core, mem)
	var refused := await m.identity()
	t.check("memory-only keys: invalid-options, nothing sent", \
			not refused.ok and refused.code == PKeyErrors.INVALID_OPTIONS and _server.requests.is_empty() and mem.public_keys().detail == null)
	m.allow_ephemeral_keys = true
	var pub_m := _public(mem)
	var body := {"ring": _ring(SUB, 1, [pub_m, X]), "certificate": _cert(1, SUB, ME, pub_m), "discKeys": [_k(1)]}
	_serve({"status": 200, "headers": HEADERS, "body": JSON.stringify(body)})
	var allowed := await m.identity()
	t.check("allow_ephemeral_keys lets them through", allowed.ok)
	var none := PKeyConnectClient.new(core, PKeyConnectState.new(PRODUCT, _scratch, true), null)
	t.check("without key ports: not-configured", String((await none.identity()).code) == "not-configured")
	# An unreadable state record is never replaced.
	var broken := PKeyConnectState.for_tests(PRODUCT, _scratch.path_join("broken"))
	DirAccess.make_dir_recursive_absolute(broken.dir)
	var f := FileAccess.open(broken.dir.path_join(PKeyConnectState.FILE), FileAccess.WRITE)
	f.store_string("not a record")
	f.close()
	var bc := PKeyConnectClient.new(core, broken, _keys)
	bc.devices = PKeyDevices.new(core)
	_server.requests.clear()
	var rb := await bc.identity()
	t.check("an unreadable record stops the call and is left alone", \
			not rb.ok and rb.code == PKeyDeviceKeyStore.KEYS_UNREADABLE \
			and FileAccess.get_file_as_string(broken.dir.path_join(PKeyConnectState.FILE)) == "not a record")


# ── list_devices ─────────────────────────────────────────────────────────────────────────

func _devices(t: PKeyTestContext, core: PKeyCore) -> void:
	_reset()
	var c := _client(core)
	var list := [
		{"deviceId": ME, "label": "Desk", "platform": "macos", "lastSeen": NOW, "self": true},
		{"deviceId": X["device_id"], "label": null, "platform": null, "lastSeen": null, "self": false},
		{"deviceId": Y["device_id"], "self": false, "lastSeen": 1.5, "label": 4},
	]
	_devices_reply = {"status": 200, "headers": HEADERS, "body": JSON.stringify({"devices": list})}
	var r := await c.list_devices()
	t.check("the device list: registered first, then asked", r.ok and _calls() == ["PUT /devices/keys", "GET /connect/devices"], str(_calls()))
	var got: Array = r.detail
	t.check("display data only; what is not a string or a whole number is null", \
			got.size() == 3 and got[0] == {"device_id": ME, "label": "Desk", "platform": "macos", "last_seen": NOW, "self": true} \
			and got[1] == {"device_id": X["device_id"], "label": null, "platform": null, "last_seen": null, "self": false} \
			and got[2]["label"] == null and got[2]["last_seen"] == null and got[2]["self"] == false)
	_server.requests.clear()
	_serve(_answer(1, [_mine, X], [_k(1)]))
	await c.identity()
	_server.requests.clear()
	r = await c.list_devices()
	t.check("registered keys are not registered again", r.ok and _calls() == ["GET /connect/devices"])
	var many := []
	for i in 129:
		many.append({"deviceId": "d%d" % i, "self": false})
	var bads := {
		"more than 128": {"devices": many}, "not an object": [], "no devices": {}, "devices not an array": {"devices": 1},
		"an entry that is not an object": {"devices": [1]}, "an entry without a deviceId": {"devices": [{"self": true}]},
		"an entry without self": {"devices": [{"deviceId": "a"}]}, "self not a boolean": {"devices": [{"deviceId": "a", "self": 1}]},
	}
	for name in bads:
		_devices_reply = {"status": 200, "headers": HEADERS, "body": JSON.stringify(bads[name])}
		var f := await c.list_devices()
		t.check("a device list is refused: %s" % name, not f.ok and String(f.code) == "invalid-response")
	_devices_reply = {"status": 403, "headers": HEADERS, "body": '{"error":{"code":"account_required"}}'}
	var refused := await c.list_devices()
	t.check("account_required passes through", not refused.ok and String(refused.code) == "account_required")


# ── PolarisKey.connect ───────────────────────────────────────────────────────────────────

func _facade(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	var before: Variant = sdk.get("connect")
	t.check("PolarisKey.connect is null until configure()", before == null)
	var keys := PKeyDeviceKeyStore.for_tests(PRODUCT, _scratch.path_join("facade"))
	var opts := PKeyTestFixtures.options(_server.base_url(), PKeyMemoryStore.new(ME, TOKEN), _clock, PRODUCT, _trust)
	opts.device_keys = keys
	opts.connect_state = PKeyConnectState.new(PRODUCT, _scratch, true)
	opts.ring_vault = PKeySyncRingVault.new(PRODUCT, _scratch.path_join("facade-vault"), true)
	opts.allow_ephemeral_keys = true
	t.check("configure() builds it", sdk.configure(opts).ok)
	var client: Variant = sdk.get("connect")
	t.check("PolarisKey.connect is the Connect client over the shared keys and devices", \
			client is PKeyConnectClient and client.allow_ephemeral_keys and client.devices == sdk.devices)
	var pub := _public(keys)
	var body := {"ring": _ring(SUB, 1, [pub, X]), "certificate": _cert(1, SUB, ME, pub), "discKeys": [_k(1)]}
	_reset()
	_serve({"status": 200, "headers": HEADERS, "body": JSON.stringify(body)})
	await sdk.start()
	var r: PKeyResult = await client.identity()
	t.check("identity() through the facade", r.ok and r.detail["epoch"] == 1 and _calls().has("GET /connect/identity"), str(_calls()))
	sdk.queue_free()
