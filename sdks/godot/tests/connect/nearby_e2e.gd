extends RefCounted
# @pkey-feature identity.nearby
# Nearby approval through the app API (PKeyCloudNearby at `cloud_connect.nearby`, CC-15b.G2c; WIRE-CONTRACT-V5
# section 15.6.1): two devices in one process, M (signed in) and D (no sign-in), each a PKeyCloudConnect over its
# own Core, on one fake discovery lane, over memory pipes (a native-style lane) and over real loopback TCP. A
# counting stand-in for the Worker's approve route checks the host-side contract: one approve for a right pick,
# none for a wrong pick or "none of these match". Also the typed N/A answers, the sign-out stop and its order, and
# a start overtaken by a sign-out.

const SLUG := "djdl"
const D_DEVICE := "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
const M_DEVICE := "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM"
const REQUEST := "nr_CCCCCCCCCCCCCCCCCCCCCC"
const APPROVED := '{"status":"approved"}'

var _host: Node
var _keys: PKeyDeviceKeyStore
var _lasting: Array = []


func run(t: PKeyTestContext) -> void:
	_host = Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	_keys = PKeyDeviceKeyStore.memory_only()
	await _approve(t, true)
	await _approve(t, false)
	await _refusals(t)
	await _unsupported(t)
	await _sign_out(t)
	await _overtaken(t)
	for i in 10:
		await _tree().process_frame
	_host.queue_free()


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _until(cond: Callable, frames := 900) -> bool:
	for i in frames:
		if cond.call():
			return true
		await _tree().process_frame
	return cond.call()


# -- doubles ----------------------------------------------------------------------------------------


class Clock extends RefCounted:
	func now() -> int:
		return PKeyTestPeers.NOW


class FakeHandle extends RefCounted:
	var stops := 0


	func stop() -> void:
		stops += 1


	func update(_instance: String, _txt: Array) -> bool:
		return true


## A discovery lane both devices use: M advertises on it, D browses it. Over TCP, the hit names the
## advertised port on loopback.
class Bus extends RefCounted:
	var adverts: Array = []
	var browsers: Array = []
	var caps := {"slots": true, "tags": true}
	var querier_only := false
	var advertise_failure: PKeyResult = null


	func capabilities() -> Dictionary:
		return caps


	func status() -> Dictionary:
		return {"active": true, "responder": not querier_only, "querier": true, "reason": "querier_only" if querier_only else ""}


	func set_tags(_tags: Dictionary) -> bool:
		return true


	func advertise(a: Dictionary) -> PKeyResult:
		if advertise_failure != null:
			return advertise_failure
		var h := FakeHandle.new()
		adverts.append({"advert": a, "handle": h})
		for b: Callable in browsers:
			b.call(_hit(a))
		return PKeyResult.success(h)


	func browse(on_up: Callable, _on_down := Callable(), _accept := Callable(), _tags := {}) -> PKeyResult:
		browsers.append(on_up)
		for ad: Dictionary in adverts:
			on_up.call(_hit(ad["advert"]))
		return PKeyResult.success(FakeHandle.new())


	func _hit(a: Dictionary) -> Dictionary:
		return {"instance": a["instance"], "host": "127.0.0.1", "hosts": ["127.0.0.1"], "port": int(a.get("port", 0)), "txt": a["txt"], "native": false}


	func live_adverts() -> int:
		return adverts.filter(func(x: Dictionary) -> bool: return (x["handle"] as FakeHandle).stops == 0).size()


## The Apple-style lane: pipes come through an acceptor and D dials by instance name.
class NativeBus extends Bus:
	var acceptors: Dictionary = {}


	func set_acceptor(slot: Variant, fn := Callable()) -> void:
		if fn.is_valid():
			acceptors[str(slot)] = fn
		else:
			acceptors.erase(str(slot))


	func set_accepted(_names: Array) -> bool:
		return true


	func dial(_instance: String) -> PKeyPeerPipe:
		var ends := PKeyPeerMemoryPipe.pair()
		var acceptor: Callable = acceptors.get("v", Callable())
		if acceptor.is_valid():
			acceptor.call(ends[1])
		return Pipe.new(ends[0]._shared, 0)


	func _hit(a: Dictionary) -> Dictionary:
		return {"instance": a["instance"], "host": "", "hosts": [], "port": 0, "txt": a["txt"], "native": true}


