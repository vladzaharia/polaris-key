extends RefCounted
# @pkey-feature connect.links connect.relay
# The contact relay (PKeyConnectContactRelay, CC-19b.G4; WIRE-CONTRACT-V5 sections 15.7 and 15.10), ported from
# sdk-node's `contactRelay.test.ts` and the Python `test_contact_relay` (the contact ticket's request and answer are
# in client_relay.gd). The 30 `contact.rooms` (9) and
# `contact.tickets` (21) rows of `peer-matrix.json` run through the relay's own code: the three room ids and the
# six aliases through a room built from a link, the 21 ticket bodies through the request body the relay asks
# with and the reader the room's ticket route is judged by. Beyond the corpus, on an in-memory room: two
# devices of two accounts open a mode-c session both ways and a message crosses it, a one-dial room stops when
# its session ends, an absent peer is not dialled, the hold of 8 first messages until MEMBERS, an account ticket
# for a contact room, the stops that must not be retried (links off, no contact rooms, 4009, three 4003, a 4008
# after a LIMIT), the backoff in minutes, the cap of 8 standing rooms, the removal of a link, and no secret,
# ticket or room id in any `str()`.
# Reads res://tests/corpus/v2/peer-matrix.json (generator-owned; never edit it).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const Lan := preload("res://tests/connect/lan.gd")

var _pair: Dictionary


## What the relay is told of the links, as the client gives them: fresh copies on each call (the relay zeroes
## them), and the promotions it reported.
class Held extends RefCounted:
	var rows: Array = []
	var promoted: Array = []
	var handed: Array = []
	var calls := 0


	func contacts() -> Array:
		calls += 1
		var out: Array = []
		for r: Dictionary in rows:
			var c := r.duplicate(true)
			c["secret"] = (r["secret"] as PackedByteArray).duplicate()
			out.append(c)
		handed.append_array(out)
		return out


	func established(c: Dictionary) -> void:
		promoted.append(c)


## Contact tickets: a new one each call, scripted results first.
class Tickets extends RefCounted:
	var issued := 0
	var rids: Array = []
	var queue: Array = []
	var url := "wss://key.plrs.im/api/connect/relay"


	func next(rid: String) -> PKeyResult:
		issued += 1
		rids.append(rid)
		await (Engine.get_main_loop() as SceneTree).process_frame
		if not queue.is_empty():
			return queue.pop_front()
		var g := PKeyConnectClient.Grant.new()
		g.url = url
		g.protocol = PKeyConnectRelay.PROTOCOL
		g.expires_at = 2000000000
		g._ticket = "pkeyrt_" + "c".repeat(31) + char(96 + (issued % 26))
		return PKeyResult.success(g)


class Clock extends RefCounted:
	var t := 1000.0


	func mono() -> float:
		return t


	func half() -> float:
		return 0.5


## One device in a contact room.
class Rig extends RefCounted:
	var env: Lan.Env
	var held: Held
	var tickets: Tickets
	var relay: PKeyConnectContactRelay
	var inbound: Array = []


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var c: Dictionary = (j.data as Dictionary)["contact"]
	_pair = PKeyTestPeers.pair(1)
	await _room_rows(t, c["rooms"])
	await _ticket_rows(t, c["tickets"])
	await _sessions(t)
	await _one_dial(t)
	await _absent_peer(t)
	await _hold(t)
	await _ticket_stops(t)
	await _close_codes(t)
	await _backoff(t)
	await _caps_and_removal(t)
	await _secrets(t)
	await _frames(30)


# -- helpers ----------------------------------------------------------------------------------------


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _frames(n: int) -> void:
	for i in n:
		await _tree().process_frame


func _until(cond: Callable, frames := 900) -> bool:
	for i in frames:
		if cond.call():
			return true
		await _tree().process_frame
	return cond.call()


func _row(secret: PackedByteArray, agree: PackedByteArray, index: int, pending := false, reachable := true) -> Dictionary:
	return {"id": "link%d" % index, "agree_key": PKeyB64Url.encode(agree), "secret": secret, "label": "", "cats": [], "pending": pending, "reachable": reachable}


