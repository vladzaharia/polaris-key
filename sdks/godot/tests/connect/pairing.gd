extends RefCounted
# @pkey-feature connect.links
# The pairing window (PKeyConnectPairing, CC-19b.G3; WIRE-CONTRACT-V5 section 15.10), ported from sdk-node
# `pairing.e2e.test.ts`: two windows on one fake discovery lane over real loopback TCP and real Noise, and over
# a native-style lane with memory pipes. The code both people compare, nothing stored before both confirm, the
# link stored on both sides with the categories both listed, a decline that stores nothing, the lower name
# that dials, a device that can only ask, the gate and the option checks.

const SLUG := PKeyTestPeers.SLUG


class FakeHandle extends RefCounted:
	var stops := 0


	func stop() -> void:
		stops += 1


## A discovery lane both windows share: an advert reaches every browser; over TCP the hit names the port.
class Bus extends RefCounted:
	var adverts: Array = []
	var browsers: Array = []
	var acceptors: Dictionary = {}


class Lane extends RefCounted:
	var bus: Bus
	var querier_only := false
	var caps := {"slots": true, "tags": true}
	var tags_seen: Array = []


	func _init(p_bus: Bus) -> void:
		bus = p_bus


	func capabilities() -> Dictionary:
		return caps


	func status() -> Dictionary:
		return {"active": true, "responder": not querier_only, "querier": true, "reason": "querier_only" if querier_only else ""}


	func set_tags(_t: Dictionary) -> bool:
		return true


	func advertise(a: Dictionary) -> PKeyResult:
		var h := FakeHandle.new()
		var entry := {"advert": a, "handle": h, "owner": get_instance_id()}
		bus.adverts.append(entry)
		if not querier_only:
			for b: Dictionary in bus.browsers:
				if b["owner"] != get_instance_id():
					(b["up"] as Callable).call(_hit(a))
		return PKeyResult.success(h)


	func browse(on_up: Callable, _down := Callable(), _accept := Callable(), tags := {}) -> PKeyResult:
		tags_seen.append(tags)
		bus.browsers.append({"up": on_up, "owner": get_instance_id()})
		for e: Dictionary in bus.adverts:
			if e["owner"] != get_instance_id() and (e["handle"] as FakeHandle).stops == 0 and not (e["owner"] == -1):
				on_up.call(_hit(e["advert"]))
		return PKeyResult.success(FakeHandle.new())


	func _hit(a: Dictionary) -> Dictionary:
		return {"instance": a["instance"], "host": "127.0.0.1", "hosts": ["127.0.0.1"], "port": int(a.get("port", 0)), "txt": a["txt"], "native": false}


## A memory pipe that reports itself connected, like the Apple lane's.
class Pipe extends PKeyPeerMemoryPipe:
	func is_connected_native() -> bool:
		return true


## The Apple-style lane: no address in a hit, the pipes arrive at the acceptor of slot p and the dial is by name.
class NativeLane extends Lane:
	var acceptors: Dictionary = {}
	var by_instance: Dictionary = {}


	func set_acceptor(slot: Variant, fn := Callable()) -> void:
		if fn.is_valid():
			acceptors[str(slot)] = fn
		else:
			acceptors.erase(str(slot))


	func advertise(a: Dictionary) -> PKeyResult:
		(bus as NativeBus).owners[a["instance"]] = self
		return super(a)


	func dial(instance: String) -> PKeyPeerPipe:
		var other: NativeLane = (bus as NativeBus).owners.get(instance)
		var acceptor: Callable = other.acceptors.get("p", Callable()) if other != null else Callable()
		if not acceptor.is_valid():
			return null
		var shared := PKeyPeerMemoryPipe.Shared.new()
		acceptor.call(Pipe.new(shared, 1))
		return Pipe.new(shared, 0)


	func _hit(a: Dictionary) -> Dictionary:
		return {"instance": a["instance"], "host": "", "hosts": [], "port": 0, "txt": a["txt"], "native": true}


class NativeBus extends Bus:
	var owners: Dictionary = {}


## What the host does on one side.
class Host extends RefCounted:
	var offers: Array = []
	var stored: Array = []
	var linked: Array = []
	var failed: Array = []
	var allowed := true
	var full := false
	var priv := PackedByteArray()
	var pub := PackedByteArray()


	func _init() -> void:
		priv = PKeyTestPeers.random32()
		pub = PKeyPeerCrypto.for_platform().x25519_public(priv)


	func now() -> int:
		return PKeyTestPeers.NOW


	func agree_key() -> String:
		return PKeyB64Url.encode(pub)


	func held() -> Array:
		return []


	func is_allowed() -> bool:
		return allowed


	func store(c: Dictionary) -> PKeyResult:
		if full:
			return PKeyResult.failure(&"full", "full")
		stored.append({"agree_key": c["agree_key"], "secret": (c["secret"] as PackedByteArray).duplicate(), "cats": c["cats"], "label": c.get("label")})
		return PKeyResult.success({"pending": false, "id": "link%d" % stored.size()})


	func on_offer(o: PKeyConnectPairing.Offer) -> void:
		offers.append(o)


	func source() -> PKeyConnectPairing.Source:
		var s := PKeyConnectPairing.Source.new()
		s.slug = SLUG
		s.now = Callable(self, "now")
		s.agree_key = Callable(self, "agree_key")
		s.held = Callable(self, "held")
		s.store = Callable(self, "store")
		s.allowed = Callable(self, "is_allowed")
		return s


	func watch(p: PKeyConnectPairing) -> void:
		p.linked.connect(func(l: Dictionary) -> void: linked.append(l))
		p.failed.connect(func(f: Dictionary) -> void: failed.append(f))


