extends RefCounted
# @pkey-feature connect.noise connect.protocol
# `PKeyPeerSession` in mode a (CC-14.8; WIRE-CONTRACT-V5 sections 15.3, 15.5 and 15.6), ported from
# the mode-a and refusal blocks of client-core's `peerSession.test.ts`: two sessions wired in memory,
# admission by certificate and held roster, HELLO first, PING, RING, TRUST, REKEY, CLOSE, the 30 s
# deadline, `peer_expired`, the PSK trial (G2), the busy step and the refusals the matrix cannot show.
# Certificates and rosters are signed with a throwaway product key.

var _pair: Dictionary
var _pair2: Dictionary
var _disc := PackedByteArray()


func run(t: PKeyTestContext) -> void:
	_pair = PKeyTestPeers.pair(1)
	_pair2 = PKeyTestPeers.pair(2)
	_disc = PKeyTestPeers.random32()
	_options(t)
	await _admits_and_talks(t)
	await _discovery_keys(t)
	await _held_roster(t)
	await _ring_and_revocation(t)
	await _trust_and_host_records(t)
	await _deadlines(t)
	await _raw_peer(t)
	await _key_port(t)
	await _busy_step(t)
	await _first_message_cap(t)
	await _ring_flood(t)
	await _abort(t)


func _a() -> Dictionary:
	return _pair["a"]


func _b() -> Dictionary:
	return _pair["b"]


## An initiator (A) and a responder (B) sharing `_disc`, optionally holding a roster each.
func _sides(held_a := "", held_b := "", extra_a := {}, extra_b := {}) -> Array:
	var a := PKeyTestPeers.account_side("initiator", _a(), [_disc], held_a, 1, extra_a)
	var b := PKeyTestPeers.account_side("responder", _b(), [_disc], held_b, 1, extra_b)
	return [a, b]


func _options(t: PKeyTestContext) -> void:
	var d := _a()
	var base := {
		"mode": "p", "role": "initiator", "slug": "djdl", "static_key": d["priv"], "hello": {"platform": "t", "app": "a"},
		"send": func(_n: PackedByteArray) -> void: pass, "on_event": func(_e: Dictionary) -> void: pass,
	}
	t.check("options: a mode p initiator needs no account", PKeyPeerSession.create(base).ok)
	t.check("options: mode a without an account is refused", not PKeyPeerSession.create(_with(base, "mode", "a")).ok)
	t.check("options: an account outside mode a is refused", not PKeyPeerSession.create(_with(base, "account", {})).ok)
	t.check("options: an unknown mode is refused", not PKeyPeerSession.create(_with(base, "mode", "x")).ok)
	t.check("options: an unknown role is refused", not PKeyPeerSession.create(_with(base, "role", "both")).ok)
	t.check("options: a short static key is refused", not PKeyPeerSession.create(_with(base, "static_key", PackedByteArray([1, 2]))).ok)
	t.check("options: no send callback is refused", not PKeyPeerSession.create(_with(base, "send", null)).ok)
	t.check("options: no hello is refused", not PKeyPeerSession.create(_with(base, "hello", {})).ok)
	var approver := _with(base, "role", "responder")
	t.check("options: an approver needs an admission limiter", not PKeyPeerSession.create(approver).ok)
	approver["admission"] = PKeyPeerLimiter.new()
	t.check("options: an approver with a limiter is accepted", PKeyPeerSession.create(approver).ok)
	var bad := PKeyPeerSession.create(_with(base, "mode", "x"))
	t.check("options: the refusal is invalid-options", bad.code == &"invalid-options")
	var s := PKeyTestPeers.account_side("initiator", d, [_disc])
	t.check("options: str() shows the mode, role and phase only", str(s.session) == "PKeyPeerSession(a initiator hs)")


static func _with(o: Dictionary, k: String, v: Variant) -> Dictionary:
	var r := o.duplicate()
	r[k] = v
	return r


