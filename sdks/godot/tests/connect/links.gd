extends RefCounted
# @pkey-feature connect.links
# The links API an app calls (PKeyCloudLinks, `PolarisKey.cloud_connect.links`, CC-19b.G4; WIRE-CONTRACT-V5
# section 15.10), ported from sdk-node's `links.test.ts` and the Python `test_links`: the gate (`pair` and
# `open` answer `connect_links_disabled` while the cached discovery `interAccount` is false; web is N/A as the
# plan's Q2 says), `list`, `set_reachable` and `remove` over the real record (the secret is gone from it, the
# peers' keys reach the purge hook, the open session ends `peer_revoked`), `pair` opening the window on a fake
# lane and a closed gate closing it, `open` over the contact relay (two devices of two accounts, a session
# both ways, `link` with nothing connected closing the session), the LAN first when the link is seen on the
# network, a discovery fetch that turns the gate off ending the sessions with `peer_bye`, and the plain-word
# rule that no key or secret is in a list or a `str()`.

const Lan := preload("res://tests/connect/lan.gd")
const Pairing := preload("res://tests/connect/pairing.gd")

var _pair: Dictionary
var _host: Node


## The identity client with its network calls replaced; the link rows are the real record's.
class StubClient extends PKeyConnectClient:
	var identities := 0
	var agree := PackedByteArray()
	var identity_fails: PKeyResult = null


	func identity(_refresh := false) -> PKeyResult:
		identities += 1
		await (Engine.get_main_loop() as SceneTree).process_frame
		return identity_fails if identity_fails != null else PKeyResult.success({})


	func _agree_public() -> Variant:
		return agree


## One device: its client, its facade and what it was told.
class Device extends RefCounted:
	var core: PKeyCore
	var client: StubClient
	var state: PKeyConnectState
	var links: PKeyCloudLinks
	var env: Lan.Env
	var relay: PKeyConnectContactRelay
	var inbound: Array = []
	var removed: Array = []
	var tickets := 0
	var id := ""


	func ticket(_rid: String) -> PKeyResult:
		tickets += 1
		await (Engine.get_main_loop() as SceneTree).process_frame
		var g := PKeyConnectClient.Grant.new()
		g.url = "wss://key.plrs.im/api/connect/relay"
		g.protocol = PKeyConnectRelay.PROTOCOL
		g.expires_at = 2000000000
		g._ticket = "pkeyrt_" + "d".repeat(31) + char(96 + (tickets % 26))
		return PKeyResult.success(g)


	func purged(keys: Array) -> void:
		removed.append_array(keys)


func run(t: PKeyTestContext) -> void:
	_pair = PKeyTestPeers.pair(1)
	_host = Node.new()
	_tree().root.add_child(_host)
	await _gate(t)
	await _rows(t)
	await _pairing(t)
	await _over_the_relay(t)
	await _lan_first(t)
	await _gate_moves(t)
	await _late_changes(t)
	await _lan_in_flight(t)
	await _cache_and_promotion(t)
	await _frames(20)
	_host.queue_free()


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


func _core(inter_account: Variant = true) -> PKeyCore:
	var clock := [PKeyTestPeers.NOW]
	var opts := PKeyTestFixtures.options("https://key.plrs.im", PKeyMemoryStore.new(_pair["a"]["id"], "pkeyt_x"), clock, "djdl", PKeyTestPeers.trust())
	var core: PKeyCore = PKeyCore.create(opts, _host, "0.0.0").detail
	_manifest(core, inter_account)
	return core


func _manifest(core: PKeyCore, inter_account: Variant) -> void:
	var f := {"enabled": true, "lan": true, "relay": true}
	if inter_account != null:
		f["interAccount"] = inter_account
	core.discovery_manifest = {"services": {"connect": f}}


static func _key(n: int) -> String:
	var b := PackedByteArray()
	b.resize(32)
	b.fill(n)
	return PKeyB64Url.encode(b)


static func _raw(agree: String, secret: String, reachable := true, pending := -1) -> Dictionary:
	var d := {"agreeKey": agree, "secret": secret, "cats": ["games"], "createdAt": 1, "reachable": reachable}
	if pending >= 0:
		d["pendingSince"] = pending
	return d