func run(t: PKeyTestContext) -> void:
	_options(t)
	await _gates(t)
	await _end_to_end(t, false)
	await _end_to_end(t, true)
	await _decline(t)
	await _querier_only(t)


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _until(cond: Callable, frames := 1500) -> bool:
	for i in frames:
		if cond.call():
			return true
		await _tree().process_frame
	return cond.call()


func _opts(h: Host, lane: Object, cats: Array, extra := {}) -> Dictionary:
	var o := {"mdns": lane, "categories": cats, "on_offer": Callable(h, "on_offer"), "label": "Phone", "allow_loopback": true, "host": "127.0.0.1"}
	for k in extra:
		o[k] = extra[k]
	return o


func _options(t: PKeyTestContext) -> void:
	var h := Host.new()
	var bus := Bus.new()
	var cases := {
		"no handler": {"categories": []},
		"too many categories": {"categories": ["a", "b", "c", "d", "e", "f", "g", "h", "i"], "on_offer": Callable(h, "on_offer")},
		"a repeated category": {"categories": ["a", "a"], "on_offer": Callable(h, "on_offer")},
		"an upper-case category": {"categories": ["Docs"], "on_offer": Callable(h, "on_offer")},
		"a long label": {"categories": [], "on_offer": Callable(h, "on_offer"), "label": "x".repeat(65)},
		"no seconds": {"categories": [], "on_offer": Callable(h, "on_offer"), "seconds": 0},
	}
	for k: String in cases:
		var o: Dictionary = cases[k]
		o["mdns"] = Lane.new(bus)
		var r := PKeyConnectPairing.start(h.source(), o)
		t.check("pairing refuses %s" % k, not r.ok and r.code == PKeyConstants.ErrorCode.INVALID_OPTIONS)
	t.check("pairing refuses a bad source", PKeyConnectPairing.start(PKeyConnectPairing.Source.new(), {}).code == PKeyConstants.ErrorCode.INVALID_OPTIONS)


func _gates(t: PKeyTestContext) -> void:
	var h := Host.new()
	h.allowed = false
	var r := PKeyConnectPairing.start(h.source(), _opts(h, Lane.new(Bus.new()), []))
	t.check("a closed gate does not open the window", not r.ok and r.code == PKeyConstants.ErrorCode.CONNECT_LINKS_DISABLED)
	h.allowed = true
	var old := Lane.new(Bus.new())
	old.caps = {"slots": false, "tags": false}
	r = PKeyConnectPairing.start(h.source(), _opts(h, old, []))
	t.check("a lane without slots answers unsupported", not r.ok and r.code == PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED)
	t.check("and advertised nothing", old.bus.adverts.is_empty())
	var bus := Bus.new()
	var lane := Lane.new(bus)
	r = PKeyConnectPairing.start(h.source(), _opts(h, lane, ["docs"]))
	t.check("the window opens", r.ok)
	var p: PKeyConnectPairing = r.detail
	var ad: Dictionary = (bus.adverts[0] as Dictionary)["advert"]
	t.check("it advertises m=p with the product tag on slot p", ad["slot"] == "p" and (ad["txt"] as Array).slice(0, 2) == ["v=1", "m=p"] and str((ad["txt"] as Array)[2]).begins_with("h="))
	t.check("and browses for the tag of this and the last epoch", (lane.tags_seen[0] as Dictionary)["p"].size() == 2)
	p.stop()
	t.check("stop closes the advert and the window", not p.is_open() and (bus.adverts[0]["handle"] as FakeHandle).stops == 1)


func _pair_up(t: PKeyTestContext, lane_a: Lane, lane_b: Lane, ha: Host, hb: Host, cats_a: Array, cats_b: Array) -> Array:
	var ra := PKeyConnectPairing.start(ha.source(), _opts(ha, lane_a, cats_a))
	var rb := PKeyConnectPairing.start(hb.source(), _opts(hb, lane_b, cats_b, {"label": "Tablet"}))
	t.check("both windows open", ra.ok and rb.ok)
	if not (ra.ok and rb.ok):
		return []
	var a: PKeyConnectPairing = ra.detail
	var b: PKeyConnectPairing = rb.detail
	ha.watch(a)
	hb.watch(b)
	return [a, b]


