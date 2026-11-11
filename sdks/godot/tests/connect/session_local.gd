extends RefCounted
# @pkey-feature connect.local
# `PKeyPeerSession` in modes q and l (CC-29b.G2b; WIRE-CONTRACT-V5 section 15.12), ported from client-core's
# `peerLocalPairing.test.ts`: CPace to a mode-q pairing in memory with the consent and LOCAL_LINK exchange, then mode l
# under the link it made; the pin, a wrong code, a decline, a peer without `local/1`, the clocks, the wipe, the shared
# listener's trial order and the limiter with a source group, and the option checks. No wall clock: the sessions and
# the limiter read a clock the test moves.

const SLUG := PKeyTestPeers.SLUG


## An AEAD port that counts the opens (each key tried is one).
class CountingCrypto extends PKeyPeerCrypto:
	var opens := 0


	func aes_gcm_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
		opens += 1
		return super.aes_gcm_open(key, nonce, aad, sealed)


## The limiter's clock.
class Clock extends RefCounted:
	var t := 0.0


	func now() -> float:
		return t


func run(t: PKeyTestContext) -> void:
	await _pairing(t)
	await _wrong_code_and_permit(t)
	await _decline_and_limits(t)
	await _without_local_cap(t)
	await _clocks(t)
	await _mode_l(t)
	await _shared_listener(t)
	await _groups(t)
	_options(t)


# -- helpers --------------------------------------------------------------------------------------

static func _pub(priv: PackedByteArray) -> PackedByteArray:
	return PKeyPeerCrypto.for_platform().x25519_public(priv)


## CPace between a joiner and a shower: the PSK and ISK each holds.
static func _cpace(joiner_code: String, shower_code: String) -> Dictionary:
	var sid := PKeyTestPeers.random32().slice(0, 10)
	var ci := PKeyPeerNoise.prologue(SLUG, "q")
	var gj := PKeyPeerCpace.generator(PKeyPeerCpace.prs_code(joiner_code), ci, sid)
	var gs := PKeyPeerCpace.generator(PKeyPeerCpace.prs_code(shower_code), ci, sid)
	var ya := PKeyPeerCpace.scalar()
	var yb := PKeyPeerCpace.scalar()
	var share_a: PackedByteArray = PKeyPeerCpace.share(ya, gj)
	var share_b: PackedByteArray = PKeyPeerCpace.share(yb, gs)
	var isk_j: PackedByteArray = PKeyPeerCpace.isk(sid, ya, share_a, share_b, "initiator")
	var isk_s: PackedByteArray = PKeyPeerCpace.isk(sid, yb, share_a, share_b, "responder")
	return {
		"joiner": {"psk": PKeyPeerCpace.psk(isk_j, SLUG), "isk": isk_j},
		"shower": {"psk": PKeyPeerCpace.psk(isk_s, SLUG), "isk": isk_s},
	}


## A mode-q pair: {joiner, shower, jkey, skey, asked (an Array that counts the shower's permits)}.
static func _pair_sides(o := {}) -> Dictionary:
	var c := _cpace(o.get("joiner_code", "123456"), o.get("shower_code", "123456"))
	var jkey := PKeyTestPeers.random32()
	var skey := PKeyTestPeers.random32()
	var asked: Array[int] = [0]
	var permit_ok: bool = o.get("permit", true)
	var permit := func() -> bool:
		asked[0] += 1
		return permit_ok
	var jp: Dictionary = (c["joiner"] as Dictionary).duplicate()
	jp.merge({"held": 0, "elapsed": 0.0, "cats": o.get("joiner_cats", ["docs"]), "label": "Anna"})
	var sp: Dictionary = (c["shower"] as Dictionary).duplicate()
	sp.merge({"held": o.get("shower_held", 0), "elapsed": o.get("shower_elapsed", 0.0), "permit": permit, "cats": o.get("shower_cats", ["docs", "music"]), "label": "Bo"})
	var extra := {}
	if o.has("crypto"):
		extra["crypto"] = o["crypto"]
	return {
		"joiner": PKeyTestPeers.side("q", "initiator", jkey, {"pair": jp}),
		"shower": PKeyTestPeers.side("q", "responder", skey, extra.merged({"pair": sp})),
		"jkey": jkey, "skey": skey, "asked": asked,
	}


