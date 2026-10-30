extends RefCounted
# @pkey-feature connect.noise connect.protocol
# `PKeyPeerSession` in modes v (approver) and p (pair) and `PKeyPeerLimiter` (CC-14.9; WIRE-CONTRACT-V5
# section 15.5 and 15.6), ported from the mode-v and mode-p blocks of client-core's `peerSession.test.ts`:
# the commit-reveal SAS, CONFIRM, the records held until the person confirms (16 records, 16 KiB), the
# 4 KiB HELLO bound, the display-data cleaning (G3), the limiter (5 a minute, 4 waiting, a monotonic
# clock), the 30 s and 120 s deadlines, and the SAS refusals no honest peer provokes.

const SAS_RE := "^\\d{3} \\d{3}$"

var _re: RegEx


func run(t: PKeyTestContext) -> void:
	_re = RegEx.create_from_string(SAS_RE)
	await _same_code_then_records(t)
	await _held_records(t)
	await _hello_display(t)
	await _limiter(t)
	_limiter_unit(t)
	await _deadlines(t)
	await _raw_refusals(t)
	await _sas_misuse(t)


func _pair(mode: String, extra_d := {}, extra_m := {}) -> Array:
	var d := PKeyTestPeers.side(mode, "initiator", PKeyTestPeers.random32(), extra_d)
	var m := PKeyTestPeers.side(mode, "responder", PKeyTestPeers.random32(), extra_m)
	return [d, m]


func _open_pair(mode: String, hello := {}) -> Array:
	var extra := {}
	if not hello.is_empty():
		extra["hello"] = hello
	var sides := _pair(mode, extra)
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	await d.session.start()
	await PKeyTestPeers.pump(d, m)
	return sides


func _same_code_then_records(t: PKeyTestContext) -> void:
	for mode in ["v", "p"]:
		var sides := await _open_pair(mode)
		var d: PKeyTestPeers.Peer = sides[0]
		var m: PKeyTestPeers.Peer = sides[1]
		var sd := d.of(&"sas")
		var sm := m.of(&"sas")
		t.check("%s: both sides show a code" % mode, sd.size() == 1 and sm.size() == 1)
		var in_range: bool = sd[0]["code"] >= 0 and sd[0]["code"] <= 999999
		t.check("%s: both codes are the same, six digits in two triples" % mode, sd[0]["code"] == sm[0]["code"] and _re.search(sd[0]["display"]) != null and in_range, str(sd[0]))
		var est := d.of(&"established")[0]
		var caps: Array = ["app/1", "ring/1", "vouch/1"] if mode == "v" else ["app/1", "ring/1"]
		t.check("%s: the capabilities are the intersection (mode v adds vouch/1 itself)" % mode, est["caps"] == caps, str(est["caps"]))
		t.check("%s: HELLO display data is not authenticated" % mode, est["hello_authenticated"] == false and est["peer_device_id"] == "")
		t.check("%s: both share the handshake hash" % mode, d.session.handshake_hash() == m.session.handshake_hash() and d.session.handshake_hash().size() == 32)
		t.check("%s: nothing flows until the person confirms" % mode, not d.session.is_open() and d.session.send_record(PKeyPeerRecord.VOUCH_RESULT, PackedByteArray()).code == &"state")
		t.check("%s: the sas event came after established" % mode, d.events.find(est) < d.events.find(sd[0]))
		d.session.confirm_sas()
		await PKeyTestPeers.pump(d, m)
		t.check("%s: the first to confirm opens only its own side" % mode, d.session.is_open() and not m.session.is_open() and m.of(&"record").is_empty())
		m.session.confirm_sas()
		await PKeyTestPeers.pump(d, m)
		var want: Array = [PKeyPeerRecord.CONFIRM] if mode == "p" else []
		var got_m := m.of(&"record").map(func(e: Dictionary) -> int: return e["record_type"])
		var got_d := d.of(&"record").map(func(e: Dictionary) -> int: return e["record_type"])
		t.check("%s: mode p's own CONFIRM reaches the other side, mode v sends none" % mode, got_m == want and got_d == want, "%s %s" % [got_m, got_d])
		t.check("%s: both are open and the person's confirmation is final" % mode, d.session.is_open() and m.session.is_open() and d.closes().is_empty() and m.closes().is_empty())
		if mode == "p":
			t.check("p: CONFIRM is the session's to send", d.session.send_record(PKeyPeerRecord.CONFIRM, PackedByteArray()).code == &"state")
		else:
			t.check("v: the host may send a vouch record once open", d.session.send_record(PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer()).ok)
		# Confirming twice closes: the second call finds the session already open.
		d.session.confirm_sas()
		await PKeyTestPeers.pump(d, m)
		t.check("%s: a second confirm_sas() closes peer_not_allowed" % mode, d.closes() == [[&"peer_not_allowed", false]], str(d.closes()))