func _record(rows: Array, device_id := "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH") -> PKeyConnectState.Record:
	var r := PKeyConnectState.Record.new()
	r.product = "djdl"
	r.device_id = device_id
	r.ring = "ring"
	r.certificate = "cert"
	r.disc_keys.append(_key(200))
	r.contacts = rows
	return r


## A device `d` holding `rows` in its record, with the gate `inter_account`.
func _device(d: Dictionary, rows: Array, inter_account: Variant = true, web := false) -> Device:
	var n := Device.new()
	n.id = d["id"]
	n.core = _core(inter_account)
	n.state = PKeyConnectState.for_tests("djdl", "user://pkey", true)
	n.state.write(_record(rows, d["id"]))
	n.client = StubClient.new(n.core, n.state, null)
	n.client.agree = d["pub"]
	n.env = Lan.Env.new()
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
	n.env.source = s
	n.env.now_value = PKeyTestPeers.NOW
	var lane := Pairing.Lane.new(Pairing.Bus.new())
	n.links = PKeyCloudLinks.new(n.core, n.client, {"tree": _tree(), "web": func() -> bool: return web, "lane": func() -> Object: return lane})
	n.links.removed = Callable(n, "purged")
	var inbound := n.inbound
	n.links.link.connect(func(x: PKeyConnectSession) -> void: inbound.append(x))
	return n


func _source(n: Device) -> PKeyConnectLan.Source:
	var src := n.env.src()
	src.contacts = Callable(n.client, "live_contacts")
	src.contact_established = Callable(n.client, "contact_established")
	src.inter_account = Callable(n.client, "inter_account")
	return src


## Two devices of two accounts holding one link, and a fake room both reach.
func _linked(inter_account: Variant = true) -> Dictionary:
	var secret := _key(7)
	var a: Dictionary = _pair["a"]
	var b: Dictionary = _pair["b"]
	var na := _device(a, [_raw(PKeyB64Url.encode(b["pub"]), secret)], inter_account)
	var nb := _device(b, [_raw(PKeyB64Url.encode(a["pub"]), secret)], inter_account)
	var room := PKeyRelayFakeRoom.new()
	var rid := PKeyPeerContact.rid(PKeyB64Url.decode_strict(secret))
	for pair in [[na, a], [nb, b]]:
		var n: Device = pair[0]
		var d: Dictionary = pair[1]
		n.relay = PKeyConnectContactRelay.new(_source(n), Callable(n, "ticket"), {
			"opener": room.opener_for(PKeyPeerContact.alias(rid, d["id"])), "tree": _tree(), "ping_seconds": 100000.0,
		})
		n.links.attach(null, n.relay, {"relay_on": true})
		n.relay.start()
	return {"a": na, "b": nb, "room": room, "id_a": PKeyConnectContacts.id_of(PKeyB64Url.encode(b["pub"])), "id_b": PKeyConnectContacts.id_of(PKeyB64Url.encode(a["pub"]))}


func _finish(r: Dictionary) -> void:
	for k in ["a", "b"]:
		var n: Device = r[k]
		n.links.detach()
		n.relay.stop()


# -- the gate ---------------------------------------------------------------------------------------


func _gate(t: PKeyTestContext) -> void:
	var n := _device(_pair["a"], [], null)
	t.check("gate: no discovery yet: interAccount is false", not n.links.inter_account())
	var pair_r: PKeyResult = await n.links.pair({"categories": [], "on_offer": func(_o: Variant) -> void: pass})
	t.check("gate: pair answers connect_links_disabled and asked for no identity", not pair_r.ok and String(pair_r.code) == "connect_links_disabled" and n.client.identities == 0, str(pair_r))
	t.check("gate: the N/A names the feature and the product as the reason", pair_r.detail["feature"] == "connect.links" and pair_r.detail["reason"] == "product")
	var open_r: PKeyResult = await n.links.open("anything")
	t.check("gate: open answers connect_links_disabled", not open_r.ok and String(open_r.code) == "connect_links_disabled")
	_manifest(n.core, false)
	t.check("gate: a discovery that says false is false", not n.links.inter_account())
	_manifest(n.core, "yes")
	t.check("gate: and only a true boolean is true", not n.links.inter_account())
	_manifest(n.core, true)
	t.check("gate: interAccount true opens the gate", n.links.inter_account())
	var started: PKeyResult = await n.links.open("anything")
	t.check("gate: open before Cloud Connect started is not_started", PKeyConnectErrors.reason_of(started) == "not_started", str(started))
	var listed := n.links.list()
	t.check("gate: list is empty and ok", listed.ok and listed.detail == [])
	# Web: no pairing, no links.
	var w := _device(_pair["a"], [_raw(_key(1), _key(2))], true, true)
	var wp: PKeyResult = await w.links.pair({"categories": []})
	t.check("web: pair answers connect-unavailable with the runtime as the reason", not wp.ok and String(wp.code) == "connect-unavailable" and wp.detail["reason"] == "runtime", str(wp))
	t.check("web: list is empty", w.links.list().ok and w.links.list().detail == [])
	var wo: PKeyResult = await w.links.open("x")
	t.check("web: open answers link-unknown", not wo.ok and String(wo.code) == "link-unknown")
	t.check("web: remove and set_reachable answer link-unknown", String(w.links.remove("x").code) == "link-unknown" and String(w.links.set_reachable("x", true).code) == "link-unknown")
	t.check("str() shows nothing", str(n.links) == "PKeyCloudLinks()")


