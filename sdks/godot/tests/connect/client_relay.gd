extends RefCounted
# @pkey-feature connect.relay connect.identity
# The Connect client side (CC-14.4): the error taxonomy (G20), the state record, the held identity
# (`current`, `discovery_keys`, `peer_source`), the roster a peer pushes (`adopt_ring`, G11, with
# `keys_stale`, G12) and the relay ticket (G13), against rosters and certificates signed here with a
# throwaway product key. The recorded ticket conversations (connect-relay-ticket, connect-relay-quota)
# replay in suite_transcripts once `connect.relay` is claimed.

const PRODUCT := "djdl"
const NOW := 1700000100
const SUB := "ps_AbCdEfGhIjKlMnOpQrStUv"
const OTHER_SUB := "ps_ZyXwVuTsRqPoNmLkJiHgFe"
const ME := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const TOKEN := "pkeyt_UnclYEPDsJKnBWqtUuw8kAHjjIn5ym9GDrR1UHdxVZI"
const TICKET := "pkeyrt_k-onWy0kgu7c5rbwa38ee3j57fNRtVhc"
const KID := "test-product-2026"
# Two other devices of the person: the corpus's own roster entries (valid keys).
const X := {
	"device_id": "J0VOdxiMbiwlR1IacWJby71aZqm9KNqx", "sign_key": "fsLskZbwiyNDAOcvWdzjPaWTBxTRCkoUQnCQhe8eJBQ",
	"agree_key": "Wgw9iFMiWpAYEM9g92J1fq928473Y_Xws075igVAJDA",
}
const Y := {
	"device_id": "Whz-NHBvQacOwY6JwDk-DsBtdaz-WMgX", "sign_key": "5ZLajJkgtNiLNr5xhXSqncSGDOyxNIH5qIZb1ePKxxQ",
	"agree_key": "PoJ7eiXVU43cuNAZVTks5zTHZXiOU75AoiYXAGfKaAQ",
}

# The Node tables (sdk-node connect/session.ts LAN_CODE and connect/relay.ts RELAY_CODE), spelled out.
const NODE_LAN := {
	"no_identity": "not-configured", "no_keys": "not-configured", "not_started": "not-configured",
	"unknown_peer": "invalid-argument", "not_listening": "connect-unavailable", "connect_failed": "network-error",
	"handshake_failed": "peer-cert-invalid", "wrong_peer": "peer-cert-invalid", "closed": "network-error",
	"too_large": "invalid-argument", "bad_type": "invalid-argument",
}
const NODE_RELAY := {
	"disabled": "relay_disabled", "paused": "relay_paused", "quota": "relay_quota_exceeded",
	"ticket_invalid": "relay_ticket_invalid", "rate_limited": "rate_limited", "busy": "rate_limited",
	"unavailable": "network-error", "not_connected": "connect-unavailable", "not_member": "peer-cert-invalid",
	"handshake_failed": "peer-cert-invalid", "wrong_peer": "peer-cert-invalid", "unknown_peer": "invalid-argument",
	"mode_not_allowed": "invalid-argument", "replaced": "cancelled", "stopped": "cancelled",
}

var _seed := PackedByteArray()
var _trust := {}
var _host: Node
var _keys: PKeyDeviceKeyStore
var _mine := {}
var _scratch := ""
var _ring5 := ""
var _cert5 := ""


func run(t: PKeyTestContext) -> void:
	_errors(t)
	_state_record(t)
	_scratch = PKeyTestFixtures.scratch_dir("connect-client")
	_state_store(t)
	_setup()
	var core := await _core("https://key.plrs.im", TOKEN)
	var held := PKeyConnectClient.new(core, PKeyConnectState.new(PRODUCT, "user://pkey", true), _keys)
	_identity(t, core)
	_adopt(t, core)
	_stale(t, core)
	_adopt_refusals(t, core)
	await _ticket(t)
	_host.queue_free()
	PKeyTestFixtures.remove_tree(_scratch)
	t.check("the held client prints no state", str(held) == "PKeyConnectClient")


# ── errors (G20) ─────────────────────────────────────────────────────────────────────────

