extends RefCounted
# @pkey-feature connect.relay
# The relay socket (PKeyConnectRelay, CC-14.13; WIRE-CONTRACT-V5 section 15.7, plans G13 to G15), ported
# from sdk-node's `relay.test.ts` and the Python `test_connect_relay`: the open (a new ticket offered
# second after the protocol, the protocol required echoed back, a LIST at once, MEMBERS believed only for
# the roster), the refusals (a text frame, a bad envelope, an oversize message: close 1002, never
# answered), the reconnect policy (backoff with jitter and a floor, reset only after 30 s stable,
# `unavailable` and five minutes after five attempts, Retry-After capped, 4001, 4003 three in a row, 4008
# with and without a LIMIT, 4009), ping and pong, ticket failures, stop and abort, and no ticket in any
# `str()` or status. Everything runs on an in-memory room and a clock the test moves; a last group runs the
# real `WebSocketPeer` against a local `TCPServer` and `WebSocketPeer.accept_stream` server and proves the
# close codes 4001, 4003, 4008 and 4009 arrive, that a text frame and an oversize message are refused, and
# that only a `wss:` URL opens by default.

const ID_A := "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
const ID_B := "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
const ID_Z := "ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS"

var _pair: Dictionary


## What the service reads of its client.
class Env extends RefCounted:
	var source: PKeyConnectClient.PeerSource
	var now_value := PKeyTestPeers.NOW
	var refreshes := 0
	var clock: Clock


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


## Tickets: a new one each call, scripted results first.
class Tickets extends RefCounted:
	var issued := 0
	var last: PKeyConnectClient.Grant = null
	var queue: Array = []
	var url := "wss://key.plrs.im/api/connect/relay"


	func next() -> PKeyResult:
		issued += 1
		await (Engine.get_main_loop() as SceneTree).process_frame
		if not queue.is_empty():
			return queue.pop_front()
		var g := PKeyConnectClient.Grant.new()
		g.url = url
		g.protocol = PKeyConnectRelay.PROTOCOL
		g.expires_at = 2000000000
		g._ticket = "pkeyrt_" + "a".repeat(31) + char(96 + (issued % 26))
		last = g
		return PKeyResult.success(g)


class Rig extends RefCounted:
	var env: Env
	var clock: Clock
	var room: PKeyRelayFakeRoom
	var tickets: Tickets
	var svc: PKeyConnectRelay
	var states: Array = []


func run(t: PKeyTestContext) -> void:
	_pair = PKeyTestPeers.pair(1)
	await _open(t)
	await _refusals(t)
	await _reconnect(t)
	await _codes(t)
	await _ticket_failures(t)
	await _ping(t)
	await _stop(t)
	await _misc(t)
	await _real_socket(t)
	# Let every stopped loop run out before the suite ends.
	await _frames(30)


# ── helpers ──────────────────────────────────────────────────────────────────────────────────


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _frames(n: int) -> void:
	for i in n:
		await _tree().process_frame


## Wait on the real clock, for the tests that run against a real socket.
func _until_ms(cond: Callable, ms: int) -> bool:
	var started := Time.get_ticks_msec()
	while Time.get_ticks_msec() - started < ms and not cond.call():
		await _tree().process_frame
	return cond.call()


func _until(cond: Callable, frames := 400) -> bool:
	var n := 0
	while n < frames and not cond.call():
		await _tree().process_frame
		n += 1
	return cond.call()


func _bytes(id: String) -> PackedByteArray:
	return PKeyPeerAdvert.device_id_bytes(id)


func _source() -> PKeyConnectClient.PeerSource:
	var d: Dictionary = _pair["a"]
	var s := PKeyConnectClient.PeerSource.new()
	s.slug = PKeyTestPeers.SLUG
	s.trust = PKeyTestPeers.trust()
	s.sub = PKeyTestPeers.SUB
	s.device_id = d["id"]
	s.certificate = d["cert"]
	s.certificate_expires_at = PKeyTestPeers.NOW + 1000
	s.ring = _pair["ring"]
	s.ring_epoch = 1
	s.roster.append(ID_A)
	s.roster.append(ID_B)
	s.disc_current = PKeyTestPeers.random32()
	s.agree_public = d["pub"]
	return s


func _rig(extra := {}) -> Rig:
	var r := Rig.new()
	r.env = Env.new()
	r.env.source = _source()
	r.clock = Clock.new()
	r.room = PKeyRelayFakeRoom.new()
	r.room.devices.append(_bytes(ID_A))
	r.tickets = Tickets.new()
	var o := {
		"opener": Callable(r.room, "opener"), "mono": Callable(r.clock, "mono"), "random": Callable(r.clock, "half"), "tree": _tree(),
		"timer": Callable(), "ping_seconds": 1000.0, "open_seconds": 5.0,
	}
	for k in extra:
		o[k] = extra[k]
	r.svc = PKeyConnectRelay.new(r.env.src(), Callable(r.tickets, "next"), o)
	var states := r.states
	r.svc.state_changed.connect(func(s: Dictionary) -> void: states.append(s["state"]))
	return r