## Both handshakes, both persons' answers, then the exchange; the shower's person may decline.
static func _settle(p: Dictionary, decline := false) -> void:
	var j: PKeyTestPeers.Peer = p["joiner"]
	var s: PKeyTestPeers.Peer = p["shower"]
	await j.session.start()
	await PKeyTestPeers.pump(j, s)
	j.session.confirm_pairing()
	if decline:
		s.session.decline_pairing()
	else:
		s.session.confirm_pairing()
	await PKeyTestPeers.pump(j, s)


static func _closed(x: PKeyTestPeers.Peer) -> Array:
	var c := x.closes()
	return c[0] if not c.is_empty() else []


# -- mode q ---------------------------------------------------------------------------------------

func _pairing(t: PKeyTestContext) -> void:
	var p := _pair_sides()
	var j: PKeyTestPeers.Peer = p["joiner"]
	var s: PKeyTestPeers.Peer = p["shower"]
	t.check("q: both sessions are made", j.session != null and s.session != null)
	if j.session == null or s.session == null:
		return
	await _settle(p)
	t.check("q: the shower counted one guess that opened", s.of(&"guess").size() == 1 and s.of(&"guess")[0]["opens"] == true and p["asked"][0] == 1)
	var ej := j.of(&"established")
	var es := s.of(&"established")
	t.check("q: both established with local/1 and an unauthenticated HELLO", ej.size() == 1 and es.size() == 1 and ej[0]["hello_authenticated"] == false \
			and (ej[0]["caps"] as Array).has("local/1") and (es[0]["caps"] as Array).has("local/1") and ej[0]["local_index"] == -1)
	var lj := j.of(&"local_link")
	var ls := s.of(&"local_link")
	t.check("q: each side stores exactly one link", lj.size() == 1 and ls.size() == 1)
	if lj.size() != 1 or ls.size() != 1:
		return
	t.check("q: one 32-byte link secret on both sides", (lj[0]["secret"] as PackedByteArray).size() == 32 and lj[0]["secret"] == ls[0]["secret"])
	var jpub := _pub(p["jkey"])
	var spub := _pub(p["skey"])
	t.check("q: the link keys are each side's own and the peer's", lj[0]["own_key"] == jpub and lj[0]["peer_key"] == spub and ls[0]["own_key"] == spub and ls[0]["peer_key"] == jpub)
	t.check("q: label and the categories both listed", lj[0]["label"] == "Bo" and ls[0]["label"] == "Anna" and lj[0]["cats"] == ["docs"] and ls[0]["cats"] == ["docs"])
	t.check("q: each side closed peer_bye after it stored the link", _closed(j) == [&"peer_bye", true] or _closed(j) == [&"peer_bye", false])
	t.check("q: the shower closed peer_bye", _closed(s)[0] == &"peer_bye")
	t.check("q: the session never prints the secret", not str(j.session).contains((lj[0]["secret"] as PackedByteArray).hex_encode()))
	t.check("q: the CPace outputs are wiped when the session ends", _all_zero(j.session._pairing.psk) and _all_zero(j.session._pairing.isk) and _all_zero(s.session._pairing.isk))
	var q := _pair_sides()
	await _settle(q)
	t.check("q: every pairing makes a new link", q["joiner"].of(&"local_link")[0]["secret"] != lj[0]["secret"])
	var fresh := _pair_sides()
	var r: PKeyResult = (fresh["joiner"] as PKeyTestPeers.Peer).session.send_record(0x0100, "{}".to_utf8_buffer())
	t.check("q: the host cannot send a record", not r.ok)


static func _all_zero(b: PackedByteArray) -> bool:
	for x in b:
		if x != 0:
			return false
	return true


