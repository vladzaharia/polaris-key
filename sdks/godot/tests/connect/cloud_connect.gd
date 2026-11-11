extends RefCounted
# @pkey-feature connect.app connect.relay connect.lan
# The Cloud Connect API an app calls (PKeyCloudConnect, CC-14.15; WIRE-CONTRACT-V5 section 15, plans G9, G18,
# G21 and D-8), ported from sdk-node's `cloudConnect.test.ts` and the Python `test_cloud_connect`: the
# launch.connect gate, the relay staying off with no ticket asked for (the host, the product, no ticket
# endpoint), the LAN off on mobile and web, `querier_only` surfaced from the mDNS adapter, LAN first and
# the relay after (two devices over the in-memory room and a fake mDNS bus on real loopback TCP), `channel`
# and the close of an inbound session nobody listens for, peers, devices, notices, and stop then leave on
# sign-out failing closed.

const LAN_TEST := preload("res://tests/connect/lan.gd")
const ID_A := "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
const ID_B := "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"

var _pair: Dictionary
var _disc := PackedByteArray()
var _host: Node


class FakeKeys extends RefCounted:
	var _priv: PackedByteArray


	func _init(priv: PackedByteArray) -> void:
		_priv = priv


	func dh(remote: PackedByteArray) -> PKeyResult:
		if PKeyCurve25519.is_low_order(remote):
			return PKeyResult.success(null)
		return PKeyResult.success(PKeyCurve25519.x25519(_priv, remote))


## What the services read of the client: a fixed identity and clock.
class Env extends RefCounted:
	var source: PKeyConnectClient.PeerSource


	func load_identity() -> PKeyResult:
		return PKeyResult.success(source)


	func now() -> int:
		return PKeyTestPeers.NOW


	func refresh() -> PKeyResult:
		return PKeyResult.success()


	func src() -> PKeyConnectLan.Source:
		var s := PKeyConnectLan.Source.new()
		s.keep = self
		s.load = Callable(self, "load_identity")
		s.now = Callable(self, "now")
		s.refresh = Callable(self, "refresh")
		return s


## The identity client with its network calls replaced.
class StubClient extends PKeyConnectClient:
	var identities := 0
	var tickets := 0
	var leaves := 0
	var leave_fails := false
	var identity_fails: PKeyResult = null
	var device_id := ""
	## The roster `current()` answers with ("" for no identity).
	var held_ring := ""


	func current() -> Variant:
		return {"ring": held_ring} if held_ring != "" else null


	func identity(_refresh := false) -> PKeyResult:
		identities += 1
		await (Engine.get_main_loop() as SceneTree).process_frame
		if identity_fails != null:
			return identity_fails
		return PKeyResult.success({"device_id": device_id})


	func relay_ticket(_contact := {}) -> PKeyResult:
		tickets += 1
		await (Engine.get_main_loop() as SceneTree).process_frame
		var g := PKeyConnectClient.Grant.new()
		g.url = "wss://key.plrs.im/api/connect/relay"
		g.protocol = PKeyConnectRelay.PROTOCOL
		g.expires_at = 2000000000
		g._ticket = "pkeyrt_" + "a".repeat(31) + char(96 + (tickets % 26))
		return PKeyResult.success(g)


	func leave() -> PKeyResult:
		leaves += 1
		return PKeyResult.failure(&"store-failed", "no") if leave_fails else PKeyResult.success()


	func list_devices() -> PKeyResult:
		return PKeyResult.success([{"device_id": device_id, "label": null, "platform": null, "last_seen": null, "self": true}])


## One device: its client, its facade and the sessions it was told of.
class Device extends RefCounted:
	var client: StubClient
	var api: PKeyCloudConnect
	var env: Env
	var inbound: Array = []
	var notices: Array = []


func run(t: PKeyTestContext) -> void:
	_pair = PKeyTestPeers.pair(1)
	_disc = PKeyTestPeers.random32()
	_host = Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	await _gating(t)
	await _relay_off(t)
	await _lan_lanes(t)
	await _relay_path(t)
	await _roster_recheck(t)
	await _lan_first(t)
	await _sign_out(t)
	await _frames(20)
	_host.queue_free()