# -- list, set_reachable, remove --------------------------------------------------------------------


func _rows(t: PKeyTestContext) -> void:
	var secret_a := _key(11)
	var n := _device(_pair["a"], [_raw(_key(21), secret_a), _raw(_key(22), _key(12), false)])
	var id1 := PKeyConnectContacts.id_of(_key(21))
	var id2 := PKeyConnectContacts.id_of(_key(22))
	var listed := n.links.list()
	t.check("list: the two links, in order", listed.ok and listed.detail.size() == 2 and listed.detail[0]["id"] == id1 and listed.detail[1]["id"] == id2, str(listed))
	t.check("list: with their categories and reachability", listed.detail[0]["categories"] == ["games"] and listed.detail[0]["reachable"] and not listed.detail[1]["reachable"])
	var text := JSON.stringify(listed.detail) + str(listed)
	t.check("list: no secret and no key", not text.contains(secret_a) and not text.contains(_key(21)) and not text.contains(_key(12)))
	var changed := [0]
	n.client.contacts_changed.connect(func() -> void: changed[0] += 1)
	var set_r := n.links.set_reachable(id2, true)
	t.check("set_reachable: marks it and tells the readers", set_r.ok and n.links.list().detail[1]["reachable"] and changed[0] == 1)
	t.check("set_reachable: an unknown link is link-unknown", String(n.links.set_reachable("zzzz", true).code) == "link-unknown")
	var live := n.client.live_contacts()
	t.check("live_contacts: both, secrets decoded for the caller", live.size() == 2 and (live[0]["secret"] as PackedByteArray).size() == 32)
	PKeyConnectContacts.wipe_live(live)
	var rem := n.links.remove(id1)
	var raw := JSON.stringify((n.state.read().detail as PKeyConnectState.Record).contacts)
	t.check("remove: ok, and the secret is gone from the record", rem.ok and not raw.contains(secret_a) and n.links.list().detail.size() == 1)
	t.check("remove: the peer's key reached the purge hook as raw bytes", n.removed.size() == 1 and n.removed[0] == PKeyB64Url.decode_strict(_key(21)))
	t.check("remove: and the readers were told", changed[0] == 2)
	var again := n.links.remove(id1)
	t.check("remove: again is link-unknown", not again.ok and String(again.code) == "link-unknown")
	var nil_list := _device(_pair["a"], [])
	nil_list.state.clear()
	t.check("a device with no record holds no links", nil_list.links.list().ok and nil_list.links.list().detail == [])


# -- pair -------------------------------------------------------------------------------------------