func _env(d: Dictionary) -> Lan.Env:
	var e := Lan.Env.new()
	var s := PKeyConnectClient.PeerSource.new()
	s.slug = PKeyTestPeers.SLUG
	s.trust = PKeyTestPeers.trust()
	s.sub = PKeyTestPeers.SUB
	s.device_id = d["id"]
	s.certificate = d["cert"]
	s.certificate_expires_at = PKeyTestPeers.NOW + 1000
	s.ring = _pair["ring"]
	s.ring_epoch = 1
	s.roster = [d["id"]]
	s.disc_current = PKeyTestPeers.random32()
	s.agree_public = d["pub"]
	s.keys = Lan.FakeKeys.new(d["priv"])
	e.source = s
	e.now_value = PKeyTestPeers.NOW
	return e


## A device `d` in the room `room` holding `rows`.
func _node(d: Dictionary, room: PKeyRelayFakeRoom, rows: Array, extra := {}) -> Rig:
	var n := Rig.new()
	n.env = _env(d)
	n.held = Held.new()
	n.held.rows = rows
	n.tickets = Tickets.new()
	var src := n.env.src()
	src.contacts = Callable(n.held, "contacts")
	src.contact_established = Callable(n.held, "established")
	var o := {"opener": room.opener_for(PKeyPeerContact.alias(PKeyPeerContact.rid(_secret_of(rows)), d["id"])), "tree": _tree(), "ping_seconds": 100000.0}
	for k in extra:
		o[k] = extra[k]
	n.relay = PKeyConnectContactRelay.new(src, Callable(n.tickets, "next"), o)
	var inbound := n.inbound
	n.relay.session_opened.connect(func(s: PKeyConnectSession) -> void: inbound.append(s))
	return n


func _secret_of(rows: Array) -> PackedByteArray:
	return rows[0]["secret"] if not rows.is_empty() else PackedByteArray()


## The two devices of one link: a holds b's key and b holds a's, one secret, one room.
func _link_pair(extra_a := {}, extra_b := {}, reach_a := true, reach_b := true) -> Dictionary:
	var secret := PKeyTestPeers.random32()
	var a: Dictionary = _pair["a"]
	var b: Dictionary = _pair["b"]
	var room := PKeyRelayFakeRoom.new()
	var na := _node(a, room, [_row(secret, b["pub"], 0, false, reach_a)], extra_a)
	var nb := _node(b, room, [_row(secret, a["pub"], 0, false, reach_b)], extra_b)
	return {"room": room, "a": na, "b": nb, "secret": secret}


func _stop(r: Dictionary) -> void:
	(r["a"] as Rig).relay.stop()
	(r["b"] as Rig).relay.stop()


func _ctx(src: PKeyConnectLan.Source) -> Dictionary:
	return {"src": src, "ticket": Callable(), "o": {}, "tree": _tree(), "pump": PKeyPeerPump.new(_tree()), "budget": PKeyConnectSession.Budget.new()}


# -- the corpus rows --------------------------------------------------------------------------------


func _room_rows(t: PKeyTestContext, rooms: Dictionary) -> void:
	var by_rid := {}
	var good := 0
	for r: Dictionary in rooms["rid"]:
		var secret := String(r["secret"]).hex_decode()
		var env := _env(_pair["a"])
		var room := PKeyConnectContactRelay.Room.new(_ctx(env.src()), _row(secret, _pair["b"]["pub"], 0), true, Callable(), Callable())
		by_rid[r["rid"]] = room
		good += int(t.check("room id %s through a room" % r["id"], room.rid == r["rid"] and room.rid.length() == 22, room.rid))
		room.stop()
	t.check("every room id row ran", good == 3, "%d/3" % good)
	good = 0
	for r: Dictionary in rooms["alias"]:
		var secret_row: Dictionary = {}
		for s: Dictionary in rooms["rid"]:
			if s["rid"] == r["rid"]:
				secret_row = s
		var d: Dictionary = _pair["a"].duplicate()
		d["id"] = r["deviceId"]
		var env := _env(d)
		var room := PKeyConnectContactRelay.Room.new(_ctx(env.src()), _row(String(secret_row["secret"]).hex_decode(), _pair["b"]["pub"], 0), true, Callable(), Callable())
		good += int(t.check("alias %s through a room" % r["id"], room._own_alias().hex_encode() == r["alias"] and room._own_alias().size() == 24))
		room.stop()
	t.check("every alias row ran", good == 6, "%d/6" % good)