func _wrong_code_and_permit(t: PKeyTestContext) -> void:
	var crypto := CountingCrypto.new()
	var p := _pair_sides({"joiner_code": "123457", "shower_code": "123456", "crypto": crypto})
	var j: PKeyTestPeers.Peer = p["joiner"]
	var s: PKeyTestPeers.Peer = p["shower"]
	await j.session.start()
	await PKeyTestPeers.pump(j, s)
	t.check("q wrong code: one failed guess", s.of(&"guess").size() == 1 and s.of(&"guess")[0]["opens"] == false and p["asked"][0] == 1)
	t.check("q wrong code: the shower closes silently with no record stored", _closed(s) == [&"handshake_failed", false] and s.out.is_empty() \
			and s.of(&"established").is_empty() and s.of(&"local_link").is_empty() and j.of(&"local_link").is_empty())
	t.check("q wrong code: one tag was tried", crypto.opens == 1)
	for o in [{"permit": false}, {"shower_elapsed": 30.0}]:
		var denied := _pair_sides(o)
		var dj: PKeyTestPeers.Peer = denied["joiner"]
		var ds: PKeyTestPeers.Peer = denied["shower"]
		await dj.session.start()
		await PKeyTestPeers.pump(dj, ds)
		t.check("q: no tag is tried without a permit or past 30 s (%s)" % str(o.keys()[0]), ds.of(&"guess").is_empty() and _closed(ds)[0] == &"handshake_failed" \
				and denied["asked"][0] == (1 if o.has("permit") else 0))
	var spent := _pair_sides({})
	(spent["joiner"] as PKeyTestPeers.Peer).session._pairing.elapsed = 30.0
	await (spent["joiner"] as PKeyTestPeers.Peer).session.start()
	t.check("q: a joiner past 30 s starts no handshake", (spent["joiner"] as PKeyTestPeers.Peer).out.is_empty() and _closed(spent["joiner"])[0] == &"handshake_failed")


func _decline_and_limits(t: PKeyTestContext) -> void:
	var p := _pair_sides()
	await _settle(p, true)
	var j: PKeyTestPeers.Peer = p["joiner"]
	var s: PKeyTestPeers.Peer = p["shower"]
	t.check("q decline: both close peer_bye and store nothing", _closed(s) == [&"peer_bye", false] and _closed(j) == [&"peer_bye", true] \
			and j.of(&"local_link").is_empty() and s.of(&"local_link").is_empty())
	var full := _pair_sides({"shower_held": PKeyPeerLocal.MAX_LOCAL_LINKS})
	await _settle(full)
	t.check("q: a side holding the most links refuses a valid LOCAL_LINK", (full["shower"] as PKeyTestPeers.Peer).of(&"local_link").is_empty() \
			and _closed(full["shower"])[0] == &"peer_not_allowed")
	var early := _pair_sides()
	(early["joiner"] as PKeyTestPeers.Peer).session.confirm_pairing()
	t.check("q: a confirmation before the transport closes peer_not_allowed", _closed(early["joiner"])[0] == &"peer_not_allowed")


## A responder that offers no `local/1`: raw Noise under the shower's PSK, then HELLO.
func _without_local_cap(t: PKeyTestContext) -> void:
	var c := _cpace("123456", "123456")
	var permit := func() -> bool: return true
	var shower := PKeyTestPeers.side("q", "responder", PKeyTestPeers.random32(), {"pair": {
		"psk": c["shower"]["psk"], "isk": c["shower"]["isk"], "held": 0, "elapsed": 0.0, "permit": permit, "cats": [], "label": "Bo"}})
	var raw: PKeyPeerNoise.Handshake = PKeyPeerNoise.start("initiator", PKeyPeerNoise.protocol_name("q"), PKeyPeerNoise.prologue(SLUG, "q"),  \
			PKeyTestPeers.random32(), c["joiner"]["psk"]).detail
	await shower.session.receive(raw.write_message('{"v":1}'.to_utf8_buffer()).detail)
	raw.read_message(shower.out.pop_front())
	await shower.session.receive(raw.write_message('{"v":1,"caps":[]}'.to_utf8_buffer()).detail)
	var tp: PKeyPeerNoise.Transport = raw.transport().detail
	var hello := PKeyPeerRecord.encode(PKeyPeerRecord.HELLO, 0, '{"platform":"test","app":"demo","maxMessage":1048576}'.to_utf8_buffer())
	await shower.session.receive(tp.send.encrypt(PackedByteArray(), hello).detail)
	t.check("q no local/1: closed before any consent", shower.of(&"established").is_empty() and _closed(shower)[0] == &"peer_not_allowed")
	var types: Array[int] = []
	for m in shower.out:
		types.append(PKeyPeerRecord.parse(tp.receive.decrypt(PackedByteArray(), m).detail)["type"])
	t.check("q no local/1: the CLOSE record follows the session's HELLO", types == [PKeyPeerRecord.HELLO, PKeyPeerRecord.CLOSE])