func _pairing(t: PKeyTestContext) -> void:
	var n := _device(_pair["a"], [])
	var offers: Array = []
	var w: PKeyResult = await n.links.pair({"categories": ["games"], "label": "Den", "on_offer": func(o: Variant) -> void: offers.append(o)})
	t.check("pair: opens the window after the identity", w.ok and n.client.identities == 1, str(w))
	if not w.ok:
		return
	var window: PKeyConnectPairing = w.detail
	t.check("pair: it is open", window.is_open())
	var bad: PKeyResult = await n.links.pair({"categories": ["Bad Name"], "on_offer": func(_o: Variant) -> void: pass})
	t.check("pair: options the window refuses are invalid-options", not bad.ok and String(bad.code) == "invalid-options", str(bad))
	_manifest(n.core, false)
	n.core.discovery_changed.emit()
	t.check("pair: a discovery that turns the gate off closes the window", not window.is_open())
	n.links.close_pairings()
	var again: PKeyResult = await n.links.pair({"categories": [], "on_offer": func(_o: Variant) -> void: pass})
	t.check("pair: and a new one is refused", String(again.code) == "connect_links_disabled")
	# A runtime with no discovery lane: the typed N/A.
	var m := _device(_pair["a"], [])
	m.links = PKeyCloudLinks.new(m.core, m.client, {"tree": _tree(), "web": func() -> bool: return false})
	var nl: PKeyResult = await m.links.pair({"categories": [], "on_offer": func(_o: Variant) -> void: pass})
	t.check("pair: with no lane it is nearby-unsupported", not nl.ok and String(nl.code) == "nearby-unsupported" and nl.detail["feature"] == "connect.links", str(nl))
	var failed := _device(_pair["a"], [])
	failed.client.identity_fails = PKeyResult.failure(&"no-token", "none")
	var nf: PKeyResult = await failed.links.pair({"categories": [], "on_offer": func(_o: Variant) -> void: pass})
	t.check("pair: an identity failure is returned as it is", not nf.ok and nf.code == &"no-token")


# -- open over the contact relay --------------------------------------------------------------------


func _over_the_relay(t: PKeyTestContext) -> void:
	var r := _linked()
	var na: Device = r["a"]
	var nb: Device = r["b"]
	await _until(func() -> bool: return na.relay.rooms().size() == 1 and na.relay.rooms()[0]["state"] == "open" and nb.relay.rooms()[0]["state"] == "open")
	var unknown: PKeyResult = await na.links.open("zzzz")
	t.check("open: a link that is not held is link-unknown", not unknown.ok and String(unknown.code) == "link-unknown", str(unknown))
	var lan_only: PKeyResult = await na.links.open(r["id_a"], {"relay": false})
	t.check("open: relay off and not on the LAN: unknown_peer", PKeyConnectErrors.reason_of(lan_only) == "unknown_peer", str(lan_only))
	var got: PKeyResult = await na.links.open(r["id_a"])
	t.check("open: a session over the contact relay", got.ok, str(got))
	if not got.ok:
		_finish(r)
		return
	var out: PKeyConnectSession = got.detail
	t.check("open: it names the link and rides the relay", out.contact == {"id": r["id_a"], "pending": false} and out.path == "relay" and out.peer_device_id == "")
	t.check("link: the other device's signal fires", await _until(func() -> bool: return not nb.inbound.is_empty()))
	var inb: PKeyConnectSession = nb.inbound[0]
	t.check("link: it names the link on that device", inb.contact == {"id": r["id_b"], "pending": false})
	out.send("hi".to_utf8_buffer())
	var m := await inb.receive()
	t.check("a message crosses", m.ok and (m.detail["body"] as PackedByteArray).get_string_from_utf8() == "hi")
	# A removed link ends its session peer_revoked, on the device that removed it first.
	var closed_a := []
	out.closed.connect(func(code: StringName, by_peer: bool) -> void: closed_a.append([code, by_peer]))
	var rem := na.links.remove(r["id_a"])
	t.check("remove: ok with a session open", rem.ok)
	t.check("remove: the open session ended peer_revoked", await _until(func() -> bool: return out.is_closed()) and closed_a[0][0] == &"peer_revoked" and not closed_a[0][1], str(closed_a))
	t.check("remove: the room of the link is gone", await _until(func() -> bool: return na.relay.rooms().is_empty()))
	t.check("remove: the other device hears it end", await _until(func() -> bool: return inb.is_closed()))
	_finish(r)
	# With nothing connected to `link` an inbound session is closed (G9).
	var q := _linked()
	var qa: Device = q["a"]
	var qb: Device = q["b"]
	for c in qb.links.get_signal_connection_list("link"):
		qb.links.link.disconnect(c["callable"])
	await _until(func() -> bool: return qa.relay.rooms().size() == 1 and qa.relay.rooms()[0]["state"] == "open" and qb.relay.rooms()[0]["state"] == "open")
	var g: PKeyResult = await qa.links.open(q["id_a"])
	# The listener closes it at once: the dial either sees the session end or is told it closed too soon.
	var shut: bool = not g.ok or await _until(func() -> bool: return (g.detail as PKeyConnectSession).is_closed())
	t.check("link: with nothing connected the inbound session is closed", shut and qb.inbound.is_empty(), str(g))
	_finish(q)