func _ticket_rows(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var body: PackedByteArray = String(r["bodyHex"]).hex_decode() if r.has("bodyHex") else String(r["body"]).to_utf8_buffer()
		var got := PKeyPeerContact.parse_ticket_body(body)
		var want: Dictionary = r["want"]
		var ok: bool = got["ok"] == want["ok"] and body.size() == int(r["length"]) and (not got["ok"] or got["rid"] == want["rid"])
		if bool(want["ok"]):
			# What the relay asks with for that room id: exactly the two members, and the reader takes it back.
			var asked := PKeyPeerContact.ticket_body(str(want["rid"]))
			var again := PKeyPeerContact.parse_ticket_body(asked.to_utf8_buffer())
			ok = ok and again["ok"] and again["rid"] == want["rid"] and asked.length() <= PKeyPeerContact.CONTACT_TICKET_BODY_MAX
		good += int(t.check("ticket body %s through the relay's request" % r["id"], ok, str(got)))
	t.check("every ticket row ran", good == 21, "%d/21" % good)


# -- two devices ------------------------------------------------------------------------------------


func _sessions(t: PKeyTestContext) -> void:
	var r := _link_pair()
	var na: Rig = r["a"]
	var nb: Rig = r["b"]
	var room: PKeyRelayFakeRoom = r["room"]
	na.relay.start()
	nb.relay.start()
	t.check("both standing rooms open", await _until(func() -> bool: return (na.relay.rooms() as Array).size() == 1 and na.relay.rooms()[0]["state"] == "open" and nb.relay.rooms()[0]["state"] == "open"))
	var rid := PKeyPeerContact.rid(r["secret"])
	t.check("each asked for a ticket for the room id, once", na.tickets.rids == [rid] and nb.tickets.rids == [rid])
	var offered: Array = room.opens[0]["protocols"]
	t.check("one socket for each, offering the protocol then the ticket", room.opens.size() == 2 and offered[0] == "pkey-relay.1" and (offered[1] as String).begins_with("pkeyrt_"))
	var got: PKeyResult = await na.relay.dial("link0")
	t.check("the dial opens a contact session", got.ok, str(got))
	if not got.ok:
		_stop(r)
		return
	var out: PKeyConnectSession = got.detail
	t.check("it names the link, has no device and rides the relay", out.contact == {"id": "link0", "pending": false} and out.peer_device_id == "" and out.path == "relay")
	t.check("the other side opens the same", await _until(func() -> bool: return not nb.inbound.is_empty()))
	var inb: PKeyConnectSession = nb.inbound[0]
	t.check("the inbound session names its link", inb.contact == {"id": "link0", "pending": false} and inb.peer_device_id == "" and inb.role == "responder")
	t.check("the room carried only aliases: the sends were addressed to 24-byte aliases", _aliases_only(room, na, rid))
	out.send("over the room".to_utf8_buffer())
	var m := await inb.receive()
	t.check("a message crosses the relay", m.ok and (m.detail["body"] as PackedByteArray).get_string_from_utf8() == "over the room")
	inb.send("and back".to_utf8_buffer())
	var back := await out.receive()
	t.check("and back", back.ok and (back.detail["body"] as PackedByteArray).get_string_from_utf8() == "and back")
	out.close()
	t.check("the close reaches the other side", await _until(func() -> bool: return inb.is_closed()))
	_stop(r)


## Every SEND the first device made is addressed to the other device's alias, never to a device id.
func _aliases_only(room: PKeyRelayFakeRoom, n: Rig, rid: String) -> bool:
	var peer_alias := PKeyPeerContact.alias(rid, _pair["b"]["id"])
	var seen := 0
	for c: PKeyRelayFakeRoom.Client in room.clients:
		if c.device != PKeyPeerContact.alias(rid, _pair["a"]["id"]):
			continue
		for data: PackedByteArray in c.sent:
			var m := PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_ROOM, data)
			if m.get("op") == &"send":
				seen += 1
				if m["to"] != peer_alias:
					return false
	return seen > 0 and n != null