# ── helpers ──────────────────────────────────────────────────────────────────────────────────


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _frames(n: int) -> void:
	for i in n:
		await _tree().process_frame


func _until(cond: Callable, frames := 600) -> bool:
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
	s.ring = _pair["ring"]
	s.ring_epoch = 1
	s.roster.append(ID_A)
	s.roster.append(ID_B)
	s.disc_current = _disc
	s.agree_public = d["pub"]
	s.keys = FakeKeys.new(d["priv"])
	return s


func _core() -> PKeyCore:
	var clock := [PKeyTestPeers.NOW]
	var opts := PKeyTestFixtures.options("https://key.plrs.im", PKeyMemoryStore.new(ID_A, "pkeyt_x"), clock, "djdl", PKeyTestPeers.trust())
	var made := PKeyCore.create(opts, _host, "0.0.0")
	return made.detail


## A device `d` with a client, a facade, a room-opener and an mDNS.
func _node(d: Dictionary, core: PKeyCore, has_feature := Callable()) -> Device:
	var n := Device.new()
	n.env = Env.new()
	n.env.source = _source(d)
	n.client = StubClient.new(core, PKeyConnectState.new("djdl", "user://pkey", true), null)
	n.client.device_id = d["id"]
	n.api = PKeyCloudConnect.new(core, n.client, {"tree": _tree(), "has_feature": has_feature})
	var inbound := n.inbound
	var notices := n.notices
	n.api.channel.connect(func(s: PKeyConnectSession) -> void: inbound.append(s))
	n.api.notice.connect(func(x: Dictionary) -> void: notices.append(x))
	return n


func _opts(n: Device, extra := {}) -> Dictionary:
	var o := {"source": n.env.src(), "label": "Den"}
	for k in extra:
		o[k] = extra[k]
	return o


func _manifest(connect: Variant) -> Dictionary:
	return {"services": {"connect": connect}}


# ── the gate and the reasons ─────────────────────────────────────────────────────────────────


func _gating(t: PKeyTestContext) -> void:
	var core := _core()
	var n := _node(_pair["a"], core)
	t.check("gate: a new facade is not running and its LAN is off, not started", not n.api.status()["running"] and n.api.status()["lan"] == "off" and n.api.status()["lan_reason"] == "not_started")
	n.api.stop()
	t.check("gate: stop() before start does nothing", not n.api.status()["running"])
	t.check("gate: peers() is empty before start", n.api.peers().is_empty())
	core.discovery_manifest = _manifest({"enabled": false})
	var off: PKeyResult = await n.api.start(_opts(n))
	t.check("gate: launch.connect off (discovery enabled false) fails connect-unavailable", not off.ok and off.code == &"connect-unavailable", str(off))
	t.check("gate: and asked the Worker for nothing", n.client.identities == 0 and n.client.tickets == 0 and not n.api.status()["running"])
	core.discovery_manifest = {"services": {}}
	var none: PKeyResult = await n.api.start(_opts(n))
	t.check("gate: a discovery without connect is off too", not none.ok and none.code == &"connect-unavailable")
	core.discovery_manifest = _manifest({"enabled": true, "relay": true, "endpoints": {"identity": "x", "ticket": "y"}})
	n.client.identity_fails = PKeyResult.failure(&"no-token", "none")
	var failed: PKeyResult = await n.api.start(_opts(n, {"lan": false, "relay": false}))
	t.check("gate: an identity failure is returned as it is, and nothing runs", not failed.ok and failed.code == &"no-token" and not n.api.status()["running"])
	var open_first: PKeyResult = await n.api.open(ID_B)
	t.check("gate: open() before a start is not_started", PKeyConnectErrors.reason_of(open_first) == "not_started")
	t.check("gate: str() shows nothing but the state", str(n.api) == "PKeyCloudConnect(running=false)")