## Advance the clock by `step` a frame at a time until `cond`, at most `limit` seconds. The seconds spent.
func _advance_until(r: Rig, cond: Callable, step := 0.05, limit := 400.0) -> float:
	var spent := 0.0
	while spent < limit and not cond.call():
		r.clock.t += step
		spent += step
		await _tree().process_frame
	return spent


func _env_msg(m: Dictionary) -> PackedByteArray:
	return PKeyPeerRelayCodec.encode(m)


# ── open ─────────────────────────────────────────────────────────────────────────────────────


func _open(t: PKeyTestContext) -> void:
	var r := _rig()
	var members_seen: Array = []
	r.svc.members_changed.connect(func(m: Array) -> void: members_seen.append(m))
	t.check("open: a new service is idle", r.svc.status()["state"] == "idle" and not r.svc.is_open())
	var ready := await r.svc.ready()
	t.check("open: ready() resolves once the socket is open", ready.ok and r.svc.is_open() and r.svc.status()["state"] == "open")
	t.check("open: the state went idle, connecting, open", r.states == ["connecting", "open"], str(r.states))
	var opened := r.room.opens[0]
	var offered: Array = opened["protocols"]
	t.check("open: it offered pkey-relay.1, then the ticket", r.room.opens.size() == 1 and offered.size() == 2 and offered[0] == "pkey-relay.1" and
		(offered[1] as String).begins_with("pkeyrt_") and opened["url"] == "wss://key.plrs.im/api/connect/relay")
	await _frames(2)
	var first := PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_ROOM, r.room.last().sent[0])
	t.check("open: the first thing it says is LIST", first.get("op") == &"list")
	t.check("open: the room's MEMBERS reply reaches it (this device is online)", r.svc.members() == [ID_A] and members_seen.size() >= 1, str(r.svc.members()))
	# MEMBERS is believed only for the roster.
	r.room.last().push(_env_msg({"op": &"members", "devices": [_bytes(ID_B), _bytes(ID_Z), _bytes(ID_A)]}))
	await _frames(2)
	t.check("open: a device that is not on the roster is not a member", r.svc.members() == [ID_A, ID_B] or r.svc.members() == [ID_B, ID_A], str(r.svc.members()))
	t.check("open: members() is sorted", r.svc.members() == ["AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH", "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"])
	r.room.last().push(_env_msg({"op": &"gone", "device": _bytes(ID_B)}))
	await _frames(2)
	t.check("open: GONE removes a member", r.svc.members() == [ID_A])
	var again: Array = await r.svc.refresh_members(1.0)
	t.check("open: refresh_members() asks again and answers the room's reply", again == [ID_A] and PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_ROOM,
		r.room.last().sent[r.room.last().sent.size() - 1]).get("op") == &"list", str(again))
	t.check("open: one socket for one service", r.room.opens.size() == 1 and r.room.clients.size() == 1)
	var secret: String = offered[1]
	t.check("open: the ticket is in no str() or status", not str(r.svc).contains(secret) and not str(r.svc.status()).contains(secret) and not str(r.room.last()).contains(secret))
	t.check("open: and the grant prints nothing", str(PKeyConnectClient.Grant.new()) == "RelayGrant(redacted)")
	t.check("open: the spent ticket is forgotten by the grant once the socket is open (R-6G2 N6)", r.tickets.last != null and r.tickets.last.ticket() == "")
	t.check("open: before the stop the service holds an identity", r.svc._id != null)
	r.svc.stop()
	await _frames(2)
	t.check("open: stop() lets the identity go (R-6G2 N3)", r.svc._id == null)


