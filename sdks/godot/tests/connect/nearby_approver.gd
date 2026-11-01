extends RefCounted
# @pkey-feature identity.nearby
# The approver side of nearby approval (PKeyPeerNearbyApprover, CC-15b.G2a; WIRE-CONTRACT-V5 sections 15.4 and
# 15.6.1), ported from sdk-node's `nearbyApprover` tests: a fake discovery lane (a native-style one whose pipes
# arrive through an acceptor, and a TCP one with a listener), memory pipes and loopback TCP, and a device D built
# from the same engine. The advert (slot v, a new instance and listener at every listen), the conditions it stands
# on, the codes, the pick before any verification, the answer table, the records after `approved`, the failure
# budget, the one prompt at a time, the notice with the prompt closed, and the shared accept gate.

const SLUG := "djdl"
const D_DEVICE := "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
const REQUEST := "nr_CCCCCCCCCCCCCCCCCCCCCC"
const APPROVED := '{"status":"approved"}'

var _re: RegEx
var _keys: PKeyDeviceKeyStore


func run(t: PKeyTestContext) -> void:
	_re = RegEx.create_from_string("^p1-[a-z2-7]{16}$")
	_keys = PKeyDeviceKeyStore.memory_only()
	_start_rules(t)
	await _advert_and_renewal(t)
	await _approve_flow(t)
	await _wrong_pick_and_budget(t)
	await _answer_table(t)
	await _prompt_rules(t)
	await _lifecycle(t)
	await _tcp_gate(t)
	await _request_wait(t)


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _pump() -> PKeyPeerPump:
	return PKeyPeerPump.new(_tree(), false)


## Wait until `cond` holds (at most `frames` frames), stepping every D side each frame.
func _until(cond: Callable, sides: Array = [], frames := 900) -> bool:
	for i in frames:
		if cond.call():
			return true
		for d: DSide in sides:
			d.step()
		await _tree().process_frame
	return cond.call()


# -- doubles ----------------------------------------------------------------------------------------


class Env extends RefCounted:
	var signed := true
	var served := true
	var now_value := 1700001000
	var reads := 0


	func now() -> int:
		return now_value


	func signed_in() -> bool:
		reads += 1
		return signed


	func nearby_served() -> bool:
		reads += 1
		return served


	func source() -> PKeyPeerNearbyApprover.Source:
		var s := PKeyPeerNearbyApprover.Source.new()
		s.slug = SLUG
		s.now = Callable(self, "now")
		s.signed_in = Callable(self, "signed_in")
		s.nearby_served = Callable(self, "nearby_served")
		return s


class Host extends RefCounted:
	var approvals: Array = []
	var notices: Array = []
	var stops: Array = []


	func on_request(a: PKeyPeerNearbyApprover.Approval) -> void:
		approvals.append(a)


	func watch(app: PKeyPeerNearbyApprover) -> void:
		app.notice.connect(func(n: Dictionary) -> void: notices.append(n))
		app.stopped.connect(func(why: String) -> void: stops.append(why))


class FakeHandle extends RefCounted:
	var stops := 0
	var updates := 0


	func stop() -> void:
		stops += 1


	func update(_instance: String, _txt: Array) -> bool:
		updates += 1
		return true


## A discovery lane that accepts pipes through an acceptor (the Apple slot listener).
class NativeLane extends RefCounted:
	var slots := true
	var querier_only := false
	var adverts: Array = []
	var acceptors: Dictionary = {}


	func capabilities() -> Dictionary:
		return {"slots": slots, "tags": slots}


	func status() -> Dictionary:
		return {"active": true, "responder": not querier_only, "querier": true, "reason": "querier_only" if querier_only else ""}


	func advertise(a: Dictionary) -> PKeyResult:
		var h := FakeHandle.new()
		adverts.append({"advert": a, "handle": h})
		return PKeyResult.success(h)


	func set_acceptor(slot: Variant, fn := Callable()) -> void:
		if fn.is_valid():
			acceptors[str(slot)] = fn
		else:
			acceptors.erase(str(slot))


	## D dials: the far end goes to the acceptor of slot v.
	func dial() -> PKeyPeerPipe:
		var ends := PKeyPeerMemoryPipe.pair()
		var acceptor: Callable = acceptors.get("v", Callable())
		if acceptor.is_valid():
			acceptor.call(ends[1])
		return ends[0]


	func last() -> Dictionary:
		return adverts[adverts.size() - 1]