func _admits_and_talks(t: PKeyTestContext) -> void:
	var sides := _sides("", "", {"rekey_messages": 2})
	var a: PKeyTestPeers.Peer = sides[0]
	var b: PKeyTestPeers.Peer = sides[1]
	var started := Time.get_ticks_msec()
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.info("mode a handshake, both sides, %d ms" % (Time.get_ticks_msec() - started))
	var est := a.of(&"established")
	t.check("a: the initiator is established", est.size() == 1 and a.session.is_open())
	t.check("a: the responder is established", b.of(&"established").size() == 1 and b.session.is_open())
	t.check("a: the admitted certificate's device id", est[0]["peer_device_id"] == PKeyTestPeers.ID_B and b.of(&"established")[0]["peer_device_id"] == PKeyTestPeers.ID_A)
	t.check("a: HELLO display data is authenticated", est[0]["hello_authenticated"] == true and est[0]["hello"]["app"] == "demo")
	t.check("a: the capabilities are the intersection, in byte order", est[0]["caps"] == ["app/1", "ring/1"])
	t.check("a: the remote static key is the peer's agreement key", est[0]["remote_static"] == _b()["pub"])
	t.check("a: both sides share the handshake hash", a.session.handshake_hash().size() == 32 and a.session.handshake_hash() == b.session.handshake_hash())
	t.check("a: no roster held asks for one on each side", a.of(&"ring_wanted").size() == 1 and b.of(&"ring_wanted").size() == 1)
	t.check("a: the peer's device id is readable", a.session.peer_device_id() == PKeyTestPeers.ID_B)
	t.check("a: nothing reached the host before the session opened", a.of(&"record").is_empty() and b.of(&"record").is_empty())

	# Five APP records with a rekey after every two messages sent: two REKEY records on the wire,
	# invisible to the host.
	var before := a.out.size()
	for body in ["one", "two", "three", "four", "five"]:
		t.check("a: send_record %s" % body, a.session.send_record(0x0100, body.to_utf8_buffer()).ok)
	t.check("a: the wire carries five records and two REKEYs", a.out.size() - before == 7, str(a.out.size() - before))
	await PKeyTestPeers.pump(a, b)
	var got := b.of(&"record").map(func(e: Dictionary) -> String: return (e["body"] as PackedByteArray).get_string_from_utf8())
	t.check("a: the host sees the five APP records in order", got == ["one", "two", "three", "four", "five"], str(got))
	t.check("a: the type is delivered", b.of(&"record")[0]["record_type"] == 0x0100)

	# PING is answered by the session; the host sees neither it nor the PONG.
	t.check("a: a PING is accepted", b.session.send_record(PKeyPeerRecord.PING, PackedByteArray([0, 0, 0, 0, 0, 0, 0, 1])).ok)
	await PKeyTestPeers.pump(a, b)
	t.check("a: the PING did not reach the host", a.of(&"record").is_empty() and b.of(&"record").size() == 5)

	# One message over 64 KiB is split into MORE records and rebuilt whole.
	var big := PackedByteArray()
	big.resize(66000)
	big.fill(0x5a)
	var t0 := Time.get_ticks_msec()
	t.check("a: a 66,000-byte message is sent", a.session.send_record(0x0101, big).ok)
	await PKeyTestPeers.pump(a, b)
	t.info("66,000-byte message, both directions of the cipher, %d ms" % (Time.get_ticks_msec() - t0))
	var last: Dictionary = b.of(&"record").back()
	t.check("a: it arrives as one record of the same bytes", last["record_type"] == 0x0101 and last["body"] == big)

	# What the session owns the host cannot send.
	for owned in [PKeyPeerRecord.HELLO, PKeyPeerRecord.CLOSE, PKeyPeerRecord.REKEY, PKeyPeerRecord.SAS_COMMIT, PKeyPeerRecord.SAS_NONCE, PKeyPeerRecord.SAS_REVEAL]:
		t.check("a: record 0x%04x belongs to the session" % owned, a.session.send_record(owned, PackedByteArray()).code == &"state")
	t.check("a: a message over the 1 MiB cap is too_large", a.session.send_record(0x0100, PackedByteArray()).ok and _too_large(a))

	a.session.close()
	await PKeyTestPeers.pump(a, b)
	t.check("a: close() makes the peer see peer_bye", b.closes() == [[&"peer_bye", true]], str(b.closes()))
	t.check("a: the closer reports its own close, once", a.closes() == [[&"peer_bye", false]])
	t.check("a: send_record after close is refused", a.session.send_record(0x0100, PackedByteArray()).code == &"state")
	a.session.close()
	await a.session.receive(PackedByteArray([1, 2, 3]))
	t.check("a: a closed session stays quiet", a.closes().size() == 1)


func _too_large(side: PKeyTestPeers.Peer) -> bool:
	var huge := PackedByteArray()
	huge.resize(PKeyPeerRecord.MAX_MESSAGE + 1)
	return side.session.send_record(0x0100, huge).code == &"too_large"


func _discovery_keys(t: PKeyTestContext) -> void:
	# A wrong discovery key ends the responder silently: nothing is sent and the tag is never answered.
	var a := PKeyTestPeers.account_side("initiator", _a(), [PKeyTestPeers.random32()])
	var b := PKeyTestPeers.account_side("responder", _b(), [PKeyTestPeers.random32()])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("keys: a wrong key sends nothing back", b.out.is_empty() and a.of(&"established").is_empty())
	t.check("keys: the responder closes handshake_failed", b.closes() == [[&"handshake_failed", false]], str(b.closes()))

	# The responder also tries the previous key; an absent one is skipped.
	var old := PKeyTestPeers.random32()
	a = PKeyTestPeers.account_side("initiator", _a(), [old])
	b = PKeyTestPeers.account_side("responder", _b(), [PKeyTestPeers.random32(), old])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("keys: the previous discovery key is tried", b.of(&"established").size() == 1 and a.of(&"established").size() == 1)
	var current := PKeyTestPeers.random32()
	a = PKeyTestPeers.account_side("initiator", _a(), [current])
	b = PKeyTestPeers.account_side("responder", _b(), [current, null])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("keys: an absent previous key is skipped", b.of(&"established").size() == 1)
	a = PKeyTestPeers.account_side("initiator", _a(), [PKeyTestPeers.random32()])
	b = PKeyTestPeers.account_side("responder", _b(), [current, null])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("keys: a wrong current key with an absent previous one fails cleanly", b.of(&"closed").size() == 1 and b.of(&"established").is_empty())
	b = PKeyTestPeers.account_side("responder", _b(), [null, old])
	a = PKeyTestPeers.account_side("initiator", _a(), [old])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("keys: an absent current key is skipped too", b.of(&"established").size() == 1)

	# An initiator with no key cannot start.
	a = PKeyTestPeers.account_side("initiator", _a(), [])
	await a.session.start()
	t.check("keys: an initiator with no discovery key closes handshake_failed", a.closes() == [[&"handshake_failed", false]] and a.out.is_empty())
	a = PKeyTestPeers.account_side("initiator", _a(), [PackedByteArray([1, 2, 3])])
	await a.session.start()
	t.check("keys: a key of the wrong length is no key", a.closes() == [[&"handshake_failed", false]])

	# A responder never answers a first message that is not a Noise message at all.
	for junk in [PackedByteArray(), PackedByteArray([1]), PKeyTestPeers.random32(), _zeros(100), _zeros(PKeyPeerSession.FIRST_MESSAGE_MAX)]:
		b = PKeyTestPeers.account_side("responder", _b(), [current])
		await b.session.receive(junk)
		t.check("keys: a %d-byte first message is refused silently" % junk.size(), b.out.is_empty() and b.closes() == [[&"handshake_failed", false]])
	# A message is only read once. A second start() on the same initiator does nothing.
	a = PKeyTestPeers.account_side("initiator", _a(), [current])
	await a.session.start()
	var first := a.out.size()
	await a.session.start()
	t.check("keys: start() is once", a.out.size() == first and first == 1)
	b = PKeyTestPeers.account_side("responder", _b(), [current])
	await b.session.start()
	t.check("keys: a responder cannot start()", b.out.is_empty() and b.closes().is_empty())