func _errors(t: PKeyTestContext) -> void:
	var registered := {}
	var codes: Dictionary = (PKeyConstants.ErrorCode as Script).get_script_constant_map()
	for k in codes:
		registered[String(codes[k])] = true
	t.check("LAN_CODE is Node's table, plus permission_denied", \
			_same_table(PKeyConnectErrors.LAN_CODE, NODE_LAN, {"permission_denied": "nearby-permission-denied"}))
	t.check("RELAY_CODE is Node's table", _same_table(PKeyConnectErrors.RELAY_CODE, NODE_RELAY, {}))
	var all_registered := true
	for table in [PKeyConnectErrors.LAN_CODE, PKeyConnectErrors.RELAY_CODE]:
		for reason in table:
			all_registered = all_registered and registered.has(String(table[reason]))
	t.check("every code in both tables is a registered code", all_registered)
	for reason in NODE_LAN:
		var r := PKeyConnectErrors.lan(reason, "m")
		t.check("lan %s -> %s" % [reason, \
			NODE_LAN[reason]], not r.ok and String(r.code) == NODE_LAN[reason] \
			and PKeyConnectErrors.reason_of(r) == reason)
	for reason in NODE_RELAY:
		var r := PKeyConnectErrors.relay(reason, "m")
		t.check("relay %s -> %s" % [reason, \
			NODE_RELAY[reason]], not r.ok and String(r.code) == NODE_RELAY[reason] \
			and PKeyConnectErrors.reason_of(r) == reason)
	t.check("an unknown reason is invalid-argument", \
			String(PKeyConnectErrors.relay("x", "m").code) == "invalid-argument" \
			and String(PKeyConnectErrors.lan("x", "m").code) == "invalid-argument")
	var q := PKeyConnectErrors.relay("quota", "m", {"scope": "person", "status": 429, "retry_after_seconds": 5, "close_code": 4008, "junk": 1})
	t.check("relay detail carries status, retry, scope and close code only", \
			q.detail == {"reason": "quota", "scope": "person", "status": 429, "retry_after_seconds": 5, "close_code": 4008})
	t.check("a scope that is not person or product is dropped", \
			not (PKeyConnectErrors.relay("quota", "m", {"scope": "global"}).detail as Dictionary).has("scope"))
	t.check("reason_of is empty for a success and for a foreign failure", \
			PKeyConnectErrors.reason_of(PKeyResult.success()) == "" \
			and PKeyConnectErrors.reason_of(PKeyResult.failure(&"x")) == "" and PKeyConnectErrors.reason_of(null) == "")


static func _same_table(got: Dictionary, want: Dictionary, extra: Dictionary) -> bool:
	if got.size() != want.size() + extra.size():
		return false
	for k in want:
		if String(got.get(k, "")) != want[k]:
			return false
	for k in extra:
		if String(got.get(k, "")) != extra[k]:
			return false
	return true


# ── the state record (D-7) ───────────────────────────────────────────────────────────────

func _state_record(t: PKeyTestContext) -> void:
	var rec := _record("jws.ring", "jws.cert")
	var back := PKeyConnectState.Record.parse(rec.encode())
	t.check("a record round-trips", \
			back != null and back.encode() == rec.encode() and back.disc_keys == rec.disc_keys \
			and back.prev_until == rec.prev_until and not back.keys_stale)
	rec.keys_stale = true
	rec.prev_until = -1
	rec.registered_sign = ""
	var stale := PKeyConnectState.Record.parse(rec.encode())
	t.check("keys_stale, no previous key and no registration round-trip", \
			stale != null and stale.keys_stale and stale.prev_until == -1 and stale.registered_sign == "")
	t.check("a record prints nothing", str(rec) == "PKeyConnectState.Record(redacted)")
	var good: Dictionary = JSON.parse_string(_record("a", "b").encode().get_string_from_utf8())
	var bad := {
		"empty": "", "not an object": "[]", "other schema": _with(good, "schema", "pkey.connect.v2"),
		"no keys": _with(good, "discKeys", []), "three keys": _with(good, "discKeys", [good["discKeys"][0], good["discKeys"][0], good["discKeys"][0]]),
		"short key": _with(good, "discKeys", ["abc"]), "key not a string": _with(good, "discKeys", [1]),
		"non-canonical key": _with(good, "discKeys", [String(good["discKeys"][0]).left(42) + "B"]),
		"epoch fraction": _with(good, "epoch", 1.5), "epoch negative": _with(good, "epoch", -1),
		"storedAt string": _with(good, "storedAt", "1"), "prevUntil fraction": _with(good, "prevUntil", 1.5),
		"registered half": _with(good, "registered", {"signKey": "a"}), "ring number": _with(good, "ring", 1),
		"product missing": _without(good, "product"),
	}
	for k in bad:
		var bytes: PackedByteArray = bad[k] if bad[k] is PackedByteArray else String(bad[k]).to_utf8_buffer()
		t.check("a record is refused: %s" % k, PKeyConnectState.Record.parse(bytes) == null)
	t.check("a duplicate member is refused", PKeyConnectState.Record.parse(JSON.stringify(good).insert(1, "\"epoch\":1,").to_utf8_buffer()) == null)