## A memory pipe that reports itself connected, like the Apple lane's.
class Pipe extends PKeyPeerMemoryPipe:
	func is_connected_native() -> bool:
		return true


## What the host does on M and D: the approvals, the notices and the Worker's approve route, counted.
class Host extends RefCounted:
	var approvals: Array = []
	var approves := 0
	var results: Array = []
	var records: Array = []
	var closes: Array = []
	var lists: Array = []


	func on_request(a: PKeyPeerNearbyApprover.Approval) -> void:
		approvals.append(a)


	## The stand-in for `nearby/approve`: counts the call, answers an approval.
	func approve(_picked: Dictionary) -> Dictionary:
		approves += 1
		return {"http": 200, "body": APPROVED, "discovery_nearby": true}


	func watch(req: PKeyNearbyRequest) -> void:
		req.result.connect(func(s: String) -> void: results.append(s))
		req.record.connect(func(rt: int, body: PackedByteArray) -> void: records.append([rt, body]))
		req.closed.connect(func(c: StringName) -> void: closes.append(c))
		req.approvers_changed.connect(func(l: Array) -> void: lists.append(l))


class StubClient extends PKeyConnectClient:
	var leaves := 0
	var order: Array = []


	func leave() -> PKeyResult:
		leaves += 1
		order.append("leave")
		return PKeyResult.success()


## One device: its Core, client and facade, and the switches the host owns.
class Device extends RefCounted:
	var core: PKeyCore
	var client: StubClient
	var api: PKeyCloudConnect
	var signed := true
	var discovers := 0
	var web := false
	var clock := Clock.new()
	var keys: Object


	func signed_in() -> bool:
		return signed


	func discover() -> void:
		discovers += 1
		await (Engine.get_main_loop() as SceneTree).process_frame


	func signer() -> PKeyResult:
		return PKeyResult.success({"port": keys, "device_id": D_DEVICE})


	func has_feature(tag: String) -> bool:
		return web and tag == "web"


# -- helpers ----------------------------------------------------------------------------------------


func _manifest(nearby: bool) -> Dictionary:
	return {"services": {"identity": {
		"enabled": true, "nearby": nearby,
		"endpoints": {
			"nearbyStart": "https://key.plrs.im/djdl/identity/nearby/start",
			"nearbyPoll": "https://key.plrs.im/djdl/identity/nearby/poll",
			"nearbyApprove": "https://key.plrs.im/djdl/identity/nearby/approve",
		},
	}}}


func _device(nearby := true) -> Device:
	var d := Device.new()
	var clock := [PKeyTestPeers.NOW]
	var opts := PKeyTestFixtures.options("https://key.plrs.im", PKeyMemoryStore.new(M_DEVICE, "pkeyt_x"), clock, SLUG, PKeyTestPeers.trust())
	d.core = PKeyCore.create(opts, _host, "0.0.0").detail
	d.core.discovery_manifest = _manifest(nearby)
	d.keys = _keys
	d.client = StubClient.new(d.core, PKeyConnectState.new(SLUG, "user://pkey", true), null)
	d.api = PKeyCloudConnect.new(d.core, d.client, {
		"tree": _tree(), "has_feature": Callable(d, "has_feature"), "nearby_now": Callable(d.clock, "now"),
		"nearby_signer": Callable(d, "signer"), "nearby_signed_in": Callable(d, "signed_in"), "nearby_discover": Callable(d, "discover"),
	})
	_lasting.append(d)
	return d


func _m_options(lane: Object, extra := {}) -> Dictionary:
	var o := {"mdns": lane, "prompt": true, "label": "Phone", "allow_loopback": true}
	for k in extra:
		o[k] = extra[k]
	return o


func _d_options(lane: Object) -> Dictionary:
	return {"request": REQUEST, "label": "Den", "mdns": lane, "allow_loopback": true}


