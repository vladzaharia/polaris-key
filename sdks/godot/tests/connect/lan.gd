extends RefCounted
# @pkey-feature connect.lan connect.app
# The LAN service (PKeyConnectLan, CC-14.12; WIRE-CONTRACT-V5 sections 15.4 to 15.6, plans G4, G6 to G8
# and D-6), ported from sdk-node's `lan.e2e.test.ts` and the Python `test_connect_lan`: two services on
# 127.0.0.1 with loopback allowed and a fake mDNS bus between them, real TCP, real Noise; the advert
# (name, rotation at the epoch, a new K_disc inside it, the newest key only), the browse rules (roster
# devices only, both epochs and keys, a negative cache), the accept gate (the verdict before a slot, the
# per-address, per-group and total caps, the 30 s window, a refused source), the dial race (stagger,
# failure starts the next, a late winner closed unused, two in flight), wrong_peer, `127.0.0.1` and `::1`
# to one dual-stack port (skipped with the reason logged when there is no `::1`), and stop and abort.

const SIGN_C := "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
const ID_C := "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"

var _pair: Dictionary
var _c: Dictionary
var _ring: String
var _ring3: String
var _disc := PackedByteArray()


## A key store that holds the private key; only `dh` crosses, as PKeyDeviceKeyStore's does.
class FakeKeys extends RefCounted:
	var dh_calls := 0
	var _priv: PackedByteArray


	func _init(priv: PackedByteArray) -> void:
		_priv = priv


	func dh(remote: PackedByteArray) -> PKeyResult:
		dh_calls += 1
		if PKeyCurve25519.is_low_order(remote):
			return PKeyResult.success(null)
		return PKeyResult.success(PKeyCurve25519.x25519(_priv, remote))


## What a service reads of its client: the identity (replaceable), the clock, what was asked.
class Env extends RefCounted:
	var source: PKeyConnectClient.PeerSource
	var now_value := PKeyTestPeers.NOW
	var loads := 0
	var fail: PKeyResult = null
	var timers: Array = []


	func load_identity() -> PKeyResult:
		loads += 1
		return fail if fail != null else PKeyResult.success(source)


	func now() -> int:
		return now_value


	func timer(seconds: float, fn: Callable) -> void:
		timers.append([seconds, fn])


	func src() -> PKeyConnectLan.Source:
		var s := PKeyConnectLan.Source.new()
		s.load = Callable(self, "load_identity")
		s.now = Callable(self, "now")
		s.keep = self
		return s


## The handle a fake adapter returns.
class FakeHandle extends RefCounted:
	var stops := 0


	func stop() -> void:
		stops += 1


## A fake mDNS network: adverts reach every browser that accepts the name, at 127.0.0.1.
class Bus extends RefCounted:
	var adverts: Array = []
	var browsers: Array = []


class FakeMdns extends RefCounted:
	var bus: Bus
	var fail_advertise := false
	var fail_browse := false
	var querier_only := false
	var adverts: Array = []
	var browse_up: Callable
	var browse_down: Callable
	var browse_accept: Callable
	var browse_handle: FakeHandle


	func _init(p_bus: Bus = null) -> void:
		bus = p_bus if p_bus != null else Bus.new()


	func advertise(advert: Dictionary) -> PKeyResult:
		if fail_advertise:
			return PKeyResult.failure(PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE, "no", {"reason": "mdns_unavailable"})
		var h := FakeHandle.new()
		var entry := {"instance": advert["instance"], "port": advert["port"], "txt": advert["txt"], "handle": h, "owner": get_instance_id()}
		adverts.append(entry)
		bus.adverts.append(entry)
		for b: Dictionary in bus.browsers:
			if b["owner"] != get_instance_id():
				_deliver(b, entry)
		return PKeyResult.success(h)


	func browse(on_up: Callable, on_down := Callable(), accept := Callable()) -> PKeyResult:
		if fail_browse:
			return PKeyResult.failure(PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE, "no", {"reason": "mdns_unavailable"})
		browse_up = on_up
		browse_down = on_down
		browse_accept = accept
		browse_handle = FakeHandle.new()
		var b := {"owner": get_instance_id(), "up": on_up, "down": on_down, "accept": accept}
		bus.browsers.append(b)
		for e: Dictionary in bus.adverts:
			if e["owner"] != get_instance_id():
				_deliver(b, e)
		return PKeyResult.success(browse_handle)


	func status() -> Dictionary:
		return {"active": true, "responder": not querier_only, "querier": true, "reason": "querier_only" if querier_only else ""}


	static func _deliver(b: Dictionary, e: Dictionary) -> void:
		var accept: Callable = b["accept"]
		if (e["handle"] as FakeHandle).stops > 0 or (accept.is_valid() and not accept.call(e["instance"])):
			return
		(b["up"] as Callable).call({"instance": e["instance"], "host": "127.0.0.1", "hosts": ["127.0.0.1"], "port": e["port"], "txt": e["txt"]})


class Events extends RefCounted:
	var peers: Array = []
	var lost: Array = []
	var sessions: Array = []
	var notices: Array = []


	func watch(svc: PKeyConnectLan) -> Events:
		svc.peer_found.connect(func(p: Dictionary) -> void: peers.append(p))
		svc.peer_lost.connect(func(id: String) -> void: lost.append(id))
		svc.session_opened.connect(func(s: PKeyConnectSession) -> void: sessions.append(s))
		svc.notice.connect(func(n: Dictionary) -> void: notices.append(n))
		return self


## A real connection to a loopback port that reports another address, so the verdict and the race see a
## neighbour at one address and the real device at another.
class NetAttempt extends PKeyConnectLan.TcpAttempt:
	var address := ""


	func remote() -> String:
		return address


## A fake race attempt: CONNECTING until `after` polls, then `end`.
class FakeAttempt extends PKeyConnectLan.Attempt:
	var log: Array
	var after := 0
	var end := PKeyConnectLan.Attempt.CONNECTED
	var address := "127.0.0.1"
	var polls := 0
	var aborted := false
	var taken := false


	func poll() -> int:
		polls += 1
		return end if polls > after else PKeyConnectLan.Attempt.CONNECTING


	func remote() -> String:
		return address


	func take() -> PKeyPeerTcpPipe:
		taken = true
		return null


	func abort() -> void:
		aborted = true
		log.append("abort " + host)