# -- the LAN first ----------------------------------------------------------------------------------


func _lan_first(t: PKeyTestContext) -> void:
	var secret := _key(9)
	var a: Dictionary = _pair["a"]
	var b: Dictionary = _pair["b"]
	var na := _device(a, [_raw(PKeyB64Url.encode(b["pub"]), secret)])
	var nb := _device(b, [_raw(PKeyB64Url.encode(a["pub"]), secret)])
	var bus := Lan.Bus.new()
	var lan_a := PKeyConnectLan.start(_source(na), {"allow_loopback": true, "host": "127.0.0.1", "mdns": Lan.FakeMdns.new(bus)})
	var lan_b := PKeyConnectLan.start(_source(nb), {"allow_loopback": true, "host": "127.0.0.1", "mdns": Lan.FakeMdns.new(bus)})
	t.check("both LAN services start", lan_a.ok and lan_b.ok)
	if not (lan_a.ok and lan_b.ok):
		return
	var la: PKeyConnectLan = lan_a.detail
	var lb: PKeyConnectLan = lan_b.detail
	na.links.attach(la, null, {})
	nb.links.attach(lb, null, {})
	var id_a := PKeyConnectContacts.id_of(PKeyB64Url.encode(b["pub"]))
	t.check("the link is seen on the network", await _until(func() -> bool: return not la.contact_peers().is_empty()))
	var got: PKeyResult = await na.links.open(id_a)
	t.check("open: the LAN first", got.ok and (got.detail as PKeyConnectSession).path == "lan", str(got))
	t.check("link: the other device's signal fires on the LAN too", await _until(func() -> bool: return not nb.inbound.is_empty()))
	if got.ok:
		(got.detail as PKeyConnectSession).close()
	# A mutation of the links reaches the LAN service: the removed link is no longer advertised.
	na.links.remove(id_a)
	t.check("remove: and no contact advert is left", la._cx.advert_names().is_empty())
	na.links.detach()
	nb.links.detach()
	la.stop()
	lb.stop()


# -- the gate moves ---------------------------------------------------------------------------------


func _gate_moves(t: PKeyTestContext) -> void:
	var r := _linked()
	var na: Device = r["a"]
	var nb: Device = r["b"]
	await _until(func() -> bool: return na.relay.rooms().size() == 1 and na.relay.rooms()[0]["state"] == "open" and nb.relay.rooms()[0]["state"] == "open")
	var got: PKeyResult = await na.links.open(r["id_a"])
	t.check("gate: a session is open", got.ok)
	if not got.ok:
		_finish(r)
		return
	var out: PKeyConnectSession = got.detail
	var codes := []
	out.closed.connect(func(code: StringName, _by: bool) -> void: codes.append(code))
	_manifest(na.core, false)
	na.core.discovery_changed.emit()
	t.check("gate: a discovery that says false ends the session peer_bye", await _until(func() -> bool: return out.is_closed()) and codes == [&"peer_bye"], str(codes))
	t.check("gate: the rooms are withdrawn", await _until(func() -> bool: return na.relay.rooms().is_empty()))
	var after: PKeyResult = await na.links.open(r["id_a"])
	t.check("gate: and open is refused", String(after.code) == "connect_links_disabled")
	_manifest(na.core, true)
	na.core.discovery_changed.emit()
	t.check("gate: the gate opening again brings the room back", await _until(func() -> bool: return na.relay.rooms().size() == 1))
	_finish(r)


# -- changes that land while a handshake runs ------------------------------------------------------