func _refusals(t: PKeyTestContext) -> void:
	# The protocol not echoed back (G14): closed 1002, nothing processed.
	var r := _rig()
	r.room.echo = "other.1"
	r.svc.start()
	await _until(func() -> bool: return r.svc.status()["close_code"] == 1002)
	t.check("refusals: a socket that does not echo pkey-relay.1 is closed 1002", r.svc.status()["close_code"] == 1002 and r.room.last().closed_by_client == 1002 and not r.svc.is_open() and
		r.svc.status()["state"] == "backoff", str(r.svc.status()))
	t.check("refusals: and it sent nothing on it", r.room.last().sent.is_empty())
	r.svc.stop()
	# Text frame, garbage envelope, oversize message, a client-only op.
	var cases := {
		"a text frame": func(c: PKeyRelayFakeRoom.Client) -> void: c.push_text("hello"),
		"a bad envelope": func(c: PKeyRelayFakeRoom.Client) -> void: c.push(PackedByteArray([0x7f, 1, 2, 3])),
		"a short MEMBERS": func(c: PKeyRelayFakeRoom.Client) -> void: c.push(PackedByteArray([0x82, 2, 1, 2, 3])),
		"a client op": func(c: PKeyRelayFakeRoom.Client) -> void: c.push(PackedByteArray([0x02])),
		"an oversize message": func(c: PKeyRelayFakeRoom.Client) -> void: c.push(_filled(0x81, PKeyConnectRelay.MAX_MESSAGE + 1)),
	}
	for name: String in cases:
		var rig := _rig()
		rig.svc.start()
		await _until(func() -> bool: return rig.svc.is_open())
		await _frames(2)
		var c := rig.room.last()
		var before := c.sent.size()
		(cases[name] as Callable).call(c)
		await _until(func() -> bool: return c.closed_by_client == 1002)
		t.check("refusals: %s closes the socket 1002" % name, c.closed_by_client == 1002 and rig.svc.status()["close_code"] == 1002 and not rig.svc.is_open(), str(rig.svc.status()))
		t.check("refusals: %s is never answered" % name, c.sent.size() == before)
		rig.svc.stop()
	# An envelope at the limit is fine.
	var ok := _rig()
	ok.svc.start()
	await _until(func() -> bool: return ok.svc.is_open())
	var recv := _env_msg({"op": &"recv", "from": _bytes(ID_B), "session": 7, "noise": _filled(1, 65535 - 100)})
	ok.room.last().push(recv)
	await _frames(3)
	t.check("refusals: a valid RECV is taken (and, before CC-14.14, ignored)", ok.svc.is_open())
	ok.svc.stop()