# -- the approval -----------------------------------------------------------------------------------


func _approve(t: PKeyTestContext, native: bool) -> void:
	var name := "memory" if native else "tcp"
	var lane: Bus = NativeBus.new() if native else Bus.new()
	var m := _device()
	var dev := _device()
	var mh := Host.new()
	var dh := Host.new()
	var started: PKeyResult = await m.api.nearby.on_request(Callable(mh, "on_request"), _m_options(lane))
	var advertised: bool = started.ok and lane.adverts.size() == 1 and m.discovers >= 1 and lane.adverts[0]["advert"]["slot"] == "v"
	if not t.check("%s: on_request starts the advert (slot v, discovery read again first)" % name, advertised, str(started)):
		return
	var app: PKeyPeerNearbyApprover = started.detail
	var asked: PKeyResult = await dev.api.nearby.request(_d_options(lane))
	if not t.check("%s: request browses and lists the approver" % name, asked.ok and asked.detail is PKeyNearbyRequest, str(asked)):
		app.stop()
		return
	var req: PKeyNearbyRequest = asked.detail
	dh.watch(req)
	t.check("%s: D has no listener of its own (it dials out)" % name, dev.api.nearby.live_count() == 1)
	var listed := await _until(func() -> bool: return req.approvers().size() == 1)
	t.check("%s: the approver is listed by its HELLO (no sign-in on D)" % name, listed and req.approvers()[0]["label"] == "Phone", str(req.approvers()))
	var chosen: PKeyResult = await req.choose(str(req.approvers()[0]["id"]))
	t.check("%s: choose answers D's code" % name, chosen.ok and str(chosen.detail["code"]).length() == 7, str(chosen))
	var code := str(chosen.detail["code"])
	var shown := await _until(func() -> bool: return mh.approvals.size() == 1)
	t.check("%s: M shows the prompt" % name, shown)
	if not shown:
		req.close()
		app.stop()
		return
	var ap: PKeyPeerNearbyApprover.Approval = mh.approvals[0]
	t.check("%s: both sides show equal codes (three on M, one is D's)" % name, ap.codes.size() == 3 and ap.codes.has(code), str(ap.codes))
	var live: PKeyPeerNearbyApprover.Live = app._live.values()[0]
	for i in 30:
		await _tree().process_frame
	t.check("%s: M has read no request before the pick" % name, not live.request_done and not live.session.vouch().may_finish() and mh.approves == 0)
	var picked: PKeyResult = await ap.pick(code)
	t.check("%s: the right pick delivers the verified request" % name, picked.ok and picked.detail["device_id"] == D_DEVICE and picked.detail["request"] == REQUEST, str(picked))
	var answer := mh.approve(picked.detail)
	var sent := ap.finish(answer)
	t.check("%s: one approve for the right pick, and approved is sent" % name, mh.approves == 1 and sent.ok and sent.detail == {"sent": "approved"}, str(sent))
	t.check("%s: approved reaches D (display only)" % name, await _until(func() -> bool: return dh.results == ["approved"]), str(dh.results))
	ap.send_record(0x0030, PackedByteArray([7, 8, 9]))
	for i in 30:
		await _tree().process_frame
	t.check("%s: the Sync record is held until confirm_account()" % name, dh.records.is_empty())
	var confirmed := req.confirm_account()
	var released := await _until(func() -> bool: return dh.records.size() == 1)
	t.check("%s: confirm_account() releases it" % name, confirmed.ok and released and dh.records[0][0] == 0x0030)
	req.close()
	app.stop()
	t.check("%s: a stopped request and advert leave nothing live" % name, dev.api.nearby.live_count() == 0 and m.api.nearby.live_count() == 0)