## A lane with no acceptor: the approver listens on a TCP port of its own and advertises it.
class TcpLane extends RefCounted:
	var adverts: Array = []


	func advertise(a: Dictionary) -> PKeyResult:
		var h := FakeHandle.new()
		adverts.append({"advert": a, "handle": h})
		return PKeyResult.success(h)


## The device with no sign-in: a mode v initiator that shows its code, confirms it and sends its request.
class DSide extends RefCounted:
	var link: PKeyPeerLink
	var pump: PKeyPeerPump
	var keys: PKeyDeviceKeyStore
	var display := ""
	var records: Array = []
	var closes: Array = []
	var send_request := true
	var _acted := false
	var _code := -1


	func connect_to(pipe: PKeyPeerPipe, p_pump: PKeyPeerPump, store: PKeyDeviceKeyStore, label := "Den") -> void:
		keys = store
		pump = p_pump
		var lr := PKeyPeerLink.create(pipe, {
			"mode": "v", "role": "initiator", "slug": SLUG, "static_key": Crypto.new().generate_random_bytes(32), "caps": [],
			"hello": {"label": label, "platform": "test", "app": SLUG},
		}, {"pump": p_pump})
		link = lr.detail
		link.sas.connect(func(code: int, text: String) -> void:
			_code = code
			display = text)
		link.record.connect(func(type: int, body: PackedByteArray) -> void: records.append([type, body]))
		link.closed.connect(func(code: StringName, by_peer: bool) -> void: closes.append([code, by_peer]))
		p_pump.add(link)
		link.start()


	## Once a frame: show the code, confirm it and send the request (outside the session's own step).
	func step() -> void:
		if _acted or _code < 0 or link == null or link.is_ended():
			return
		_acted = true
		link.session.vouch().shown()
		link.session.confirm_sas()
		if not send_request:
			return
		var built := PKeyPeerVouch.build_request({
			"port": keys, "slug": SLUG, "h": link.session.handshake_hash(), "request": REQUEST, "device_id": D_DEVICE,
			"hello": {"label": "Den", "platform": "test"},
		})
		if built.ok:
			link.send_record(PKeyPeerRecord.VOUCH_REQ, built.detail)


	func got(type: int) -> bool:
		return records.any(func(r: Array) -> bool: return r[0] == type)


# -- helpers ----------------------------------------------------------------------------------------


func _approver(env: Env, host: Host, lane: Object, extra := {}) -> PKeyResult:
	var o := {"mdns": lane, "prompt": true, "label": "Phone", "pump": _pump(), "tree": _tree(), "timer": Callable(), "allow_loopback": true}
	for k in extra:
		o[k] = extra[k]
	var r := PKeyPeerNearbyApprover.start(env.source(), Callable(host, "on_request"), o)
	if r.ok:
		host.watch(r.detail)
	return r


func _dial(lane: NativeLane, sides: Array, send_request := true) -> DSide:
	var d := DSide.new()
	d.send_request = send_request
	sides.append(d)
	d.connect_to(lane.dial(), _pump(), _keys)
	return d


# -- start ------------------------------------------------------------------------------------------


func _start_rules(t: PKeyTestContext) -> void:
	var env := Env.new()
	var host := Host.new()
	var none := PKeyPeerNearbyApprover.start(env.source(), Callable(host, "on_request"), {"mdns": NativeLane.new(), "prompt": false})
	t.check("start: no prompt and no background approval is refused", not none.ok and none.code == &"invalid-options", str(none))
	var bad := PKeyPeerNearbyApprover.start(PKeyPeerNearbyApprover.Source.new(), Callable(host, "on_request"), {"mdns": NativeLane.new(), "prompt": true})
	t.check("start: a source with no slug or reads is refused", not bad.ok and bad.code == &"invalid-options")
	var old := NativeLane.new()
	old.slots = false
	var r := _approver(env, host, old)
	t.check("start: an older binding with no slots answers nearby-unsupported and advertises nothing", not r.ok and r.code == &"nearby-unsupported" and old.adverts.is_empty(), str(r))
	var asker := NativeLane.new()
	asker.querier_only = true
	r = _approver(env, host, asker)
	t.check("start: a querier-only lane answers nearby-unsupported and leaves no advert", not r.ok and r.code == &"nearby-unsupported" \
			and asker.adverts.size() == 1 and (asker.adverts[0]["handle"] as FakeHandle).stops == 1, str(r))
	var bg := _approver(env, host, NativeLane.new(), {"prompt": false, "background": true})
	t.check("start: background approval stands with the prompt closed", bg.ok and bg.detail.status()["state"] == "advertising")
	if bg.ok:
		bg.detail.stop()