static func _zeros(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	return b


func _held_roster(t: PKeyTestContext) -> void:
	var ring: String = _pair["ring"]
	var sides := _sides(ring, ring)
	var a: PKeyTestPeers.Peer = sides[0]
	var b: PKeyTestPeers.Peer = sides[1]
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	var open := a.of(&"established").size() == 1 and b.of(&"established").size() == 1
	t.check("held: both hold the roster: both established, neither asks for one", open and a.of(&"ring_wanted").is_empty() and b.of(&"ring_wanted").is_empty())

	# A held roster that does not verify refuses the peer and asks for a fresh one.
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc])
	b = PKeyTestPeers.account_side("responder", _b(), [_disc], "not-a-roster")
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("held: an unusable roster asks for another", b.of(&"ring_wanted").size() == 1)
	t.check("held: and refuses the peer", b.of(&"established").is_empty() and b.closes() == [[&"handshake_failed", false]])
	# Another account's roster, and an expired one, are no better.
	var other := PKeyTestPeers.ring(1, [_a(), _b()], PKeyTestPeers.OTHER_SUB)
	var stale := PKeyTestPeers.ring(1, [_a(), _b()], PKeyTestPeers.SUB, PKeyTestPeers.NOW - 5000, PKeyTestPeers.NOW - 1000)
	for held in [other, stale]:
		a = PKeyTestPeers.account_side("initiator", _a(), [_disc])
		b = PKeyTestPeers.account_side("responder", _b(), [_disc], held)
		await a.session.start()
		await PKeyTestPeers.pump(a, b)
		t.check("held: a roster of another account or an expired one refuses", b.of(&"established").is_empty() and b.closes() == [[&"handshake_failed", false]] and b.of(&"ring_wanted").size() == 1)

	# A certificate on a newer roster than the held one: admitted, and the roster is wanted.
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc], ring, 1)
	var b2 := PKeyTestPeers.account_side("responder", _pair2["b"], [_disc], _pair2["ring"], 2)
	await a.session.start()
	await PKeyTestPeers.pump(a, b2)
	t.check("held: a certificate on a newer epoch is admitted", a.of(&"established").size() == 1 and b2.of(&"established").size() == 1)
	t.check("held: and the older holder asks for the new roster", a.of(&"ring_wanted").size() == 1)
	var pushed := a.of(&"ring")
	t.check("held: the newer holder pushes its roster", pushed.size() == 1 and pushed[0]["jws"] == _pair2["ring"] and pushed[0]["epoch"] == 2)
	t.check("held: the peer is still in the new roster, so the session stays open", a.session.is_open() and b2.session.is_open())


func _ring_and_revocation(t: PKeyTestContext) -> void:
	var ring1: String = _pair["ring"]
	var ring3 := PKeyTestPeers.ring(3, [_a()])
	# At admission: a roster newer than the peer's certificate that does not list it.
	var a := PKeyTestPeers.account_side("initiator", _a(), [_disc], ring3, 3)
	var b := PKeyTestPeers.account_side("responder", _b(), [_disc])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("revoke: a roster that drops the peer closes peer_revoked", a.closes() == [[&"peer_revoked", false]] and a.of(&"established").is_empty(), str(a.closes()))

	# In the session: the peer pushes a roster that drops it.
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc], ring1, 1)
	b = PKeyTestPeers.account_side("responder", _b(), [_disc], ring3, 3)
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("revoke: a pushed roster is surfaced to the host", a.of(&"ring").size() == 1 and a.of(&"ring")[0]["epoch"] == 3)
	t.check("revoke: and, dropping the peer, closes the session peer_revoked", a.closes() == [[&"peer_revoked", false]], str(a.closes()))
	t.check("revoke: the peer is told", b.closes() == [[&"peer_revoked", true]], str(b.closes()))

	# A stale, equal or foreign roster changes nothing.
	var ring2: String = _pair2["ring"]
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc], ring2, 2)
	b = PKeyTestPeers.account_side("responder", _b(), [_disc], ring2, 2)
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	for pushed_ring in [ring1, ring2, PKeyTestPeers.ring(9, [_a(), _b()], PKeyTestPeers.OTHER_SUB)]:
		b.mono_value += PKeyPeerSession.RING_GAP_SECONDS
		a.session.send_record(PKeyPeerRecord.RING, PKeyJson.stringify({"ring": pushed_ring}).to_utf8_buffer())
		await PKeyTestPeers.pump(a, b)
	t.check("ring: an older, an equal and another account's roster are ignored", b.of(&"ring").is_empty() and b.session.is_open() and a.session.is_open())
	b.mono_value += PKeyPeerSession.RING_GAP_SECONDS
	a.session.send_record(PKeyPeerRecord.RING, PKeyJson.stringify({"ring": "not.a.jws"}).to_utf8_buffer())
	await PKeyTestPeers.pump(a, b)
	t.check("ring: a roster that does not verify is ignored", b.of(&"ring").is_empty() and b.session.is_open())
	b.mono_value += PKeyPeerSession.RING_GAP_SECONDS
	a.session.send_record(PKeyPeerRecord.RING, "{\"ring\":5}".to_utf8_buffer())
	await PKeyTestPeers.pump(a, b)
	t.check("ring: a body that is no roster closes peer_bad_frame", b.closes() == [[&"peer_bad_frame", false]], str(b.closes()))
	t.check("ring: and the sender is told", a.closes() == [[&"peer_bad_frame", true]])