func _refusals(t: PKeyTestContext) -> void:
	var lane := NativeBus.new()
	var m := _device()
	var dev := _device()
	var mh := Host.new()
	var started: PKeyResult = await m.api.nearby.on_request(Callable(mh, "on_request"), _m_options(lane))
	var app: PKeyPeerNearbyApprover = started.detail
	# A wrong pick.
	var dh := Host.new()
	var req: PKeyNearbyRequest = (await dev.api.nearby.request(_d_options(lane))).detail
	dh.watch(req)
	await _until(func() -> bool: return req.approvers().size() == 1)
	var chosen: PKeyResult = await req.choose(str(req.approvers()[0]["id"]))
	await _until(func() -> bool: return mh.approvals.size() == 1)
	var ap: PKeyPeerNearbyApprover.Approval = mh.approvals[0]
	var wrong: String = ap.codes.filter(func(c: String) -> bool: return c != str(chosen.detail["code"]))[0]
	var bad: PKeyResult = await ap.pick(wrong)
	t.check("refusals: a wrong pick fails (mismatch) and calls no route", not bad.ok and bad.detail["reason"] == "mismatch" and mh.approves == 0, str(bad))
	t.check("refusals: D hears peer_bye", await _until(func() -> bool: return not dh.closes.is_empty()) and dh.closes[0] == &"peer_bye", str(dh.closes))
	t.check("refusals: and nothing can be finished", not ap.finish({"http": 200, "body": APPROVED, "discovery_nearby": true}).ok)
	# "None of these match".
	var dh2 := Host.new()
	var req2: PKeyNearbyRequest = (await dev.api.nearby.request(_d_options(lane))).detail
	dh2.watch(req2)
	await _until(func() -> bool: return req2.approvers().size() == 1)
	await req2.choose(str(req2.approvers()[0]["id"]))
	await _until(func() -> bool: return mh.approvals.size() == 2)
	mh.approvals[1].decline()
	t.check("refusals: none of these match closes D's session and calls no route", await _until(func() -> bool: return not dh2.closes.is_empty()) and mh.approves == 0, str(dh2.closes))
	app.stop()
	req.close()
	req2.close()


func _unsupported(t: PKeyTestContext) -> void:
	var host := Host.new()
	var d := _device()
	# The product serves no nearby approval.
	var off := _device(false)
	var r: PKeyResult = await off.api.nearby.on_request(Callable(host, "on_request"), _m_options(Bus.new()))
	t.check("n/a: a product that names no nearby approval answers service-unavailable", not r.ok and r.code == &"service-unavailable" and r.detail["reason"] == "product", str(r))
	r = await off.api.nearby.request(_d_options(Bus.new()))
	t.check("n/a: and so does request", not r.ok and r.code == &"service-unavailable", str(r))
	t.check("n/a: discovery was asked for again", off.discovers == 2)
	# Signed out.
	d.signed = false
	r = await d.api.nearby.on_request(Callable(host, "on_request"), _m_options(Bus.new()))
	t.check("n/a: signed out answers account_required", not r.ok and r.code == &"account_required", str(r))
	d.signed = true
	# Web.
	d.web = true
	r = await d.api.nearby.request({"request": REQUEST})
	t.check("n/a: web answers nearby-unsupported", not r.ok and r.code == &"nearby-unsupported" and r.detail["reason"] == "runtime", str(r))
	r = await d.api.nearby.on_request(Callable(host, "on_request"), {})
	t.check("n/a: and M on web too", not r.ok and r.code == &"nearby-unsupported", str(r))
	d.web = false
	# An older native binding.
	var old := Bus.new()
	old.caps = {"slots": false, "tags": false}
	r = await d.api.nearby.on_request(Callable(host, "on_request"), _m_options(old))
	t.check("n/a: an older binding (no slots) answers nearby-unsupported for M", not r.ok and r.code == &"nearby-unsupported" and old.adverts.is_empty(), str(r))
	r = await d.api.nearby.request(_d_options(old))
	t.check("n/a: and for D", not r.ok and r.code == &"nearby-unsupported", str(r))
	# A querier-only lane cannot be found.
	var asker := Bus.new()
	asker.querier_only = true
	r = await d.api.nearby.on_request(Callable(host, "on_request"), _m_options(asker))
	t.check("n/a: M on a querier-only lane answers nearby-unsupported and leaves no advert", not r.ok and r.code == &"nearby-unsupported" and asker.live_adverts() == 0, str(r))
	# The permission hook: the lane's own refusal is passed on.
	var denied := Bus.new()
	denied.advertise_failure = PKeyConnectErrors.lan("permission_denied", "Local network access was refused.")
	r = await d.api.nearby.on_request(Callable(host, "on_request"), _m_options(denied))
	t.check("n/a: a refused local-network permission answers nearby-permission-denied", not r.ok and r.code == &"nearby-permission-denied", str(r))
	# Bad input.
	r = await d.api.nearby.request({"request": "nr_short", "mdns": Bus.new()})
	t.check("n/a: a bad request handle is refused", not r.ok and r.code == &"invalid-options", str(r))
	r = await d.api.nearby.on_request(Callable(), _m_options(Bus.new()))
	t.check("n/a: a handler that is not callable is refused", not r.ok and r.code == &"invalid-options", str(r))
	t.check("n/a: nothing is left running", d.api.nearby.live_count() == 0)