func _relay_off(t: PKeyTestContext) -> void:
	var cases := {
		"the host turned it off": [_manifest({"enabled": true, "relay": true, "endpoints": {"ticket": "y"}}), {"relay": false}, "host"],
		"the product has it off": [_manifest({"enabled": true, "relay": false, "endpoints": {"ticket": null}}), {}, "product"],
		"discovery names no ticket endpoint": [_manifest({"enabled": true, "relay": true, "endpoints": {"identity": "x", "ticket": null}}), {}, "no_ticket"],
	}
	for name: String in cases:
		var core := _core()
		core.discovery_manifest = cases[name][0]
		var n := _node(_pair["a"], core)
		var o: Dictionary = cases[name][1].duplicate()
		o["lan"] = false
		var started: PKeyResult = await n.api.start(_opts(n, o))
		await _frames(10)
		var st := n.api.status()
		t.check("G21: %s: the relay stays off with reason %s" % [name, cases[name][2]], started.ok and st["relay"] == "off" and st["relay_reason"] == cases[name][2], str(st))
		t.check("G21: %s: and no ticket was asked for" % name, n.client.tickets == 0)
		t.check("G21: %s: running, LAN off for the host" % name, st["running"] and st["lan"] == "off" and st["lan_reason"] == "host")
		var refreshed: Array = await n.api.refresh_peers()
		t.check("G21: %s: refresh_peers is a no-op" % name, refreshed.is_empty())
		var opened: PKeyResult = await n.api.open(ID_B)
		t.check("G21: %s: open() has neither path: unknown_peer" % name, PKeyConnectErrors.reason_of(opened) == "unknown_peer", str(opened))
		n.api.stop()
	t.check("G21: no discovery at all allows the relay", PKeyCloudConnect._relay_wanted(null) == "")
	# The LAN failing to start is returned when the relay is off.
	var core2 := _core()
	var n2 := _node(_pair["a"], core2)
	var bad := LAN_TEST.FakeMdns.new()
	bad.fail_advertise = true
	var lan_fail: PKeyResult = await n2.api.start(_opts(n2, {"relay": false, "lan": {"mdns": bad, "allow_loopback": true}}))
	t.check("lan failure: with the relay off the LAN failure is returned", not lan_fail.ok and not n2.api.status()["running"], str(lan_fail))
	t.check("lan failure: and it is on the status", n2.api.status()["lan"] == "failed")
	n2.api.stop()


func _lan_lanes(t: PKeyTestContext) -> void:
	var core := _core()
	core.discovery_manifest = _manifest({"enabled": true, "relay": false})
	# With the real Apple or Android binding loaded in this process (a run with the native plugin installed) the
	# mobile tags find a native lane and the LAN is on: the "no native lane" expectations hold only without it.
	var bridged := PKeyCloudConnect._native_lane() != null
	for tag in ["web"] if bridged else ["android", "ios", "mobile", "web"]:
		var n := _node(_pair["a"], core, func(f: String) -> bool: return f == tag)
		var r: PKeyResult = await n.api.start(_opts(n))
		var st := n.api.status()
		t.check("D-8: %s: the LAN is off with reason unsupported, nothing opened" % tag, r.ok and st["lan"] == "off" and st["lan_reason"] == "unsupported", str(st))
		n.api.stop()
	if bridged:
		t.info("CC-14b: a native bridge is loaded in this process; the no-native-lane check is skipped")
	else:
		t.check("CC-14b: with no native bridge in this process there is no native lane", PKeyCloudConnect._native_lane() == null)
	for tag in ["ios", "android"]:
		var m := _node(_pair["a"], core, func(f: String) -> bool: return f == tag or f == "mobile")
		var lane := LAN_TEST.FakeMdns.new()
		var ms: PKeyResult = await m.api.start(_opts(m, {"lan": {"mdns": lane, "allow_loopback": true}}))
		t.check("CC-14b: %s: a discovery lane the host hands in runs the LAN" % tag, ms.ok and m.api.status()["lan"] == "on", str(m.api.status()))
		m.api.stop()
	var web := _node(_pair["a"], core, func(f: String) -> bool: return f == "web")
	var ws: PKeyResult = await web.api.start(_opts(web, {"lan": {"mdns": LAN_TEST.FakeMdns.new()}}))
	t.check("CC-14b: web: the LAN stays off even with a lane handed in", ws.ok and web.api.status()["lan"] == "off" and web.api.status()["lan_reason"] == "unsupported", str(web.api.status()))
	web.api.stop()
	var q := _node(_pair["a"], core)
	var querier := LAN_TEST.FakeMdns.new()
	querier.querier_only = true
	var started: PKeyResult = await q.api.start(_opts(q, {"lan": {"mdns": querier, "allow_loopback": true}}))
	var st2 := q.api.status()
	t.check("mdns reason: a querier-only device is on the LAN as querier_only", started.ok and st2["lan"] == "querier_only" and st2["lan_reason"] == "querier_only", str(st2))
	q.api.stop()
	var full := _node(_pair["a"], core)
	var ok_mdns := LAN_TEST.FakeMdns.new()
	await full.api.start(_opts(full, {"lan": {"mdns": ok_mdns, "allow_loopback": true}}))
	t.check("mdns reason: a responder is on, with no reason", full.api.status()["lan"] == "on" and full.api.status()["lan_reason"] == "")
	full.api.stop()
	t.check("mdns reason: after stop the LAN is off", full.api.status()["lan"] == "off" and not full.api.status()["running"])