static func _filled(v: int, n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	b.fill(v)
	return b


# ── reconnect policy ─────────────────────────────────────────────────────────────────────────


func _reconnect(t: PKeyTestContext) -> void:
	var r := _rig()
	r.svc.start()
	await _until(func() -> bool: return r.svc.is_open())
	t.check("reconnect: the first ticket", r.tickets.issued == 1)
	r.room.last().remote_close(-1)
	await _until(func() -> bool: return r.svc.status()["state"] == "backoff")
	var first := await _advance_until(r, func() -> bool: return r.tickets.issued == 2)
	t.check("reconnect: after a drop the next ticket comes after the backoff, 0.75 s with jitter 0.5 (%.2f)" % first, first >= 0.7 and first <= 0.85, str(first))
	await _until(func() -> bool: return r.svc.is_open())
	t.check("reconnect: every connect has a new ticket", r.room.tickets.size() == 2 and r.room.tickets[0] != r.room.tickets[1])
	# The backoff is not reset by an open that does not last: the second drop waits longer.
	r.room.last().remote_close(-1)
	await _until(func() -> bool: return r.svc.status()["state"] == "backoff")
	var second := await _advance_until(r, func() -> bool: return r.tickets.issued == 3)
	t.check("reconnect: and again longer, 1.5 s (%.2f)" % second, second >= 1.45 and second <= 1.65, str(second))
	t.check("reconnect: attempts count the drops", r.svc.status()["attempts"] == 2, str(r.svc.status()["attempts"]))
	await _until(func() -> bool: return r.svc.is_open())
	# A socket that stayed up 30 s resets the backoff.
	r.clock.t += 31.0
	await _frames(2)
	r.room.last().remote_close(-1)
	await _until(func() -> bool: return r.svc.status()["state"] == "backoff")
	var third := await _advance_until(r, func() -> bool: return r.tickets.issued == 4)
	t.check("reconnect: after 30 s stable the backoff starts over, 0.75 s (%.2f)" % third, third >= 0.7 and third <= 0.85 and r.svc.status()["attempts"] <= 1, str(third))
	r.svc.stop()

	# Never opens: five attempts, then unavailable and five minutes.
	var u := _rig()
	u.room.refuse_open = true
	u.svc.start()
	var delays: Array = []
	for i in 4:
		await _until(func() -> bool: return u.tickets.issued == i + 1 and u.svc.status()["state"] == "backoff")
		delays.append(await _advance_until(u, func() -> bool: return u.tickets.issued == i + 2))
	var ok_delays: bool = delays[0] <= 0.85 and delays[1] >= 1.45 and delays[1] <= 1.65 and delays[2] >= 2.95 and delays[2] <= 3.15 and delays[3] >= 5.95 and delays[3] <= 6.2
	t.check("reconnect: the backoff doubles with jitter: 0.75, 1.5, 3, 6", ok_delays, str(delays))
	await _until(func() -> bool: return u.svc.status()["state"] == "unavailable")
	t.check("reconnect: the fifth failure is unavailable", u.svc.status()["state"] == "unavailable" and u.tickets.issued == 5 and u.svc.status()["attempts"] == 5, str(u.svc.status()))
	u.clock.t += 299.0
	await _frames(5)
	t.check("reconnect: nothing for five minutes", u.tickets.issued == 5)
	u.clock.t += 2.0
	await _until(func() -> bool: return u.tickets.issued == 6)
	t.check("reconnect: and then another try", u.tickets.issued == 6)
	u.svc.stop()
	# resume() cuts a backoff short.
	var s := _rig()
	s.svc.start()
	await _until(func() -> bool: return s.svc.is_open())
	s.room.last().remote_close(-1)
	await _until(func() -> bool: return s.svc.status()["state"] == "backoff")
	s.svc.resume()
	await _until(func() -> bool: return s.tickets.issued == 2)
	t.check("reconnect: resume() cuts the backoff short", s.tickets.issued == 2)
	s.svc.stop()


# ── close codes and LIMIT ────────────────────────────────────────────────────────────────────


func _codes(t: PKeyTestContext) -> void:
	# 4009: replaced. Stops without fighting back.
	var r := _rig()
	r.svc.start()
	await _until(func() -> bool: return r.svc.is_open())
	r.room.last().remote_close(4009)
	await _until(func() -> bool: return r.svc.status()["state"] == "blocked")
	var err: PKeyResult = r.svc.status()["error"]
	t.check("codes: 4009 blocks the service, replaced", PKeyConnectErrors.reason_of(err) == "replaced" and err.detail["close_code"] == 4009, str(err))
	await _advance_until(r, func() -> bool: return false, 5.0, 100.0)
	t.check("codes: and it does not come back", r.tickets.issued == 1 and not r.svc.is_open())
	var blocked_ready: PKeyResult = await r.svc.ready()
	t.check("codes: ready() reports the block", not blocked_ready.ok and PKeyConnectErrors.reason_of(blocked_ready) == "replaced")
	r.svc.resume()
	await _until(func() -> bool: return r.svc.is_open())
	t.check("codes: resume() tries again after a block", r.svc.is_open() and r.tickets.issued == 2 and r.svc.status()["attempts"] == 0)
	# 4001: a new ticket after the backoff.
	r.room.last().remote_close(4001)
	await _until(func() -> bool: return r.svc.status()["state"] == "backoff")
	t.check("codes: 4001 backs off", r.svc.status()["close_code"] == 4001)
	await _advance_until(r, func() -> bool: return r.tickets.issued == 3)
	await _until(func() -> bool: return r.svc.is_open())
	t.check("codes: and gets a new ticket", r.tickets.issued == 3 and r.svc.is_open())
	# 4003: refresh the roster once, and stop after three in a row.
	var before := r.env.refreshes
	r.room.last().remote_close(4003)
	await _until(func() -> bool: return r.svc.status()["state"] == "backoff")
	t.check("codes: 4003 fetches the roster", r.env.refreshes == before + 1 and r.svc.status()["state"] == "backoff")
	await _advance_until(r, func() -> bool: return r.tickets.issued == 4)
	await _until(func() -> bool: return r.svc.is_open())
	r.room.last().remote_close(4003)
	await _until(func() -> bool: return r.svc.status()["state"] == "backoff")
	await _advance_until(r, func() -> bool: return r.tickets.issued == 5)
	await _until(func() -> bool: return r.svc.is_open())
	r.room.last().remote_close(4003)
	await _until(func() -> bool: return r.svc.status()["state"] == "blocked")
	t.check("codes: the third 4003 in a row blocks, not_member", PKeyConnectErrors.reason_of(r.svc.status()["error"]) == "not_member", str(r.svc.status()["error"]))
	r.svc.stop()
	# 4003, something else, 4003, 4003: not three in a row.
	var q := _rig()
	q.svc.start()
	for code in [4003, 4001, 4003, 4003]:
		await _until(func() -> bool: return q.svc.is_open())
		q.room.last().remote_close(code)
		await _until(func() -> bool: return q.svc.status()["state"] == "backoff" or q.svc.status()["state"] == "blocked")
		await _advance_until(q, func() -> bool: return q.svc.is_open() or q.svc.status()["state"] == "blocked", 0.5, 20.0)
	t.check("codes: another close between resets the count", q.svc.status()["state"] != "blocked" and q.svc.is_open(), str(q.svc.status()))
	q.svc.stop()
	# 4008 after LIMIT 2 and 3: a quota; otherwise it backs off.
	for pair: Array in [[2, "person"], [3, "product"]]:
		var z := _rig()
		z.svc.start()
		await _until(func() -> bool: return z.svc.is_open())
		z.room.last().push(_env_msg({"op": &"limit", "reason": pair[0]}))
		await _frames(2)
		t.check("codes: LIMIT %d is a quota error with its scope" % pair[0], PKeyConnectErrors.reason_of(z.svc.status()["error"]) == "quota" and
			z.svc.status()["error"].detail["scope"] == pair[1], str(z.svc.status()["error"]))
		z.room.last().remote_close(4008)
		await _until(func() -> bool: return z.svc.status()["state"] == "blocked")
		var e: PKeyResult = z.svc.status()["error"]
		t.check("codes: 4008 after LIMIT %d blocks, quota, scope %s" % [pair[0], pair[1]], PKeyConnectErrors.reason_of(e) == "quota" and e.detail["scope"] == pair[1] and
			e.detail["close_code"] == 4008 and e.code == &"relay_quota_exceeded", str(e))
		z.svc.stop()
	var w := _rig()
	w.svc.start()
	await _until(func() -> bool: return w.svc.is_open())
	w.room.last().remote_close(4008)
	await _until(func() -> bool: return w.svc.status()["state"] == "backoff")
	t.check("codes: 4008 with no LIMIT is room full or abuse: it backs off", w.svc.status()["state"] == "backoff" and w.svc.status()["close_code"] == 4008)
	await _advance_until(w, func() -> bool: return w.svc.is_open())
	w.room.last().push(_env_msg({"op": &"limit", "reason": 1}))
	await _frames(2)
	t.check("codes: LIMIT 1 is rate_limited", PKeyConnectErrors.reason_of(w.svc.status()["error"]) == "rate_limited" and w.svc.is_open())
	w.room.last().remote_close(4008)
	await _until(func() -> bool: return w.svc.status()["state"] == "backoff")
	t.check("codes: 4008 after LIMIT 1 is not a quota", w.svc.status()["state"] == "backoff")
	await _advance_until(w, func() -> bool: return w.svc.is_open())
	t.check("codes: the last LIMIT is cleared on reopen", w.svc.status()["error"] == null and w.svc.is_open())
	w.room.last().push(_env_msg({"op": &"limit", "reason": 4}))
	await _frames(2)
	t.check("codes: LIMIT 4 is paused", PKeyConnectErrors.reason_of(w.svc.status()["error"]) == "paused")
	w.room.last().remote_close(4008)
	await _until(func() -> bool: return w.svc.status()["state"] == "backoff")
	t.check("codes: 4008 after LIMIT 4 is not a quota either", w.svc.status()["state"] == "backoff")
	w.svc.stop()
	# RING: a newer roster than the held one asks for a refresh; the same one does not.
	var g := _rig()
	g.svc.start()
	await _until(func() -> bool: return g.svc.is_open())
	g.room.last().push(_env_msg({"op": &"ring", "epoch": 1}))
	await _frames(3)
	t.check("codes: a RING no newer than the held roster fetches nothing", g.env.refreshes == 0)
	g.room.last().push(_env_msg({"op": &"ring", "epoch": 2}))
	await _frames(3)
	t.check("codes: a newer one fetches the roster", g.env.refreshes == 1)
	g.svc.stop()


# ── ticket failures ──────────────────────────────────────────────────────────────────────────


func _ticket_failures(t: PKeyTestContext) -> void:
	var r := _rig()
	r.tickets.queue.append(PKeyConnectErrors.relay("disabled", "off", {"status": 403}))
	r.svc.start()
	await _until(func() -> bool: return r.svc.status()["state"] == "blocked")
	t.check("tickets: a product with the relay off blocks, disabled, and opens no socket", PKeyConnectErrors.reason_of(r.svc.status()["error"]) == "disabled" and r.room.opens.is_empty())
	var rr: PKeyResult = await r.svc.ready()
	t.check("tickets: ready() reports it", not rr.ok and rr.code == &"relay_disabled")
	r.svc.stop()
	var q := _rig()
	q.tickets.queue.append(PKeyConnectErrors.relay("quota", "spent", {"status": 429, "scope": "person"}))
	q.svc.start()
	await _until(func() -> bool: return q.svc.status()["state"] == "blocked")
	t.check("tickets: a spent quota blocks", PKeyConnectErrors.reason_of(q.svc.status()["error"]) == "quota" and q.svc.status()["error"].detail["scope"] == "person")
	q.svc.stop()
	# Retry-After holds the next ticket back.
	var p := _rig()
	p.tickets.queue.append(PKeyConnectErrors.relay("paused", "later", {"status": 503, "retry_after_seconds": 120}))
	p.svc.start()
	await _until(func() -> bool: return p.svc.status()["state"] == "backoff")
	t.check("tickets: a paused relay backs off with its error", PKeyConnectErrors.reason_of(p.svc.status()["error"]) == "paused")
	p.clock.t += 119.0
	await _frames(5)
	t.check("tickets: Retry-After: no ticket for 120 s", p.tickets.issued == 1)
	p.clock.t += 2.0
	await _until(func() -> bool: return p.tickets.issued == 2)
	t.check("tickets: and then one", p.tickets.issued == 2)
	p.svc.stop()
	var cap := _rig()
	cap.tickets.queue.append(PKeyConnectErrors.relay("paused", "later", {"retry_after_seconds": 99999}))
	cap.svc.start()
	await _until(func() -> bool: return cap.svc.status()["state"] == "backoff")
	cap.clock.t += 3599.0
	await _frames(5)
	t.check("tickets: Retry-After is capped at an hour (not yet at 3599 s)", cap.tickets.issued == 1)
	cap.clock.t += 2.0
	await _until(func() -> bool: return cap.tickets.issued == 2)
	t.check("tickets: and ends at 3600 s", cap.tickets.issued == 2)
	cap.svc.stop()
	# Any other failure is unavailable and retries.
	var o := _rig()
	o.tickets.queue.append(PKeyResult.failure(&"network-error", "down"))
	o.svc.start()
	await _until(func() -> bool: return o.svc.status()["state"] == "backoff")
	t.check("tickets: another failure is unavailable and backs off", PKeyConnectErrors.reason_of(o.svc.status()["error"]) == "unavailable" and o.svc.status()["error"].code == &"network-error")
	await _advance_until(o, func() -> bool: return o.svc.is_open())
	t.check("tickets: and recovers", o.svc.is_open() and o.svc.status()["error"] == null)
	o.svc.stop()


# ── ping ─────────────────────────────────────────────────────────────────────────────────────


func _ping(t: PKeyTestContext) -> void:
	var r := _rig({"ping_seconds": 5.0})
	r.svc.start()
	await _until(func() -> bool: return r.svc.is_open())
	var c := r.room.last()
	var n := c.sent.size()
	r.clock.t += 5.1
	await _frames(3)
	var ops: Array = c.sent.slice(n).map(func(b: PackedByteArray) -> StringName: return PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_ROOM, b).get("op"))
	t.check("ping: after ping_seconds a PING and a LIST go out", ops == [&"ping", &"list"], str(ops))
	for i in 4:
		r.clock.t += 5.1
		await _frames(3)
	t.check("ping: a room that answers keeps the socket open", r.svc.is_open() and r.room.opens.size() == 1)
	# A room that never answers: closed 1001 after two intervals.
	r.room.auto = false
	for i in 3:
		r.clock.t += 5.1
		await _frames(3)
	await _until(func() -> bool: return r.svc.status()["close_code"] == 1001)
	t.check("ping: two intervals without a pong close the socket 1001", r.svc.status()["close_code"] == 1001 and c.closed_by_client == 1001, str(r.svc.status()))
	r.room.auto = true
	await _advance_until(r, func() -> bool: return r.svc.is_open())
	t.check("ping: and the loop reconnects with a new ticket", r.svc.is_open() and r.tickets.issued == 2)
	r.svc.stop()