func _trust_and_host_records(t: PKeyTestContext) -> void:
	var sides := _sides()
	var a: PKeyTestPeers.Peer = sides[0]
	var b: PKeyTestPeers.Peer = sides[1]
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	a.session.send_record(PKeyPeerRecord.TRUST, "{\"trust\":\"aaa.bbb.ccc\"}".to_utf8_buffer())
	await PKeyTestPeers.pump(a, b)
	var trust_events := b.of(&"trust_unverified")
	t.check("trust: a pushed TRUST is handed up unverified", trust_events.size() == 1 and trust_events[0]["jws"] == "aaa.bbb.ccc" and b.session.is_open())
	# Unknown non-critical types are ignored; an APP-critical type in the table goes to the host.
	a.session.send_record(0x0010, "x".to_utf8_buffer())
	a.session.send_record(0x8100, "y".to_utf8_buffer())
	await PKeyTestPeers.pump(a, b)
	var types := b.of(&"record").map(func(e: Dictionary) -> int: return e["record_type"])
	t.check("trust: a type outside the table is ignored, an APP-critical one is the host's", types == [0x8100] and b.session.is_open(), str(types))
	# A critical type outside the table closes the session.
	a.session.send_record(0xfffe, "z".to_utf8_buffer())
	await PKeyTestPeers.pump(a, b)
	t.check("trust: an unknown critical type closes peer_unknown_critical", b.closes() == [[&"peer_unknown_critical", false]], str(b.closes()))
	t.check("trust: and the sender is told", a.closes() == [[&"peer_unknown_critical", true]])
	# A TRUST body that is no object.
	sides = _sides()
	a = sides[0]
	b = sides[1]
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	a.session.send_record(PKeyPeerRecord.TRUST, "{\"x\":1}".to_utf8_buffer())
	await PKeyTestPeers.pump(a, b)
	t.check("trust: a TRUST body without a trust member closes peer_bad_frame", b.closes() == [[&"peer_bad_frame", false]])
	# The mode-a type table refuses what belongs to other modes.
	sides = _sides()
	a = sides[0]
	b = sides[1]
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	a.session.send_record(PKeyPeerRecord.VOUCH_REQ, PackedByteArray())
	await PKeyTestPeers.pump(a, b)
	t.check("trust: a mode-v record in mode a closes peer_not_allowed", b.closes() == [[&"peer_not_allowed", false]], str(b.closes()))


func _deadlines(t: PKeyTestContext) -> void:
	# The responder's 30 s begin at the first message and end at the transport.
	var sides := _sides()
	var a: PKeyTestPeers.Peer = sides[0]
	var b: PKeyTestPeers.Peer = sides[1]
	await a.session.start()
	await b.session.receive(a.out.pop_front())
	b.mono_value = 29.9
	b.session.tick()
	t.check("deadline: 29.9 s into the handshake is still open", b.closes().is_empty())
	b.mono_value = 30.0
	b.session.tick()
	t.check("deadline: 30 s closes peer_timeout", b.closes() == [[&"peer_timeout", false]], str(b.closes()))
	t.check("deadline: with no transport nothing but message 2 was sent", b.out.size() == 1)

	# Once the transport is up, mode a has no deadline; the hour-old keys rekey on the next send.
	sides = _sides()
	a = sides[0]
	b = sides[1]
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	a.mono_value = 100000.0
	b.mono_value = 100000.0
	a.session.tick()
	b.session.tick()
	t.check("deadline: an open mode-a session never times out", a.session.is_open() and b.session.is_open())
	var before := a.out.size()
	a.session.send_record(0x0100, "late".to_utf8_buffer())
	t.check("deadline: a send after an hour rekeys first", a.out.size() - before == 2)
	await PKeyTestPeers.pump(a, b)
	t.check("deadline: and the peer follows", b.of(&"record").size() == 1 and b.session.is_open())

	# A certificate that ends while the session is open closes it, and says so.
	var short := PKeyTestPeers.device(PKeyTestPeers.ID_B, PKeyTestPeers.SIGN_B, 1, PKeyTestPeers.SUB, PKeyTestPeers.NOW - 10, PKeyTestPeers.NOW + 20, PKeyTestPeers.fixed(2))
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc])
	b = PKeyTestPeers.account_side("responder", short, [_disc])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("expiry: a certificate with 20 s left is admitted", a.of(&"established").size() == 1)
	a.now_value = PKeyTestPeers.NOW + 19
	a.session.tick()
	t.check("expiry: 19 s on it is still good", a.session.is_open())
	a.now_value = PKeyTestPeers.NOW + 20
	a.session.tick()
	await PKeyTestPeers.pump(a, b)
	t.check("expiry: at its end the session closes peer_expired", a.closes() == [[&"peer_expired", false]], str(a.closes()))
	t.check("expiry: the peer is told", b.closes() == [[&"peer_expired", true]])
	# A certificate past its end but inside the clock allowance is refused at once.
	var lapsed := PKeyTestPeers.device(PKeyTestPeers.ID_B, PKeyTestPeers.SIGN_B, 1, PKeyTestPeers.SUB, PKeyTestPeers.NOW - 100, PKeyTestPeers.NOW - 5, PKeyTestPeers.fixed(2))
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc])
	b = PKeyTestPeers.account_side("responder", lapsed, [_disc])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("expiry: a certificate inside the skew but ended is peer_expired at the handshake", a.closes() == [[&"peer_expired", false]] and a.of(&"established").is_empty(), str(a.closes()))
	# Another account's certificate and the device's own are no peers.
	var stranger := PKeyTestPeers.device(PKeyTestPeers.ID_B, PKeyTestPeers.SIGN_B, 1, PKeyTestPeers.OTHER_SUB, PKeyTestPeers.NOW - 10, PKeyTestPeers.NOW + 1000, PKeyTestPeers.fixed(2))
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc])
	b = PKeyTestPeers.account_side("responder", stranger, [_disc])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("admit: a certificate of another account is refused", a.closes() == [[&"handshake_failed", false]] and a.of(&"established").is_empty())
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc])
	b = PKeyTestPeers.account_side("responder", _a(), [_disc])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("admit: this device's own certificate is refused", a.closes() == [[&"handshake_failed", false]] and a.of(&"established").is_empty())


