extends RefCounted
# @pkey-feature connect.local
# Local links over an OS discovery lane (CC-29b.G4): the Apple-style lane listens itself, so a pairing window (slot q)
# and the shared listener (slot l) take their sockets from the lane's acceptors, a hit carries no address and the
# dial is by name through the lane. Two devices pair and open the link over memory pipes and real Noise; no TCP
# listener is opened on either side. The helpers (the devices, the clock) are `local_links.gd`'s.

const Base := preload("res://tests/connect/local_links.gd")
const Pairing := preload("res://tests/connect/pairing.gd")

var _b: Base
var _host: Node
var _buses: Array[OsBus] = []


class OsBus:
	extends Pairing.Bus
	var owners: Dictionary = {}

	## `owners` names the lanes, and each lane holds its bus: cut that end too.
	func drop() -> void:
		owners.clear()
		super()


## The end of a memory pipe an OS lane hands to an acceptor: it has a source address and counts `admit`.
class Remote:
	extends Pairing.Pipe
	var address := "192.168.1.5"
	var admitted := 0

	func remote_address() -> String:
		return address

	func admit() -> void:
		admitted += 1


## The Apple-style lane: no address in a hit, the sockets of each slot reach that slot's acceptor, and a dial is by name.
class OsLane:
	extends Base.LiveLane
	var acceptors: Dictionary = {}
	var slots_advertised: Array = []
	var accepted_names: Array = []
	## The pipes this lane handed to an acceptor, with the slot.
	var accepted: Array = []
	var source := "192.168.1.5"

	func set_acceptor(slot: Variant, fn := Callable()) -> void:
		if fn.is_valid():
			acceptors[str(slot)] = fn
		else:
			acceptors.erase(str(slot))

	func set_accepted(names: Array) -> bool:
		accepted_names = names.duplicate()
		return true

	func advertise(a: Dictionary) -> PKeyResult:
		slots_advertised.append(str(a.get("slot", "a")))
		(bus as OsBus).owners[a["instance"]] = {"lane": self, "slot": str(a.get("slot", "a"))}
		return super(a)

	func dial(instance: String) -> PKeyPeerPipe:
		var owner: Dictionary = (bus as OsBus).owners.get(instance, {})
		# The owning lane is another instance of this class: held untyped, so the class names no cycle with itself.
		var owner_lane = owner.get("lane")
		var acceptor: Callable = (
			owner_lane.acceptors.get(owner["slot"], Callable()) if owner_lane != null else Callable()
		)
		if not acceptor.is_valid():
			return null
		var shared := PKeyPeerMemoryPipe.Shared.new()
		var inbound := Remote.new(shared, 1)
		inbound.address = source
		owner_lane.accepted.append({"slot": owner["slot"], "pipe": inbound})
		acceptor.call(inbound)
		return Pairing.Pipe.new(shared, 0)

	## The m=l adverts of this lane that are still up.
	func live_local_adverts() -> int:
		var n := 0
		for e: Dictionary in bus.adverts:
			if e["owner"] == get_instance_id() and e["handle"].stops == 0 and (e["advert"]["txt"] as Array).has("m=l"):
				n += 1
		return n

	func _hit(a: Dictionary) -> Dictionary:
		return {
			"instance": a["instance"], "host": "", "hosts": [], "port": 0, "txt": a["txt"], "native": true
		}


func run(t: PKeyTestContext) -> void:
	_b = Base.new()
	_host = Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	_b._host = _host
	await _idle(t)
	await _shower_bounds(t)
	await _pair_and_open(t)
	await _b._frames(20)
	PKeyCloudLocalLinks.reset_budgets()
	for bus in _buses:
		bus.drop()
	_buses.clear()
	_host.queue_free()


func _device(bus: OsBus) -> Array:
	if not _buses.has(bus):
		_buses.append(bus)
	var lane := OsLane.new(bus)
	return [_b._device(bus, true, false, {"lane": func() -> Object: return lane}), lane]