# -- the advert -------------------------------------------------------------------------------------


func _advert_and_renewal(t: PKeyTestContext) -> void:
	var env := Env.new()
	var host := Host.new()
	var lane := NativeLane.new()
	var timers: Array = []
	var r := _approver(env, host, lane, {"timer": func(seconds: float, fn: Callable) -> void: timers.append([seconds, fn])})
	if not t.check("advert: the approver starts on a native lane", r.ok and lane.adverts.size() == 1, str(r)):
		return
	var app: PKeyPeerNearbyApprover = r.detail
	var a: Dictionary = lane.adverts[0]["advert"]
	var tag := PKeyPeerAdvert.product_tag(SLUG, PKeyPeerAdvert.advert_epoch(env.now()))
	t.check("advert: slot v, a random p1- instance, TXT v=1, m=v and the product tag", a["slot"] == "v" and _re.search(str(a["instance"])) != null and a["txt"] == ["v=1", "m=v", "h=" + tag], str(a))
	t.check("advert: a native lane's pipes come through the acceptor, with no port given", lane.acceptors.has("v") and not a.has("port"))
	t.check("advert: the renewal is set for 300 s", timers.size() == 1 and is_equal_approx(float(timers[0][0]), 300.0))
	# The renewal reads sign-in and discovery again, then moves to a new instance (and, natively, a new listener).
	var first := str(a["instance"])
	env.reads = 0
	(timers[0][1] as Callable).call()
	await _until(func() -> bool: return lane.adverts.size() == 2)
	t.check("renewal: sign-in and discovery were read again", env.reads == 2)
	t.check("renewal: a new instance replaced the old, and the old advert stopped", lane.adverts.size() == 2 \
			and str(lane.last()["advert"]["instance"]) != first and (lane.adverts[0]["handle"] as FakeHandle).stops == 1)
	t.check("renewal: and the clock was set again", timers.size() == 2)
	# Signed out at the next renewal: the advert stops for good and the host hears why.
	env.signed = false
	(timers[1][1] as Callable).call()
	await _until(func() -> bool: return host.stops.size() == 1)
	t.check("renewal: a sign-out stops the advert for good", host.stops == ["signed-out"] and app.status()["state"] == "stopped" and (lane.last()["handle"] as FakeHandle).stops == 1, str(host.stops))
	t.check("renewal: and the acceptor is gone", not lane.acceptors.has("v"))
	await app.resume()
	t.check("renewal: nothing brings a sign-out back", app.status()["state"] == "stopped")

	# Discovery losing `nearby` at a renewal stops it too.
	env = Env.new()
	host = Host.new()
	lane = NativeLane.new()
	timers = []
	r = _approver(env, host, lane, {"timer": func(seconds: float, fn: Callable) -> void: timers.append([seconds, fn])})
	env.served = false
	(timers[0][1] as Callable).call()
	await _until(func() -> bool: return host.stops.size() == 1)
	t.check("renewal: discovery losing nearby stops it", host.stops == ["discovery"] and r.detail.status()["reason"] == "discovery")

	# A TCP lane gets a listener of its own, with a new port at each listen.
	env = Env.new()
	host = Host.new()
	var tcp := TcpLane.new()
	timers = []
	r = _approver(env, host, tcp, {"timer": func(seconds: float, fn: Callable) -> void: timers.append([seconds, fn])})
	if not t.check("tcp: the approver starts with a listener", r.ok and tcp.adverts.size() == 1 and int(tcp.adverts[0]["advert"]["port"]) > 0, str(r)):
		return
	var port := int(tcp.adverts[0]["advert"]["port"])
	t.check("tcp: the advert names the listener's port", port == r.detail.port())
	(timers[0][1] as Callable).call()
	await _until(func() -> bool: return tcp.adverts.size() == 2)
	var port2 := int(tcp.adverts[1]["advert"]["port"])
	t.check("tcp: the renewal opens a new listener under a new instance", tcp.adverts.size() == 2 and port2 > 0 and port2 != port \
			and tcp.adverts[1]["advert"]["instance"] != tcp.adverts[0]["advert"]["instance"])
	t.check("tcp: and the old listener is closed", (tcp.adverts[0]["handle"] as FakeHandle).stops == 1 and _free(port))
	r.detail.stop()