func _held_records(t: PKeyTestContext) -> void:
	# A record that arrives before this side's person confirms is held, not refused, then delivered.
	var sides := await _open_pair("v")
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	d.session.confirm_sas()
	d.session.send_record(PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer())
	await PKeyTestPeers.pump(d, m)
	t.check("held: an early record is held, not delivered and not refused", m.of(&"record").is_empty() and not m.session.is_closed())
	m.session.confirm_sas()
	var got := m.of(&"record")
	t.check("held: and delivered when this side confirms", got.size() == 1 and got[0]["record_type"] == PKeyPeerRecord.VOUCH_REQ)

	# 16 KiB at most before the confirmation, then peer_busy.
	sides = await _open_pair("v")
	d = sides[0]
	m = sides[1]
	d.session.confirm_sas()
	d.session.send_record(PKeyPeerRecord.VOUCH_REQ, _bytes(8 * 1024))
	await PKeyTestPeers.pump(d, m)
	t.check("held: 8 KiB is held", not m.session.is_closed())
	d.session.send_record(PKeyPeerRecord.VOUCH_REQ, _bytes(8 * 1024 + 1))
	await PKeyTestPeers.pump(d, m)
	t.check("held: over 16 KiB closes peer_busy", m.closes() == [[&"peer_busy", false]], str(m.closes()))
	t.check("held: and the sender is told", d.closes() == [[&"peer_busy", true]])

	# 16 records at most.
	sides = await _open_pair("v")
	d = sides[0]
	m = sides[1]
	d.session.confirm_sas()
	for i in 16:
		d.session.send_record(PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer())
	await PKeyTestPeers.pump(d, m)
	t.check("held: 16 records are held", not m.session.is_closed())
	d.session.send_record(PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer())
	await PKeyTestPeers.pump(d, m)
	t.check("held: the 17th closes peer_busy", m.closes() == [[&"peer_busy", false]], str(m.closes()))

	# After a close the held records are gone.
	sides = await _open_pair("v")
	d = sides[0]
	m = sides[1]
	d.session.confirm_sas()
	d.session.send_record(PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer())
	await PKeyTestPeers.pump(d, m)
	m.session.close()
	m.session.confirm_sas()
	t.check("held: a closed session delivers nothing", m.of(&"record").is_empty() and m.session.is_closed())


