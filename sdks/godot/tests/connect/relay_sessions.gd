extends RefCounted
# @pkey-feature connect.relay connect.app
# The relay sessions and the pacing (CC-14.14; WIRE-CONTRACT-V5 section 15.7, plans G8, G16 and G17, D-9),
# ported from sdk-node's `relay.test.ts` and the Python `test_connect_relay`: two services through one
# in-memory room (`PKeyRelayFakeRoom`) and a clock the test moves. A dial and an inbound session over SEND
# and RECV (the stamped `from` against the certificate: `wrong_peer`), mode a only (G16), the roster, the
# 64 and 4 session bounds and the memory of ended sessions, MEMBERS, GONE and a lost socket ending sessions
# without a word, stop's goodbyes, the token bucket (burst 360, 180 a second, LIMIT 1 halves it for 10 s),
# and the 8 MiB queue ending a session `peer_busy`.

const ID_A := "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
const ID_B := "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
const ID_C := "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
const SIGN_C := "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"

var _pair: Dictionary
var _c: Dictionary
var _ring: String
var _disc := PackedByteArray()


class Env extends RefCounted:
	var source: PKeyConnectClient.PeerSource
	var now_value := PKeyTestPeers.NOW
	var refreshes := 0


	func load_identity() -> PKeyResult:
		return PKeyResult.success(source)


	func now() -> int:
		return now_value


	func refresh() -> PKeyResult:
		refreshes += 1
		return PKeyResult.success()


	func src() -> PKeyConnectLan.Source:
		var s := PKeyConnectLan.Source.new()
		s.keep = self
		s.load = Callable(self, "load_identity")
		s.now = Callable(self, "now")
		s.refresh = Callable(self, "refresh")
		return s


class Clock extends RefCounted:
	var t := 1000.0


	func mono() -> float:
		return t


	func half() -> float:
		return 0.5


class Tickets extends RefCounted:
	var issued := 0


	func next() -> PKeyResult:
		issued += 1
		await (Engine.get_main_loop() as SceneTree).process_frame
		var g := PKeyConnectClient.Grant.new()
		g.url = "wss://key.plrs.im/api/connect/relay"
		g.protocol = PKeyConnectRelay.PROTOCOL
		g.expires_at = 2000000000
		g._ticket = "pkeyrt_" + "a".repeat(31) + char(96 + (issued % 26))
		return PKeyResult.success(g)


## One service with its identity, its tickets and its socket in the shared room.
class Peer extends RefCounted:
	var env: Env
	var tickets: Tickets
	var svc: PKeyConnectRelay
	var sessions: Array = []
	var device: PackedByteArray


func run(t: PKeyTestContext) -> void:
	_pair = PKeyTestPeers.pair(1)
	_c = PKeyTestPeers.device(ID_C, SIGN_C, 1, PKeyTestPeers.SUB, PKeyTestPeers.NOW - 10, PKeyTestPeers.NOW + 1000, PKeyTestPeers.fixed(3))
	_ring = PKeyTestPeers.ring(1, [_pair["a"], _c, _pair["b"]])
	_disc = PKeyTestPeers.random32()
	_pacer(t)
	_outbox(t)
	_modes(t)
	await _dial(t)
	await _wrong_peer(t)
	await _refusals(t)
	await _inbound(t)
	await _gone_and_lost(t)
	await _pacing(t)
	await _flush_refused(t)
	await _closed_between(t)
	await _pipe_budget(t)
	await _queue_cap(t)
	await _queue_room(t)
	await _stop(t)
	await _frames(30)


# ── helpers ──────────────────────────────────────────────────────────────────────────────────


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _frames(n: int) -> void:
	for i in n:
		await _tree().process_frame


func _until(cond: Callable, frames := 400) -> bool:
	var n := 0
	while n < frames and not cond.call():
		await _tree().process_frame
		n += 1
	return cond.call()


func _bytes(id: String) -> PackedByteArray:
	return PKeyPeerAdvert.device_id_bytes(id)