func _one_dial(t: PKeyTestContext) -> void:
	# A link not marked reachable has no standing room: the dial makes one, and it stops with the session.
	var r := _link_pair({}, {}, false, true)
	var na: Rig = r["a"]
	var nb: Rig = r["b"]
	nb.relay.start()
	await _until(func() -> bool: return nb.relay.rooms().size() == 1 and nb.relay.rooms()[0]["state"] == "open")
	na.relay.start()
	t.check("a link not marked reachable has no standing room", na.relay.rooms().is_empty() and na.tickets.issued == 0)
	var got: PKeyResult = await na.relay.dial("link0")
	t.check("the dial still works, through a one-dial room", got.ok and na.tickets.issued == 1, str(got))
	t.check("that room is marked transient", na.relay.rooms().size() == 1 and na.relay.rooms()[0]["transient"])
	if got.ok:
		(got.detail as PKeyConnectSession).close()
	t.check("it is gone when its last session ends", await _until(func() -> bool: return na.relay.rooms().is_empty()))
	var unknown: PKeyResult = await na.relay.dial("nope")
	t.check("a link that is not held is unknown_peer", PKeyConnectErrors.reason_of(unknown) == "unknown_peer", str(unknown))
	_stop(r)


func _absent_peer(t: PKeyTestContext) -> void:
	var r := _link_pair()
	var na: Rig = r["a"]
	var room: PKeyRelayFakeRoom = r["room"]
	na.relay.start()
	await _until(func() -> bool: return na.relay.rooms().size() == 1 and na.relay.rooms()[0]["state"] == "open")
	var sent_before := room.last().sent.size()
	var got: PKeyResult = await na.relay.dial("link0")
	t.check("a peer MEMBERS does not list is not dialled", PKeyConnectErrors.reason_of(got) == "unknown_peer", str(got))
	var sends := 0
	for data: PackedByteArray in room.last().sent.slice(sent_before):
		if PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_ROOM, data).get("op") == &"send":
			sends += 1
	t.check("and no first message was sent into the room", sends == 0)
	na.relay.stop()


func _hold(t: PKeyTestContext) -> void:
	var secret := PKeyTestPeers.random32()
	var env := _env(_pair["a"])
	var held := Held.new()
	var src := env.src()
	src.contacts = Callable(held, "contacts")
	var room := PKeyConnectContactRelay.Room.new(_ctx(src), _row(secret, _pair["b"]["pub"], 0), true, Callable(), Callable())
	var rid := room.rid
	var own := PKeyPeerContact.alias(rid, _pair["a"]["id"])
	var peer := PKeyPeerContact.alias(rid, _pair["b"]["id"])
	var stranger := PKeyPeerContact.alias(rid, "ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS")
	room._open = true
	for i in 12:
		room._on_recv(peer, i + 1, PackedByteArray([1, 2, 3]), true)
	t.check("before MEMBERS at most 8 first messages are held", room._deferred.size() == 8 and room._links.is_empty())
	room._on_recv(own, 99, PackedByteArray([1]), true)
	t.check("a first message stamped with this device's own alias is dropped", room._deferred.size() == 8)
	room._on_members([own, peer])
	t.check("MEMBERS names the peer: the member that is not this device", room._peer == peer and room._deferred.is_empty())
	t.check("and the held messages from the peer were judged on it (4 sessions at most)", room._links.size() == 4, str(room._links.size()))
	room._on_recv(stranger, 50, PackedByteArray([1]), true)
	t.check("a first message from any other alias is dropped", not room._links.has("%s:50" % stranger.hex_encode()) and room._links.size() == 4)
	room._on_members([own, stranger, peer])
	t.check("with two others listed the peer is the first that is not this device", room._peer == stranger)
	room.stop()
	t.check("the room's secret is zeroed when it stops", room._secret.is_empty())


# -- tickets and stops ------------------------------------------------------------------------------


