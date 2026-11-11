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


class OsBus:
	extends Pairing.Bus
	var owners: Dictionary = {}


## The Apple-style lane: no address in a hit, the sockets of each slot reach that slot's acceptor, and a dial is by name.
class OsLane:
	extends Base.LiveLane
	var acceptors: Dictionary = {}
	var slots_advertised: Array = []
	var accepted_names: Array = []

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
		var acceptor: Callable = (
			(owner["lane"] as OsLane).acceptors.get(owner["slot"], Callable())
			if not owner.is_empty()
			else Callable()
		)
		if not acceptor.is_valid():
			return null
		var shared := PKeyPeerMemoryPipe.Shared.new()
		acceptor.call(Pairing.Pipe.new(shared, 1))
		return Pairing.Pipe.new(shared, 0)

	func _hit(a: Dictionary) -> Dictionary:
		return {
			"instance": a["instance"], "host": "", "hosts": [], "port": 0, "txt": a["txt"], "native": true
		}


func run(t: PKeyTestContext) -> void:
	_b = Base.new()
	_host = Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	_b._host = _host
	await _pair_and_open(t)
	await _b._frames(20)
	PKeyCloudLocalLinks.reset_budgets()
	_host.queue_free()


func _device(bus: OsBus) -> Array:
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
	var opened: PKeyResult = await b.links.open(id_b)
	await _b._until(func() -> bool: return got.size() == 1)
	t.check("native: b opens the link by name and a is handed the session", opened.ok and got.size() == 1)
	if opened.ok and got.size() == 1:
		var sb: PKeyConnectSession = opened.detail
		var sa: PKeyConnectSession = got[0]
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
	a.links.remove(id_a)
	t.check("native: forgetting the last link takes the acceptor back", not la.acceptors.has("l"))
	a.links.stop_all()
	b.links.stop_all()