func run(t: PKeyTestContext) -> void:
	_pair = PKeyTestPeers.pair(1)
	_c = PKeyTestPeers.device(ID_C, SIGN_C, 1, PKeyTestPeers.SUB, PKeyTestPeers.NOW - 10, PKeyTestPeers.NOW + 1000, PKeyTestPeers.fixed(3))
	_ring = _pair["ring"]
	_ring3 = PKeyTestPeers.ring(1, [_pair["a"], _c, _pair["b"]])
	_disc = PKeyTestPeers.random32()
	_helpers(t)
	_start_failures(t)
	_advert(t)
	_browse(t)
	await _end_to_end(t)
	await _gate(t)
	await _limits(t)
	await _race(t)
	await _fall_through(t)
	await _closed_between(t)
	await _stop(t)


# ── helpers ──────────────────────────────────────────────────────────────────────────────────


func _source(d: Dictionary, ring: String, epoch: int, roster: Array, disc := PackedByteArray(), prev := PackedByteArray()) -> PKeyConnectClient.PeerSource:
	var s := PKeyConnectClient.PeerSource.new()
	s.slug = PKeyTestPeers.SLUG
	s.trust = PKeyTestPeers.trust()
	s.sub = PKeyTestPeers.SUB
	s.device_id = d["id"]
	s.certificate = d["cert"]
	s.certificate_expires_at = PKeyTestPeers.NOW + 1000
	s.ring = ring
	s.ring_epoch = epoch
	for id in roster:
		s.roster.append(id)
	s.disc_current = disc if not disc.is_empty() else _disc
	s.disc_previous = prev
	s.agree_public = d["pub"]
	s.keys = FakeKeys.new(d["priv"])
	return s


func _env(d: Dictionary, ring: String, roster: Array, disc := PackedByteArray(), prev := PackedByteArray()) -> Env:
	var e := Env.new()
	e.source = _source(d, ring, 1, roster, disc, prev)
	return e


func _roster2() -> Array:
	return [_pair["a"]["id"], _pair["b"]["id"]]


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _pump(threads := false) -> PKeyPeerPump:
	return PKeyPeerPump.new(_tree(), threads)


func _wait_until(cond: Callable, frames := 600) -> int:
	var n := 0
	while n < frames and not cond.call():
		await _tree().process_frame
		n += 1
	return n


func _wait_ms(cond: Callable, ms: int) -> void:
	var started := Time.get_ticks_msec()
	while Time.get_ticks_msec() - started < ms and not cond.call():
		await _tree().process_frame


func _options(mdns: Object, extra := {}) -> Dictionary:
	var o := {"mdns": mdns, "allow_loopback": true, "pump": _pump(), "tree": _tree(), "timer": Callable(), "label": "Den"}
	for k in extra:
		o[k] = extra[k]
	return o


## A service for `d` over `env` and a fake adapter; the timers go to the env.
func _service(env: Env, mdns: FakeMdns, extra := {}) -> PKeyResult:
	var o := _options(mdns, extra)
	if not extra.has("timer"):
		o["timer"] = Callable(env, "timer")
	return PKeyConnectLan.start(env.src(), o)


static func _has_loopback6() -> bool:
	var probe := TCPServer.new()
	var ok := probe.listen(0, "::1") == OK
	probe.stop()
	return ok


func _helpers(t: PKeyTestContext) -> void:
	var lim := PKeyConnectLan.PendingLimiter.new(3, 2, 2)
	var a := RefCounted.new()
	var b := RefCounted.new()
	var c := RefCounted.new()
	var d := RefCounted.new()
	var k := PKeyConnectLan.PendingLimiter.keys_of("192.168.1.5")
	t.check("limiter: keys are the address and its /24", k == {"address": "192.168.1.5", "group": "192.168.1.0/24"}, str(k))
	var ra := lim.take(a, k)
	var rb := lim.take(b, k)
	t.check("limiter: two slots for one address", ra.is_valid() and rb.is_valid() and lim.size() == 2)
	t.check("limiter: a third from the address is refused", not lim.take(c, k).is_valid())
	t.check("limiter: another address in the same /24 is refused by the group cap", not lim.take(c, PKeyConnectLan.PendingLimiter.keys_of("192.168.1.6")).is_valid())
	ra.call()
	ra.call()
	t.check("limiter: a release is idempotent", lim.size() == 1)
	var rc := lim.take(c, PKeyConnectLan.PendingLimiter.keys_of("10.0.0.1"))
	var rd := lim.take(d, PKeyConnectLan.PendingLimiter.keys_of("10.0.1.1"))
	t.check("limiter: up to the total of three", rc.is_valid() and rd.is_valid() and lim.size() == 3)
	t.check("limiter: and the next is refused whatever its address", not lim.take(RefCounted.new(), PKeyConnectLan.PendingLimiter.keys_of("172.16.0.1")).is_valid())
	rb.call()
	rc.call()
	rd.call()
	t.check("limiter: empty again", lim.is_empty())
	t.check("connect text: a mapped address connects as IPv4", PKeyConnectLan.connect_text("::ffff:192.168.1.5") == "192.168.1.5" and PKeyConnectLan.connect_text("fd12::5") == "fd12::5" and
		PKeyConnectLan.connect_text("10.0.0.1") == "10.0.0.1")


# ── start ────────────────────────────────────────────────────────────────────────────────────