func _ticket_stops(t: PKeyTestContext) -> void:
	var cases := {
		"links off": PKeyConnectErrors.relay("links_disabled", "off"),
		"no contact rooms": PKeyConnectErrors.relay("contact_unsupported", "old"),
		"the relay off": PKeyConnectErrors.relay("disabled", "off"),
		"a spent quota": PKeyConnectErrors.relay("quota", "spent"),
	}
	for name: String in cases:
		var r := _link_pair()
		var na: Rig = r["a"]
		na.tickets.queue = [cases[name]]
		na.relay.start()
		await _until(func() -> bool: return na.relay.rooms().size() == 1 and na.relay.rooms()[0]["state"] == "blocked")
		t.check("%s: the room is blocked and asked once" % name, na.relay.rooms()[0]["state"] == "blocked" and na.tickets.issued == 1)
		var dialled: PKeyResult = await na.relay.dial("link0")
		t.check("%s: a dial answers the typed reason" % name, PKeyConnectErrors.reason_of(dialled) == PKeyConnectErrors.reason_of(cases[name]), str(dialled))
		await _frames(10)
		t.check("%s: and nothing more is asked" % name, na.tickets.issued == 1)
		_stop(r)


func _close_codes(t: PKeyTestContext) -> void:
	var clock := Clock.new()
	# 4009: another socket took the room; no fight back.
	var rig := _link_pair()
	var a: Rig = rig["a"]
	a.relay.start()
	await _until(func() -> bool: return a.relay.rooms().size() == 1 and a.relay.rooms()[0]["state"] == "open")
	(rig["room"] as PKeyRelayFakeRoom).last().remote_close(4009)
	await _until(func() -> bool: return a.relay.rooms()[0]["state"] == "blocked")
	t.check("4009 stops the room without fighting back", a.relay.rooms()[0]["state"] == "blocked" and a.tickets.issued == 1)
	_stop(rig)
	# 4003 three times in a row is not_member.
	var c3 := _link_pair({"mono": Callable(clock, "mono"), "random": Callable(clock, "half")})
	var n3: Rig = c3["a"]
	n3.relay.start()
	for i in 3:
		await _until(func() -> bool: return n3.tickets.issued == i + 1 and n3.relay.rooms()[0]["state"] == "open")
		(c3["room"] as PKeyRelayFakeRoom).last().remote_close(4003)
		await _until(func() -> bool: return n3.relay.rooms()[0]["state"] in ["backoff", "blocked"])
		while n3.relay.rooms()[0]["state"] == "backoff":
			clock.t += 1.0
			await _tree().process_frame
	t.check("three 4003 in a row end it", n3.relay.rooms()[0]["state"] == "blocked" and n3.tickets.issued == 3, str(n3.relay.rooms()))
	_stop(c3)
	# 4008 after LIMIT 3 is a product quota.
	var q := _link_pair()
	var nq: Rig = q["a"]
	nq.relay.start()
	await _until(func() -> bool: return nq.relay.rooms().size() == 1 and nq.relay.rooms()[0]["state"] == "open")
	(q["room"] as PKeyRelayFakeRoom).last().push(PKeyPeerRelayCodec.encode({"op": &"limit", "reason": 3}))
	await _frames(3)
	(q["room"] as PKeyRelayFakeRoom).last().remote_close(4008)
	await _until(func() -> bool: return nq.relay.rooms()[0]["state"] == "blocked")
	t.check("4008 after a LIMIT 3 stops with the quota", nq.relay.rooms()[0]["state"] == "blocked" and nq.tickets.issued == 1)
	_stop(q)
	t.check("a text frame closes the socket 1002", await _text_frame_closes())


func _text_frame_closes() -> bool:
	var r := _link_pair()
	var na: Rig = r["a"]
	na.relay.start()
	await _until(func() -> bool: return na.relay.rooms().size() == 1 and na.relay.rooms()[0]["state"] == "open")
	var c: PKeyRelayFakeRoom.Client = (r["room"] as PKeyRelayFakeRoom).last()
	c.push_text("hello")
	await _until(func() -> bool: return c.closed_by_client == 1002)
	var ok := c.closed_by_client == 1002
	_stop(r)
	return ok