func _sign_out(t: PKeyTestContext) -> void:
	var lane := NativeBus.new()
	var m := _device()
	var dev := _device()
	var mh := Host.new()
	var started: PKeyResult = await m.api.nearby.on_request(Callable(mh, "on_request"), _m_options(lane))
	var app: PKeyPeerNearbyApprover = started.detail
	var req: PKeyNearbyRequest = (await dev.api.nearby.request(_d_options(lane))).detail
	t.check("sign-out: an advert and a request are live, with Connect never started", m.api.nearby.live_count() == 1 and dev.api.nearby.live_count() == 1 and not m.api.status()["running"])
	# Connect stopping alone does not touch nearby approval.
	m.api.stop()
	t.check("sign-out: cloud_connect.stop() leaves the advert up", app.status()["state"] == "advertising")
	# The step: Connect stops, nearby stops, then the state is forgotten.
	var out := m.api._sign_out_step()
	var down: bool = app.status()["state"] == "stopped" and m.api.nearby.live_count() == 0 and lane.live_adverts() == 0
	t.check("sign-out: the step stops the advert, then forgets the Connect state", out.ok and down and m.client.leaves == 1, str(out))
	t.check("sign-out: and the acceptor is gone", not lane.acceptors.has("v"))
	var out2 := dev.api._sign_out_step()
	t.check("sign-out: a request closes too", out2.ok and req.is_closed() and dev.api.nearby.live_count() == 0)
	t.check("sign-out: it can be run twice", m.api._sign_out_step().ok)
	# The force path drops sockets with no goodbye.
	var lane2 := NativeBus.new()
	var m2 := _device()
	var started2: PKeyResult = await m2.api.nearby.on_request(Callable(mh, "on_request"), _m_options(lane2))
	m2.api.nearby.force_stop()
	t.check("sign-out: force_stop() ends the advert at once", started2.ok and started2.detail.status()["state"] == "stopped" and m2.api.nearby.live_count() == 0)


## A start that a sign-out overtook leaves nothing behind.
func _overtaken(t: PKeyTestContext) -> void:
	var lane := NativeBus.new()
	var m := _device()
	var mh := Host.new()
	var box: Array = []
	var go := func() -> void:
		box.append(await m.api.nearby.on_request(Callable(mh, "on_request"), _m_options(lane)))
	go.call()
	m.api.nearby.stop_all()
	await _until(func() -> bool: return box.size() == 1)
	var r: PKeyResult = box[0] if box.size() == 1 else null
	t.check("overtaken: on_request that a sign-out passed over fails account_required", r != null and not r.ok and r.code == &"account_required", str(r))
	t.check("overtaken: and started no advert", lane.adverts.is_empty() and m.api.nearby.live_count() == 0)
	var dev := _device()
	var box2: Array = []
	var go2 := func() -> void:
		box2.append(await dev.api.nearby.request(_d_options(lane)))
	go2.call()
	dev.api.nearby.stop_all()
	await _until(func() -> bool: return box2.size() == 1)
	var r2: PKeyResult = box2[0] if box2.size() == 1 else null
	t.check("overtaken: request that a sign-out passed over fails closed", r2 != null and not r2.ok and dev.api.nearby.live_count() == 0, str(r2))