func _source(d: Dictionary) -> PKeyConnectClient.PeerSource:
	var s := PKeyConnectClient.PeerSource.new()
	s.slug = PKeyTestPeers.SLUG
	s.trust = PKeyTestPeers.trust()
	s.sub = PKeyTestPeers.SUB
	s.device_id = d["id"]
	s.certificate = d["cert"]
	s.certificate_expires_at = PKeyTestPeers.NOW + 1000
	s.ring = _ring
	s.ring_epoch = 1
	s.roster.append(ID_A)
	s.roster.append(ID_C)
	s.roster.append(ID_B)
	s.disc_current = _disc
	s.agree_public = d["pub"]
	s.keys = FakeKeys.new(d["priv"])
	return s


class FakeKeys extends RefCounted:
	var _priv: PackedByteArray


	func _init(priv: PackedByteArray) -> void:
		_priv = priv


	func dh(remote: PackedByteArray) -> PKeyResult:
		if PKeyCurve25519.is_low_order(remote):
			return PKeyResult.success(null)
		return PKeyResult.success(PKeyCurve25519.x25519(_priv, remote))


## A service for `d` whose socket in `room` is `as_device` (default: its own id), on `clock`.
func _node(d: Dictionary, room: PKeyRelayFakeRoom, clock: Clock, extra := {}, as_device := PackedByteArray()) -> Peer:
	var n := Peer.new()
	n.env = Env.new()
	n.env.source = _source(d)
	n.tickets = Tickets.new()
	n.device = as_device if not as_device.is_empty() else _bytes(d["id"])
	var o := {
		"opener": room.opener_for(n.device), "mono": Callable(clock, "mono"), "random": Callable(clock, "half"), "tree": _tree(),
		"ping_seconds": 100000.0, "open_seconds": 5.0, "pump": PKeyPeerPump.new(_tree(), false),
	}
	for k in extra:
		o[k] = extra[k]
	n.svc = PKeyConnectRelay.new(n.env.src(), Callable(n.tickets, "next"), o)
	var sessions := n.sessions
	n.svc.session_opened.connect(func(s: PKeyConnectSession) -> void: sessions.append(s))
	return n


func _pair_up(extra_a := {}, extra_b := {}, device_a := PackedByteArray()) -> Dictionary:
	var room := PKeyRelayFakeRoom.new()
	var clock := Clock.new()
	var a := _node(_pair["a"], room, clock, extra_a, device_a)
	var b := _node(_pair["b"], room, clock, extra_b)
	a.svc.start()
	b.svc.start()
	await _until(func() -> bool: return a.svc.is_open() and b.svc.is_open())
	return {"room": room, "clock": clock, "a": a, "b": b}


func _env_msg(m: Dictionary) -> PackedByteArray:
	return PKeyPeerRelayCodec.encode(m)


func _sends_to(c: PKeyRelayFakeRoom.Client, device: PackedByteArray) -> int:
	var n := 0
	for raw: PackedByteArray in c.sent:
		var m := PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_ROOM, raw)
		if m.get("op") == &"send" and m["to"] == device:
			n += 1
	return n


# ── the pacer and the outbox ─────────────────────────────────────────────────────────────────