## Opens a responder's mode-a session to a raw Noise initiator for device A. The transport ciphers,
## or null when the responder did not complete. The responder's HELLO is left in `side.out`.
func _raw_open(side: PKeyTestPeers.Peer, hello_after := true, hello: PackedByteArray = PackedByteArray()) -> PKeyPeerNoise.Transport:
	var psk := PKeyPeerNoise.psk(_disc, PKeyTestPeers.SLUG)
	var hs: PKeyPeerNoise.Handshake = PKeyPeerNoise.start("initiator", PKeyPeerNoise.protocol_name("a"), PKeyPeerNoise.prologue(PKeyTestPeers.SLUG, "a"), _a()["priv"], psk).detail
	await side.session.receive(hs.write_message(PKeyPeerPayload.payload1()).detail)
	if side.out.is_empty() or not hs.read_message(side.out.pop_front()).ok:
		return null
	var own := PKeyPeerPayload.payload23("a", ["app/1"], {"cert": _a()["cert"], "ring": 1})
	await side.session.receive(hs.write_message(own).detail)
	var tp: PKeyPeerNoise.Transport = hs.transport().detail
	if hello_after:
		await _raw_send(tp, side, PKeyPeerRecord.HELLO, hello if not hello.is_empty() else PKeyPeerPayload.hello_body("", "t", "a", 1048576))
	return tp


func _raw_send(tp: PKeyPeerNoise.Transport, side: PKeyTestPeers.Peer, type: int, body: PackedByteArray, flags := 0) -> void:
	await side.session.receive(tp.send.encrypt(PackedByteArray(), PKeyPeerRecord.encode(type, flags, body)).detail)


## The records in `side.out` decrypted with the raw peer's receive cipher: [[type, body], ...].
func _raw_records(tp: PKeyPeerNoise.Transport, side: PKeyTestPeers.Peer) -> Array:
	var out := []
	for m in side.out:
		var plain := tp.receive.decrypt(PackedByteArray(), m)
		if not plain.ok:
			out.append([-1, PackedByteArray()])
			continue
		var rec := PKeyPeerRecord.parse(plain.detail)
		out.append([rec["type"], rec["body"]])
	side.out.clear()
	return out


func _responder() -> PKeyTestPeers.Peer:
	return PKeyTestPeers.account_side("responder", _b(), [_disc])