# ── stop, abort, ready ───────────────────────────────────────────────────────────────────────


func _stop(t: PKeyTestContext) -> void:
	var r := _rig()
	r.svc.start()
	await _until(func() -> bool: return r.svc.is_open())
	var c := r.room.last()
	r.svc.stop()
	await _frames(3)
	t.check("stop: the socket is closed 1000 and the state is stopped", c.closed_by_client == 1000 and r.svc.status()["state"] == "stopped" and not r.svc.is_open())
	var rr: PKeyResult = await r.svc.ready()
	t.check("stop: ready() fails stopped", not rr.ok and PKeyConnectErrors.reason_of(rr) == "stopped")
	await _advance_until(r, func() -> bool: return false, 10.0, 100.0)
	t.check("stop: no ticket is fetched after it", r.tickets.issued == 1)
	r.svc.start()
	t.check("stop: and it does not start again", r.tickets.issued == 1)
	var a := _rig()
	a.svc.start()
	await _until(func() -> bool: return a.svc.is_open())
	var c2 := a.room.last()
	a.svc.abort()
	await _frames(3)
	t.check("abort: no close frame is sent, the state is stopped", c2.closed_by_client == -1 and a.svc.status()["state"] == "stopped" and not a.svc.is_open())
	t.check("abort: and the identity is let go (R-6G2 N3)", a.svc._id == null)
	# stop() while napping.
	var n := _rig()
	n.room.refuse_open = true
	n.svc.start()
	await _until(func() -> bool: return n.svc.status()["state"] == "backoff")
	n.svc.stop()
	await _advance_until(n, func() -> bool: return false, 5.0, 30.0)
	t.check("stop: during a backoff it ends the loop", n.tickets.issued == 1 and n.svc.status()["state"] == "stopped")
	# A stop between the ticket and the open.
	var m := _rig()
	m.svc.start()
	m.svc.stop()
	await _frames(5)
	t.check("stop: right after start no socket opens", m.room.opens.is_empty() and m.svc.status()["state"] == "stopped")