func _clocks(t: PKeyTestContext) -> void:
	# 120 s from the first byte to both CONFIRMs, counted from C1 and C2 as well (29 s spent: 91 s left).
	var p := _pair_sides({"shower_elapsed": 29.0})
	var j: PKeyTestPeers.Peer = p["joiner"]
	var s: PKeyTestPeers.Peer = p["shower"]
	await j.session.start()
	await PKeyTestPeers.pump(j, s)
	s.mono_value = 90.0
	s.session.tick()
	t.check("q clock: 90 s into a 91 s allowance nothing happens", not s.session.is_closed())
	s.mono_value = 91.0
	s.session.tick()
	t.check("q clock: the shower times out peer_timeout without both CONFIRMs", _closed(s) == [&"peer_timeout", false])
	# 30 s from both CONFIRMs to the peer's LOCAL_LINK.
	var q := _pair_sides()
	var qj: PKeyTestPeers.Peer = q["joiner"]
	var qs: PKeyTestPeers.Peer = q["shower"]
	await qj.session.start()
	await PKeyTestPeers.pump(qj, qs)
	qj.session.confirm_pairing()
	qs.session.confirm_pairing()
	var to_shower: Array[PackedByteArray] = qj.out.duplicate()
	qj.out.clear()
	qs.out.clear()
	for m in to_shower:
		await qs.session.receive(m)
	qs.mono_value = 29.0
	qs.session.tick()
	t.check("q clock: the exchange waits 30 s for the peer's link", not qs.session.is_closed())
	qs.mono_value = 31.0
	qs.session.tick()
	t.check("q clock: the exchange times out peer_timeout and stores nothing", _closed(qs) == [&"peer_timeout", false] and qs.of(&"local_link").is_empty())


# -- mode l ---------------------------------------------------------------------------------------

static func _link(secret: PackedByteArray, own: PackedByteArray, peer_pub: PackedByteArray) -> Dictionary:
	return {"secret": secret, "own_key": own, "peer_key": peer_pub}


func _mode_l(t: PKeyTestContext) -> void:
	var p := _pair_sides()
	await _settle(p)
	var secret: PackedByteArray = p["joiner"].of(&"local_link")[0]["secret"]
	var ka := PKeyTestPeers.random32()
	var kb := PKeyTestPeers.random32()
	var decoy := _link(PKeyTestPeers.random32(), PKeyTestPeers.random32(), PKeyTestPeers.random32())
	var i := PKeyTestPeers.side("l", "initiator", null, {"locals": [_link(secret, ka, _pub(kb))]})
	var r := PKeyTestPeers.side("l", "responder", null, {"locals": [decoy, _link(secret, kb, _pub(ka))]})
	t.check("l: both sessions are made", i.session != null and r.session != null)
	if i.session == null or r.session == null:
		return
	await i.session.start()
	await PKeyTestPeers.pump(i, r)
	var ei := i.of(&"established")
	var er := r.of(&"established")
	t.check("l: both open, the dialled and the matched link named", i.session.is_open() and r.session.is_open() and ei.size() == 1 \
			and er.size() == 1 and ei[0]["local_index"] == 0 and er[0]["local_index"] == 1)
	t.check("l: the HELLO is display data, not authenticated", ei[0]["hello_authenticated"] == false and er[0]["remote_static"] == _pub(ka) and ei[0]["remote_static"] == _pub(kb))
	t.check("l: no SAS and no pairing records", i.of(&"sas").is_empty() and r.of(&"sas").is_empty())
	i.session.send_record(0x0100, "hi".to_utf8_buffer())
	await PKeyTestPeers.pump(i, r)
	t.check("l: a host record is delivered", r.of(&"record").size() == 1 and r.of(&"record")[0]["record_type"] == 0x0100)
	r.session.send_record(0x0101, "back".to_utf8_buffer())
	await PKeyTestPeers.pump(i, r)
	t.check("l: and the other way", i.of(&"record").size() == 1 and i.of(&"record")[0]["record_type"] == 0x0101)
	i.session.send_record(PKeyPeerRecord.CONFIRM, "{}".to_utf8_buffer())
	await PKeyTestPeers.pump(i, r)
	t.check("l: the pairing record is refused by the peer", _closed(r)[0] == &"peer_not_allowed")
	await _mode_l_refusals(t, secret)