func _raw_peer(t: PKeyTestContext) -> void:
	# The first record each way is HELLO; anything else is refused and closed, and says so.
	var b := _responder()
	var tp := await _raw_open(b, false)
	t.check("raw: the handshake completes", tp != null and b.session.is_open() == false)
	await _raw_send(tp, b, PKeyPeerRecord.PING, _zeros(8))
	t.check("raw: a PING instead of HELLO closes peer_bad_frame", b.closes() == [[&"peer_bad_frame", false]] and b.of(&"established").is_empty(), str(b.closes()))
	var recs := _raw_records(tp, b)
	var named: bool = recs.size() == 2 and recs[1][0] == PKeyPeerRecord.CLOSE and (recs[1][1] as PackedByteArray).get_string_from_utf8() == "{\"code\":\"peer_bad_frame\"}"
	t.check("raw: the responder's HELLO, then CLOSE naming the code", named and recs[0][0] == PKeyPeerRecord.HELLO, str(recs.map(func(r: Array) -> int: return r[0])))

	# A long label is cleaned and cut; mode a accepts a HELLO over 4 KiB.
	b = _responder()
	var label := "  Café \u202eTV\ufffd ".repeat(1) + "x".repeat(5000)
	tp = await _raw_open(b, true, PKeyPeerPayload.hello_body(label, "mac\u202eos", "  App\u202e  ", 1000))
	var est := b.of(&"established")
	t.check("raw: a HELLO over 4 KiB is accepted in mode a", est.size() == 1)
	if est.size() == 1:
		t.check("raw: the label is cleaned and cut to 64 code points", (est[0]["hello"]["label"] as String).length() == 64 and not (est[0]["hello"]["label"] as String).contains("\u202e"))
		t.check("raw: a platform of another shape is Unknown, an app is cleaned", est[0]["hello"]["platform"] == "Unknown" and est[0]["hello"]["app"] == "App")
		t.check("raw: max_message is the peer's", est[0]["hello"]["max_message"] == 1000)
	t.check("raw: a message at the peer's maxMessage is sent, one over is too_large", b.session.send_record(0x0100, _zeros(1000)).ok and b.session.send_record(0x0100, _zeros(1001)).code == &"too_large")

	# A second HELLO, a wrong-length PING and a record of another mode.
	var cases := {
		"a second HELLO": [PKeyPeerRecord.HELLO, PKeyPeerPayload.hello_body("", "t", "a", 1000), &"peer_bad_frame"],
		"a PING of 7 bytes": [PKeyPeerRecord.PING, _zeros(7), &"peer_bad_frame"],
		"a REKEY with a body": [PKeyPeerRecord.REKEY, _zeros(1), &"peer_bad_frame"],
		"a pairing record": [PKeyPeerRecord.CONTACT, PackedByteArray(), &"peer_not_allowed"],
		"a critical type outside the table": [0xfffe, PackedByteArray(), &"peer_unknown_critical"],
	}
	for name in cases:
		b = _responder()
		tp = await _raw_open(b)
		await _raw_send(tp, b, cases[name][0], cases[name][1])
		t.check("raw: %s closes %s" % [name, cases[name][2]], b.closes() == [[cases[name][2], false]], str(b.closes()))

	# CLOSE from the peer: a known code is reported, an unknown one is a bad frame; both are the peer's.
	for pair in [["{\"code\":\"peer_busy\"}", &"peer_busy"], ["{\"code\":\"nonsense\"}", &"peer_bad_frame"], ["{}", &"peer_bad_frame"], ["not json", &"peer_bad_frame"]]:
		b = _responder()
		tp = await _raw_open(b)
		await _raw_send(tp, b, PKeyPeerRecord.CLOSE, pair[0].to_utf8_buffer())
		t.check("raw: CLOSE %s is reported %s by the peer" % [pair[0], pair[1]], b.closes() == [[pair[1], true]], str(b.closes()))
		t.check("raw: and nothing is sent back", _raw_records(tp, b).size() == 1)

	# MORE chains: three records of one type are one message; an empty last record is fine; a chain of
	# another type in the middle is a bad frame.
	b = _responder()
	tp = await _raw_open(b)
	await _raw_send(tp, b, 0x0100, "ab".to_utf8_buffer(), PKeyPeerRecord.FLAG_MORE)
	await _raw_send(tp, b, 0x0100, "cd".to_utf8_buffer(), PKeyPeerRecord.FLAG_MORE)
	await _raw_send(tp, b, 0x0100, "ef".to_utf8_buffer())
	var rec_events := b.of(&"record")
	t.check("raw: three records of a MORE chain are one message", rec_events.size() == 1 and (rec_events[0]["body"] as PackedByteArray).get_string_from_utf8() == "abcdef")
	await _raw_send(tp, b, 0x0100, "x".to_utf8_buffer(), PKeyPeerRecord.FLAG_MORE)
	await _raw_send(tp, b, 0x0101, "y".to_utf8_buffer())
	t.check("raw: a chain broken by another type closes peer_bad_frame", b.closes() == [[&"peer_bad_frame", false]])

	# REKEY from the peer: both ciphers move together.
	b = _responder()
	tp = await _raw_open(b)
	await _raw_send(tp, b, PKeyPeerRecord.REKEY, PackedByteArray())
	tp.send.rekey()
	await _raw_send(tp, b, 0x0100, "after".to_utf8_buffer())
	t.check("raw: a REKEY then a record under the new key is delivered", b.of(&"record").size() == 1 and b.session.is_open())
	# A record under the old key after a REKEY is a bad frame.
	await _raw_send(tp, b, PKeyPeerRecord.REKEY, PackedByteArray())
	await _raw_send(tp, b, 0x0100, "stale".to_utf8_buffer())
	t.check("raw: a record that skips the key change closes peer_bad_frame", b.closes() == [[&"peer_bad_frame", false]])

	# A flipped bit in a ciphertext, and a replay, are bad frames.
	b = _responder()
	tp = await _raw_open(b)
	var sealed: PackedByteArray = tp.send.encrypt(PackedByteArray(), PKeyPeerRecord.encode(0x0100, 0, "hello".to_utf8_buffer())).detail
	var forged := sealed.duplicate()
	forged[forged.size() - 1] ^= 1
	await b.session.receive(forged)
	t.check("raw: a flipped bit closes peer_bad_frame", b.closes() == [[&"peer_bad_frame", false]], str(b.closes()))
	b = _responder()
	tp = await _raw_open(b)
	sealed = tp.send.encrypt(PackedByteArray(), PKeyPeerRecord.encode(0x0100, 0, "hello".to_utf8_buffer())).detail
	await b.session.receive(sealed)
	await b.session.receive(sealed)
	t.check("raw: a replayed message closes peer_bad_frame", b.of(&"record").size() == 1 and b.closes() == [[&"peer_bad_frame", false]])

	# A low-order point as the peer's ephemeral key is refused (an all-zero DH aborts), mode p.
	var p := PKeyTestPeers.side("p", "responder", PKeyTestPeers.random32())
	await p.session.receive(_zeros(32) + "{\"v\":1}".to_utf8_buffer())
	t.check("raw: a low-order ephemeral key closes handshake_failed and sends nothing", p.out.is_empty() and p.closes() == [[&"handshake_failed", false]], str(p.closes()))


## A key port: the private key stays in it and only `dh` crosses (G1).
class CountingPort extends RefCounted:
	var dh_calls := 0
	var _priv: PackedByteArray
	var _pub: PackedByteArray


	func _init(priv: PackedByteArray) -> void:
		_priv = priv
		_pub = PKeyCurve25519.x25519_public(priv)


	func public_key() -> PackedByteArray:
		return _pub


	func dh(remote: PackedByteArray) -> Variant:
		dh_calls += 1
		return PKeyCurve25519.x25519(_priv, remote)


## Counts the curve calls the engine makes.
class CountingCrypto extends PKeyPeerCrypto:
	var x25519_calls := 0


	func x25519(private_key: PackedByteArray, peer_public: PackedByteArray) -> Variant:
		x25519_calls += 1
		return super.x25519(private_key, peer_public)