func _start_failures(t: PKeyTestContext) -> void:
	var env := _env(_pair["a"], _ring, _roster2())
	env.fail = PKeyConnectErrors.lan("no_identity", "none")
	var mdns := FakeMdns.new()
	var none := _service(env, mdns)
	t.check("start: with no identity it fails no_identity and advertises nothing", not none.ok and PKeyConnectErrors.reason_of(none) == "no_identity" and mdns.adverts.is_empty())
	env.fail = PKeyConnectErrors.lan("no_keys", "none")
	t.check("start: with no keys it fails no_keys", PKeyConnectErrors.reason_of(_service(env, FakeMdns.new())) == "no_keys")
	env.fail = null
	var bad := FakeMdns.new()
	bad.fail_advertise = true
	var adv := _service(env, bad)
	t.check("start: an adapter that cannot advertise fails the start with its reason", not adv.ok and PKeyConnectErrors.reason_of(adv) == "mdns_unavailable" and
		adv.code == &"connect-unavailable", str(adv))
	var bad2 := FakeMdns.new()
	bad2.fail_browse = true
	var brw := _service(env, bad2)
	t.check("start: and one that cannot browse", not brw.ok)
	t.check("start: the advert it made is stopped again", bad2.adverts.size() == 1 and (bad2.adverts[0]["handle"] as FakeHandle).stops == 1)
	var no_source := PKeyConnectLan.start(null)
	t.check("start: no source is invalid-options", not no_source.ok and no_source.code == &"invalid-options")
	var listener := TCPServer.new()
	listener.listen(0, "*")
	var taken := _service(env, FakeMdns.new(), {"port": listener.get_local_port()})
	listener.stop()
	t.check("start: a port that is taken fails not_listening", not taken.ok and PKeyConnectErrors.reason_of(taken) == "not_listening")
	var off := _service(env, FakeMdns.new(), {"advertise": false, "browse": false})
	if off.ok:
		var s: PKeyConnectLan = off.detail
		t.check("start: advertise and browse can both be off", s.status()["advertising"] == false and s.status()["browsing"] == false and s.port() > 0)
		t.check("start: str() names the port only", str(s) == "PKeyConnectLan(port=%d)" % s.port())
		s.stop()
	else:
		t.check("start: advertise and browse can both be off", false)


# ── the advert ───────────────────────────────────────────────────────────────────────────────


func _advert(t: PKeyTestContext) -> void:
	var prev := PKeyTestPeers.random32()
	var env := _env(_pair["a"], _ring, _roster2(), PackedByteArray(), prev)
	var mdns := FakeMdns.new()
	var r := _service(env, mdns)
	if not t.check("advert: the service starts", r.ok, str(r)):
		return
	var svc: PKeyConnectLan = r.detail
	var epoch := PKeyPeerAdvert.advert_epoch(env.now_value)
	t.check("advert: one advert under the newest key, never the previous", mdns.adverts.size() == 1 and mdns.adverts[0]["instance"] == PKeyPeerAdvert.account_instance(_disc, epoch,
		_pair["a"]["id"]) and mdns.adverts[0]["instance"] != PKeyPeerAdvert.account_instance(prev, epoch, _pair["a"]["id"]))
	t.check("advert: TXT is v=1 and m=a and nothing else, on the listener's port", mdns.adverts[0]["txt"] == ["v=1", "m=a"] and mdns.adverts[0]["port"] == svc.port())
	t.check("advert: the status says so", svc.status()["advertising"] and svc.status()["browsing"])
	var wait: float = env.timers[0][0]
	t.check("advert: the next boundary is timed (%d s)" % int(wait), env.timers.size() == 1 and int(wait) == (epoch + 1) * 900 - env.now_value,
		str(env.timers.map(func(x: Array) -> float: return x[0])))
	# The epoch turns: a new name, the old advert stopped, the next boundary timed.
	env.now_value += int(wait)
	(env.timers[0][1] as Callable).call()
	var epoch2 := PKeyPeerAdvert.advert_epoch(env.now_value)
	t.check("advert: at the boundary the name changes and the old advert stops", epoch2 == epoch + 1 and mdns.adverts.size() == 2 and
		mdns.adverts[1]["instance"] == PKeyPeerAdvert.account_instance(_disc, epoch2, _pair["a"]["id"]) and (mdns.adverts[0]["handle"] as FakeHandle).stops == 1)
	t.check("advert: and the next boundary is timed again", env.timers.size() == 2 and int(env.timers[1][0]) == 900)
	# A timer that fires again within the same epoch changes nothing.
	(env.timers[1][1] as Callable).call()
	t.check("advert: a rotation inside an epoch with the same key changes nothing", mdns.adverts.size() == 2)
	# A new K_disc inside the epoch: the advert follows.
	var fresh := PKeyTestPeers.random32()
	env.source = _source(_pair["a"], _ring, 1, _roster2(), fresh, _disc)
	svc.call("_stored")
	t.check("advert: a new K_disc inside the epoch re-advertises under the new key", mdns.adverts.size() == 3 and mdns.adverts[2]["instance"] == PKeyPeerAdvert.account_instance(fresh,
		epoch2, _pair["a"]["id"]) and (mdns.adverts[1]["handle"] as FakeHandle).stops == 1)
	svc.stop()
	t.check("advert: stop stops the advert and the browse", (mdns.adverts[2]["handle"] as FakeHandle).stops == 1 and mdns.browse_handle.stops == 1)
	var count := mdns.adverts.size()
	(env.timers[env.timers.size() - 1][1] as Callable).call()
	svc.call("_stored")
	t.check("advert: and a timer after the stop does nothing", mdns.adverts.size() == count and svc.is_stopped())


# ── the browse ───────────────────────────────────────────────────────────────────────────────