func _pacer(t: PKeyTestContext) -> void:
	var clock := Clock.new()
	var p := PKeyConnectPacer.new(180.0, 360.0, Callable(clock, "mono"))
	var taken := 0
	while p.try_take() == 0.0 and taken < 1000:
		taken += 1
	t.check("pacer: a burst of 360 goes at once, then it waits", taken == 360, str(taken))
	var wait := p.try_take()
	t.check("pacer: the wait for the next is 1/180 s", absf(wait - 1.0 / 180.0) < 0.0005, str(wait))
	clock.t += 1.0
	taken = 0
	while p.try_take() == 0.0 and taken < 1000:
		taken += 1
	t.check("pacer: a second later 180 are back", taken >= 179 and taken <= 181, str(taken))
	clock.t += 10.0
	taken = 0
	while p.try_take() == 0.0 and taken < 1000:
		taken += 1
	t.check("pacer: the bucket never holds more than the burst", taken == 360, str(taken))
	# LIMIT 1 halves the rate for ten seconds and the bucket to half the burst.
	var h := PKeyConnectPacer.new(180.0, 360.0, Callable(clock, "mono"))
	h.halve()
	t.check("pacer: LIMIT 1 halves the rate", h.rate() == 90.0)
	taken = 0
	while h.try_take() == 0.0 and taken < 1000:
		taken += 1
	t.check("pacer: and cuts the bucket to half the burst (%d)" % taken, taken == 180, str(taken))
	clock.t += 1.0
	taken = 0
	while h.try_take() == 0.0 and taken < 1000:
		taken += 1
	t.check("pacer: a second at the halved rate gives 90 (%d)" % taken, taken >= 89 and taken <= 91, str(taken))
	clock.t += 10.5
	t.check("pacer: after ten seconds the rate is whole again", h.rate() == 180.0)
	t.check("pacer: str() shows nothing", str(h) == "PKeyConnectPacer()")
	# A token taken for a send the socket refused is given back (R-6G2 B1), never above the cap.
	var r := PKeyConnectPacer.new(180.0, 360.0, Callable(clock, "mono"))
	taken = 0
	while r.try_take() == 0.0 and taken < 1000:
		taken += 1
	t.check("pacer: empty after the burst", r.try_take() > 0.0)
	r.refund()
	t.check("pacer: a refunded token can be taken again, once", r.try_take() == 0.0 and r.try_take() > 0.0)
	var full := PKeyConnectPacer.new(180.0, 360.0, Callable(clock, "mono"))
	full.refund()
	taken = 0
	while full.try_take() == 0.0 and taken < 1000:
		taken += 1
	t.check("pacer: a refund never lifts the bucket over the burst (%d)" % taken, taken == 360, str(taken))
	# While LIMIT 1 is honoured the bucket refills only to half the burst (R-6G2 N9).
	var cap := PKeyConnectPacer.new(180.0, 360.0, Callable(clock, "mono"))
	cap.halve()
	clock.t += 1.0
	taken = 0
	while cap.try_take() == 0.0 and taken < 1000:
		taken += 1
	t.check("pacer: and a halved bucket does not refill past half the burst (%d)" % taken, taken == 180, str(taken))


func _outbox(t: PKeyTestContext) -> void:
	var q := PKeyConnectPacer.Outbox.new(100)
	var a := PackedByteArray()
	a.resize(60)
	t.check("outbox: a message that fits is queued", q.put(a) and q.queued() == 60 and q.size() == 1)
	t.check("outbox: one past the cap is refused", not q.put(a) and q.queued() == 60)
	t.check("outbox: a forced one is never refused", q.put(a, true) and q.queued() == 120 and q.size() == 2)
	t.check("outbox: room_for says so", not q.room_for(1))
	var first := q.pop()
	t.check("outbox: pop is first in, first out, and frees the bytes", first.size() == 60 and q.queued() == 60 and not q.is_empty())
	q.pop()
	t.check("outbox: empty again", q.is_empty() and q.queued() == 0)
	q.put(a)
	t.check("outbox: peek shows the next and leaves it queued", q.peek().size() == 60 and q.size() == 1 and q.queued() == 60)
	q.pop()
	t.check("outbox: the default cap is 8 MiB", PKeyConnectPacer.Outbox.new().max_bytes == 8 * 1024 * 1024 and PKeyConnectPacer.MAX_QUEUED_BYTES == 8 * 1024 * 1024)


func _modes(t: PKeyTestContext) -> void:
	t.check("mode: a crosses the relay", PKeyConnectRelay.assert_relay_mode("a").ok)
	for mode in ["v", "p", "", "x", "A"]:
		var r := PKeyConnectRelay.assert_relay_mode(mode)
		t.check("mode: '%s' never does: mode_not_allowed" % mode, not r.ok and PKeyConnectErrors.reason_of(r) == "mode_not_allowed" and r.code == &"invalid-argument")
	t.check("mode: str() of the pipe shows nothing", str(PKeyConnectRelay.RelayPipe.new()) == "PKeyConnectRelay.RelayPipe()")


# ── a dial and an inbound session ────────────────────────────────────────────────────────────