## Is `port` free to listen on again (its listener is closed)?
func _free(port: int) -> bool:
	var probe := TCPServer.new()
	var ok := probe.listen(port, "*") == OK or probe.listen(port, "127.0.0.1") == OK
	probe.stop()
	return ok


# -- the approval -----------------------------------------------------------------------------------


func _approve_flow(t: PKeyTestContext) -> void:
	var env := Env.new()
	var host := Host.new()
	var lane := NativeLane.new()
	var pump := PKeyPeerPump.new(_tree(), true)
	var r := _approver(env, host, lane, {"pump": pump})
	var app: PKeyPeerNearbyApprover = r.detail
	var sides: Array = []
	var d := _dial(lane, sides)
	if not t.check("flow: the prompt shows", await _until(func() -> bool: return host.approvals.size() == 1 and d.display != "", sides)):
		app.stop()
		return
	var ap: PKeyPeerNearbyApprover.Approval = host.approvals[0]
	t.check("flow: three distinct codes and one is the code D shows", ap.codes.size() == 3 and ap.codes.has(d.display) \
			and ap.codes[0] != ap.codes[1] and ap.codes[1] != ap.codes[2] and ap.codes[0] != ap.codes[2], str(ap.codes))
	t.check("flow: D's label and platform are shown as D sent them", ap.label == "Den" and ap.platform == "test")
	# D's request is held until the pick: nothing was verified and nothing may be finished.
	await _until(func() -> bool: return d.link.session.is_open() == false and d.link.is_established(), sides, 20)
	var live: PKeyPeerNearbyApprover.Live = app._live.values()[0]
	t.check("flow: the request is not read before the pick", not live.request_done and not live.session.vouch().may_finish())
	var early := ap.finish({"http": 200, "body": APPROVED, "discovery_nearby": true})
	t.check("flow: finish before the pick is refused and sends nothing", not early.ok and early.detail["reason"] == "not_picked" and not d.got(PKeyPeerRecord.VOUCH_RESULT))
	var early_send := ap.send_record(0x0030, PackedByteArray([1]))
	t.check("flow: a Sync record before approved is refused", not early_send.ok)
	var picked: PKeyResult = await ap.pick(d.display)
	t.check("flow: the right pick delivers the verified request", picked.ok and picked.detail["device_id"] == D_DEVICE \
			and picked.detail["request"] == REQUEST and picked.detail["label"] == "Den" and picked.detail["platform"] == "test", str(picked))
	t.check("flow: the check of the signature ran through the pump's offload", pump.tasks_run + pump.inline_run > 0, "%d %d" % [pump.tasks_run, pump.inline_run])
	t.check("flow: the pick opens the way to finish", live.session.vouch().may_finish())
	var again: PKeyResult = await ap.pick(d.display)
	t.check("flow: a second pick answers the first one's result", again.ok and again.detail["device_id"] == D_DEVICE)
	var sent := ap.finish({"http": 200, "body": APPROVED, "discovery_nearby": true})
	t.check("flow: approved goes to D", sent.ok and sent.detail == {"sent": "approved"}, str(sent))
	await _until(func() -> bool: return d.got(PKeyPeerRecord.VOUCH_RESULT), sides)
	var result_body: PackedByteArray = d.records.filter(func(x: Array) -> bool: return x[0] == PKeyPeerRecord.VOUCH_RESULT)[0][1]
	t.check("flow: and reads approved", PKeyPeerVouch.parse_result(result_body) == {"status": "approved"})
	var second := ap.finish({"http": 200, "body": APPROVED, "discovery_nearby": true})
	t.check("flow: the answer is final", not second.ok)
	t.check("flow: the session stays open for records after approved", not ap.is_closed())
	var wrap := ap.send_record(0x0030, PackedByteArray([1, 2, 3]))
	t.check("flow: a Sync record goes out after approved", wrap.ok, str(wrap))
	var odd := ap.send_record(0x0100, PackedByteArray([1]))
	t.check("flow: only 0x0030 to 0x003F are the host's to send", not odd.ok and odd.detail["reason"] == "bad_type")
	for i in 30:
		await _tree().process_frame
		d.step()
	t.check("flow: D holds the record until its person confirms the account", not d.got(0x0030))
	d.link.session.vouch().confirm_account()
	t.check("flow: and has it after", d.got(0x0030))
	ap.close()
	await _until(func() -> bool: return ap.is_closed() and not d.closes.is_empty(), sides)
	t.check("flow: the host's close ends the session peer_bye", ap.close_code() == &"peer_bye" and d.closes[0] == [&"peer_bye", true], str(d.closes))
	t.check("flow: a finished approval is no failure", app.status()["state"] == "advertising" and host.stops.is_empty())
	app.stop()