func _end_to_end(t: PKeyTestContext, native_pipes: bool) -> void:
	var tag := "memory lane" if native_pipes else "tcp"
	var bus: Bus = NativeBus.new() if native_pipes else Bus.new()
	var ha := Host.new()
	var hb := Host.new()
	var lane_a: Lane = NativeLane.new(bus) if native_pipes else Lane.new(bus)
	var lane_b: Lane = NativeLane.new(bus) if native_pipes else Lane.new(bus)
	var ps := _pair_up(t, lane_a, lane_b, ha, hb, ["docs", "photos"], ["photos", "notes"])
	if ps.is_empty():
		return
	var a: PKeyConnectPairing = ps[0]
	var b: PKeyConnectPairing = ps[1]
	t.check("%s: one session, one offer each" % tag, await _until(func() -> bool: return ha.offers.size() == 1 and hb.offers.size() == 1))
	if ha.offers.is_empty() or hb.offers.is_empty():
		a.stop()
		b.stop()
		return
	var oa: PKeyConnectPairing.Offer = ha.offers[0]
	var ob: PKeyConnectPairing.Offer = hb.offers[0]
	t.check("%s: both people see the same code" % tag, oa.code == ob.code and oa.code.length() == 7)
	t.check("%s: the offer shows what the device reported" % tag, oa.label == "Tablet" and ob.label == "Phone" and oa.platform != "")
	t.check("%s: and the categories asked for" % tag, oa.categories == ["docs", "photos"])
	oa.confirm()
	for i in 30:
		await _tree().process_frame
	t.check("%s: nothing is stored on one confirm" % tag, ha.stored.is_empty() and hb.stored.is_empty())
	ob.confirm()
	t.check("%s: both sides store the link" % tag, await _until(func() -> bool: return ha.stored.size() == 1 and hb.stored.size() == 1))
	if ha.stored.size() == 1 and hb.stored.size() == 1:
		var same: bool = ha.stored[0]["secret"] == hb.stored[0]["secret"]
		t.check("%s: with the same secret and each other's key" % tag, same and ha.stored[0]["agree_key"] == hb.agree_key() and hb.stored[0]["agree_key"] == ha.agree_key())
		t.check("%s: and the categories both listed" % tag, ha.stored[0]["cats"] == ["photos"] and hb.stored[0]["cats"] == ["photos"])
		t.check("%s: and the other's label" % tag, ha.stored[0]["label"] == "Tablet")
	t.check("%s: the host hears linked and the window closes" % tag, await _until(func() -> bool: return ha.linked.size() == 1 and not a.is_open() and not b.is_open()))
	t.check("%s: a link names its id and no key" % tag, ha.linked.size() == 1 and ha.linked[0]["id"] == "link1" and not str(ha.linked[0]).contains(ha.agree_key()) and ha.failed.is_empty())
	t.check("%s: str() shows no key" % tag, not str(a).contains(ha.agree_key()))


func _decline(t: PKeyTestContext) -> void:
	var bus := Bus.new()
	var ha := Host.new()
	var hb := Host.new()
	var ps := _pair_up(t, Lane.new(bus), Lane.new(bus), ha, hb, ["docs"], ["docs"])
	if ps.is_empty():
		return
	t.check("decline: both reach the code", await _until(func() -> bool: return ha.offers.size() == 1 and hb.offers.size() == 1))
	if ha.offers.is_empty() or hb.offers.is_empty():
		return
	(ha.offers[0] as PKeyConnectPairing.Offer).decline()
	t.check("decline: the decliner and the other hear a failure", await _until(func() -> bool: return ha.failed.size() == 1 and hb.failed.size() == 1))
	t.check("decline: the reasons are declined and closed", ha.failed.size() == 1 and ha.failed[0]["reason"] == "declined" and hb.failed[0]["reason"] == "closed")
	t.check("decline: nothing is stored", ha.stored.is_empty() and hb.stored.is_empty())
	for p: PKeyConnectPairing in ps:
		p.stop()


func _querier_only(t: PKeyTestContext) -> void:
	var bus := Bus.new()
	var ha := Host.new()
	var hb := Host.new()
	var lane_b := Lane.new(bus)
	lane_b.querier_only = true
	var ps := _pair_up(t, Lane.new(bus), lane_b, ha, hb, [], [])
	if ps.is_empty():
		return
	var b: PKeyConnectPairing = ps[1]
	t.check("querier-only: the device that only asks has no instance and no listener", b.instance() == "" and b.port() == 0)
	t.check("querier-only: it dials the advert it found", await _until(func() -> bool: return ha.offers.size() == 1 and hb.offers.size() == 1))
	for p: PKeyConnectPairing in ps:
		p.stop()