## Links layer, with no LAN service in the way: a session that comes up after its link was removed or links were
## switched off is closed before the host hears of it, and an `open` in flight when its link is removed fails.
func _late_changes(t: PKeyTestContext) -> void:
	# Inbound, the link removed (the readers are not told: only the check at establish can catch it).
	var r := _linked()
	var na: Device = r["a"]
	var nb: Device = r["b"]
	await _until(func() -> bool: return na.relay.rooms().size() == 1 and na.relay.rooms()[0]["state"] == "open" and nb.relay.rooms()[0]["state"] == "open")
	var caught: Array = []
	nb.relay.session_opened.disconnect(nb.links._inbound)
	nb.relay.session_opened.connect(func(s: PKeyConnectSession) -> void: caught.append(s))
	var first: PKeyResult = await na.links.open(r["id_a"])
	t.check("late: a session is up on both sides", first.ok and await _until(func() -> bool: return not caught.is_empty()))
	if caught.is_empty():
		_finish(r)
		return
	var codes: Array = []
	(caught[0] as PKeyConnectSession).closed.connect(func(code: StringName, _by: bool) -> void: codes.append(code))
	nb.client.contacts().remove(r["id_b"])
	nb.links._inbound(caught[0])
	t.check("late: a session for a link removed meanwhile is closed peer_revoked", (caught[0] as PKeyConnectSession).is_closed() and codes == [&"peer_revoked"], str(codes))
	t.check("late: and the host never hears of it", nb.inbound.is_empty() and nb.links._sessions.is_empty())
	_finish(r)
	# Inbound, links switched off meanwhile.
	var g := _linked()
	var ga: Device = g["a"]
	var gb: Device = g["b"]
	await _until(func() -> bool: return ga.relay.rooms().size() == 1 and ga.relay.rooms()[0]["state"] == "open" and gb.relay.rooms()[0]["state"] == "open")
	var seen: Array = []
	gb.relay.session_opened.disconnect(gb.links._inbound)
	gb.relay.session_opened.connect(func(s: PKeyConnectSession) -> void: seen.append(s))
	var second: PKeyResult = await ga.links.open(g["id_a"])
	await _until(func() -> bool: return not seen.is_empty())
	if not t.check("late: a second session is up", second.ok and not seen.is_empty()):
		_finish(g)
		return
	var codes2: Array = []
	(seen[0] as PKeyConnectSession).closed.connect(func(code: StringName, _by: bool) -> void: codes2.append(code))
	_manifest(gb.core, false)
	gb.links._inbound(seen[0])
	t.check("late: a session that comes up after links were switched off is closed peer_bye", (seen[0] as PKeyConnectSession).is_closed() and codes2 == [&"peer_bye"], str(codes2))
	t.check("late: and the host never hears of it either", gb.inbound.is_empty())
	_finish(g)
	# Outbound: the link is removed while open() is still dialling.
	var o := _linked()
	var oa: Device = o["a"]
	var ob: Device = o["b"]
	await _until(func() -> bool: return oa.relay.rooms().size() == 1 and oa.relay.rooms()[0]["state"] == "open" and ob.relay.rooms()[0]["state"] == "open")
	var res: Array = [null]
	var runner := func() -> void:
		res[0] = await oa.links.open(o["id_a"])
	runner.call()
	oa.client.contacts().remove(o["id_a"])
	await _until(func() -> bool: return res[0] != null)
	var out: PKeyResult = res[0]
	t.check("late: an open in flight when its link is removed answers link-unknown", out != null and not out.ok and String(out.code) == "link-unknown", str(out))
	t.check("late: and no session of it is kept", oa.links._sessions.is_empty())
	_finish(o)