func _mode_l_refusals(t: PKeyTestContext, secret: PackedByteArray) -> void:
	var ka := PKeyTestPeers.random32()
	var kb := PKeyTestPeers.random32()
	# A link whose peer key is not the one that dials: the pin ends the session, sending nothing.
	var other := PKeyTestPeers.random32()
	var i := PKeyTestPeers.side("l", "initiator", null, {"locals": [_link(secret, ka, _pub(other))]})
	var r := PKeyTestPeers.side("l", "responder", null, {"locals": [_link(secret, kb, _pub(ka))]})
	await i.session.start()
	await PKeyTestPeers.pump(i, r)
	t.check("l pin: a peer key that is not the stored one ends peer_revoked, nothing established", _closed(i) == [&"peer_revoked", false] and i.of(&"established").is_empty())
	# A revoked link: the listener no longer holds the secret and closes silently.
	var i2 := PKeyTestPeers.side("l", "initiator", null, {"locals": [_link(PKeyTestPeers.random32(), ka, _pub(kb))]})
	var r2 := PKeyTestPeers.side("l", "responder", null, {"locals": [_link(PKeyTestPeers.random32(), kb, _pub(ka))]})
	await i2.session.start()
	await PKeyTestPeers.pump(i2, r2)
	t.check("l revoked: the listener closes handshake_failed and sends nothing", _closed(r2) == [&"handshake_failed", false] and r2.out.is_empty() and r2.of(&"established").is_empty())
	t.check("l revoked: the dialler never reaches a transport", i2.of(&"established").is_empty())