func _wrong_pick_and_budget(t: PKeyTestContext) -> void:
	var env := Env.new()
	var host := Host.new()
	var lane := NativeLane.new()
	var r := _approver(env, host, lane)
	var app: PKeyPeerNearbyApprover = r.detail
	var sides: Array = []
	var d := _dial(lane, sides)
	await _until(func() -> bool: return host.approvals.size() == 1, sides)
	var ap: PKeyPeerNearbyApprover.Approval = host.approvals[0]
	var wrong: String = ap.codes.filter(func(c: String) -> bool: return c != d.display)[0]
	var bad: PKeyResult = await ap.pick(wrong)
	t.check("wrong pick: it fails with reason mismatch", not bad.ok and bad.detail["reason"] == "mismatch", str(bad))
	await _until(func() -> bool: return not d.closes.is_empty(), sides)
	t.check("wrong pick: D is told peer_bye and the session is down", d.closes[0] == [&"peer_bye", true] and ap.is_closed())
	t.check("wrong pick: no request was ever delivered and no answer can be sent", not ap.finish({"http": 200, "body": APPROVED, "discovery_nearby": true}).ok)
	t.check("wrong pick: one failure leaves the advert up", app.status()["state"] == "advertising")
	# A second prompted failure in the window (here: "None of these match") stops the advert.
	var d2 := _dial(lane, sides)
	await _until(func() -> bool: return host.approvals.size() == 2 and d2.display != "", sides)
	host.approvals[1].decline()
	await _until(func() -> bool: return host.stops.size() == 1, sides)
	t.check("budget: the second failure stops the advert", host.stops == ["budget"] and app.status()["state"] == "stopped" and app.status()["reason"] == "budget", str(host.stops))
	t.check("budget: and the advert handle was stopped", (lane.last()["handle"] as FakeHandle).stops == 1)
	await app.resume()
	t.check("budget: resume() does not clear it", app.status()["state"] == "stopped")
	await app.set_prompt(false)
	await app.set_prompt(true)
	t.check("budget: opening the prompt again does (a budget stop is not final)", app.status()["state"] == "advertising" and lane.adverts.size() == 2)
	app.stop()
	d.link.destroy()