static func _with(good: Dictionary, key: String, value: Variant) -> PackedByteArray:
	var d := good.duplicate(true)
	d[key] = value
	return JSON.stringify(d).to_utf8_buffer()


static func _without(good: Dictionary, key: String) -> PackedByteArray:
	var d := good.duplicate(true)
	d.erase(key)
	return JSON.stringify(d).to_utf8_buffer()


func _state_store(t: PKeyTestContext) -> void:
	var mem := PKeyConnectState.new(PRODUCT, _scratch, true)
	t.check("a memory store is memory", mem.persistence() == "memory" and mem.protection() == "memory" and mem.read().detail == null)
	var rec := _record("jws.ring", "jws.cert")
	t.check("a memory store keeps a record", mem.write(rec).ok and (mem.read().detail as PKeyConnectState.Record).encode() == rec.encode())
	t.check("clear forgets it", mem.clear().ok and mem.read().detail == null)
	var file := PKeyConnectState.for_tests(PRODUCT, _scratch)
	t.check("a test store is a durable file", file.persistence() == "durable" and file.protection() == "file" and file.read().detail == null)
	t.check("the file store writes and reads back", \
			file.write(rec).ok \
			and (PKeyConnectState.for_tests(PRODUCT, _scratch).read().detail as PKeyConnectState.Record).encode() == rec.encode())
	t.check("the file is named connect.v1 under the product", FileAccess.file_exists(_scratch.path_join(PRODUCT).path_join("connect.v1")))
	var path := _scratch.path_join(PRODUCT).path_join("connect.v1")
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string("not a record")
	f.close()
	var broken := PKeyConnectState.for_tests(PRODUCT, _scratch).read()
	t.check("an unusable record is device-keys-unreadable, not replaced", \
			not broken.ok and broken.code == PKeyDeviceKeyStore.KEYS_UNREADABLE \
			and FileAccess.get_file_as_string(path) == "not a record")
	t.check("clear removes an unusable record", file.clear().ok and not FileAccess.file_exists(path))
	var sealer := PKeyFakeSealer.new("keystore")
	var sealed := PKeyConnectState.new(PRODUCT, _scratch, false, sealer)
	t.check("a sealer seals", sealed.persistence() == "durable" and sealed.protection() == "keystore-sealed")
	t.check("a sealed record writes and reads back", \
			sealed.write(rec).ok and (sealed.read().detail as PKeyConnectState.Record).encode() == rec.encode())
	var raw := FileAccess.get_file_as_bytes(path)
	t.check("the file is PKSL, version 1, never the clear record", \
			raw.slice(0, 4).get_string_from_ascii() == "PKSL" and raw[4] == 1 \
			and raw.get_string_from_utf8().find("discKeys") == -1)
	t.check("the sealer saw the connect context", sealer.calls.size() >= 2)
	sealer.fault_open = true
	t.check("a sealer that cannot open fails, not as none", not sealed.read().ok)
	sealer.fault_open = false
	t.check("sealed clear leaves the platform key", sealed.clear().ok and not FileAccess.file_exists(path) and not sealer.calls.has("destroy"))
	var plain_dir := PKeyConnectState.new(PRODUCT, "user://not-a-private-root", false, null)
	t.check("a root that is not private is memory", plain_dir.persistence() == "memory" or plain_dir.sealer == null)


# ── signed documents ─────────────────────────────────────────────────────────────────────

func _setup() -> void:
	_seed = PackedByteArray()
	for i in 32:
		_seed.append(i + 1)
	_trust = {KID: PKeyB64Url.encode(PKeyTestSigner.public_key(_seed))}
	_keys = PKeyDeviceKeyStore.for_tests(PRODUCT, _scratch.path_join("keys"))
	var pub: Dictionary = _keys.ensure().detail
	_mine = {"device_id": ME, "sign_key": pub["sign_key"], "agree_key": pub["agree_key"]}