# ── the relay path ───────────────────────────────────────────────────────────────────────────


func _relay_pair(core: PKeyCore, lan_a: Variant, lan_b: Variant) -> Dictionary:
	var room := PKeyRelayFakeRoom.new()
	var a := _node(_pair["a"], core)
	var b := _node(_pair["b"], core)
	var oa := {"opener": room.opener_for(_bytes(ID_A)), "ping_seconds": 100000.0}
	var ob := {"opener": room.opener_for(_bytes(ID_B)), "ping_seconds": 100000.0}
	var la: Variant = false if lan_a == null else {"mdns": lan_a, "allow_loopback": true}
	var lb: Variant = false if lan_b == null else {"mdns": lan_b, "allow_loopback": true}
	var ra: PKeyResult = await a.api.start(_opts(a, {"lan": la, "relay": oa}))
	var rb: PKeyResult = await b.api.start(_opts(b, {"lan": lb, "relay": ob}))
	return {"room": room, "a": a, "b": b, "ok": ra.ok and rb.ok}


func _relay_path(t: PKeyTestContext) -> void:
	var core := _core()
	core.discovery_manifest = _manifest({"enabled": true, "relay": true, "endpoints": {"ticket": "y"}})
	var rig := await _relay_pair(core, null, null)
	var a: Device = rig["a"]
	var b: Device = rig["b"]
	t.check("relay: both start", rig["ok"] and a.api.status()["running"] and b.api.status()["running"])
	await _until(func() -> bool: return a.api.status()["relay"] == "open" and b.api.status()["relay"] == "open")
	t.check("relay: each asked for its own ticket once", a.client.tickets == 1 and b.client.tickets == 1)
	var peers: Array = await a.api.refresh_peers()
	t.check("relay: refresh_peers lists the other device on the relay only", peers == [{"device_id": ID_B, "lan": false, "relay": true}], str(peers))
	t.check("relay: peers() does not list this device", not a.api.peers().any(func(p: Dictionary) -> bool: return p["device_id"] == ID_A))
	var devs: PKeyResult = await a.api.devices()
	t.check("relay: devices() is the Worker's list", devs.ok and devs.detail.size() == 1 and devs.detail[0]["device_id"] == ID_A)
	var r: PKeyResult = await a.api.open(ID_B)
	if not t.check("relay: open() reaches the other device over the relay", r.ok and (r.detail as PKeyConnectSession).path == "relay", str(r)):
		a.api.stop()
		b.api.stop()
		return
	var sa: PKeyConnectSession = r.detail
	await _until(func() -> bool: return b.inbound.size() == 1)
	t.check("relay: channel fires on the other device", b.inbound.size() == 1 and (b.inbound[0] as PKeyConnectSession).peer_device_id == ID_A)
	sa.send("over the relay".to_utf8_buffer())
	var got: PKeyResult = await (b.inbound[0] as PKeyConnectSession).receive()
	t.check("relay: and a message crosses", got.ok and (got.detail["body"] as PackedByteArray).get_string_from_utf8() == "over the relay")
	var refused: PKeyResult = await a.api.open(ID_B, {"relay": false})
	t.check("relay: relay=false per call with no LAN path is unknown_peer", PKeyConnectErrors.reason_of(refused) == "unknown_peer", str(refused))
	# G9: B stops listening; an inbound session is closed.
	for c in b.api.channel.get_connections():
		b.api.channel.disconnect(c["callable"])
	var again: PKeyResult = await a.api.open(ID_B)
	if again.ok:
		var s2: PKeyConnectSession = again.detail
		await _until(func() -> bool: return s2.is_closed())
		t.check("G9: an inbound session with no channel listener is closed", s2.is_closed() and b.inbound.size() == 1, str(s2.closed_info()))
	else:
		t.check("G9: an inbound session with no channel listener is closed (the dial itself failed)", PKeyConnectErrors.reason_of(again) != "", str(again))
	# stop closes the sessions.
	var closed := [0]
	sa.closed.connect(func(_c: StringName, _p: bool) -> void: closed[0] += 1)
	a.api.stop()
	t.check("stop: the session is closed and the relay and LAN are gone", sa.is_closed() and closed[0] <= 1 and a.api.status()["relay"] == "off" and not a.api.status()["running"])
	a.api.stop()
	b.api.stop()
	await _frames(5)