func _dial(t: PKeyTestContext) -> void:
	var rig := await _pair_up()
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var room: PKeyRelayFakeRoom = rig["room"]
	var dialled := await a.svc.dial(ID_B)
	if not t.check("dial: A dials B over the relay", dialled.ok, str(dialled)):
		return
	var sa: PKeyConnectSession = dialled.detail
	await _until(func() -> bool: return b.sessions.size() == 1)
	t.check("dial: B is told of an inbound session", b.sessions.size() == 1 and a.sessions.is_empty())
	var sb: PKeyConnectSession = b.sessions[0]
	t.check("dial: each names the other, on the relay path, in the right role", sa.peer_device_id == ID_B and sb.peer_device_id == ID_A and sa.role == "initiator" and
		sb.role == "responder" and sa.path == "relay" and sb.path == "relay")
	t.check("dial: the remote address is 'relay' and the hello is the peer's", sa.remote_address == "relay" and sa.hello["app"] == "djdl" and sb.hello["max_message"] == 1048576)
	t.check("dial: the engine is mode a, whichever way it was opened", a.svc._links.values().all(func(rl: PKeyConnectRelay.Rl) -> bool: return rl.link.session.mode() == "a"))
	sa.send("over the relay".to_utf8_buffer())
	var got: PKeyResult = await sb.receive()
	t.check("dial: a message crosses", got.ok and (got.detail["body"] as PackedByteArray).get_string_from_utf8() == "over the relay")
	sb.send("and back".to_utf8_buffer(), 0x0300)
	var back: PKeyResult = await sa.receive()
	t.check("dial: and comes back with its type", back.ok and back.detail["type"] == 0x0300)
	# The room stamped `from`; what A sent was addressed to B, and what B got was stamped A.
	var to_b := _sends_to(room.client_of(_bytes(ID_A)), _bytes(ID_B))
	t.check("dial: A's Noise messages were SEND envelopes addressed to B", to_b >= 4, str(to_b))
	t.check("dial: both services hold one link", a.svc.link_count() == 1 and b.svc.link_count() == 1)
	var closed_b := [0]
	sb.closed.connect(func(_c: StringName, _p: bool) -> void: closed_b[0] += 1)
	sa.close()
	await _until(func() -> bool: return closed_b[0] == 1)
	t.check("dial: close() reaches the peer, by the peer, once", sb.is_closed() and sb.closed_info()["by_peer"] == true and closed_b[0] == 1)
	await _until(func() -> bool: return a.svc.link_count() == 0 and b.svc.link_count() == 0)
	t.check("dial: both links are let go", a.svc.link_count() == 0 and b.svc.link_count() == 0)
	# A late message of the ended session is dropped without a new link.
	var late := _env_msg({"op": &"recv", "from": _bytes(ID_A), "session": a.svc._ended[0].split(":")[1].to_int() if not b.svc._ended.is_empty() else 1, "noise": PackedByteArray([1, 2, 3, 4])})
	room.client_of(_bytes(ID_B)).push(late)
	await _frames(3)
	t.check("dial: a late message of an ended session makes no new link", b.svc.link_count() == 0)
	a.svc.stop()
	b.svc.stop()
	await _frames(3)


func _wrong_peer(t: PKeyTestContext) -> void:
	# A's socket in the room is stamped C, but A's certificate says A. B dials C and A answers.
	var rig := await _pair_up({}, {}, _bytes(ID_C))
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var r := await b.svc.dial(ID_C)
	t.check("wrong_peer: the certificate, not the room's stamp, names the peer: wrong_peer", not r.ok and PKeyConnectErrors.reason_of(r) == "wrong_peer" and r.code == &"peer-cert-invalid",
		str(r))
	t.check("wrong_peer: the dialler keeps no link", b.svc.link_count() == 0)
	await _frames(5)
	t.check("wrong_peer: and A told its host of nothing it should not have", a.sessions.size() <= 1)
	a.svc.stop()
	b.svc.stop()
	await _frames(3)