func _misc(t: PKeyTestContext) -> void:
	var r := _rig()
	r.room.refuse_open = true
	var waited := [null]
	var runner := func() -> void: waited[0] = await r.svc.ready(0.3)
	runner.call()
	await _advance_until(r, func() -> bool: return waited[0] != null, 0.05, 30.0)
	var started: PKeyResult = waited[0]
	t.check("misc: ready() times out not_connected", started != null and not started.ok and PKeyConnectErrors.reason_of(started) == "not_connected", str(started))
	r.svc.stop()
	var slow := _rig()
	slow.room.open_after = 1000000
	slow.svc.start()
	var spent := await _advance_until(slow, func() -> bool: return slow.svc.status()["state"] == "backoff", 0.5, 100.0)
	t.check("misc: a socket that never opens is given up on after open_seconds (%d s)" % int(spent), slow.svc.status()["state"] == "backoff" and spent >= 4.9 and spent <= 8.0, str(spent))
	slow.svc.stop()
	t.check("misc: str() shows the state only", str(slow.svc) == "PKeyConnectRelay(stopped)")
	t.check("misc: the socket port is closed by default", PKeyConnectRelay.Socket.new().state() == PKeyConnectRelay.Socket.CLOSED and PKeyConnectRelay.Socket.new().recv() == null and
		not PKeyConnectRelay.Socket.new().send(PackedByteArray([1])) and PKeyConnectRelay.Socket.new().code() == -1)