## A newly stored roster is judged against every open session: one that drops the peer closes `peer_revoked`,
## and one that only adds a device keeps it.
func _roster_recheck(t: PKeyTestContext) -> void:
	var core := _core()
	core.discovery_manifest = _manifest({"enabled": true, "relay": true, "endpoints": {"ticket": "y"}})
	var rig := await _relay_pair(core, null, null)
	var a: Device = rig["a"]
	var b: Device = rig["b"]
	await _until(func() -> bool: return a.api.status()["relay"] == "open" and b.api.status()["relay"] == "open")
	var r: PKeyResult = await a.api.open(ID_B)
	if not t.check("roster: a session is open", r.ok, str(r)):
		a.api.stop()
		b.api.stop()
		return
	var sa: PKeyConnectSession = r.detail
	await _until(func() -> bool: return b.inbound.size() == 1)
	var sb: PKeyConnectSession = b.inbound[0]
	a.client.held_ring = PKeyTestPeers.ring(3, [_pair["a"], _pair["b"]])
	a.client.on_stored.call()
	await _frames(10)
	t.check("roster: a stored roster that keeps the peer keeps the session", not sa.is_closed() and not sb.is_closed())
	a.client.held_ring = PKeyTestPeers.ring(4, [_pair["a"]])
	a.client.on_stored.call()
	await _until(func() -> bool: return sa.is_closed() and sb.is_closed())
	t.check("roster: a stored roster that drops the peer closes the session peer_revoked", sa.closed_info() == {"code": &"peer_revoked", "by_peer": false}, str(sa.closed_info()))
	t.check("roster: and the peer is told", sb.closed_info() == {"code": &"peer_revoked", "by_peer": true}, str(sb.closed_info()))
	a.api.stop()
	b.api.stop()
	await _frames(5)


# ── LAN first, then the relay ────────────────────────────────────────────────────────────────