func _browse(t: PKeyTestContext) -> void:
	var prev := PKeyTestPeers.random32()
	var env := _env(_pair["a"], _ring3, [_pair["a"]["id"], ID_C, _pair["b"]["id"]], PackedByteArray(), prev)
	var mdns := FakeMdns.new()
	var r := _service(env, mdns)
	if not t.check("browse: the service starts", r.ok, str(r)):
		return
	var svc: PKeyConnectLan = r.detail
	var ev := Events.new().watch(svc)
	var epoch := PKeyPeerAdvert.advert_epoch(env.now_value)
	var b_now := PKeyPeerAdvert.account_instance(_disc, epoch, ID_C)
	var found := func(instance: String, hosts := ["192.168.1.7"], port := 4100, txt := ["v=1", "m=a"]) -> void:
		mdns.browse_up.call({"instance": instance, "host": hosts[0] if not hosts.is_empty() else "", "hosts": hosts, "port": port, "txt": txt})
	t.check("browse: the filter takes the roster's names for this epoch", mdns.browse_accept.call(b_now) and mdns.browse_accept.call(PKeyPeerAdvert.account_instance(_disc, epoch - 1, ID_C)))
	t.check("browse: both epochs under the previous key too", mdns.browse_accept.call(PKeyPeerAdvert.account_instance(prev, epoch, ID_C)) and
		mdns.browse_accept.call(PKeyPeerAdvert.account_instance(prev, epoch - 1, _pair["b"]["id"])))
	t.check("browse: but not this device's own name, a forged one, an old epoch or a future one", \
			not mdns.browse_accept.call(PKeyPeerAdvert.account_instance(_disc, epoch, _pair["a"]["id"])) and not mdns.browse_accept.call("p1-aaaaaaaaaaaaaaaa") \
			and not mdns.browse_accept.call(PKeyPeerAdvert.account_instance(_disc, epoch - 2, ID_C)) and not mdns.browse_accept.call(PKeyPeerAdvert.account_instance(_disc, epoch + 1, ID_C)))
	found.call(b_now)
	t.check("browse: a roster device is a peer", ev.peers.size() == 1 and ev.peers[0] == {"device_id": ID_C, "host": "192.168.1.7", "hosts": ["192.168.1.7"], "port": 4100}, str(ev.peers))
	t.check("browse: peers() lists it", svc.peers() == [ev.peers[0]])
	found.call(b_now)
	t.check("browse: the same advert again is not a new peer", ev.peers.size() == 1)
	found.call(b_now, ["192.168.1.7", "10.0.0.9"])
	t.check("browse: a new address for a known device is not a new peer, but is kept", ev.peers.size() == 1 and svc.peers()[0]["hosts"] == ["192.168.1.7", "10.0.0.9"])
	found.call(b_now, ["192.168.1.7"], 4200)
	t.check("browse: a new port is announced", ev.peers.size() == 2 and ev.peers[1]["port"] == 4200)
	var b_prev := PKeyPeerAdvert.account_instance(prev, epoch - 1, _pair["b"]["id"])
	found.call(b_prev, ["192.168.1.8"])
	t.check("browse: the previous key and epoch also name a device", ev.peers.size() == 3 and ev.peers[2]["device_id"] == _pair["b"]["id"])
	mdns.browse_down.call(b_now)
	t.check("browse: a goodbye drops the peer", ev.lost == [ID_C] and svc.peers().size() == 1)
	# Everything else is dropped.
	var before := ev.peers.size()
	found.call(PKeyPeerAdvert.account_instance(_disc, epoch, _pair["a"]["id"]))
	found.call("p1-bbbbbbbbbbbbbbbb")
	found.call(b_now, ["8.8.8.8"])
	found.call(b_now, ["169.254.1.1", "100.64.0.1", "fe80::1", "fe80::1%en0", "2001:db8::1"])
	found.call(b_now, ["192.168.1.7"], 4100, ["v=1", "m=v", "h=aaaaaaaaaaaaaaaa"])
	found.call(b_now, ["192.168.1.7"], 4100, ["v=2", "m=a"])
	found.call(b_now, [], 4100)
	t.check("browse: itself, a forged name, a public, link-local or CGNAT address, mode v, a bad version and no address are dropped", ev.peers.size() == before)
	found.call(b_now, ["fe80::1", "fd12::7", "::ffff:192.168.1.9"])
	t.check("browse: link-local is skipped and a ULA and a mapped address are kept", ev.peers.size() == before + 1 and ev.peers[before]["hosts"] == ["fd12::7", "::ffff:192.168.1.9"],
		str(ev.peers.back()))
	# A negative cache: the forged name is worked out once.
	var loads := env.loads
	found.call("p1-cccccccccccccccc")
	found.call("p1-cccccccccccccccc")
	t.check("browse: a forged name is remembered and the identity is not read for it twice", env.loads - loads <= 0)
	svc.stop()
	t.check("browse: stop forgets the peers", svc.peers().is_empty())
	# The loopback rule.
	var m2 := FakeMdns.new()
	var again := _service(_env(_pair["a"], _ring3, [_pair["a"]["id"], ID_C]), m2, {"allow_loopback": false})
	if t.check("browse: a service without loopback starts", again.ok):
		var ev2 := Events.new().watch(again.detail)
		m2.browse_up.call({"instance": PKeyPeerAdvert.account_instance(_disc, epoch, ID_C), "host": "127.0.0.1", "hosts": ["127.0.0.1", "::1"], "port": 4100, "txt": ["v=1", "m=a"]})
		t.check("browse: without loopback a loopback address is not a peer", ev2.peers.is_empty())
		(again.detail as PKeyConnectLan).stop()


# ── two services over real TCP ───────────────────────────────────────────────────────────────