func _key_port(t: PKeyTestContext) -> void:
	var port := CountingPort.new(_b()["priv"])
	var crypto := CountingCrypto.new()
	var a := PKeyTestPeers.account_side("initiator", _a(), [_disc])
	# The same options as account_side, with the key port as the static key.
	var held := PKeyTestPeers.Peer.new()
	var b := PKeyTestPeers.side("a", "responder", port, {"crypto": crypto, "account": PKeyTestPeers.account(_b(), held, [_disc])}, held)
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("port: a session over a key port is established with the same keys", a.of(&"established").size() == 1 and a.of(&"established")[0]["remote_static"] == _b()["pub"])
	t.check("port: the static DH ran in the port (one: se)", port.dh_calls == 1, str(port.dh_calls))
	t.check("port: the engine ran the ephemeral ones (e, ee, es)", crypto.x25519_calls >= 1)

	# G2: no static DH before message 1's tag verifies.
	port = CountingPort.new(_b()["priv"])
	crypto = CountingCrypto.new()
	held = PKeyTestPeers.Peer.new()
	b = PKeyTestPeers.side("a", "responder", port, {"crypto": crypto, "account": PKeyTestPeers.account(_b(), held, [PKeyTestPeers.random32()])}, held)
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc])
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("port: a failed message 1 does no DH at all", port.dh_calls == 0 and crypto.x25519_calls == 0, "%d %d" % [port.dh_calls, crypto.x25519_calls])
	# A port that gives no public key, or one that is not a port, cannot make a session.
	var odd := {
		"mode": "p", "role": "initiator", "slug": "djdl", "static_key": RefCounted.new(), "hello": {"platform": "t", "app": "a"},
		"send": func(_n: PackedByteArray) -> void: pass, "on_event": func(_e: Dictionary) -> void: pass,
	}
	t.check("port: an object that is no port is refused", not PKeyPeerSession.create(odd).ok)
	t.check("port: a session never prints the key", not str(a.session).contains(str(_a()["priv"])))


func _busy_step(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var ran: Array[int] = []
	var slow := func(work: Callable) -> Variant:
		ran.append(1)
		await tree.process_frame
		return work.call()
	# The offload hook sees three steps on the initiator and two on the responder.
	var a := PKeyTestPeers.account_side("initiator", _a(), [_disc], "", 1, {"offload": slow})
	var b := PKeyTestPeers.account_side("responder", _b(), [_disc], "", 1, {"offload": slow})
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	t.check("busy: the handshake is the same through an offload that takes frames", a.of(&"established").size() == 1 and b.of(&"established").size() == 1)
	t.check("busy: the initiator offloads three steps and the responder two", ran.size() == 5, str(ran.size()))

	# close() during a step waits for its end; tick() does nothing; a message meanwhile queues.
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc], "", 1, {"offload": slow})
	a.session.start()
	t.check("busy: the session is busy while the step runs", a.session.is_busy())
	a.session.tick()
	a.session.close()
	t.check("busy: close() is deferred", a.closes().is_empty())
	await tree.process_frame
	await tree.process_frame
	t.check("busy: the close lands after the step, once", a.closes() == [[&"peer_bye", false]] and not a.session.is_busy(), str(a.closes()))

	b = PKeyTestPeers.account_side("responder", _b(), [_disc], "", 1, {"offload": slow})
	var peer := PKeyTestPeers.account_side("initiator", _a(), [_disc])
	await peer.session.start()
	b.session.receive(peer.out.pop_front())
	b.session.receive(PackedByteArray([9, 9, 9]))
	t.check("busy: a second message only queues", b.session.is_busy() and b.out.is_empty())
	await tree.process_frame
	await tree.process_frame
	await tree.process_frame
	t.check("busy: the queued message is handled after the first, in order", b.out.size() == 1 and b.closes() == [[&"handshake_failed", false]], str(b.closes()))


## A crypto port that counts the AEAD opens and the ladders it is asked for.
class OpenCountingCrypto extends PKeyPeerCrypto:
	var opens := 0
	var ladders := 0


	func x25519(private_key: PackedByteArray, peer_public: PackedByteArray) -> Variant:
		ladders += 1
		return super.x25519(private_key, peer_public)


	func aes_gcm_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
		opens += 1
		return super.aes_gcm_open(key, nonce, aad, sealed)


## R-6G B2: a responder reads no more than FIRST_MESSAGE_MAX bytes of a first message, and runs no HKDF
## or AEAD over a longer one; nothing is sent.
func _first_message_cap(t: PKeyTestContext) -> void:
	t.check("first message: the cap is the ephemeral key, a tag and 256 bytes", PKeyPeerSession.FIRST_MESSAGE_MAX == 304)
	var good := PKeyTestPeers.account_side("initiator", _a(), [_disc])
	await good.session.start()
	var real: PackedByteArray = good.out[0]
	t.check("first message: a real one is far under the cap", real.size() < 100, str(real.size()))
	var control := OpenCountingCrypto.new()
	var b := PKeyTestPeers.account_side("responder", _b(), [_disc], "", 1, {"crypto": control})
	await b.session.receive(real)
	t.check("first message: a real one is opened (the counter works)", control.opens >= 1 and not b.out.is_empty(), "%d" % control.opens)
	for n in [PKeyPeerSession.FIRST_MESSAGE_MAX + 1, 1000, PKeyPeerLink.HANDSHAKE_FRAME_MAX, 65535]:
		var counting := OpenCountingCrypto.new()
		var r := PKeyTestPeers.account_side("responder", _b(), [_disc], "", 1, {"crypto": counting})
		var big := PackedByteArray(real)
		big.resize(n)
		await r.session.receive(big)
		t.check("first message: %d bytes close peer_bad_frame, say nothing, run no AEAD or ladder" % n, \
				r.closes() == [[&"peer_bad_frame", false]] and r.out.is_empty() and counting.opens == 0 and counting.ladders == 0, \
				"%s %d %d" % [r.closes(), counting.opens, counting.ladders])
	# At the cap it is still read (and fails its tag silently).
	var edge := OpenCountingCrypto.new()
	var e := PKeyTestPeers.account_side("responder", _b(), [_disc], "", 1, {"crypto": edge})
	var at_cap := PackedByteArray(real)
	at_cap.resize(PKeyPeerSession.FIRST_MESSAGE_MAX)
	await e.session.receive(at_cap)
	t.check("first message: at the cap it is read, and a bad tag closes silently", e.closes() == [[&"handshake_failed", false]] and e.out.is_empty() and edge.opens >= 1)
	# Modes v and p are bound the same way.
	var pb := PKeyTestPeers.side("p", "responder", PKeyTestPeers.random32())
	var big_p := PackedByteArray(real)
	big_p.resize(5000)
	await pb.session.receive(big_p)
	t.check("first message: in mode p too", pb.closes() == [[&"peer_bad_frame", false]] and pb.out.is_empty())