func _lan_first(t: PKeyTestContext) -> void:
	var core := _core()
	core.discovery_manifest = _manifest({"enabled": true, "relay": true, "endpoints": {"ticket": "y"}})
	var bus := LAN_TEST.Bus.new()
	var rig := await _relay_pair(core, LAN_TEST.FakeMdns.new(bus), LAN_TEST.FakeMdns.new(bus))
	var a: Device = rig["a"]
	var b: Device = rig["b"]
	await _until(func() -> bool: return a.api.status()["relay"] == "open" and b.api.status()["relay"] == "open")
	t.check("lan first: both are on the LAN and the relay", a.api.status()["lan"] == "on" and a.api.status()["relay"] == "open")
	await _until(func() -> bool: return a.api.peers().any(func(p: Dictionary) -> bool: return p["lan"]))
	var seen: Array = a.api.peers()
	t.check("lan first: the peer is on the LAN (and the relay once listed)", seen.size() == 1 and seen[0]["device_id"] == ID_B and seen[0]["lan"], str(seen))
	var r: PKeyResult = await a.api.open(ID_B)
	t.check("lan first: open() takes the LAN", r.ok and (r.detail as PKeyConnectSession).path == "lan", str(r))
	await _until(func() -> bool: return b.inbound.size() == 1)
	t.check("lan first: and channel fires on the other, path lan", b.inbound.size() == 1 and (b.inbound[0] as PKeyConnectSession).path == "lan")
	a.api.stop()
	b.api.stop()
	await _frames(5)
	# Two networks: the LAN never sees the peer, so the relay is used.
	var split := await _relay_pair(core, LAN_TEST.FakeMdns.new(LAN_TEST.Bus.new()), LAN_TEST.FakeMdns.new(LAN_TEST.Bus.new()))
	var c: Device = split["a"]
	var d: Device = split["b"]
	await _until(func() -> bool: return c.api.status()["relay"] == "open" and d.api.status()["relay"] == "open")
	await c.api.refresh_peers()
	var via_relay: PKeyResult = await c.api.open(ID_B)
	t.check("relay after: a device not seen on the LAN goes straight to the relay", via_relay.ok and (via_relay.detail as PKeyConnectSession).path == "relay", str(via_relay))
	c.api.stop()
	d.api.stop()
	await _frames(5)
	# A LAN peer that cannot be dialled: bounded, then the relay.
	var bus2 := LAN_TEST.Bus.new()
	var third := await _relay_pair(core, LAN_TEST.FakeMdns.new(bus2), LAN_TEST.FakeMdns.new(bus2))
	var e: Device = third["a"]
	var f: Device = third["b"]
	await _until(func() -> bool: return e.api.peers().any(func(p: Dictionary) -> bool: return p["lan"]) and e.api.status()["relay"] == "open")
	# Close B's TCP listener so the dial is refused; A falls to the relay.
	(f.api._lan as PKeyConnectLan)._server.stop()
	var fell: PKeyResult = await e.api.open(ID_B, {"lan_attempt_seconds": 3.0})
	t.check("relay after: a LAN attempt that fails falls through to the relay", fell.ok and (fell.detail as PKeyConnectSession).path == "relay", str(fell))
	e.api.stop()
	f.api.stop()
	await _frames(5)


# ── sign-out ─────────────────────────────────────────────────────────────────────────────────


func _sign_out(t: PKeyTestContext) -> void:
	var core := _core()
	core.discovery_manifest = _manifest({"enabled": true, "relay": true, "endpoints": {"ticket": "y"}})
	var rig := await _relay_pair(core, null, null)
	var a: Device = rig["a"]
	var b: Device = rig["b"]
	await _until(func() -> bool: return a.api.status()["relay"] == "open")
	var r: PKeyResult = await a.api.open(ID_B)
	var ended := r.ok and (r.detail as PKeyConnectSession) != null
	var out := a.api._sign_out_step()
	t.check("sign-out: stops Connect, then forgets the state", out.ok and a.client.leaves == 1 and not a.api.status()["running"] and a.api.status()["relay"] == "off", str(out))
	t.check("sign-out: and the open session is closed", ended and (r.detail as PKeyConnectSession).is_closed())
	t.check("sign-out: it can be run twice", a.api._sign_out_step().ok and a.client.leaves == 2)
	b.client.leave_fails = true
	var failed := b.api._sign_out_step()
	t.check("sign-out: a record that cannot be forgotten fails closed, Connect still stopped", not failed.ok and not b.api.status()["running"])
	# A stop while start waits for the identity cancels the start.
	var c := _node(_pair["a"], core)
	var pending := [null]
	var run := func() -> void: pending[0] = await c.api.start(_opts(c, {"lan": false, "relay": false}))
	run.call()
	c.api.stop()
	await _until(func() -> bool: return pending[0] != null)
	t.check("sign-out: a stop during start cancels it: nothing runs", pending[0] != null and not (pending[0] as PKeyResult).ok and not c.api.status()["running"])
	b.api.stop()
	await _frames(5)