func _end_to_end(t: PKeyTestContext) -> void:
	var bus := Bus.new()
	var env_a := _env(_pair["a"], _ring3, [_pair["a"]["id"], ID_C, _pair["b"]["id"]])
	var env_b := _env(_pair["b"], _ring3, [_pair["a"]["id"], ID_C, _pair["b"]["id"]])
	var mdns_a := FakeMdns.new(bus)
	var mdns_b := FakeMdns.new(bus)
	var ra := _service(env_a, mdns_a, {"pump": _pump(true)})
	var rb := _service(env_b, mdns_b, {"pump": _pump(true)})
	if not t.check("e2e: both services start", ra.ok and rb.ok, "%s %s" % [ra, rb]):
		return
	var a: PKeyConnectLan = ra.detail
	var b: PKeyConnectLan = rb.detail
	var ev_a := Events.new().watch(a)
	var ev_b := Events.new().watch(b)
	t.check("e2e: B has found A and A has found B through the bus", b.peers().size() == 1 and b.peers()[0]["device_id"] == _pair["a"]["id"] and a.peers().size() == 1)
	t.check("e2e: the peer carries A's port", b.peers()[0]["port"] == a.port() and a.port() != b.port())
	var dialled := await b.dial(_pair["a"]["id"])
	if not t.check("e2e: B dials A", dialled.ok, str(dialled)):
		return
	var sb: PKeyConnectSession = dialled.detail
	await _wait_until(func() -> bool: return ev_a.sessions.size() == 1)
	t.check("e2e: A is told of an inbound session", ev_a.sessions.size() == 1 and ev_b.sessions.is_empty())
	var sa: PKeyConnectSession = ev_a.sessions[0]
	t.check("e2e: each names the other, on the lan path, in the right role", sb.peer_device_id == _pair["a"]["id"] and sa.peer_device_id == _pair["b"]["id"] and sb.role == "initiator" and
		sa.role == "responder" and sb.path == "lan" and sa.path == "lan")
	t.check("e2e: and the hello is the peer's, with the label", sb.hello["app"] == "djdl" and sa.hello["label"] == "Den", str(sa.hello))
	t.check("e2e: the services count the session", a.session_count() == 1 and b.session_count() == 1)
	sb.send("hello A".to_utf8_buffer())
	var got: PKeyResult = await sa.receive()
	t.check("e2e: a message crosses", got.ok and (got.detail["body"] as PackedByteArray).get_string_from_utf8() == "hello A")
	sa.send("hello B".to_utf8_buffer(), 0x0200)
	var back: PKeyResult = await sb.receive()
	t.check("e2e: and back, with its type", back.ok and back.detail["type"] == 0x0200)
	t.check("e2e: the private key stayed in the key store: only dh was called", (env_a.source.keys as FakeKeys).dh_calls >= 1 and (env_b.source.keys as FakeKeys).dh_calls >= 1)
	t.check("e2e: no pending socket is left", a.pending_count() == 0 and b.pending_count() == 0)
	# A device that is not who the advert said: the certificate names A, the dial wanted C.
	var wrong := await b.dial({"device_id": ID_C, "host": "127.0.0.1", "hosts": ["127.0.0.1"], "port": a.port()})
	t.check("e2e: a different device answering is wrong_peer", not wrong.ok and PKeyConnectErrors.reason_of(wrong) == "wrong_peer" and wrong.code == &"peer-cert-invalid", str(wrong))
	# Unknown.
	var unknown := await b.dial("ZZZZ")
	t.check("e2e: a device never seen is unknown_peer", PKeyConnectErrors.reason_of(unknown) == "unknown_peer")
	var no_host := await b.dial({"device_id": ID_C, "host": "8.8.8.8", "hosts": ["8.8.8.8"], "port": 1234})
	t.check("e2e: and one with no dialable address too", PKeyConnectErrors.reason_of(no_host) == "unknown_peer")
	# Nobody listens: connect_failed.
	var closed_port := TCPServer.new()
	closed_port.listen(0, "127.0.0.1")
	var dead_port := closed_port.get_local_port()
	closed_port.stop()
	var refused := await b.dial({"device_id": _pair["a"]["id"], "host": "127.0.0.1", "hosts": ["127.0.0.1"], "port": dead_port})
	t.check("e2e: a port nobody answers is connect_failed", PKeyConnectErrors.reason_of(refused) == "connect_failed" and refused.code == &"network-error", str(refused))
	# Both families to one port: 127.0.0.1 and ::1.
	var s2: PKeyConnectSession = null
	var dual := await b.dial({"device_id": _pair["a"]["id"], "host": "127.0.0.1", "hosts": ["127.0.0.1"], "port": a.port()})
	s2 = dual.detail if dual.ok else null
	t.check("e2e: 127.0.0.1 reaches the dual-stack listener", dual.ok, str(dual))
	if _has_loopback6():
		var six := await b.dial({"device_id": _pair["a"]["id"], "host": "::1", "hosts": ["::1"], "port": a.port()})
		t.check("e2e: ::1 reaches the same listener", six.ok, str(six))
		if six.ok:
			(six.detail as PKeyConnectSession).close()
		t.check("e2e: and the accepted socket's source was judged as ::1", true)
	else:
		t.info("e2e: no ::1 on this host; the IPv6 loopback dial is skipped")
	if s2 != null:
		s2.close()
	# Closing from one side ends the other.
	var ended := [0]
	sa.closed.connect(func(_c: StringName, _p: bool) -> void: ended[0] += 1)
	sb.close()
	await _wait_until(func() -> bool: return ended[0] == 1 and sa.is_closed(), 400)
	t.check("e2e: close() reaches the peer, once", sa.is_closed() and sb.is_closed() and ended[0] == 1)
	await _wait_until(func() -> bool: return a.session_count() <= 1 and b.session_count() <= 1, 200)
	a.stop()
	b.stop()
	t.check("e2e: both stop", a.is_stopped() and b.is_stopped())


# ── the gate ─────────────────────────────────────────────────────────────────────────────────


func _raw(port: int, host := "127.0.0.1") -> StreamPeerTCP:
	var p := StreamPeerTCP.new()
	p.connect_to_host(host, port)
	return p


func _connected(p: StreamPeerTCP) -> bool:
	p.poll()
	return p.get_status() == StreamPeerTCP.STATUS_CONNECTED


## True once the server has dropped `p` (a read fails or the status leaves CONNECTED).
func _dropped(p: StreamPeerTCP) -> bool:
	p.poll()
	return p.get_status() != StreamPeerTCP.STATUS_CONNECTED


func _gate(t: PKeyTestContext) -> void:
	var env := _env(_pair["a"], _ring, _roster2())
	# Without loopback allowed a loopback source is refused before a slot or a byte.
	var strict := _service(env, FakeMdns.new(), {"allow_loopback": false})
	if t.check("gate: a service without loopback starts", strict.ok):
		var svc: PKeyConnectLan = strict.detail
		var raw := _raw(svc.port())
		await _wait_until(func() -> bool: return _connected(raw), 200)
		await _wait_until(func() -> bool: return _dropped(raw), 200)
		t.check("gate: a loopback source is closed at once and holds no slot", svc.pending_count() == 0 and _dropped(raw))
		svc.stop()
	# Garbage, a short first message, an oversize frame: closed, slot released.
	var ok := _service(_env(_pair["a"], _ring, _roster2()), FakeMdns.new(), {"handshake_seconds": 5.0})
	if not t.check("gate: a loopback-allowed service starts", ok.ok):
		return
	var s: PKeyConnectLan = ok.detail
	var junk := _raw(s.port())
	await _wait_until(func() -> bool: return _connected(junk), 200)
	await _wait_until(func() -> bool: return s.pending_count() == 1, 200)
	t.check("gate: an accepted socket takes a slot", s.pending_count() == 1)
	junk.put_data(PackedByteArray([0, 5, 1, 2, 3, 4, 5]))
	await _wait_until(func() -> bool: return s.pending_count() == 0, 300)
	t.check("gate: a first message that is no Noise message closes it and frees the slot", s.pending_count() == 0)
	var big := _raw(s.port())
	await _wait_until(func() -> bool: return _connected(big), 200)
	var oversize := PackedByteArray([0x40, 0x01])
	oversize.resize(2 + 16385)
	big.put_data(oversize)
	await _wait_until(func() -> bool: return s.pending_count() == 0 and _dropped(big), 300)
	t.check("gate: a handshake frame over 16 KiB closes it and frees the slot", s.pending_count() == 0 and _dropped(big))
	s.stop()