## LAN service and links layer together, the PoC shapes: a handshake that began before `remove()`, and an `open()`
## in flight when its own link is removed.
func _lan_in_flight(t: PKeyTestContext) -> void:
	var secret := _key(9)
	var a: Dictionary = _pair["a"]
	var b: Dictionary = _pair["b"]
	var na := _device(a, [_raw(PKeyB64Url.encode(b["pub"]), secret)])
	var nb := _device(b, [_raw(PKeyB64Url.encode(a["pub"]), secret)])
	var bus := Lan.Bus.new()
	var la: PKeyConnectLan = PKeyConnectLan.start(_source(na), {"allow_loopback": true, "host": "127.0.0.1", "mdns": Lan.FakeMdns.new(bus)}).detail
	var lb: PKeyConnectLan = PKeyConnectLan.start(_source(nb), {"allow_loopback": true, "host": "127.0.0.1", "mdns": Lan.FakeMdns.new(bus)}).detail
	na.links.attach(la, null, {})
	nb.links.attach(lb, null, {})
	var id_a := PKeyConnectContacts.id_of(PKeyB64Url.encode(b["pub"]))
	var id_b := PKeyConnectContacts.id_of(PKeyB64Url.encode(a["pub"]))
	await _until(func() -> bool: return not la.contact_peers().is_empty())
	var res: Array = [null]
	var runner := func() -> void:
		res[0] = await na.links.open(id_a)
	runner.call()
	await _until(func() -> bool: return not lb._links.is_empty() or not lb._pending.is_empty(), 600)
	t.check("lan: B removes the link while the handshake runs", nb.links.remove(id_b).ok)
	await _until(func() -> bool: return res[0] != null, 600)
	await _frames(30)
	t.check("lan: the removed link opens no session on B", nb.inbound.is_empty() and lb.session_count() == 0)
	var dialled: PKeyResult = res[0]
	var shut: bool = dialled != null and (not dialled.ok or await _until(func() -> bool: return (dialled.detail as PKeyConnectSession).is_closed()))
	t.check("lan: and the dialler's session, if it came up, is closed", shut)
	# Outbound: A removes the link while its own open() waits for the LAN attempt.
	var na2 := _device(a, [_raw(PKeyB64Url.encode(b["pub"]), secret)])
	var nb2 := _device(b, [_raw(PKeyB64Url.encode(a["pub"]), secret)])
	var bus2 := Lan.Bus.new()
	var l2a: PKeyConnectLan = PKeyConnectLan.start(_source(na2), {"allow_loopback": true, "host": "127.0.0.1", "mdns": Lan.FakeMdns.new(bus2)}).detail
	var l2b: PKeyConnectLan = PKeyConnectLan.start(_source(nb2), {"allow_loopback": true, "host": "127.0.0.1", "mdns": Lan.FakeMdns.new(bus2)}).detail
	na2.links.attach(l2a, null, {})
	nb2.links.attach(l2b, null, {})
	await _until(func() -> bool: return not l2a.contact_peers().is_empty())
	var res2: Array = [null]
	var runner2 := func() -> void:
		res2[0] = await na2.links.open(id_a)
	runner2.call()
	na2.links.remove(id_a)
	await _until(func() -> bool: return res2[0] != null, 600)
	var r2: PKeyResult = res2[0]
	t.check("lan: an open in flight when its link is removed returns no live session", r2 != null and not r2.ok, str(r2))
	for n: Device in [na, nb, na2, nb2]:
		n.links.detach()
	for l: PKeyConnectLan in [la, lb, l2a, l2b]:
		l.stop()


## The cached gate lapses and a failed read clears it; a pending contact is promoted by the secret that opened the session.
func _cache_and_promotion(t: PKeyTestContext) -> void:
	var n := _device(_pair["a"], [])
	var core := n.core
	t.check("gate cache: a manifest nothing stamped counts", n.links.inter_account())
	core.set_meta("discovery_expires", float(Time.get_ticks_msec()) / 1000.0 + 100.0)
	t.check("gate cache: a read stamped within a day counts", n.links.inter_account())
	core.set_meta("discovery_expires", float(Time.get_ticks_msec()) / 1000.0 - 1.0)
	t.check("gate cache: one older than a day no longer counts", not n.links.inter_account())
	core.set_meta("discovery_expires", -1.0)
	var moved := [0]
	core.discovery_changed.connect(func() -> void: moved[0] += 1)
	core._discovery_failed()
	t.check("gate cache: a read that failed clears it and tells the readers", not n.links.inter_account() and moved[0] == 1)
	core.set_meta("discovery_lapsed", false)
	t.check("gate cache: a good read brings it back", n.links.inter_account())
	# Promotion follows the secret.
	var key := _key(30)
	var held := _raw(key, _key(31))
	var pend := _raw(key, _key(32), true, PKeyTestPeers.NOW - 10)
	var m := _device(_pair["a"], [held, pend])
	m.client.contact_established({"id": PKeyConnectContacts.id_of(key), "agree_key": key, "tag": PKeyConnectContacts.tag_of(PKeyB64Url.decode_strict(_key(31)))})
	var rows: Array = m.state.read().detail.contacts
	t.check("promotion: a session under the held secret does not promote the newer pending row", rows.size() == 2 and rows[1].has("pendingSince"))
	m.client.contact_established({"id": PKeyConnectContacts.id_of(key), "agree_key": key, "tag": PKeyConnectContacts.tag_of(PKeyB64Url.decode_strict(_key(32)))})
	var after: Array = m.state.read().detail.contacts
	t.check("promotion: the secret that opened it is promoted", after.size() == 1 and after[0]["secret"] == _key(32) and not after[0].has("pendingSince"), str(after.size()))