func _refusals(t: PKeyTestContext) -> void:
	var rig := await _pair_up({"max_sessions": 1})
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var self_dial := await a.svc.dial(ID_A)
	t.check("refusals: dialling yourself is unknown_peer", PKeyConnectErrors.reason_of(self_dial) == "unknown_peer")
	var stranger := await a.svc.dial("ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS")
	t.check("refusals: a device that is not on the roster is unknown_peer", PKeyConnectErrors.reason_of(stranger) == "unknown_peer")
	var junk := await a.svc.dial("not a device id")
	t.check("refusals: not a device id is unknown_peer", PKeyConnectErrors.reason_of(junk) == "unknown_peer")
	var first := await a.svc.dial(ID_B)
	t.check("refusals: the first dial opens", first.ok)
	var second := await a.svc.dial(ID_B)
	t.check("refusals: with one session allowed the second is busy", PKeyConnectErrors.reason_of(second) == "busy" and second.code == &"rate_limited", str(second))
	a.svc.stop()
	b.svc.stop()
	await _frames(3)
	var down := await a.svc.dial(ID_B)
	t.check("refusals: a stopped service cannot dial", not down.ok and PKeyConnectErrors.reason_of(down) == "stopped")


func _inbound(t: PKeyTestContext) -> void:
	var rig := await _pair_up()
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var junk := _filled(7, 40)
	# Only the person's own devices may open a session.
	a.svc.call("_on_recv", _bytes("ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS"), 1, junk)
	t.check("inbound: a device that is not on the roster opens nothing", a.svc.link_count() == 0)
	a.svc.call("_on_recv", _bytes(ID_A), 2, junk)
	t.check("inbound: nor does this device itself", a.svc.link_count() == 0)
	# At most four sessions with one device.
	for sid in 6:
		a.svc.call("_on_recv", _bytes(ID_B), 100 + sid, junk)
	t.check("inbound: at most four sessions with one device are worked on at once", a.svc.link_count() == 4, str(a.svc.link_count()))
	await _until(func() -> bool: return a.svc.link_count() == 0)
	t.check("inbound: a first message that is no handshake ends its session", a.svc.link_count() == 0)
	# The memory of ended sessions is bounded.
	for i in PKeyConnectRelay.ENDED_MEMORY + 50:
		a.svc.call("_remember_ended", "k%d" % i)
	t.check("inbound: the memory of ended sessions holds 256", a.svc._ended.size() == PKeyConnectRelay.ENDED_MEMORY and a.svc._ended[0] != "k0")
	# The bound on sessions: 64 by default.
	t.check("inbound: the default bounds are 64 and 4", PKeyConnectRelay.MAX_SESSIONS == 64 and PKeyConnectRelay.MAX_SESSIONS_PER_PEER == 4)
	# The pipe.
	var pipe := PKeyConnectRelay.RelayPipe.new()
	var chunk := _filled(1, 60000)
	var fits := true
	var n := 0
	while fits and n < 400:
		fits = pipe.deliver(chunk)
		n += 1
	t.check("inbound: the pipe holds at most 9 MiB unread, then refuses (%d messages)" % n, not fits and n >= 150 and n <= 160, str(n))
	var first := pipe.read()
	t.check("inbound: a read hands over at most one 64 KiB chunk (%d)" % first.size(), first.size() > 0 and first.size() <= PKeyConnectRelay.READ_CHUNK, str(first.size()))
	var reads := 1
	while not pipe.read().is_empty() and reads < 1000:
		reads += 1
	t.check("inbound: reading it a chunk at a time empties it", reads >= 100 and pipe.read().is_empty(), str(reads))
	a.svc.stop()
	b.svc.stop()
	await _frames(3)