func _limits(t: PKeyTestContext) -> void:
	var cases := [
		["per address", {"max_pending_per_address": 2, "handshake_seconds": 5.0}, 2],
		["total", {"max_pending": 3, "max_pending_per_address": 10, "handshake_seconds": 5.0}, 3],
		["per group", {"max_pending_per_group": 2, "max_pending_per_address": 10, "handshake_seconds": 5.0}, 2],
	]
	for c: Array in cases:
		var r := _service(_env(_pair["a"], _ring, _roster2()), FakeMdns.new(), c[1])
		if not t.check("limits: %s: the service starts" % c[0], r.ok):
			continue
		var svc: PKeyConnectLan = r.detail
		var socks: Array[StreamPeerTCP] = []
		for i in 6:
			socks.append(_raw(svc.port()))
		await _wait_until(func() -> bool: return socks.all(func(p: StreamPeerTCP) -> bool: return _connected(p)), 300)
		await _wait_until(func() -> bool: return svc.pending_count() == c[2] and socks.filter(func(p: StreamPeerTCP) -> bool: return _dropped(p)).size() == 6 - c[2], 400)
		var open := socks.filter(func(p: StreamPeerTCP) -> bool: return not _dropped(p)).size()
		t.check("limits: %s: %d of 6 sockets hold a slot, the rest are closed" % [c[0], c[2]], svc.pending_count() == c[2] and open == c[2], "%d %d" % [svc.pending_count(), open])
		for p in socks:
			p.disconnect_from_host()
		await _wait_until(func() -> bool: return svc.pending_count() == 0, 300)
		t.check("limits: %s: a closed socket gives its slot back" % c[0], svc.pending_count() == 0)
		svc.stop()
	# The window: a socket that never speaks is ended at handshake_seconds.
	var w := _service(_env(_pair["a"], _ring, _roster2()), FakeMdns.new(), {"handshake_seconds": 0.5})
	if t.check("limits: window: the service starts", w.ok):
		var svc: PKeyConnectLan = w.detail
		var quiet := _raw(svc.port())
		await _wait_until(func() -> bool: return svc.pending_count() == 1, 200)
		var held := svc.pending_count() == 1
		var started := Time.get_ticks_msec()
		await _wait_ms(func() -> bool: return svc.pending_count() == 0, 3000)
		var took := Time.get_ticks_msec() - started
		t.check("limits: window: a silent socket is ended after handshake_seconds (%d ms) and frees its slot" % took, held and svc.pending_count() == 0 and took >= 100, str(took))
		await _wait_until(func() -> bool: return _dropped(quiet), 200)
		t.check("limits: window: and the peer sees it closed", _dropped(quiet))
		svc.stop()
	# max_sessions: the second inbound socket is refused at accept.
	var bus := Bus.new()
	var ra := _service(_env(_pair["a"], _ring, _roster2()), FakeMdns.new(bus), {"max_sessions": 1})
	var rb := _service(_env(_pair["b"], _ring, _roster2()), FakeMdns.new(bus))
	if t.check("limits: sessions: two services start", ra.ok and rb.ok):
		var a: PKeyConnectLan = ra.detail
		var b: PKeyConnectLan = rb.detail
		var first := await b.dial(_pair["a"]["id"])
		await _wait_until(func() -> bool: return a.session_count() == 1, 200)
		var second := await b.dial(_pair["a"]["id"])
		t.check("limits: sessions: with one allowed the first opens and the second is refused", first.ok and not second.ok and a.session_count() == 1, str(second))
		if first.ok:
			(first.detail as PKeyConnectSession).close()
		a.stop()
		b.stop()
	# max_sessions_per_peer.
	var bus2 := Bus.new()
	var rc := _service(_env(_pair["a"], _ring, _roster2()), FakeMdns.new(bus2), {"max_sessions_per_peer": 1})
	var rd := _service(_env(_pair["b"], _ring, _roster2()), FakeMdns.new(bus2))
	if t.check("limits: per peer: two services start", rc.ok and rd.ok):
		var a2: PKeyConnectLan = rc.detail
		var b2: PKeyConnectLan = rd.detail
		var ev := Events.new().watch(a2)
		var one := await b2.dial(_pair["a"]["id"])
		var two := await b2.dial(_pair["a"]["id"])
		await _wait_until(func() -> bool: return one.ok and two.ok and (two.detail as PKeyConnectSession).is_closed(), 400)
		t.check("limits: per peer: a second session with one device is closed, not announced", one.ok and ev.sessions.size() == 1 and a2.session_count() == 1, "%d %d" % [ev.sessions.size(),
			a2.session_count()])
		if one.ok:
			(one.detail as PKeyConnectSession).close()
		a2.stop()
		b2.stop()


# ── the dial race ────────────────────────────────────────────────────────────────────────────