## Counts how often a session reads the held roster, which is the first thing a RING it works on does.
class RingCounter extends RefCounted:
	var calls := 0
	var inner: Callable


	func held() -> Variant:
		calls += 1
		return inner.call()


## R-6G B4: one RING in RING_GAP_SECONDS is worked on per session; the rest are dropped without a
## parse or a verify; RING_DROP_LIMIT of them in a window close the session peer_busy.
func _ring_flood(t: PKeyTestContext) -> void:
	var ring2: String = _pair2["ring"]
	var body := PKeyJson.stringify({"ring": "not.a.jws"}).to_utf8_buffer()
	var a := PKeyTestPeers.account_side("initiator", _a(), [_disc], ring2, 2)
	var b := PKeyTestPeers.account_side("responder", _b(), [_disc], ring2, 2)
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	var counter := RingCounter.new()
	counter.inner = Callable(b, "held_ring")
	b.session._account["held_ring"] = Callable(counter, "held")
	var before := counter.calls
	a.session.send_record(PKeyPeerRecord.RING, body)
	await PKeyTestPeers.pump(a, b)
	t.check("ring flood: the first RING is worked on", counter.calls == before + 1 and b.session.is_open())
	for i in PKeyPeerSession.RING_DROP_LIMIT - 1:
		a.session.send_record(PKeyPeerRecord.RING, body)
		await PKeyTestPeers.pump(a, b)
	t.check("ring flood: the next seven are dropped, unworked, and the session stays open", counter.calls == before + 1 and b.session.is_open() and b.closes().is_empty(), str(b.closes()))
	a.session.send_record(PKeyPeerRecord.RING, body)
	await PKeyTestPeers.pump(a, b)
	t.check("ring flood: the eighth dropped closes peer_busy", b.closes() == [[&"peer_busy", false]] and counter.calls == before + 1, str(b.closes()))
	t.check("ring flood: and the sender is told", a.closes() == [[&"peer_busy", true]])
	# A window: after the gap one more is worked on, and the drop count starts again.
	a = PKeyTestPeers.account_side("initiator", _a(), [_disc], ring2, 2)
	b = PKeyTestPeers.account_side("responder", _b(), [_disc], ring2, 2)
	await a.session.start()
	await PKeyTestPeers.pump(a, b)
	counter = RingCounter.new()
	counter.inner = Callable(b, "held_ring")
	b.session._account["held_ring"] = Callable(counter, "held")
	before = counter.calls
	for i in 6:
		a.session.send_record(PKeyPeerRecord.RING, body)
		await PKeyTestPeers.pump(a, b)
	t.check("ring flood: six in a window cost one", counter.calls == before + 1 and b.session.is_open())
	b.mono_value += PKeyPeerSession.RING_GAP_SECONDS
	for i in 6:
		a.session.send_record(PKeyPeerRecord.RING, body)
		await PKeyTestPeers.pump(a, b)
	t.check("ring flood: after the gap one is worked on again, and the count starts over", counter.calls == before + 2 and b.session.is_open() and b.closes().is_empty(), str(b.closes()))
	# A real, newer roster is still taken when it is the one in the window.
	b.mono_value += PKeyPeerSession.RING_GAP_SECONDS
	var older := PKeyTestPeers.account_side("initiator", _a(), [_disc], _pair["ring"], 1)
	var newer := PKeyTestPeers.account_side("responder", _b(), [_disc], ring2, 2)
	await older.session.start()
	await PKeyTestPeers.pump(older, newer)
	t.check("ring flood: a real roster in the first window is still surfaced", older.of(&"ring").size() == 1 and older.of(&"ring")[0]["epoch"] == 2)


## N3: abort() ends a session with no CLOSE and no event, releases the approver's slot and wipes.
func _abort(t: PKeyTestContext) -> void:
	var limiter := PKeyPeerLimiter.new(5, 4)
	var m := PKeyTestPeers.side("p", "responder", PKeyTestPeers.random32(), {"admission": limiter})
	var d := PKeyTestPeers.side("p", "initiator", PKeyTestPeers.random32())
	await d.session.start()
	await m.session.receive(d.out.pop_front())
	t.check("abort: an approver holds a slot while the code is awaited", limiter.pending() == 1)
	var events := m.events.size()
	m.session.abort()
	var quiet := m.events.size() == events and m.of(&"closed").is_empty()
	t.check("abort: the slot is released, the session is closed, nothing is sent or reported", limiter.pending() == 0 and m.session.is_closed() and quiet)
	m.session.abort()
	t.check("abort: twice is nothing", limiter.pending() == 0)
	await m.session.receive(PackedByteArray([1, 2, 3]))
	t.check("abort: and a message after it is ignored", m.events.size() == events and m.out.size() == 1)