func _backoff(t: PKeyTestContext) -> void:
	var clock := Clock.new()
	var r := _link_pair({"mono": Callable(clock, "mono"), "random": Callable(clock, "half")})
	var na: Rig = r["a"]
	na.tickets.queue = [PKeyConnectErrors.relay("unavailable", "x"), PKeyConnectErrors.relay("unavailable", "x")]
	na.relay.start()
	await _until(func() -> bool: return na.tickets.issued == 1 and na.relay.rooms()[0]["state"] == "backoff")
	var first := 0.0
	while na.tickets.issued < 2 and first < 100.0:
		clock.t += 0.05
		first += 0.05
		await _tree().process_frame
	t.check("a failed ticket waits minutes, not seconds: 5 s with the jitter at half is 3.75 s (%.2f)" % first, first >= 3.7 and first <= 3.9, str(first))
	await _until(func() -> bool: return na.tickets.issued == 2 and na.relay.rooms()[0]["state"] == "backoff")
	var second := 0.0
	while na.tickets.issued < 3 and second < 100.0:
		clock.t += 0.05
		second += 0.05
		await _tree().process_frame
	t.check("and twice that the next time, 7.5 s (%.2f)" % second, second >= 7.45 and second <= 7.65, str(second))
	await _until(func() -> bool: return na.relay.rooms()[0]["state"] == "open")
	_stop(r)
	# Retry-After is honoured, capped at an hour.
	var r2 := _link_pair({"mono": Callable(clock, "mono"), "random": Callable(clock, "half")})
	var nb: Rig = r2["a"]
	nb.tickets.queue = [PKeyConnectErrors.relay("unavailable", "x", {"retry_after_seconds": 90000})]
	nb.relay.start()
	await _until(func() -> bool: return nb.tickets.issued == 1 and nb.relay.rooms()[0]["state"] == "backoff")
	var waited := 0.0
	while nb.tickets.issued < 2 and waited < 4000.0:
		clock.t += 10.0
		waited += 10.0
		await _tree().process_frame
	t.check("Retry-After is capped at an hour (%.0f s)" % waited, waited >= 3590.0 and waited <= 3610.0, str(waited))
	_stop(r2)


func _caps_and_removal(t: PKeyTestContext) -> void:
	var a: Dictionary = _pair["a"]
	var room := PKeyRelayFakeRoom.new()
	var rows: Array = []
	for i in 10:
		rows.append(_row(PKeyTestPeers.random32(), PKeyTestPeers.random32(), i))
	var env := _env(a)
	var held := Held.new()
	held.rows = rows
	var tickets := Tickets.new()
	var src := env.src()
	src.contacts = Callable(held, "contacts")
	var relay := PKeyConnectContactRelay.new(src, Callable(tickets, "next"), {"opener": room.opener_for(PackedByteArray()), "tree": _tree(), "ping_seconds": 100000.0})
	relay.start()
	t.check("ten reachable links keep eight standing rooms", relay.rooms().size() == 8)
	held.rows = rows.slice(0, 3)
	relay.sync()
	t.check("a shorter list stops the rooms of the links that are gone", relay.rooms().size() == 3)
	held.rows = []
	relay.sync()
	t.check("a closed gate (no links) stops every room", relay.rooms().is_empty())
	held.rows = rows.slice(0, 2)
	relay.sync()
	relay.drop_link("link0")
	t.check("a removed link's room goes", relay.rooms().size() == 1 and relay.rooms()[0]["id"] == "link1")
	relay.stop()
	t.check("stop() leaves no room", relay.rooms().is_empty())
	var after: PKeyResult = await relay.dial("link1")
	t.check("a stopped relay dials nothing", PKeyConnectErrors.reason_of(after) == "stopped")


func _secrets(t: PKeyTestContext) -> void:
	var r := _link_pair()
	var na: Rig = r["a"]
	na.relay.start()
	await _until(func() -> bool: return na.relay.rooms().size() == 1 and na.relay.rooms()[0]["state"] == "open")
	var zeroed := true
	for c: Dictionary in na.held.handed:
		for b in (c["secret"] as PackedByteArray):
			if b != 0:
				zeroed = false
	t.check("the secrets the source handed over are zeroed", zeroed and not na.held.handed.is_empty())
	var hex := (r["secret"] as PackedByteArray).hex_encode()
	var rid := PKeyPeerContact.rid(r["secret"])
	var text := str(na.relay) + str(na.relay.rooms()) + str(PKeyConnectContactRelay.Rl.new())
	for room in (na.relay._rooms.values()):
		text += str(room)
	t.check("no secret, ticket or room id is in a str()", not text.contains(hex) and not text.contains(rid) and not text.contains("pkeyrt_"))
	_stop(r)