func _shared_listener(t: PKeyTestContext) -> void:
	var ka := PKeyTestPeers.random32()
	var kb := PKeyTestPeers.random32()
	var secret := PKeyTestPeers.random32()
	var locals: Array = [0, 1].map(func(_n: int) -> Dictionary: return _link(PKeyTestPeers.random32(), PKeyTestPeers.random32(), PKeyTestPeers.random32()))
	locals.append(_link(secret, kb, _pub(ka)))
	var contact := {"secret": PKeyTestPeers.random32(), "agree_key": "x".repeat(43)}
	for busy in [false, true]:
		var limiter := PKeyPeerLimiter.new(0 if busy else 5, 4)
		var crypto := CountingCrypto.new()
		var r := PKeyTestPeers.side("c", "responder", PKeyTestPeers.random32(), {"contacts": [contact], "locals": locals, "admission": limiter, "crypto": crypto})
		var i := PKeyTestPeers.side("l", "initiator", null, {"locals": [_link(secret, ka, _pub(kb))]})
		await i.session.start()
		await PKeyTestPeers.pump(i, r)
		if busy:
			t.check("shared listener: a full limiter refuses before any secret is tried", _closed(r) == [&"peer_busy", false] and crypto.opens == 0 and r.of(&"established").is_empty())
		else:
			t.check("shared listener: local links are tried after the contacts, the third one opens", r.of(&"established").size() == 1 \
					and r.of(&"established")[0]["local_index"] == 2 and r.session.mode() == "l" and r.session.is_open())
			# The same listener with the dialled link first: two fewer keys are tried before it opens.
			var first_crypto := CountingCrypto.new()
			var swapped: Array = [locals[2], locals[0], locals[1]]
			var r0 := PKeyTestPeers.side("c", "responder", PKeyTestPeers.random32(), {"contacts": [contact], "locals": swapped, "admission": PKeyPeerLimiter.new(), "crypto": first_crypto})
			var i0 := PKeyTestPeers.side("l", "initiator", null, {"locals": [_link(secret, ka, _pub(kb))]})
			await i0.session.start()
			await PKeyTestPeers.pump(i0, r0)
			t.check("shared listener: the keys are tried in held order, one open each", r0.of(&"established").size() == 1 \
					and r0.of(&"established")[0]["local_index"] == 0 and crypto.opens - first_crypto.opens == 2)
	# A mode-a account listener with no account key matching still reaches the links after its keys.
	var d := PKeyTestPeers.device(PKeyTestPeers.ID_A, PKeyTestPeers.SIGN_A, 1, PKeyTestPeers.SUB, PKeyTestPeers.NOW - 10, PKeyTestPeers.NOW + 1000, PKeyTestPeers.fixed(1))
	var disc: Array = [PKeyTestPeers.random32(), null]
	var ra := PKeyTestPeers.account_side("responder", d, disc, "", 1, {"locals": [_link(secret, kb, _pub(ka))], "admission": PKeyPeerLimiter.new()})
	var ia := PKeyTestPeers.side("l", "initiator", null, {"locals": [_link(secret, ka, _pub(kb))]})
	t.check("shared listener: a mode-a responder may serve local links", ra.session != null)
	if ra.session != null:
		await ia.session.start()
		await PKeyTestPeers.pump(ia, ra)
		t.check("shared listener: the account keys miss, the link opens", ra.of(&"established").size() == 1 and ra.session.mode() == "l")


func _attempt(limiter: PKeyPeerLimiter, group: String, opens: bool) -> Dictionary:
	var ka := PKeyTestPeers.random32()
	var kb := PKeyTestPeers.random32()
	var secret := PKeyTestPeers.random32()
	var crypto := CountingCrypto.new()
	var extra := {"locals": [_link(secret if opens else PKeyTestPeers.random32(), kb, _pub(ka))], "admission": limiter, "crypto": crypto}
	if group != "":
		extra["admission_group"] = group
	var r := PKeyTestPeers.side("l", "responder", null, extra)
	var i := PKeyTestPeers.side("l", "initiator", null, {"locals": [_link(secret, ka, _pub(kb))]})
	await i.session.start()
	await PKeyTestPeers.pump(i, r)
	return {"r": r, "opens": crypto.opens}


func _groups(t: PKeyTestContext) -> void:
	# A group that sent two message 1s is refused the third before any secret is tried; another group is not.
	var clock := Clock.new()
	var limiter := PKeyPeerLimiter.new(5, 4, Callable(clock, "now"))
	for at in [0.0, 1.0]:
		clock.t = at
		var miss := await _attempt(limiter, "g1", false)
		t.check("group: a failed trial closes handshake_failed", _closed(miss["r"]) == [&"handshake_failed", false] and miss["opens"] == 1)
	clock.t = 2.0
	var third := await _attempt(limiter, "g1", true)
	t.check("group: the third message 1 is refused peer_busy before any secret is tried", _closed(third["r"]) == [&"peer_busy", false] and third["opens"] == 0)
	var other := await _attempt(limiter, "g2", true)
	t.check("group: another group is heard", (other["r"] as PKeyTestPeers.Peer).of(&"established").size() == 1)
	clock.t = 70.0
	var later := await _attempt(limiter, "g1", true)
	t.check("group: the window slides, a minute on the group is heard again", (later["r"] as PKeyTestPeers.Peer).of(&"established").size() == 1)
	# A trial that opens is not counted against the group, and only a failed trial spends the shared budget.
	var c2 := Clock.new()
	var l2 := PKeyPeerLimiter.new(5, 4, Callable(c2, "now"))
	var all_open := true
	for n in 3:
		c2.t = float(n)
		var ok := await _attempt(l2, "g1", true)
		all_open = all_open and (ok["r"] as PKeyTestPeers.Peer).of(&"established").size() == 1
	t.check("group: three opening attempts from one group inside a minute", all_open)
	for n in 5:
		c2.t = 10.0 + n
		await _attempt(l2, "f%d" % n, false)
	c2.t = 20.0
	var six := await _attempt(l2, "f5", true)
	t.check("group: five failures spend the shared budget, a sixth is refused", _closed(six["r"]) == [&"peer_busy", false] and six["opens"] == 0)
	# Without a group the shared limiter counts the attempt as it begins.
	var c3 := Clock.new()
	var l3 := PKeyPeerLimiter.new(5, 4, Callable(c3, "now"))
	for n in 5:
		c3.t = float(n)
		await _attempt(l3, "", true)
	c3.t = 6.0
	var shared := await _attempt(l3, "", true)
	t.check("group: without a group the shared limiter counts every attempt", _closed(shared["r"]) == [&"peer_busy", false])