func _answer_table(t: PKeyTestContext) -> void:
	var env := Env.new()
	var host := Host.new()
	var lane := NativeLane.new()
	var app: PKeyPeerNearbyApprover = _approver(env, host, lane).detail
	var sides: Array = []
	var d := _dial(lane, sides)
	await _until(func() -> bool: return host.approvals.size() == 1, sides)
	var ap: PKeyPeerNearbyApprover.Approval = host.approvals[0]
	var picked: PKeyResult = await ap.pick(d.display.replace(" ", ""))
	t.check("answers: a code without the space is read", picked.ok)
	var choose := ap.finish({"http": 409, "body": '{"code":"license_choice_required"}', "discovery_nearby": true})
	t.check("answers: a licence choice waits, and sends nothing", choose.ok and choose.detail == {"wait": "choice"} and not d.got(PKeyPeerRecord.VOUCH_RESULT))
	var keys := ap.finish({"http": 409, "body": '{"code":"device_keys_required"}', "discovery_nearby": true})
	t.check("answers: the keys are asked for once", keys.ok and keys.detail == {"wait": "keys"})
	var again := ap.finish({"http": 409, "body": '{"code":"device_keys_required"}', "discovery_nearby": true})
	t.check("answers: and the second time the session closes", again.ok and again.detail == {"closed": true})
	await _until(func() -> bool: return ap.is_closed(), sides)
	t.check("answers: a closed session cannot be finished again", not ap.finish({"http": 204, "body": null, "discovery_nearby": true}).ok)
	app.stop()

	# denied, expired, and the 404 that is ambiguous.
	for row: Array in [[204, null, true, "denied"], [403, '{"code":"not_nearby"}', true, "denied"], [404, null, true, "expired"]]:
		host = Host.new()
		lane = NativeLane.new()
		app = _approver(env, host, lane).detail
		sides = []
		d = _dial(lane, sides)
		await _until(func() -> bool: return host.approvals.size() == 1, sides)
		ap = host.approvals[0]
		await ap.pick(d.display)
		var got := ap.finish({"http": row[0], "body": row[1], "discovery_nearby": row[2]})
		t.check("answers: %s with %s sends %s" % [row[0], row[1], row[3]], got.ok and got.detail == {"sent": row[3]}, str(got))
		await _until(func() -> bool: return d.got(PKeyPeerRecord.VOUCH_RESULT) and ap.is_closed(), sides)
		t.check("answers: and the session ends after a result that is not approved (%s)" % row[3], ap.is_closed())
		app.stop()
	# A 404 with discovery no longer naming nearby stops the advert.
	host = Host.new()
	lane = NativeLane.new()
	app = _approver(env, host, lane).detail
	sides = []
	d = _dial(lane, sides)
	await _until(func() -> bool: return host.approvals.size() == 1, sides)
	ap = host.approvals[0]
	await ap.pick(d.display)
	var gone := ap.finish({"http": 404, "body": null, "discovery_nearby": false})
	t.check("answers: a 404 once discovery lost nearby closes and stops the advert", gone.ok and gone.detail == {"closed": true} \
			and app.status()["reason"] == "discovery" and host.stops == ["discovery"], str(host.stops))


# -- the prompt -------------------------------------------------------------------------------------


func _prompt_rules(t: PKeyTestContext) -> void:
	var env := Env.new()
	var host := Host.new()
	var lane := NativeLane.new()
	var app: PKeyPeerNearbyApprover = _approver(env, host, lane, {"prompt": false, "background": true}).detail
	var sides: Array = []
	var d := _dial(lane, sides)
	await _until(func() -> bool: return host.notices.size() == 1, sides)
	t.check("prompt: with the screen closed a session only raises a notice", host.approvals.is_empty() and host.notices == [{"label": "Den", "platform": "test"}], str(host.notices))
	await app.set_prompt(true)
	t.check("prompt: opening the screen shows the waiting session", host.approvals.size() == 1)
	# One prompt at a time: a second session waits with no code shown.
	var d2 := _dial(lane, sides)
	for i in 120:
		await _tree().process_frame
		d2.step()
	t.check("prompt: a second session waits while one is shown", host.approvals.size() == 1 and d2.display != "")
	await app.set_prompt(false)
	t.check("prompt: closing the screen ends the prompt that was showing (and counts for nothing)", host.approvals[0].is_closed() and host.stops.is_empty())
	# Without `background`, closing the screen pauses the advert.
	app.stop()
	host = Host.new()
	lane = NativeLane.new()
	app = _approver(env, host, lane).detail
	await app.set_prompt(false)
	t.check("prompt: without background approval a closed screen pauses the advert", app.status()["state"] == "paused" and (lane.last()["handle"] as FakeHandle).stops == 1)
	await app.set_prompt(true)
	t.check("prompt: and opening it starts it again, under a new instance", app.status()["state"] == "advertising" and lane.adverts.size() == 2)
	app.stop()
	d.link.destroy()
	d2.link.destroy()