func _pair_and_open(t: PKeyTestContext) -> void:
	PKeyCloudLocalLinks.reset_budgets()
	var bus := OsBus.new()
	var da := _device(bus)
	var db := _device(bus)
	var a: Base.Dev = da[0]
	var b: Base.Dev = db[0]
	var la: OsLane = da[1]
	var lb: OsLane = db[1]
	var r: PKeyResult = await a.links.pair(a.pair_options(["docs"], "Anna"))
	t.check("native: a window opens on the OS lane", r.ok and not a.codes.is_empty())
	if not r.ok or a.codes.is_empty():
		return
	t.check(
		"native: its advert is on slot q and the lane's acceptor takes the sockets",
		la.slots_advertised == ["q"] and la.acceptors.has("q")
	)
	var holder := {"r": null}
	var run := func() -> void:
		holder["r"] = await b.links.join(
			b.join_options(["docs"], "Bo", a.codes[0]["code"]).merged({"browse_seconds": 15})
		)
	run.call()
	await _b._until(func() -> bool: return a.offers.size() == 1 and b.offers.size() == 1)
	t.check("native: both devices are asked to confirm", a.offers.size() == 1 and b.offers.size() == 1)
	if a.offers.is_empty() or b.offers.is_empty():
		a.links.stop_all()
		b.links.stop_all()
		return
	b.offers[0].confirm()
	a.offers[0].confirm()
	await _b._until(func() -> bool: return holder["r"] != null and a.ended.size() == 1)
	t.check(
		"native: the pairing stores a link on both sides",
		holder["r"] != null and holder["r"].ok and _b._held(a).size() == 1 and _b._held(b).size() == 1
	)
	await _b._frames(5)
	t.check("native: the window's acceptor is gone with the window", not la.acceptors.has("q"))
	if _b._held(a).is_empty() or _b._held(b).is_empty():
		a.links.stop_all()
		b.links.stop_all()
		return
	var id_a := str(_b._held(a)[0]["id"])
	var id_b := str(_b._held(b)[0]["id"])
	var got: Array = []
	a.links.on_link(func(s: PKeyConnectSession) -> void: got.append(s))
	b.links.on_link(func(_s: PKeyConnectSession) -> void: pass)
	t.check(
		"native: the shared listener takes slot l from the lane and binds no TCP port",
		la.acceptors.has("l") and lb.acceptors.has("l") and a.links._lan.port() == 0
		and la.slots_advertised.has("l") and a.links._lan.advert_names().size() == 1
	)
	t.check(
		"native: the lane is told the m=l names to report",
		la.accepted_names.size() == 2 and lb.accepted_names.size() == 2
	)
	await _b._until(
		func() -> bool: return a.links._lan.seen().size() == 1 and b.links._lan.seen().size() == 1
	)
	var sessions: Array = []
	var opened: PKeyResult = await b.links.open(id_b)
	await _b._until(func() -> bool: return got.size() == 1)
	t.check("native: b opens the link by name and a is handed the session", opened.ok and got.size() == 1)
	if opened.ok and got.size() == 1:
		var sb: PKeyConnectSession = opened.detail
		var sa: PKeyConnectSession = got[0]
		sessions = [sb, sa]
		t.check(
			"native: the sessions name their link",
			sb.local["id"] == id_b and sa.local["id"] == id_a and sb.role == "initiator"
		)
		sb.send("hello".to_utf8_buffer())
		var heard: PKeyResult = await sa.receive()
		t.check(
			"native: a message crosses",
			heard.ok and (heard.detail["body"] as PackedByteArray).get_string_from_utf8() == "hello"
		)
	await _admission(t, a, b, la, id_b)
	await _gate(t, a, la, sessions)
	a.links.remove(id_a)
	t.check("native: forgetting the last link takes the acceptor back", not la.acceptors.has("l"))
	a.links.stop_all()
	b.links.stop_all()


# -- nothing without a link --------------------------------------------------------------------------


func _idle(t: PKeyTestContext) -> void:
	var bus := OsBus.new()
	var d := _device(bus)
	var lane: OsLane = d[1]
	var dev: Base.Dev = d[0]
	dev.links.on_link(func(_s: PKeyConnectSession) -> void: pass)
	dev.links.serve()
	t.check(
		"idle: with no link held no acceptor is held and nothing is advertised",
		lane.acceptors.is_empty() and lane.slots_advertised.is_empty() and bus.adverts.is_empty()
	)
	dev.links.stop_all()


# -- the pairing window's native bounds --------------------------------------------------------------


func _shower_bounds(t: PKeyTestContext) -> void:
	PKeyCloudLocalLinks.reset_budgets()
	var bus := OsBus.new()
	var d := _device(bus)
	var a: Base.Dev = d[0]
	var lane: OsLane = d[1]
	var r: PKeyResult = await a.links.pair(a.pair_options(["docs"], "Anna"))
	if not r.ok:
		t.check("window: opens", false)
		return
	var shower: PKeyConnectLocalShower = a.links._shower
	var accept: Callable = lane.acceptors["q"]
	var pipes: Array = []
	for i in PKeyConnectLocalShower.WAITING * 2 + 3:
		var p := Remote.new(PKeyPeerMemoryPipe.Shared.new(), 1)
		pipes.append(p)
		accept.call(p)
	t.check(
		"window: waiting native sockets are bounded and the rest are closed unread",
		shower._attempts.size() == PKeyConnectLocalShower.WAITING * 2
		and pipes.slice(PKeyConnectLocalShower.WAITING * 2).all(func(p: Remote) -> bool: return p.is_finished())
		and pipes.slice(0, PKeyConnectLocalShower.WAITING * 2).all(func(p: Remote) -> bool: return not p.is_finished())
	)
	_b._clock[0] += 31.0
	await _b._frames(3)
	t.check(
		"window: a native socket that sends nothing is closed after the handshake time",
		shower._attempts.is_empty() and pipes.all(func(p: Remote) -> bool: return p.is_finished())
	)
	t.check("window: and none was admitted", pipes.all(func(p: Remote) -> bool: return p.admitted == 0))
	a.links.stop_all()
	t.check("window: closing it takes the q acceptor back", not lane.acceptors.has("q"))