# ── the real WebSocketPeer ───────────────────────────────────────────────────────────────────


## A local WebSocket server on loopback: each accepted connection follows `scripts[n]` {send, close, after}.
class LocalRoom extends RefCounted:
	var server := TCPServer.new()
	var conns: Array = []
	var scripts: Array = []
	var protocols := PackedStringArray([PKeyConnectRelay.PROTOCOL])


	func start() -> int:
		return server.get_local_port() if server.listen(0, "127.0.0.1") == OK else 0


	func tick() -> void:
		while server.is_connection_available():
			var ws := WebSocketPeer.new()
			ws.supported_protocols = protocols
			ws.inbound_buffer_size = 1 << 20
			ws.outbound_buffer_size = 1 << 20
			ws.accept_stream(server.take_connection())
			conns.append({"ws": ws, "n": conns.size(), "opened": false, "frames": 0, "received": [], "code": -2, "selected": ""})
		for c: Dictionary in conns:
			_tick_conn(c)


	func _tick_conn(c: Dictionary) -> void:
		var ws: WebSocketPeer = c["ws"]
		ws.poll()
		var script: Dictionary = scripts[c["n"]] if c["n"] < scripts.size() else {}
		match ws.get_ready_state():
			WebSocketPeer.STATE_OPEN:
				if not c["opened"]:
					c["opened"] = true
					c["selected"] = ws.get_selected_protocol()
					for p in script.get("send", []):
						if p is String:
							ws.send_text(p)
						else:
							ws.send(p, WebSocketPeer.WRITE_MODE_BINARY)
				c["frames"] += 1
				while ws.get_available_packet_count() > 0:
					(c["received"] as Array).append(ws.get_packet())
				if script.has("close") and c["frames"] >= int(script.get("after", 3)):
					var code: int = script["close"]
					script.erase("close")
					ws.close(code, "")
			WebSocketPeer.STATE_CLOSED:
				if c["code"] == -2:
					c["code"] = ws.get_close_code()


	func stop() -> void:
		for c: Dictionary in conns:
			(c["ws"] as WebSocketPeer).close()
		server.stop()