func _core(base: String, token: String) -> PKeyCore:
	if _host == null:
		_host = Node.new()
		(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	var clock := [NOW]
	var opts := PKeyTestFixtures.options(base, PKeyMemoryStore.new(ME, token), clock, PRODUCT, _trust)
	var made := PKeyCore.create(opts, _host, "0.0.0")
	var core: PKeyCore = made.detail
	await core.start()
	return core


static func _dev(d: Dictionary) -> String:
	return '{"deviceId":"%s","signKey":"%s","agreeKey":"%s"}' % [d["device_id"], d["sign_key"], d["agree_key"]]


func _ring(sub: String, epoch: int, devices: Array, iat := NOW - 100, exp := NOW + 600000) -> String:
	var list := ",".join(devices.map(_dev))
	var body := '{"iss":"key.plrs.im","aud":"%s","sub":"%s","epoch":%d,"issuedAt":%d,"expiresAt":%d,"devices":[%s]}' % [PRODUCT, sub, epoch, iat, exp, list]
	return PKeyTestSigner.sign_jws(body, _seed, KID, "pkey-ring+jws")


func _cert(epoch: int) -> String:
	var body := '{"iss":"key.plrs.im","aud":"%s","sub":"%s","deviceId":"%s","signKey":"%s",' % [PRODUCT, SUB, ME, _mine["sign_key"]]
	body += '"agreeKey":"%s","ringEpoch":%d,"issuedAt":%d,"expiresAt":%d}' % [_mine["agree_key"], epoch, NOW - 100, NOW + 400000]
	return PKeyTestSigner.sign_jws(body, _seed, KID, "pkey-peer+jws")


func _record(ring: String, cert: String) -> PKeyConnectState.Record:
	var r := PKeyConnectState.Record.new()
	r.product = PRODUCT
	r.device_id = ME
	r.ring = ring
	r.certificate = cert
	r.disc_keys = [PKeyB64Url.encode(_filled(1)), PKeyB64Url.encode(_filled(2))] as Array[String]
	r.prev_until = NOW + 5000
	r.epoch = 5
	r.registered_sign = _mine.get("sign_key", "signsignsignsignsignsignsignsignsignsignsign")
	r.registered_agree = _mine.get("agree_key", "agreeagreeagreeagreeagreeagreeagreeagreeagre")
	r.stored_at = NOW - 10
	return r


static func _filled(v: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(32)
	b.fill(v)
	return b


# ── the held identity ────────────────────────────────────────────────────────────────────

func _identity(t: PKeyTestContext, core: PKeyCore) -> void:
	var state := PKeyConnectState.new(PRODUCT, _scratch, true)
	var c := PKeyConnectClient.new(core, state, _keys)
	t.check("nothing held: current is null, keys are not stale, no discovery keys", \
			c.current() == null and not c.keys_stale() and c.discovery_keys() == null and c.held().detail == null)
	var none := c.peer_source()
	t.check("nothing held: peer_source is no_identity", \
			not none.ok and PKeyConnectErrors.reason_of(none) == "no_identity" and String(none.code) == "not-configured")
	_ring5 = _ring(SUB, 5, [_mine, X, Y])
	_cert5 = _cert(5)
	t.check("hold stores a record", c.hold(_record(_ring5, _cert5)).ok)
	var id: Variant = c.current()
	t.check("current verifies the held documents", \
			id != null and id["sub"] == SUB and id["epoch"] == 5 and id["device_id"] == ME \
			and (id["devices"] as Array).size() == 3 and id["certificate"] == _cert5 and id["ring"] == _ring5)
	var keys: Variant = c.discovery_keys()
	t.check("discovery keys: current, and a previous key inside its 24 hours", \
			keys != null and keys["current"] == _filled(1) and keys["previous"] == _filled(2))
	var src := c.peer_source()
	t.check("peer_source holds the snapshot", \
			src.ok and src.detail.slug == PRODUCT and src.detail.sub == SUB and src.detail.device_id == ME \
			and src.detail.ring_epoch == 5 and Array(src.detail.roster) == [ME, X["device_id"], Y["device_id"]])
	t.check("peer_source: K_disc newest first, the agreement key public", \
			src.detail.disc_current == _filled(1) and src.detail.disc_previous == _filled(2) \
			and src.detail.agree_public == PKeyB64Url.decode_strict(_mine["agree_key"]) and src.detail.trust == _trust)
	var peer_priv := _filled(9)
	var peer_pub := PKeyCurve25519.x25519_public(peer_priv)
	var shared: Variant = src.detail.dh(peer_pub).detail
	t.check("dh runs in the key port, with the same result as the key store", \
			shared is PackedByteArray and (shared as PackedByteArray).size() == 32 \
			and shared == _keys.dh(peer_pub).detail)
	t.check("a snapshot prints nothing", str(src.detail) == "PeerSource(redacted)")
	t.check("the client holds K_disc nowhere it prints", str(c).find("pkey") == -1)
	# The previous key lapses 24 hours after it was first seen.
	var lapsed := _record(_ring5, _cert5)
	lapsed.prev_until = NOW - 1
	c.hold(lapsed)
	keys = c.discovery_keys()
	t.check("a lapsed previous key is left out", keys != null and keys["current"] == _filled(1) and keys["previous"] == null)
	var one := _record(_ring5, _cert5)
	one.disc_keys = [one.disc_keys[0]] as Array[String]
	one.prev_until = -1
	c.hold(one)
	t.check("a single key has no previous", c.discovery_keys()["previous"] == null)
	var nokeys := PKeyConnectClient.new(core, state, null)
	var r := nokeys.peer_source()
	t.check("without the device keys: no_keys", not r.ok and PKeyConnectErrors.reason_of(r) == "no_keys")
	var other := _record(_ring5, _cert5)
	other.device_id = "someone-else"
	c.hold(other)
	t.check("a record of another device is not held", c.current() == null and c.held().detail == null and c.discovery_keys() == null)
	var tampered := _record(_ring5.left(_ring5.length() - 4) + "AAAA", _cert5)
	c.hold(tampered)
	t.check("a roster that no longer verifies is not an identity", c.current() == null)
	t.check("leave forgets the record", c.hold(_record(_ring5, _cert5)).ok and c.leave().ok and c.held().detail == null)
	t.check("leave with nothing held is fine", c.leave().ok)
	var expired := _record(_ring(SUB, 5, [_mine, X], NOW - 1000000, NOW - 500000), _cert5)
	c.hold(expired)
	t.check("an expired roster is not an identity", c.current() == null)
	c.leave()


# ── adopt_ring (G11) ─────────────────────────────────────────────────────────────────────

func _fresh(core: PKeyCore) -> PKeyConnectClient:
	var c := PKeyConnectClient.new(core, PKeyConnectState.new(PRODUCT, _scratch, true), _keys)
	c.hold(_record(_ring5, _cert5))
	return c


func _adopt(t: PKeyTestContext, core: PKeyCore) -> void:
	var c := _fresh(core)
	var ring6 := _ring(SUB, 6, [_mine, X, Y])
	var r := c.adopt_ring(ring6)
	t.check("a newer roster that keeps every device is stored", r == {"stored": true, "epoch": 6})
	var held: PKeyConnectState.Record = c.held().detail
	t.check("the roster and epoch move, the certificate stays", held.ring == ring6 and held.epoch == 6 and held.certificate == _cert5)
	t.check("nothing was lost: keys not stale, previous key kept", \
			not c.keys_stale() and held.disc_keys.size() == 2 and held.prev_until == NOW + 5000 \
			and held.registered_sign == _mine["sign_key"])
	t.check("the same epoch again is refused", c.adopt_ring(ring6) == {"stored": false, "reason": "epoch-not-higher"})
	var fourth := {
		"device_id": "zzzz-new-device-zzzzzzzzzzzzzzzz", "sign_key": "-S65VC6LofSRZPPd49z4A1AonRxNIbKaouOy892h8yg",
		"agree_key": "-tQZbA2pdKTgcJY0AEcXGA-Q5N35wnLxzx1ZwqTvRyA",
	}
	var grown := _ring(SUB, 7, [_mine, X, Y, fourth])
	t.check("a roster that gains a device is stored and not stale", \
			c.adopt_ring(grown).get("stored") == true and not c.keys_stale() \
			and (c.held().detail as PKeyConnectState.Record).disc_keys.size() == 2)


func _stale(t: PKeyTestContext, core: PKeyCore) -> void:
	var c := _fresh(core)
	var dropped := _ring(SUB, 6, [_mine, X])
	t.check("a roster that drops a device is stored", c.adopt_ring(dropped) == {"stored": true, "epoch": 6})
	var held: PKeyConnectState.Record = c.held().detail
	t.check("it sets keys_stale and drops the previous key", \
			c.keys_stale() and held.keys_stale and held.disc_keys.size() == 1 \
			and held.disc_keys[0] == PKeyB64Url.encode(_filled(1)) and held.prev_until == -1)
	t.check("a stale K_disc is not handed out", c.discovery_keys() == null)
	var r := c.peer_source()
	t.check("a stale K_disc makes peer_source no_keys", not r.ok and PKeyConnectErrors.reason_of(r) == "no_keys")
	t.check("a stale record still shows the identity", c.current() != null and c.current()["epoch"] == 6)
	t.check("a further roster keeps the flag", c.adopt_ring(_ring(SUB, 7, [_mine, X])).get("stored") == true and c.keys_stale())
	# A successful identity fetch writes a record without the flag; K_disc is usable again.
	var fetched := _record(_ring(SUB, 8, [_mine, X]), _cert(8))
	fetched.disc_keys = [PKeyB64Url.encode(_filled(3))] as Array[String]
	fetched.prev_until = -1
	t.check("a refresh clears keys_stale", c.hold(fetched).ok and not c.keys_stale() and c.discovery_keys()["current"] == _filled(3))
	var ps := c.peer_source()
	t.check("and peer_source is whole again", ps.ok and ps.detail.ring_epoch == 8)
	var changed := _ring(SUB, 9, [_mine, {"device_id": X["device_id"], "sign_key": Y["sign_key"], "agree_key": X["agree_key"]}])
	var c2 := _fresh(core)
	t.check("a device whose keys changed counts as dropped", c2.adopt_ring(changed).get("stored") == true and c2.keys_stale())


func _adopt_refusals(t: PKeyTestContext, core: PKeyCore) -> void:
	var c := _fresh(core)
	t.check("a roster of another subject is refused", \
			c.adopt_ring(_ring(OTHER_SUB, 6, [_mine, X])) == {"stored": false, "reason": "other-product-or-subject"})
	t.check("a lower epoch is refused", c.adopt_ring(_ring(SUB, 4, [_mine, X])) == {"stored": false, "reason": "epoch-not-higher"})
	t.check("an expired roster is refused", \
			c.adopt_ring(_ring(SUB, 6, [_mine, X], NOW - 1000000, NOW - 500000)) == {"stored": false, "reason": "new-expired"})
	t.check("a roster that does not verify is refused", \
			c.adopt_ring(_ring(SUB, 6, [_mine, X]).left(40) + "AAAA") == {"stored": false, "reason": "new-rejected"})
	t.check("garbage is refused", c.adopt_ring("not a jws") == {"stored": false, "reason": "new-rejected"})
	t.check("a roster without this device is refused", c.adopt_ring(_ring(SUB, 6, [X, Y])) == {"stored": false, "reason": "device_not_in_roster"})
	var me_other_keys := {"device_id": ME, "sign_key": X["sign_key"], "agree_key": X["agree_key"]}
	t.check("a roster with this device under other keys is refused",
			c.adopt_ring(_ring(SUB, 6, [me_other_keys, Y])) == {"stored": false, "reason": "device_not_in_roster"})
	var held: PKeyConnectState.Record = c.held().detail
	t.check("a refusal changes nothing", held.ring == _ring5 and held.epoch == 5 and not held.keys_stale)
	var unregistered := _record(_ring5, _cert5)
	unregistered.registered_sign = ""
	unregistered.registered_agree = ""
	c.hold(unregistered)
	t.check("a record that never registered keys refuses", \
			c.adopt_ring(_ring(SUB, 6, [_mine, X])) == {"stored": false, "reason": "device_not_in_roster"})
	c.leave()
	t.check("nothing held: no_identity", c.adopt_ring(_ring(SUB, 6, [_mine, X])) == {"stored": false, "reason": "no_identity"})
	var unverified := _record("garbage.ring", "garbage.cert")
	c.hold(unverified)
	t.check("a held record that verifies nowhere: held_unverified", \
			c.adopt_ring(_ring(SUB, 6, [_mine, X])) == {"stored": false, "reason": "held_unverified"})
	var lonely := _record("garbage.ring", _cert5)
	c.hold(lonely)
	t.check("a certificate alone still names the subject", c.adopt_ring(_ring(SUB, 6, [_mine, X])).get("stored") == true)


# ── the relay ticket (G13) ───────────────────────────────────────────────────────────────

func _ticket(t: PKeyTestContext) -> void:
	# A lambda captures its variables by value: the reply is edited in place.
	var reply := {"status": 200, "headers": {"content-type": "application/json"}, "body": ""}
	var server := PKeyTestFixtures.new_server(func(req: Dictionary) -> Dictionary:
		return reply.duplicate(true) if req["path"].ends_with("/connect/relay/ticket") else {"status": 599})
	var core := await _core(server.base_url(), TOKEN)
	var c := PKeyConnectClient.new(core, PKeyConnectState.new(PRODUCT, _scratch, true), _keys)
	c.home_url = "https://key.plrs.im"
	var ok_body := {"ticket": TICKET, "url": "wss://key.plrs.im/djdl/connect/relay", "protocol": "pkey-relay.1", "expiresAt": NOW + 60}
	reply["body"] = JSON.stringify(ok_body)
	var r := await c.relay_ticket()
	var req: Dictionary = server.requests[0]
	t.check("a ticket: POST with the bearer and no body", \
			r.ok and req["method"] == "POST" and req["path"] == "/djdl/connect/relay/ticket" \
			and req["headers"].get("authorization") == "Bearer " + TOKEN and req["body"].is_empty())
	var grant: PKeyConnectClient.Grant = r.detail
	t.check("the grant: url, protocol, expiry, and the ticket by its accessor", \
			grant.url == ok_body["url"] and grant.protocol == "pkey-relay.1" and grant.expires_at == NOW + 60 \
			and grant.ticket() == TICKET)
	t.check("the ticket is in no string form", \
			str(grant).find("pkeyrt_") == -1 and str(r).find("pkeyrt_") == -1 and str(c).find("pkeyrt_") == -1 \
			and JSON.stringify(server.requests.map(func(q): return q["headers"])).find(TICKET) == -1)
	var again := await c.relay_ticket()
	t.check("every call asks for a new ticket", again.ok and server.requests.size() == 2)
	# The refusals, in the Worker's own words.
	var refusals := [
		[403, {"error": {"code": "relay_disabled"}}, {}, "disabled", "relay_disabled", {}],
		[503, {"error": {"code": "relay_paused"}}, {"retry-after": "300"}, "paused", "relay_paused", {"retry_after_seconds": 300}],
		[503, {"error": {"code": "relay_paused"}}, {"retry-after": "99999"}, "paused", "relay_paused", {"retry_after_seconds": 3600}],
		[503, {"error": {"code": "relay_paused"}}, {"retry-after": "Wed, 21 Oct"}, "paused", "relay_paused", {}],
		[429, {"error": {"code": "relay_quota_exceeded"}, "scope": "product"}, {}, "quota", "relay_quota_exceeded", {"scope": "product"}],
		[429, {"error": {"code": "relay_quota_exceeded"}, "scope": "person"}, {}, "quota", "relay_quota_exceeded", {"scope": "person"}],
		[429, {"error": {"code": "relay_quota_exceeded"}, "scope": "galaxy"}, {}, "quota", "relay_quota_exceeded", {}],
		[403, {"error": {"code": "relay_ticket_invalid"}}, {}, "ticket_invalid", "relay_ticket_invalid", {}],
	]
	for row in refusals:
		_reply(reply, {"status": row[0], "headers": {"content-type": "application/json"}.merged(row[2]), "body": JSON.stringify(row[1])})
		var f := await c.relay_ticket()
		var d: Dictionary = f.detail if f.detail is Dictionary else {}
		var ok: bool = not f.ok and String(f.code) == row[4] and PKeyConnectErrors.reason_of(f) == row[3] and d.get("status") == row[0]
		for k in row[5]:
			ok = ok and d.get(k) == row[5][k]
		ok = ok and d.has("retry_after_seconds") == row[5].has("retry_after_seconds") and d.has("scope") == row[5].has("scope")
		t.check("refusal %s %s" % [row[0], row[3]], ok)
	_reply(reply, {"status": 401, "headers": {"content-type": "application/json"}, "body": '{"error":{"code":"unauthorized"}}'})
	var unauth := await c.relay_ticket()
	t.check("another refusal keeps the Worker's code", not unauth.ok and String(unauth.code) == "unauthorized" and unauth.detail["status"] == 401)
	_reply(reply, {"status": 404, "headers": {"content-type": "application/json"}, "body": '{"error":"not_found"}'})
	var gone := await c.relay_ticket()
	t.check("the launch gate off: not_found", not gone.ok and String(gone.code) == "not_found")
	# An answer that is not the contract's, or does not name this Worker.
	var bad_bodies := {
		"ticket too short": _with_d(ok_body, "ticket", "pkeyrt_short"), "ticket wrong prefix": _with_d(ok_body, "ticket", "pkeyx_k-onWy0kgu7c5rbwa38ee3j57fNRtVhc"),
		"ticket with a newline": _with_d(ok_body, "ticket", TICKET + "\n"), "ticket not a string": _with_d(ok_body, "ticket", 1),
		"another protocol": _with_d(ok_body, "protocol", "pkey-relay.2"), "no protocol": _without_d(ok_body, "protocol"),
		"ws, not wss": _with_d(ok_body, "url", "ws://key.plrs.im/djdl/connect/relay"), "https url": _with_d(ok_body, "url", "https://key.plrs.im/djdl/connect/relay"),
		"another host": _with_d(ok_body, "url", "wss://evil.example/djdl/connect/relay"), "userinfo": _with_d(ok_body, "url", "wss://evil.example@key.plrs.im/x"),
		"suffix host": _with_d(ok_body, "url", "wss://key.plrs.im.evil.example/x"), "another port": _with_d(ok_body, "url", "wss://key.plrs.im:8443/x"),
		"url not a string": _with_d(ok_body, "url", 7), "no url": _without_d(ok_body, "url"),
		"expiresAt fraction": _with_d(ok_body, "expiresAt", 1.5), "expiresAt string": _with_d(ok_body, "expiresAt", "9"),
		"expiresAt negative": _with_d(ok_body, "expiresAt", -1), "expiresAt too big": '{"ticket":"%s","url":"wss://key.plrs.im/x","protocol":"pkey-relay.1","expiresAt":9007199254740992}' % TICKET,
		"not an object": "[]", "not json": "pong",
	}
	for k in bad_bodies:
		_reply(reply, {"status": 200, "headers": {"content-type": "application/json"}, "body": bad_bodies[k]})
		var f := await c.relay_ticket()
		t.check("an answer is refused: %s" % k, \
			not f.ok and PKeyConnectErrors.reason_of(f) == "ticket_invalid" and String(f.code) == "relay_ticket_invalid" \
			and f.message.find("pkeyrt_") == -1)
	_reply(reply, {"status": 200, "headers": {"content-type": "application/json"}, "body": JSON.stringify(ok_body).replace("wss://key.plrs.im", "wss://KEY.plrs.im:443")})
	t.check("host case and the default port are the same origin", (await c.relay_ticket()).ok)
	# Without an override the URL must name the SDK's own origin.
	var c2 := PKeyConnectClient.new(core, PKeyConnectState.new(PRODUCT, _scratch, true), _keys)
	_reply(reply, {"status": 200, "headers": {"content-type": "application/json"}, "body": JSON.stringify(ok_body)})
	t.check("a recorded host is refused by a client at the loopback origin", not (await c2.relay_ticket()).ok)
	var own := _with_d(ok_body, "url", "wss://127.0.0.1:%d/djdl/connect/relay" % server.port)
	_reply(reply, {"status": 200, "headers": {"content-type": "application/json"}, "body": own})
	t.check("the SDK's own origin is accepted", (await c2.relay_ticket()).ok)
	server.queue_free()
	# No bearer held: nothing is sent.
	var bare := await _core("https://key.plrs.im", "")
	var c3 := PKeyConnectClient.new(bare, PKeyConnectState.new(PRODUCT, _scratch, true), _keys)
	var nt := await c3.relay_ticket()
	t.check("no token: no-token, nothing sent", not nt.ok and nt.code == PKeyErrors.NO_TOKEN)


static func _reply(reply: Dictionary, next: Dictionary) -> void:
	reply.clear()
	reply.merge(next)


static func _with_d(good: Dictionary, key: String, value: Variant) -> String:
	var d := good.duplicate(true)
	d[key] = value
	return JSON.stringify(d)


static func _without_d(good: Dictionary, key: String) -> String:
	var d := good.duplicate(true)
	d.erase(key)
	return JSON.stringify(d)