# -- admission on a native l socket ------------------------------------------------------------------


func _admission(t: PKeyTestContext, a: Base.Dev, b: Base.Dev, la: OsLane, id_b: String) -> void:
	var lan_a: PKeyConnectLocalLan = a.links._lan
	var lan_b: PKeyConnectLocalLan = b.links._lan
	var good := lan_a.pending_count()
	var ok_pipes := la.accepted.filter(func(e: Dictionary) -> bool: return e["slot"] == "l")
	t.check(
		"admission: a socket that became a session was admitted once",
		not ok_pipes.is_empty() and ok_pipes.all(func(e: Dictionary) -> bool: return (e["pipe"] as Remote).admitted == 1) and good == 0
	)
	t.check(
		"admission: a miss costs the fixed number of trials whatever is held",
		1 + PKeyPeerLocal.trial_padding(1) == PKeyPeerLocal.TRIAL_TOTAL
	)
	# b dials with a wrong secret, three times from one source group: every try is a miss on the shared listener.
	var real_secret: PackedByteArray = (lan_b._locals[0]["secret"] as PackedByteArray).duplicate()
	lan_b._locals[0]["secret"] = PKeyTestPeers.random32()
	var before := la.accepted.size()
	var failed := 0
	for i in 3:
		var r: PKeyResult = await lan_b.connect_local(id_b)
		if not r.ok:
			failed += 1
	lan_b._locals[0]["secret"] = real_secret
	var misses: Array = la.accepted.slice(before)
	t.check("admission: three wrong-secret dials all fail", failed == 3 and misses.size() == 3)
	t.check(
		"admission: and none of those sockets was admitted",
		misses.all(func(e: Dictionary) -> bool: return (e["pipe"] as Remote).admitted == 0)
	)
	var group := str(PKeyLanAddress.group_key(la.source))
	t.check(
		"admission: the source group's budget is spent after two misses (the third is refused before any trial)",
		not lan_a._limiter.begin_local(group)["ok"]
	)
	var other: Dictionary = lan_a._limiter.begin_local("10.9.8.0/24")
	t.check("admission: another group still has its budget", other["ok"])
	if other["ok"]:
		(other["admission"] as PKeyPeerLimiter.LocalAdmission).miss()
	# A source that cannot be grouped is closed before a byte is read.
	var lost := Remote.new(PKeyPeerMemoryPipe.Shared.new(), 1)
	lost.address = ""
	var pending_before := lan_a.pending_count()
	(la.acceptors["l"] as Callable).call(lost)
	t.check(
		"admission: an empty source address is closed at once and takes no place",
		lost.is_finished() and lan_a.pending_count() == pending_before and lost.admitted == 0
	)


# -- the gate going off ------------------------------------------------------------------------------


func _gate(t: PKeyTestContext, a: Base.Dev, la: OsLane, sessions: Array) -> void:
	if sessions.size() != 2:
		t.check("gate: sessions to end", false)
		return
	var lan: PKeyConnectLocalLan = a.links._lan
	var stale: Callable = la.acceptors["l"]
	t.check("gate: before, an m=l advert is up", la.live_local_adverts() == 1)
	_b._manifest(a.core, false)
	a.core.discovery_changed.emit()
	await _b._until(func() -> bool: return (sessions[0] as PKeyConnectSession).is_closed() and (sessions[1] as PKeyConnectSession).is_closed())
	t.check(
		"gate: sessions end peer_bye",
		(sessions[0] as PKeyConnectSession).closed_info()["code"] == PKeyPeerSession.PEER_BYE
		and (sessions[1] as PKeyConnectSession).closed_info()["code"] == PKeyPeerSession.PEER_BYE
	)
	t.check("gate: every m=l advert is withdrawn and the acceptor is gone", la.live_local_adverts() == 0 and not la.acceptors.has("l"))
	var late := Remote.new(PKeyPeerMemoryPipe.Shared.new(), 1)
	stale.call(late)
	t.check(
		"gate: a socket reaching the stale acceptor is closed before a byte is read",
		late.is_finished() and lan.pending_count() == 0 and late.admitted == 0
	)
	_b._manifest(a.core, true)
	a.core.discovery_changed.emit()