func _lifecycle(t: PKeyTestContext) -> void:
	var env := Env.new()
	var host := Host.new()
	var lane := NativeLane.new()
	var app: PKeyPeerNearbyApprover = _approver(env, host, lane).detail
	var sides: Array = []
	var d := _dial(lane, sides)
	await _until(func() -> bool: return host.approvals.size() == 1, sides)
	app.pause()
	t.check("pause: the advert stops and the acceptor goes", app.status()["state"] == "paused" and (lane.last()["handle"] as FakeHandle).stops == 1 and not lane.acceptors.has("v"))
	t.check("pause: and the live session is closed", host.approvals[0].is_closed() or app.session_count() == 0)
	await _until(func() -> bool: return not d.closes.is_empty(), sides)
	t.check("pause: D sees peer_bye", d.closes[0][0] == &"peer_bye")
	t.check("pause: the host's own pause raises no stopped", host.stops.is_empty())
	env.signed = false
	await app.resume()
	t.check("resume: reads sign-in first, and a sign-out stops it for good", app.status()["state"] == "stopped" and app.status()["reason"] == "signed-out")
	app.stop()

	env = Env.new()
	host = Host.new()
	lane = NativeLane.new()
	app = _approver(env, host, lane).detail
	app.pause()
	await app.resume()
	t.check("resume: after the host's own pause it advertises again, under a new instance", app.status()["state"] == "advertising" and lane.adverts.size() == 2 and lane.acceptors.has("v"))
	app.stop()
	await app.resume()
	t.check("stop: is final", app.status()["state"] == "stopped" and lane.adverts.size() == 2)
	app.pause()
	t.check("stop: and pause does nothing after it", app.status()["state"] == "stopped")
	d.link.destroy()


# -- the shared accept gate -------------------------------------------------------------------------


func _tcp_gate(t: PKeyTestContext) -> void:
	var env := Env.new()
	var host := Host.new()
	var tcp := TcpLane.new()
	var r := _approver(env, host, tcp)
	if not t.check("tcp session: the approver starts", r.ok):
		return
	var app: PKeyPeerNearbyApprover = r.detail
	var port := app.port()
	var sides: Array = []
	var d := DSide.new()
	sides.append(d)
	d.connect_to(PKeyPeerTcpPipe.dial("127.0.0.1", port), _pump(), _keys)
	await _until(func() -> bool: return host.approvals.size() == 1, sides)
	t.check("tcp session: a session over a real socket reaches the prompt", host.approvals.size() == 1 and host.approvals[0].codes.has(d.display))
	# One waiting session per source address (rule 2): a second socket from 127.0.0.1 is closed.
	var extra := StreamPeerTCP.new()
	extra.connect_to_host("127.0.0.1", port)
	var closed := false
	for i in 120:
		await _tree().process_frame
		d.step()
		extra.poll()
		if extra.get_status() == StreamPeerTCP.STATUS_ERROR or extra.get_status() == StreamPeerTCP.STATUS_NONE:
			closed = true
			break
		if extra.get_status() == StreamPeerTCP.STATUS_CONNECTED and extra.get_available_bytes() == 0:
			# Accepted by the kernel; the gate closes it on its next frame.
			continue
	t.check("tcp session: a second pending socket from the same address is refused by the gate", closed or app.session_count() == 1, str(app.session_count()))
	t.check("tcp session: and only the first session is live", app.session_count() == 1)
	extra.disconnect_from_host()
	# The first completes (its slot is given back on the pick).
	var picked: PKeyResult = await host.approvals[0].pick(d.display)
	t.check("tcp session: the pick over TCP verifies the request", picked.ok and picked.detail["device_id"] == D_DEVICE, str(picked))
	app.stop()
	await _until(func() -> bool: return not d.closes.is_empty(), sides)
	t.check("tcp session: stop() closes the session and the listener", app.session_count() == 0 and _free(port))
	d.link.destroy()


func _request_wait(t: PKeyTestContext) -> void:
	var env := Env.new()
	var host := Host.new()
	var lane := NativeLane.new()
	var app: PKeyPeerNearbyApprover = _approver(env, host, lane, {"request_wait_seconds": 0.3}).detail
	var sides: Array = []
	var d := _dial(lane, sides, false)
	await _until(func() -> bool: return host.approvals.size() == 1, sides)
	var ap: PKeyPeerNearbyApprover.Approval = host.approvals[0]
	var got: PKeyResult = await ap.pick(d.display)
	t.check("wait: a request that never comes ends the session and fails the pick", not got.ok and ap.is_closed(), str(got))
	await _until(func() -> bool: return not d.closes.is_empty(), sides)
	t.check("wait: D is told peer_timeout", d.closes[0][0] == &"peer_timeout", str(d.closes))
	app.stop()
	d.link.destroy()