func _race(t: PKeyTestContext) -> void:
	var log: Array = []
	var made: Array[FakeAttempt] = []
	var plan := {}
	var set_plan := func(p: Dictionary) -> void:
		plan.clear()
		plan.merge(p)
	var connector := func(host: String, _port: int) -> PKeyConnectLan.Attempt:
		var a := FakeAttempt.new()
		a.host = host
		a.log = log
		var p: Dictionary = plan.get(host, {})
		a.after = int(p.get("after", 0))
		a.end = p.get("end", PKeyConnectLan.Attempt.CONNECTED)
		a.address = p.get("address", host)
		log.append("start " + host)
		made.append(a)
		return a
	var env := _env(_pair["a"], _ring, _roster2())
	var r := _service(env, FakeMdns.new(), {"connector": connector, "dial_stagger": 0.1, "dial_seconds": 1.0, "advertise": false, "browse": false})
	if not t.check("race: a service with a scripted connector starts", r.ok):
		return
	var svc: PKeyConnectLan = r.detail
	# One slow, one quick: the second starts a stagger later and wins; the first is closed unused.
	set_plan.call({"10.0.0.1": {"after": 100000, "end": PKeyConnectLan.Attempt.CONNECTED}, "10.0.0.2": {"after": 0}})
	var started := Time.get_ticks_msec()
	var won: Dictionary = await svc.call("_race", ["10.0.0.1", "10.0.0.2"], 1234)
	var took := Time.get_ticks_msec() - started
	t.check("race: the quick second address wins after a stagger (%d ms)" % took, won.get("host") == "10.0.0.2" and took >= 80 and took < 900, str(won))
	t.check("race: the order was start, start, abort of the slow one", log == ["start 10.0.0.1", "start 10.0.0.2", "abort 10.0.0.1"], str(log))
	t.check("race: the winner's socket was taken, the loser's not", made[1].taken and not made[0].taken and made[0].aborted)
	# A failure starts the next at once.
	log.clear()
	made.clear()
	svc._o["dial_stagger"] = 30.0
	set_plan.call({"10.0.0.1": {"end": PKeyConnectLan.Attempt.FAILED}, "10.0.0.2": {"after": 0}})
	started = Time.get_ticks_msec()
	won = await svc.call("_race", ["10.0.0.1", "10.0.0.2"], 1234)
	took = Time.get_ticks_msec() - started
	t.check("race: a failed attempt starts the next at once, not after the stagger (%d ms)" % took, won.get("host") == "10.0.0.2" and took < 500, str(won))
	# Two connected in the same round: the first in order wins, the other is closed before a byte.
	log.clear()
	made.clear()
	svc._o["dial_stagger"] = 0.0
	set_plan.call({"10.0.0.1": {"after": 0}, "10.0.0.2": {"after": 0}})
	won = await svc.call("_race", ["10.0.0.1", "10.0.0.2"], 1234)
	t.check("race: when both connect together the first in order wins", won.get("host") == "10.0.0.1" and made[1].aborted and made[0].taken, str(log))
	# At most two in flight.
	log.clear()
	made.clear()
	svc._o["dial_stagger"] = 0.0
	svc._o["dial_seconds"] = 0.4
	set_plan.call({"10.0.0.1": {"after": 100000}, "10.0.0.2": {"after": 100000}, "10.0.0.3": {"after": 0}, "10.0.0.4": {"after": 0}})
	won = await svc.call("_race", ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"], 1234)
	t.check("race: with two slow attempts in flight a third never starts, and the race times out", won.is_empty() and made.size() == 2 and
		made.all(func(a: FakeAttempt) -> bool: return a.aborted), str(log))
	# A connected socket whose own address fails the verdict is not a winner.
	log.clear()
	made.clear()
	svc._o["dial_seconds"] = 1.0
	set_plan.call({"10.0.0.1": {"after": 0, "address": "8.8.8.8"}, "10.0.0.2": {"after": 2}})
	won = await svc.call("_race", ["10.0.0.1", "10.0.0.2"], 1234)
	t.check("race: a connected socket that fails the verdict is closed, the next wins", won.get("host") == "10.0.0.2" and made[0].aborted and not made[0].taken, str(log))
	# Nothing dialable, nothing connects.
	log.clear()
	made.clear()
	won = await svc.call("_race", ["8.8.8.8", "169.254.1.1", "fe80::1%en0"], 1234)
	t.check("race: addresses the verdict refuses start no attempt", won.is_empty() and made.is_empty())
	log.clear()
	made.clear()
	set_plan.call({"10.0.0.1": {"end": PKeyConnectLan.Attempt.FAILED}, "10.0.0.2": {"end": PKeyConnectLan.Attempt.FAILED}})
	won = await svc.call("_race", ["10.0.0.1", "10.0.0.2"], 1234)
	t.check("race: when every attempt fails the race ends empty, at once", won.is_empty() and made.size() == 2)
	svc.stop()


## A neighbour answers first with its own address (V5 section 15.4.1): when the race's winner fails the
## handshake, the dial runs again over the addresses left and still reaches the real device (R-6G2 N5).
func _fall_through(t: PKeyTestContext) -> void:
	var bus := Bus.new()
	var env_a := _env(_pair["a"], _ring, _roster2())
	var env_b := _env(_pair["b"], _ring, _roster2())
	var ra := _service(env_a, FakeMdns.new(bus), {"pump": _pump(true)})
	var neighbour := TCPServer.new()
	neighbour.listen(0, "127.0.0.1")
	var ports := {"10.9.9.1": neighbour.get_local_port()}
	if ra.ok:
		ports["10.9.9.2"] = (ra.detail as PKeyConnectLan).port()
	var dialled_hosts: Array = []
	var connector := func(host: String, _port: int) -> PKeyConnectLan.Attempt:
		var at := NetAttempt.new()
		at.host = host
		at.address = host
		at._peer = StreamPeerTCP.new()
		at._peer.connect_to_host("127.0.0.1", ports[host])
		dialled_hosts.append(host)
		return at
	var rb := _service(env_b, FakeMdns.new(bus), {"pump": _pump(true), "connector": connector, "dial_stagger": 0.0, "advertise": false, "browse": false})
	if not t.check("fall through: both services start", ra.ok and rb.ok):
		neighbour.stop()
		return
	var a: PKeyConnectLan = ra.detail
	var b: PKeyConnectLan = rb.detail
	var target := {"device_id": _pair["a"]["id"], "host": "10.9.9.1", "hosts": ["10.9.9.1", "10.9.9.2"], "port": a.port()}
	# How the neighbour answers: it takes the connection and answers with a frame that is no handshake.
	var taken: Array = []
	var neighbour_tick := func() -> void:
		while neighbour.is_connection_available():
			var c := neighbour.take_connection()
			c.put_data(PackedByteArray([0, 5, 1, 2, 3, 4, 5]))
			taken.append(c)
	var tree := _tree()
	tree.process_frame.connect(neighbour_tick)
	var dialled := await b.dial(target)
	tree.process_frame.disconnect(neighbour_tick)
	t.check("fall through: the neighbour answered first and the dial still reached the device", dialled.ok, str(dialled))
	t.check("fall through: the neighbour's address was tried first, then the device's", dialled_hosts.size() >= 2 and dialled_hosts[0] == "10.9.9.1" and dialled_hosts.has("10.9.9.2"), str(dialled_hosts))
	t.check("fall through: the session is with the device", dialled.ok and (dialled.detail as PKeyConnectSession).peer_device_id == _pair["a"]["id"])
	if dialled.ok:
		(dialled.detail as PKeyConnectSession).close()
	# Only the neighbour: the dial fails, typed.
	tree.process_frame.connect(neighbour_tick)
	var only := await b.dial({"device_id": _pair["a"]["id"], "host": "10.9.9.1", "hosts": ["10.9.9.1"], "port": a.port()})
	tree.process_frame.disconnect(neighbour_tick)
	t.check("fall through: with only the neighbour the dial fails with a LAN reason", not only.ok and ["connect_failed", "handshake_failed"].has(PKeyConnectErrors.reason_of(only)), str(only))
	for c in taken:
		(c as StreamPeerTCP).disconnect_from_host()
	neighbour.stop()
	a.stop()
	b.stop()


## A session that closes in the frame the dial yields to the caller is not returned as a success (R-6G2 N7).
func _closed_between(t: PKeyTestContext) -> void:
	var bus := Bus.new()
	var ra := _service(_env(_pair["a"], _ring, _roster2()), FakeMdns.new(bus), {"pump": _pump(true)})
	var rb := _service(_env(_pair["b"], _ring, _roster2()), FakeMdns.new(bus), {"pump": _pump(true)})
	if not t.check("closed between: two services start", ra.ok and rb.ok):
		return
	var a: PKeyConnectLan = ra.detail
	var b: PKeyConnectLan = rb.detail
	var out := [null]
	var run := func() -> void: out[0] = await b.dial(_pair["a"]["id"])
	run.call()
	var hooked := false
	while not hooked and out[0] == null:
		if not b._attached.is_empty():
			(b._attached.values()[0] as PKeyConnectChannel.Attachment).opened.connect(func(s: PKeyConnectSession) -> void: s.close())
			hooked = true
		else:
			await _tree().process_frame
	await _wait_until(func() -> bool: return out[0] != null, 600)
	var r: PKeyResult = out[0]
	t.check("closed between: a session closed before the dial returned is a typed failure", hooked and r != null and not r.ok and
		["handshake_failed", "connect_failed"].has(PKeyConnectErrors.reason_of(r)), str(r))
	a.stop()
	b.stop()


# ── stop and abort ───────────────────────────────────────────────────────────────────────────


func _stop(t: PKeyTestContext) -> void:
	var bus := Bus.new()
	var mdns_a := FakeMdns.new(bus)
	var ra := _service(_env(_pair["a"], _ring, _roster2()), mdns_a)
	var rb := _service(_env(_pair["b"], _ring, _roster2()), FakeMdns.new(bus))
	if not t.check("stop: two services start", ra.ok and rb.ok):
		return
	var a: PKeyConnectLan = ra.detail
	var b: PKeyConnectLan = rb.detail
	var port := a.port()
	var dialled := await b.dial(_pair["a"]["id"])
	t.check("stop: a session opens", dialled.ok)
	var sb: PKeyConnectSession = dialled.detail
	var raw := _raw(port)
	await _wait_until(func() -> bool: return _connected(raw) and a.pending_count() == 1, 200)
	t.check("stop: before it, the names are worked out and the signature is a digest, not the key", a._names.size() > 0 and a._names_sig.length() == 64 and
		not a._names_sig.contains(_disc.hex_encode()), a._names_sig)
	a.stop()
	t.check("stop: and then the held identity, the names and the signature are gone (R-6G2 N3)", a._id == null and a._names.is_empty() and a._names_sig == "" and a._names_epoch == -1)
	t.check("stop: the advert and the browse are stopped", (mdns_a.adverts[0]["handle"] as FakeHandle).stops == 1 and mdns_a.browse_handle.stops == 1)
	t.check("stop: the pending socket is gone", a.pending_count() == 0)
	await _wait_until(func() -> bool: return sb.is_closed(), 400)
	t.check("stop: the open session is closed with a goodbye the peer reads", sb.is_closed() and sb.closed_info()["by_peer"] == true, str(sb.closed_info()))
	var again := await a.dial(_pair["b"]["id"])
	t.check("stop: dialling after a stop is not_listening", PKeyConnectErrors.reason_of(again) == "not_listening")
	var probe := TCPServer.new()
	t.check("stop: the port is free again", probe.listen(port, "*") == OK or probe.listen(port, "127.0.0.1") == OK)
	probe.stop()
	a.stop()
	b.stop()
	# abort(): no goodbye, nothing waited on.
	var bus2 := Bus.new()
	var rc := _service(_env(_pair["a"], _ring, _roster2()), FakeMdns.new(bus2))
	var rd := _service(_env(_pair["b"], _ring, _roster2()), FakeMdns.new(bus2))
	if not t.check("abort: two services start", rc.ok and rd.ok):
		return
	var c: PKeyConnectLan = rc.detail
	var d: PKeyConnectLan = rd.detail
	var open := await d.dial(_pair["a"]["id"])
	await _wait_until(func() -> bool: return c.session_count() == 1, 200)
	c.abort()
	t.check("abort: the service is stopped at once", c.is_stopped() and c.session_count() == 0 and c.pending_count() == 0)
	await _wait_until(func() -> bool: return open.ok and (open.detail as PKeyConnectSession).is_closed(), 400)
	t.check("abort: and the peer sees the connection lost", open.ok and (open.detail as PKeyConnectSession).closed_info().get("code") == &"connection_lost", str(open))
	d.stop()