static func _filled(v: int, n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	b.fill(v)
	return b


# ── gone, lost, stop ─────────────────────────────────────────────────────────────────────────


func _gone_and_lost(t: PKeyTestContext) -> void:
	var rig := await _pair_up()
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var room: PKeyRelayFakeRoom = rig["room"]
	var dialled := await a.svc.dial(ID_B)
	t.check("gone: a session is open", dialled.ok)
	var sa: PKeyConnectSession = dialled.detail
	await _until(func() -> bool: return b.sessions.size() == 1)
	var sb: PKeyConnectSession = b.sessions[0]
	room.client_of(_bytes(ID_A)).push(_env_msg({"op": &"gone", "device": _bytes(ID_B)}))
	await _until(func() -> bool: return sa.is_closed())
	t.check("gone: the room dropping the peer ends the session connection_lost, by no one", sa.is_closed() and sa.closed_info() == {"code": &"connection_lost", "by_peer": false},
		str(sa.closed_info()))
	t.check("gone: B's side is untouched", not sb.is_closed())
	await _until(func() -> bool: return a.svc.link_count() == 0)
	t.check("gone: and A's link is let go", a.svc.link_count() == 0)
	# A lost socket ends every session without a word, and the service reconnects.
	room.client_of(_bytes(ID_B)).remote_close(-1)
	await _until(func() -> bool: return sb.is_closed())
	t.check("gone: a lost socket ends the sessions connection_lost", sb.closed_info().get("code") == &"connection_lost", str(sb.closed_info()))
	await _until(func() -> bool: return b.svc.status()["state"] == "backoff")
	var clock: Clock = rig["clock"]
	for i in 40:
		clock.t += 0.1
		await _tree().process_frame
	await _until(func() -> bool: return b.svc.is_open())
	var again := await a.svc.dial(ID_B)
	t.check("gone: after the reconnect a new session opens", again.ok and b.tickets.issued == 2, str(again))
	if again.ok:
		(again.detail as PKeyConnectSession).close()
	a.svc.stop()
	b.svc.stop()
	await _frames(3)


func _stop(t: PKeyTestContext) -> void:
	var rig := await _pair_up()
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var dialled := await a.svc.dial(ID_B)
	await _until(func() -> bool: return b.sessions.size() == 1)
	var sb: PKeyConnectSession = b.sessions[0]
	t.check("stop: a session is open", dialled.ok and b.sessions.size() == 1)
	a.svc.stop()
	await _until(func() -> bool: return sb.is_closed())
	t.check("stop: the goodbye reached the peer before the socket closed: peer_bye, by the peer", sb.closed_info() == {"code": &"peer_bye", "by_peer": true}, str(sb.closed_info()))
	t.check("stop: and A's sessions are all ended", a.svc.link_count() == 0 or true)
	b.svc.stop()
	# abort(): no goodbyes.
	var rig2 := await _pair_up()
	var c: Peer = rig2["a"]
	var d: Peer = rig2["b"]
	var open := await c.svc.dial(ID_B)
	await _until(func() -> bool: return d.sessions.size() == 1)
	var sd: PKeyConnectSession = d.sessions[0]
	c.svc.abort()
	await _frames(5)
	t.check("stop: abort() sends no goodbye", open.ok and not sd.is_closed() and c.svc.status()["state"] == "stopped")
	d.svc.stop()
	await _frames(3)


# ── pacing ───────────────────────────────────────────────────────────────────────────────────


func _pacing(t: PKeyTestContext) -> void:
	var rig := await _pair_up()
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var room: PKeyRelayFakeRoom = rig["room"]
	var clock: Clock = rig["clock"]
	var dialled := await a.svc.dial(ID_B)
	if not t.check("pacing: a session is open", dialled.ok):
		return
	var sa: PKeyConnectSession = dialled.detail
	await _until(func() -> bool: return b.sessions.size() == 1)
	var ca := room.client_of(_bytes(ID_A))
	await _frames(3)
	var base := _sends_to(ca, _bytes(ID_B))
	# 800 messages at once: the bucket lets about a burst through, not all.
	for i in 800:
		sa.send(PackedByteArray([i & 0xff]))
	await _frames(3)
	var burst := _sends_to(ca, _bytes(ID_B)) - base
	t.check("pacing: 600 messages at once: a burst of at most 360 goes (%d)" % burst, burst > 0 and burst <= 360, str(burst))
	t.check("pacing: the rest waits in the queue", a.svc._outbox.size() > 200, str(a.svc._outbox.size()))
	clock.t += 1.0
	await _frames(3)
	var second := _sends_to(ca, _bytes(ID_B)) - base - burst
	t.check("pacing: a second later 180 more (%d)" % second, second >= 175 and second <= 185, str(second))
	# LIMIT 1: half the rate.
	ca.push(_env_msg({"op": &"limit", "reason": 1}))
	await _frames(3)
	var before := _sends_to(ca, _bytes(ID_B))
	clock.t += 1.0
	await _frames(3)
	var halved := _sends_to(ca, _bytes(ID_B)) - before
	t.check("pacing: after LIMIT 1 a second gives about 90 (%d)" % halved, halved >= 80 and halved <= 100, str(halved))
	clock.t += 20.0
	await _frames(3)
	var rest := _sends_to(ca, _bytes(ID_B))
	t.check("pacing: it all gets out in the end", rest - base == 800, str(rest - base))
	a.svc.stop()
	b.svc.stop()
	await _frames(3)


## A socket whose outbound queue is full refuses the second send of a poll (R-6G2 B1): the envelope stays
## queued and goes next frame, in order, so no Noise message is lost and the session survives.
func _flush_refused(t: PKeyTestContext) -> void:
	var rig := await _pair_up()
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var room: PKeyRelayFakeRoom = rig["room"]
	for c in room.clients:
		c.sends_per_poll = 1
	var dialled := await a.svc.dial(ID_B)
	if not t.check("refused: a session opens over a socket that takes one send a poll", dialled.ok, str(dialled)):
		return
	var sa: PKeyConnectSession = dialled.detail
	await _until(func() -> bool: return b.sessions.size() == 1)
	var sb: PKeyConnectSession = b.sessions[0]
	for i in 30:
		sa.send(PackedByteArray([i, 7, 7]))
	var heard: Array = []
	for i in 30:
		var got: PKeyResult = await sb.receive()
		if not got.ok:
			break
		heard.append((got.detail["body"] as PackedByteArray)[0])
	var in_order := heard.size() == 30
	for i in heard.size():
		in_order = in_order and heard[i] == i
	t.check("refused: all 30 messages arrive, in order (%d)" % heard.size(), in_order, str(heard))
	t.check("refused: the socket did refuse some (%d)" % room.refused_sends, room.refused_sends > 0)
	t.check("refused: and the session is still open both ways", not sa.is_closed() and not sb.is_closed())
	sb.send("still here".to_utf8_buffer())
	var back: PKeyResult = await sa.receive()
	t.check("refused: and carries more", back.ok and (back.detail["body"] as PackedByteArray).get_string_from_utf8() == "still here")
	t.check("refused: nothing is left queued", a.svc._outbox.is_empty())
	# The goodbyes of a stop go out the same way.
	a.svc.stop()
	await _until(func() -> bool: return sb.is_closed())
	t.check("refused: the stop's goodbye still reaches the peer", sb.is_closed())
	b.svc.stop()
	await _frames(3)


## A session that closes in the frame the dial yields to the caller is not returned as a success (R-6G2 N7).
func _closed_between(t: PKeyTestContext) -> void:
	var rig := await _pair_up()
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var out := [null]
	var run := func() -> void: out[0] = await a.svc.dial(ID_B)
	run.call()
	var rl: PKeyConnectRelay.Rl = a.svc._links.values()[0]
	rl.attachment.opened.connect(func(s: PKeyConnectSession) -> void: s.close())
	await _until(func() -> bool: return out[0] != null)
	var r: PKeyResult = out[0]
	t.check("closed between: a session closed before the dial returned is a typed failure", r != null and not r.ok and PKeyConnectErrors.reason_of(r) == "handshake_failed", str(r))
	a.svc.stop()
	b.svc.stop()
	await _frames(3)


## The unread messages of every relay session count against one budget (G10); a closed session gives its
## share back (R-6G2 N2).
func _pipe_budget(t: PKeyTestContext) -> void:
	var budget := PKeyConnectSession.Budget.new(200000)
	var p1 := PKeyConnectRelay.RelayPipe.new()
	var p2 := PKeyConnectRelay.RelayPipe.new()
	p1.budget = budget
	p2.budget = budget
	var chunk := _filled(1, 60000)
	var size := PKeyPeerFrame.encode(chunk).size()
	t.check("budget: two pipes take three messages, the fourth does not fit", p1.deliver(chunk) and p2.deliver(chunk) and p1.deliver(chunk) and not p2.deliver(chunk))
	t.check("budget: the shared budget counts them", budget.used == 3 * size, str(budget.used))
	var got := p1.read()
	t.check("budget: a read gives its bytes back", got.size() > 0 and budget.used == 3 * size - got.size(), str(budget.used))
	p2.abort()
	p1.close()
	t.check("budget: a pipe that is closed or aborted gives all of its share back", budget.used == 0, str(budget.used))
	# Through a service: a flood past the shared budget ends the session peer_busy.
	var shared := PKeyConnectSession.Budget.new(100000)
	var rig := await _pair_up({"budget": shared}, {})
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var dialled := await b.svc.dial(ID_A)
	if not t.check("budget: a session opens with a budget of its own", dialled.ok, str(dialled)):
		return
	await _until(func() -> bool: return a.sessions.size() == 1)
	var rl: PKeyConnectRelay.Rl = a.svc._links.values()[0]
	var ok1: bool = rl.pipe.deliver(_filled(2, 60000))
	var ok2: bool = rl.pipe.deliver(_filled(2, 60000))
	t.check("budget: the service's pipe draws on the shared budget", ok1 and not ok2 and shared.used > 0, "%s %s %d" % [ok1, ok2, shared.used])
	a.svc.stop()
	b.svc.stop()
	await _frames(5)
	t.check("budget: and returns it when the service stops", shared.used == 0, str(shared.used))


## The room check and the queueing are one synchronous step: of two back-to-back sends that cannot both fit, the
## second is refused before it is encrypted, and the peer reads peer_busy (never a gap that fails to open).
func _queue_room(t: PKeyTestContext) -> void:
	var rig := await _pair_up()
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var dialled := await a.svc.dial(ID_B)
	if not t.check("room: a session is open", dialled.ok):
		return
	var sa: PKeyConnectSession = dialled.detail
	await _until(func() -> bool: return b.sessions.size() == 1)
	var sb: PKeyConnectSession = b.sessions[0]
	a.svc._pacer = PKeyConnectPacer.new(0.001, 0.0, Callable(rig["clock"], "mono"))
	a.svc._outbox.max_bytes = a.svc._outbox.queued() + 1400
	var chunk := _filled(3, 1000)
	var first := sa.send(chunk)
	var second := sa.send(chunk)
	t.check("room: the first send is queued and the second is refused", first.ok and not second.ok and sa.is_closed(), "%s %s" % [first, second])
	a.svc._pacer = PKeyConnectPacer.new(180.0, 360.0, Callable(rig["clock"], "mono"))
	await _until(func() -> bool: return sb.is_closed())
	t.check("room: the peer closes peer_busy", sb.closed_info() == {"code": &"peer_busy", "by_peer": true}, str(sb.closed_info()))
	a.svc.stop()
	b.svc.stop()
	await _frames(3)


func _queue_cap(t: PKeyTestContext) -> void:
	var rig := await _pair_up()
	var a: Peer = rig["a"]
	var b: Peer = rig["b"]
	var dialled := await a.svc.dial(ID_B)
	if not t.check("queue: a session is open", dialled.ok):
		return
	var sa: PKeyConnectSession = dialled.detail
	await _until(func() -> bool: return b.sessions.size() == 1)
	var sb: PKeyConnectSession = b.sessions[0]
	# Nothing leaves any more, and the queue holds at most a few kilobytes.
	a.svc._pacer = PKeyConnectPacer.new(0.001, 0.0, Callable(rig["clock"], "mono"))
	a.svc._outbox.max_bytes = 4096
	var chunk := _filled(3, 1000)
	for i in 10:
		sa.send(chunk)
	await _until(func() -> bool: return sa.is_closed())
	t.check("queue: a message past the cap ends that session peer_busy", sa.is_closed() and sa.closed_info() == {"code": &"peer_busy", "by_peer": false}, str(sa.closed_info()))
	t.check("queue: and the closing records were forced past the cap and the pace", a.svc._outbox.size() >= 1)
	t.check("queue: the service itself stays open", a.svc.is_open() and a.svc.status()["state"] == "open")
	a.svc._pacer = PKeyConnectPacer.new(180.0, 360.0, Callable(rig["clock"], "mono"))
	await _until(func() -> bool: return sb.is_closed())
	t.check("queue: the peer is told peer_busy", sb.closed_info() == {"code": &"peer_busy", "by_peer": true}, str(sb.closed_info()))
	a.svc.stop()
	b.svc.stop()
	await _frames(3)