# -- options --------------------------------------------------------------------------------------

func _options(t: PKeyTestContext) -> void:
	var l := _link(PKeyTestPeers.random32(), PKeyTestPeers.random32(), PKeyTestPeers.random32())
	var limiter := PKeyPeerLimiter.new()
	t.check("options: mode l without links", PKeyTestPeers.side("l", "initiator", null, {}).session == null)
	t.check("options: an initiator names exactly one link", PKeyTestPeers.side("l", "initiator", null, {"locals": [l, l]}).session == null)
	t.check("options: a responder needs a limiter", PKeyPeerSession.create({"mode": "l", "role": "responder", "slug": SLUG, "locals": [l],  \
			"hello": {"platform": "t", "app": "d"}, "send": func(_n: PackedByteArray) -> void: pass, "on_event": func(_e: Dictionary) -> void: pass}).ok == false)
	var many: Array = []
	for n in PKeyPeerLocal.MAX_LOCAL_LINKS + 1:
		many.append(l)
	t.check("options: at most 32 links", PKeyTestPeers.side("l", "responder", null, {"locals": many, "admission": limiter}).session == null)
	t.check("options: a link secret of the wrong size", PKeyTestPeers.side("l", "initiator", null, {"locals": [_link(PackedByteArray([1]), l["own_key"], l["peer_key"])]}).session == null)
	t.check("options: locals belong to modes l, c and a", PKeyTestPeers.side("p", "initiator", PKeyTestPeers.random32(), {"locals": [l]}).session == null)
	t.check("options: an admission group is a responder's", PKeyTestPeers.side("l", "initiator", null, {"locals": [l], "admission_group": "g"}).session == null)
	var c := _cpace("123456", "123456")
	var pair: Dictionary = (c["shower"] as Dictionary).duplicate()
	var allow := func() -> bool: return true
	pair.merge({"held": 0, "elapsed": 0.0, "cats": [], "permit": allow})
	t.check("options: a mode-q responder without a permit", PKeyTestPeers.side("q", "responder", PKeyTestPeers.random32(), {"pair": {"psk": pair["psk"],  \
			"isk": pair["isk"], "held": 0, "elapsed": 0.0, "cats": []}}).session == null)
	t.check("options: mode q without a pairing", PKeyTestPeers.side("q", "initiator", PKeyTestPeers.random32(), {}).session == null)
	t.check("options: a pairing for another mode", PKeyTestPeers.side("c", "initiator", PKeyTestPeers.random32(), {"pair": pair,  \
			"contacts": [{"secret": PKeyTestPeers.random32(), "agree_key": "x".repeat(43)}]}).session == null)
	t.check("options: a PSK of the wrong size", PKeyTestPeers.side("q", "responder", PKeyTestPeers.random32(), {"pair": {"psk": PackedByteArray([1]),  \
			"isk": pair["isk"], "held": 0, "elapsed": 0.0, "cats": [], "permit": pair["permit"]}}).session == null)
	t.check("options: a mode-q responder needs no limiter", PKeyTestPeers.side("q", "responder", PKeyTestPeers.random32(), {"pair": pair}).session != null)