static func _bytes(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	return b


## Opens a pair whose requester's HELLO is `hello`, and answers the responder's `established` event.
func _established(mode: String, hello: Dictionary) -> Dictionary:
	var sides := _pair(mode, {"hello": hello})
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	await d.session.start()
	await PKeyTestPeers.pump(d, m)
	var est := m.of(&"established")
	return est[0] if est.size() == 1 else {}


func _hello_display(t: PKeyTestContext) -> void:
	var est := await _established("v", {"platform": "t", "app": "a", "label": "  Café \u202eTV\ufffd  "})
	t.check("hello: the label is cleaned (controls, bidi and the replacement character gone)", est.get("hello", {}).get("label", "") == "Café TV", str(est.get("hello", {})))
	t.check("hello: and marked unauthenticated", est.get("hello_authenticated", true) == false)
	var rows := [
		["macos", "Demo", "macos", "Demo"],
		["Android 14.1_x+y-z", "a", "Android 14.1_x+y-z", "a"],
		["x".repeat(33), "a", "Unknown", "a"],
		["<b>ok</b>", "a", "Unknown", "a"],
		["mac\u202eos", "a", "Unknown", "a"],
		["", "a", "Unknown", "a"],
		["linux", "  Pay\u202e\ufffdment  ", "linux", "Payment"],
		["linux", "\u202e\ufffd", "linux", "Unknown"],
		["linux", "a".repeat(100), "linux", "a".repeat(64)],
	]
	for row in rows:
		var e := await _established("v", {"platform": row[0], "app": row[1]})
		var shown: Array = [e.get("hello", {}).get("platform"), e.get("hello", {}).get("app")]
		t.check("hello: platform %s and app %s are shown as %s and %s" % [str(row[0]).left(12), str(row[1]).left(12), row[2], str(row[3]).left(12)], shown == [row[2], row[3]], str(shown))
	# The label: cut to 64 code points; an empty one is left out.
	_check_label(t, await _established("p", {"platform": "t", "app": "a", "label": "x".repeat(100)}), "x".repeat(64), "a 100-character label is cut to 64")
	var none := await _established("p", {"platform": "t", "app": "a", "label": "\u202e"})
	t.check("hello: a label with nothing left is left out", none.get("hello", {"label": 1}).has("label") == false)

	# 4 KiB at most in modes v and p.
	for mode in ["v", "p"]:
		var big := _pair(mode, {"hello": {"platform": "t", "app": "a", "label": "x".repeat(4100)}})
		var d: PKeyTestPeers.Peer = big[0]
		var m: PKeyTestPeers.Peer = big[1]
		await d.session.start()
		await PKeyTestPeers.pump(d, m)
		t.check("hello: a HELLO over 4 KiB in mode %s is refused before it is established" % mode, m.of(&"established").is_empty() and m.closes() == [[&"peer_bad_frame", false]], str(m.closes()))
	var ok := await _established("v", {"platform": "t", "app": "a", "label": "x".repeat(4000)})
	t.check("hello: 4000 bytes of label fit (cut to 64 for display)", ok.has("hello") and ok["hello"]["label"] == "x".repeat(64))


func _check_label(t: PKeyTestContext, est: Dictionary, want: String, name: String) -> void:
	t.check("hello: " + name, est.get("hello", {}).get("label", "") == want, str(est.get("hello", {}).get("label", "")).left(70))


func _limiter(t: PKeyTestContext) -> void:
	var now := [0.0]
	var clock := func() -> float: return now[0]
	var lim := PKeyPeerLimiter.new(5, 2, clock)
	var mk := func() -> PKeyTestPeers.Peer: return PKeyTestPeers.side("v", "responder", PKeyTestPeers.random32(), {"admission": lim})
	var hello := func() -> Array:
		var m: PKeyTestPeers.Peer = mk.call()
		var d := PKeyTestPeers.side("v", "initiator", PKeyTestPeers.random32())
		await d.session.start()
		await PKeyTestPeers.pump(d, m)
		return [d, m]
	var one: Array = await hello.call()
	await hello.call()
	t.check("limiter: two sessions wait on a code", lim.pending() == 2)
	var third: PKeyTestPeers.Peer = mk.call()
	var d3 := PKeyTestPeers.side("v", "initiator", PKeyTestPeers.random32())
	await d3.session.start()
	await PKeyTestPeers.pump(d3, third)
	t.check("limiter: a third is refused at its first message, silently", third.out.is_empty() and third.closes() == [[&"peer_busy", false]], str(third.closes()))
	var m1: PKeyTestPeers.Peer = one[1]
	m1.session.confirm_sas()
	t.check("limiter: a confirmation frees the slot", lim.pending() == 1)
	# The minute window: 5 admitted in the last minute, the sixth is refused whatever is waiting.
	var lim2 := PKeyPeerLimiter.new(5, 99, clock)
	var tickets := []
	for i in 6:
		tickets.append(lim2.begin())
	t.check("limiter: five a minute, the sixth refused", tickets.slice(0, 5).all(func(x: Variant) -> bool: return x != null) and tickets[5] == null)
	now[0] = 61.0
	t.check("limiter: and a minute later it is open again", lim2.begin() != null)
	# A session that ends releases its slot too.
	var lim3 := PKeyPeerLimiter.new(5, 1, clock)
	var m: PKeyTestPeers.Peer = PKeyTestPeers.side("v", "responder", PKeyTestPeers.random32(), {"admission": lim3})
	var d := PKeyTestPeers.side("v", "initiator", PKeyTestPeers.random32())
	await d.session.start()
	await PKeyTestPeers.pump(d, m)
	t.check("limiter: one waits", lim3.pending() == 1)
	d.session.close()
	await PKeyTestPeers.pump(d, m)
	t.check("limiter: a session that ends releases its slot", lim3.pending() == 0)


func _limiter_unit(t: PKeyTestContext) -> void:
	var now := [0.0]
	var l := PKeyPeerLimiter.new(5, 99, func() -> float: return now[0])
	var verdicts := []
	for i in 6:
		verdicts.append(l.begin() != null)
	t.check("limiter: five handshakes a minute on a monotonic clock", verdicts == [true, true, true, true, true, false], str(verdicts))
	now[0] = 61.0
	t.check("limiter: sixty seconds later it admits again", l.begin() != null)
	var one := PKeyPeerLimiter.new(5, 1)
	var ticket := one.begin()
	t.check("limiter: with the engine's clock, a ticket holds the one waiting slot", ticket != null and one.begin() == null)
	ticket.release()
	ticket.release()
	t.check("limiter: release is idempotent", one.pending() == 0)
	t.check("limiter: str() shows nothing", str(one) == "PKeyPeerLimiter()" and str(ticket) == "PKeyPeerLimiter.Ticket()")


func _deadlines(t: PKeyTestContext) -> void:
	# The transport: 30 s from the first message.
	var sides := _pair("v")
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	await d.session.start()
	await m.session.receive(d.out.pop_front())
	m.mono_value = 30.0
	m.session.tick()
	t.check("deadline: a transport that takes 30 s closes peer_timeout, with no CLOSE to send", m.closes() == [[&"peer_timeout", false]] and m.out.size() == 1)
	# The code: 120 s from the first message, whether or not the transport is up.
	sides = await _open_pair("v")
	d = sides[0]
	m = sides[1]
	m.mono_value = 119.9
	m.session.tick()
	t.check("deadline: 119.9 s and no confirmation is still open", m.closes().is_empty())
	m.mono_value = 120.0
	m.session.tick()
	await PKeyTestPeers.pump(d, m)
	t.check("deadline: 120 s closes peer_timeout and says so", m.closes() == [[&"peer_timeout", false]] and d.closes() == [[&"peer_timeout", true]], "%s %s" % [m.closes(), d.closes()])
	# A confirmation ends the deadline.
	sides = await _open_pair("v")
	d = sides[0]
	m = sides[1]
	m.session.confirm_sas()
	m.mono_value = 100000.0
	m.session.tick()
	t.check("deadline: a confirmed session has no code deadline", m.closes().is_empty())


## A raw Noise initiator in `mode` against a session responder: {tp, hash}. The responder's HELLO is
## left in `side.out`; the raw peer sends its own when `hello` is true.
func _raw_open(side: PKeyTestPeers.Peer, mode: String, caps: Array, hello := true) -> Dictionary:
	var hs: PKeyPeerNoise.Handshake = PKeyPeerNoise.start("initiator", PKeyPeerNoise.protocol_name(mode), PKeyPeerNoise.prologue(PKeyTestPeers.SLUG, mode), PKeyTestPeers.random32()).detail
	await side.session.receive(hs.write_message(PKeyPeerPayload.payload1()).detail)
	if side.out.is_empty() or not hs.read_message(side.out.pop_front()).ok:
		return {}
	await side.session.receive(hs.write_message(PKeyPeerPayload.payload23(mode, caps)).detail)
	var hash := hs.handshake_hash()
	var tp: PKeyPeerNoise.Transport = hs.transport().detail
	var raw := {"tp": tp, "hash": hash}
	if hello:
		await _raw_send(raw, side, PKeyPeerRecord.HELLO, PKeyPeerPayload.hello_body("", "t", "a", 1048576))
	return raw


func _raw_send(raw: Dictionary, side: PKeyTestPeers.Peer, type: int, body: PackedByteArray) -> void:
	var tp: PKeyPeerNoise.Transport = raw["tp"]
	await side.session.receive(tp.send.encrypt(PackedByteArray(), PKeyPeerRecord.encode(type, 0, body)).detail)


func _raw_records(raw: Dictionary, side: PKeyTestPeers.Peer) -> Array:
	var tp: PKeyPeerNoise.Transport = raw["tp"]
	var out := []
	for msg in side.out:
		var plain := tp.receive.decrypt(PackedByteArray(), msg)
		var rec := PKeyPeerRecord.parse(plain.detail) if plain.ok else {"type": -1, "body": PackedByteArray()}
		out.append([rec["type"], rec["body"]])
	side.out.clear()
	return out


func _responder(mode: String) -> PKeyTestPeers.Peer:
	return PKeyTestPeers.side(mode, "responder", PKeyTestPeers.random32())


func _raw_refusals(t: PKeyTestContext) -> void:
	# The first record each way is HELLO, in mode p too; the CLOSE names the code.
	var m := _responder("p")
	var raw := await _raw_open(m, "p", [], false)
	await _raw_send(raw, m, PKeyPeerRecord.PING, _bytes(8))
	t.check("raw: a PING instead of HELLO closes peer_bad_frame", m.closes() == [[&"peer_bad_frame", false]] and m.of(&"established").is_empty())
	var recs := _raw_records(raw, m)
	var named: bool = recs.size() == 2 and recs[1][0] == PKeyPeerRecord.CLOSE and (recs[1][1] as PackedByteArray).get_string_from_utf8() == "{\"code\":\"peer_bad_frame\"}"
	t.check("raw: HELLO then CLOSE naming the code", named and recs[0][0] == PKeyPeerRecord.HELLO)

	# Mode v needs vouch/1 on both sides; without it the session closes before any SAS record.
	m = _responder("v")
	raw = await _raw_open(m, "v", ["app/1"])
	t.check("raw: a peer without vouch/1 closes peer_not_allowed, not established", m.closes() == [[&"peer_not_allowed", false]] and m.of(&"established").is_empty(), str(m.closes()))
	recs = _raw_records(raw, m)
	var types := recs.map(func(r: Array) -> int: return r[0])
	t.check("raw: its own HELLO then CLOSE, no SAS record", types == [PKeyPeerRecord.HELLO, PKeyPeerRecord.CLOSE], str(types))
	# Mode p does not ask for it.
	m = _responder("p")
	raw = await _raw_open(m, "p", ["app/1"])
	t.check("raw: mode p needs no vouch/1", m.of(&"established").size() == 1)

	# A garbage handshake payload and a payload with a certificate in mode v are refused.
	m = _responder("v")
	var hs: PKeyPeerNoise.Handshake = PKeyPeerNoise.start("initiator", PKeyPeerNoise.protocol_name("v"), PKeyPeerNoise.prologue(PKeyTestPeers.SLUG, "v"), PKeyTestPeers.random32()).detail
	await m.session.receive(hs.write_message("{\"v\":1,\"cert\":\"x\"}".to_utf8_buffer()).detail)
	t.check("raw: a message 1 payload that carries a certificate is refused", m.out.is_empty() and m.closes() == [[&"handshake_failed", false]])
	m = _responder("v")
	hs = PKeyPeerNoise.start("initiator", PKeyPeerNoise.protocol_name("v"), PKeyPeerNoise.prologue(PKeyTestPeers.SLUG, "v"), PKeyTestPeers.random32()).detail
	await m.session.receive(hs.write_message(PKeyPeerPayload.payload1()).detail)
	hs.read_message(m.out.pop_front())
	await m.session.receive(hs.write_message("{\"v\":1}".to_utf8_buffer()).detail)
	t.check("raw: a message 3 payload without caps is refused", m.of(&"established").is_empty() and m.closes() == [[&"handshake_failed", false]])

	# Records of other modes are not allowed.
	for pair in [["p", PKeyPeerRecord.RING], ["p", PKeyPeerRecord.TRUST], ["v", PKeyPeerRecord.CONFIRM], ["v", PKeyPeerRecord.CONTACT], ["p", PKeyPeerRecord.VOUCH_REQ]]:
		m = _responder(pair[0])
		raw = await _raw_open(m, pair[0], ["vouch/1"] if pair[0] == "v" else [])
		await _raw_send(raw, m, pair[1], _bytes(0))
		t.check("raw: record 0x%04x in mode %s closes peer_not_allowed" % [pair[1], pair[0]], m.closes() == [[&"peer_not_allowed", false]], str(m.closes()))
	# A host record before the code is shown is not allowed (the person has nothing to confirm yet).
	m = _responder("p")
	raw = await _raw_open(m, "p", [])
	await _raw_send(raw, m, 0x0100, "x".to_utf8_buffer())
	t.check("raw: a host record before the SAS is shown closes peer_not_allowed", m.closes() == [[&"peer_not_allowed", false]], str(m.closes()))


func _sas_misuse(t: PKeyTestContext) -> void:
	# The code is an HKDF of the handshake hash and both nonces: recompute it as an independent peer.
	var m := _responder("p")
	var raw := await _raw_open(m, "p", [])
	var n_d := PKeyTestPeers.random32()
	await _raw_send(raw, m, PKeyPeerRecord.SAS_COMMIT, PKeyPeerSas.body("c", PKeyPeerSas.commit(n_d)))
	var recs := _raw_records(raw, m)
	var nonce_rec: Array = recs.back()
	t.check("sas: the responder answers a COMMIT with its nonce", nonce_rec[0] == PKeyPeerRecord.SAS_NONCE)
	var n_m: Variant = PKeyPeerSas.parse_body("nM", nonce_rec[1])
	t.check("sas: the nonce is the canonical one-member body", n_m != null)
	await _raw_send(raw, m, PKeyPeerRecord.SAS_REVEAL, PKeyPeerSas.body("nD", n_d))
	var shown := m.of(&"sas")
	var want := PKeyPeerSas.value(raw["hash"], n_d, n_m, "p")
	t.check("sas: the code is the independent HKDF of the hash and both nonces", shown.size() == 1 and shown[0]["code"] == want, str(shown))

	# A reveal that does not match its commitment is a bad frame.
	m = _responder("p")
	raw = await _raw_open(m, "p", [])
	await _raw_send(raw, m, PKeyPeerRecord.SAS_COMMIT, PKeyPeerSas.body("c", PKeyPeerSas.commit(n_d)))
	await _raw_send(raw, m, PKeyPeerRecord.SAS_REVEAL, PKeyPeerSas.body("nD", PKeyTestPeers.random32()))
	t.check("sas: a reveal that does not match the commitment closes peer_bad_frame", m.closes() == [[&"peer_bad_frame", false]] and m.of(&"sas").is_empty(), str(m.closes()))
	# A reveal with no commit, a second commit, a nonce sent to the responder and a malformed body.
	var cases := {
		"a REVEAL before any COMMIT": [[PKeyPeerRecord.SAS_REVEAL, PKeyPeerSas.body("nD", n_d)]],
		"a second COMMIT": [[PKeyPeerRecord.SAS_COMMIT, PKeyPeerSas.body("c", PKeyPeerSas.commit(n_d))], [PKeyPeerRecord.SAS_COMMIT, PKeyPeerSas.body("c", PKeyPeerSas.commit(n_d))]],
		"a NONCE sent to the responder": [[PKeyPeerRecord.SAS_NONCE, PKeyPeerSas.body("nM", n_d)]],
		"a COMMIT of the wrong member": [[PKeyPeerRecord.SAS_COMMIT, PKeyPeerSas.body("nD", n_d)]],
		"a COMMIT that is not canonical": [[PKeyPeerRecord.SAS_COMMIT, "{\"c\":\"abc\"}".to_utf8_buffer()]],
		"a COMMIT with an extra member": [[PKeyPeerRecord.SAS_COMMIT, ("{\"c\":\"%s\",\"x\":1}" % PKeyPeerSas.encode_value(PKeyPeerSas.commit(n_d))).to_utf8_buffer()]],
	}
	for name in cases:
		m = _responder("p")
		raw = await _raw_open(m, "p", [])
		for rec in cases[name]:
			await _raw_send(raw, m, rec[0], rec[1])
		t.check("sas: %s closes peer_bad_frame" % name, m.closes() == [[&"peer_bad_frame", false]], str(m.closes()))
	# After the code is shown, another SAS record is refused.
	m = _responder("p")
	raw = await _raw_open(m, "p", [])
	await _raw_send(raw, m, PKeyPeerRecord.SAS_COMMIT, PKeyPeerSas.body("c", PKeyPeerSas.commit(n_d)))
	await _raw_send(raw, m, PKeyPeerRecord.SAS_REVEAL, PKeyPeerSas.body("nD", n_d))
	await _raw_send(raw, m, PKeyPeerRecord.SAS_REVEAL, PKeyPeerSas.body("nD", n_d))
	t.check("sas: a second REVEAL after the code is shown closes peer_bad_frame", m.of(&"sas").size() == 1 and m.closes() == [[&"peer_bad_frame", false]])

	# confirm_sas() before the code is shown closes peer_not_allowed.
	var early := _responder("p")
	await _raw_open(early, "p", [])
	early.session.confirm_sas()
	t.check("sas: confirm_sas() before the code closes peer_not_allowed", early.closes() == [[&"peer_not_allowed", false]], str(early.closes()))

	# The initiator against a raw responder: its code is the same independent HKDF, and a nonce or
	# reveal that is not the next step closes the session.
	var d := PKeyTestPeers.side("p", "initiator", PKeyTestPeers.random32())
	var peer := await _raw_responder(d, "p", [])
	t.check("sas: the initiator commits first", _raw_records(peer, d).back()[0] == PKeyPeerRecord.SAS_COMMIT)
	var n_m2 := PKeyTestPeers.random32()
	await _raw_send(peer, d, PKeyPeerRecord.SAS_NONCE, PKeyPeerSas.body("nM", n_m2))
	var revealed: Array = _raw_records(peer, d).back()
	t.check("sas: it reveals its nonce on the responder's", revealed[0] == PKeyPeerRecord.SAS_REVEAL)
	var n_d2: Variant = PKeyPeerSas.parse_body("nD", revealed[1])
	var seen := d.of(&"sas")
	t.check("sas: and shows the independent code", n_d2 != null and seen.size() == 1 and seen[0]["code"] == PKeyPeerSas.value(peer["hash"], n_d2, n_m2, "p"), str(seen))
	for pair in [[PKeyPeerRecord.SAS_REVEAL, PKeyPeerSas.body("nD", n_m2)], [PKeyPeerRecord.SAS_NONCE, "{\"nM\":\"short\"}".to_utf8_buffer()], [PKeyPeerRecord.SAS_COMMIT, PKeyPeerSas.body("c", n_m2)]]:
		d = PKeyTestPeers.side("p", "initiator", PKeyTestPeers.random32())
		peer = await _raw_responder(d, "p", [])
		await _raw_send(peer, d, pair[0], pair[1])
		t.check("sas: record 0x%04x sent to the initiator closes peer_bad_frame" % pair[0], d.closes() == [[&"peer_bad_frame", false]] and d.of(&"sas").is_empty(), str(d.closes()))


## A raw Noise responder against an initiator session: {tp, hash}. The initiator's HELLO is read
## off and its SAS_COMMIT is the last record in `side.out`.
func _raw_responder(side: PKeyTestPeers.Peer, mode: String, caps: Array) -> Dictionary:
	await side.session.start()
	var hs: PKeyPeerNoise.Handshake = PKeyPeerNoise.start("responder", PKeyPeerNoise.protocol_name(mode), PKeyPeerNoise.prologue(PKeyTestPeers.SLUG, mode), PKeyTestPeers.random32()).detail
	hs.read_message(side.out.pop_front())
	await side.session.receive(hs.write_message(PKeyPeerPayload.payload23(mode, caps)).detail)
	hs.read_message(side.out.pop_front())
	var hash := hs.handshake_hash()
	var raw := {"tp": hs.transport().detail, "hash": hash}
	await _raw_send(raw, side, PKeyPeerRecord.HELLO, PKeyPeerPayload.hello_body("", "t", "a", 1048576))
	return raw