func _real_socket(t: PKeyTestContext) -> void:
	t.check("real: only a wss URL opens by default", PKeyConnectRelay.open_ws("ws://127.0.0.1:9/x", ["pkey-relay.1", "t"]) == null and PKeyConnectRelay.open_ws("https://key.plrs.im/x",
		["pkey-relay.1", "t"]) == null and PKeyConnectRelay.open_ws("http://key.plrs.im/x", []) == null and PKeyConnectRelay.open_ws("", []) == null)
	var room := LocalRoom.new()
	var port := room.start()
	if not t.check("real: a loopback WebSocket server listens", port > 0):
		return
	room.scripts = [
		{"send": [_env_msg({"op": &"members", "devices": [_bytes(ID_A), _bytes(ID_B), _bytes(ID_Z)]})], "close": -1},
		{"send": ["not binary"]},
		{"send": [_filled(0x81, PKeyConnectRelay.MAX_MESSAGE + 1)]},
		{"close": 4001},
		{"close": 4003},
		{"close": 4008},
		{"send": [_env_msg({"op": &"limit", "reason": 2})], "close": 4008, "after": 6},
	]
	var env := Env.new()
	env.source = _source()
	var tickets := Tickets.new()
	tickets.url = "ws://127.0.0.1:%d/relay" % port
	var opener := func(url: String, protocols: Array) -> PKeyConnectRelay.Socket: return PKeyConnectRelay.open_ws(url, protocols, true)
	var svc := PKeyConnectRelay.new(env.src(), Callable(tickets, "next"), {
		"opener": opener, "tree": _tree(), "backoff_base": 0.02, "backoff_max": 0.05, "backoff_min": 0.01, "ping_seconds": 60.0, "stable_seconds": 0.0,
	})
	var tree := _tree()
	var pump := func() -> void: room.tick()
	tree.process_frame.connect(pump)
	svc.start()
	var got_open := await _until_ms(func() -> bool: return svc.is_open() and room.conns.size() >= 1 and room.conns[0]["received"].size() >= 1 and svc.members().size() == 2, 10000)
	t.check("real: the service opens a WebSocketPeer and the server selects pkey-relay.1", got_open and room.conns[0]["selected"] == "pkey-relay.1", str(svc.status()))
	var first_msg: PackedByteArray = room.conns[0]["received"][0]
	t.check("real: the server read a LIST first", PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_ROOM, first_msg).get("op") == &"list")
	t.check("real: and its MEMBERS reached the service, filtered to the roster", svc.members().size() == 2 and not svc.members().has(ID_Z), str(svc.members()))
	# The scripted sequence: conn 0 drops, 1 sends a text frame, 2 an oversize message, then 4001, 4003, 4008.
	var seen: Array = []
	var watch := func(s: Dictionary) -> void:
		if s["close_code"] != -1 and (seen.is_empty() or seen[seen.size() - 1] != [s["state"], s["close_code"]]):
			seen.append([s["state"], s["close_code"]])
	svc.state_changed.connect(watch)
	var finished := await _until_ms(func() -> bool: return svc.status()["state"] == "blocked", 30000)
	var codes: Array = room.conns.map(func(c: Dictionary) -> int: return c["code"])
	t.check("real: the service went through every connection to the quota block (%d connections)" % room.conns.size(), finished and room.conns.size() >= 7, str(codes))
	t.check("real: a text frame closed it 1002, which the server saw", codes.size() > 1 and codes[1] == 1002, str(codes))
	t.check("real: an oversize message closed it 1002 too", codes.size() > 2 and codes[2] == 1002, str(codes))
	var closes: Array = seen.map(func(x: Array) -> int: return x[1])
	t.check("real: the codes 4001, 4003 and 4008 arrived at the client", closes.has(4001) and closes.has(4003) and closes.has(4008), str(closes))
	t.check("real: 4003 fetched the roster", env.refreshes >= 1, str(env.refreshes))
	t.check("real: 4008 after LIMIT 2 ended in a quota block", PKeyConnectErrors.reason_of(svc.status()["error"]) == "quota", str(svc.status()["error"]))
	t.check("real: every connect had a new ticket", tickets.issued >= 7)
	svc.stop()
	# 4009 on a fresh service.
	room.scripts = [{"close": 4009, "after": 3}]
	room.conns = []
	var env2 := Env.new()
	env2.source = _source()
	var t2 := Tickets.new()
	t2.url = tickets.url
	var svc2 := PKeyConnectRelay.new(env2.src(), Callable(t2, "next"), {"opener": opener, "tree": _tree(), "backoff_base": 0.02, "backoff_min": 0.01})
	svc2.start()
	var replaced := await _until_ms(func() -> bool: return svc2.status()["state"] == "blocked", 10000)
	t.check("real: 4009 arrives and the service stops without fighting back", replaced and PKeyConnectErrors.reason_of(svc2.status()["error"]) == "replaced" and
		svc2.status()["close_code"] == 4009, str(svc2.status()))
	await _frames(20)
	t.check("real: and does not reconnect", room.conns.size() == 1 and t2.issued == 1)
	svc2.stop()
	# A server that does not select the protocol never opens the service.
	room.protocols = PackedStringArray(["other.1"])
	room.scripts = []
	room.conns = []
	var env3 := Env.new()
	env3.source = _source()
	var t3 := Tickets.new()
	t3.url = tickets.url
	var svc3 := PKeyConnectRelay.new(env3.src(), Callable(t3, "next"), {"opener": opener, "tree": _tree(), "backoff_base": 0.02, "backoff_min": 0.01, "open_seconds": 3.0})
	svc3.start()
	await _until_ms(func() -> bool: return t3.issued >= 2, 10000)
	t.check("real: a server that does not echo the protocol never opens the service", t3.issued >= 2 and not svc3.is_open(), str(svc3.status()))
	svc3.stop()
	tree.process_frame.disconnect(pump)
	await _frames(5)
	room.stop()
	var probe := TCPServer.new()
	t.check("real: the local server's port is released", probe.listen(port, "127.0.0.1") == OK)
	probe.stop()
