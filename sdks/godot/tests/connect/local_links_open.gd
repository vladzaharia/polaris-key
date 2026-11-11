extends RefCounted
# @pkey-feature connect.local
# Opening a local link (PKeyCloudLocalLinks.open and on_link, CC-29b.G3b; WIRE-CONTRACT-V5 section 15.12, "Mode l") between
# two devices over real loopback TCP and real Noise: the pairing that makes the link, the `m=l` adverts and the shared
# listener, a session each way, a failed dial and its cooldown, Direct Transfer over a mode-l session, `remove` ending an
# open session `peer_revoked`, a gate that goes off ending one `peer_bye`, and a listener that binds nothing while no link
# is held. The helpers (the devices, the fake lane, the clock) are `local_links.gd`'s. No wall clock.

const Base := preload("res://tests/connect/local_links.gd")
const Pairing := preload("res://tests/connect/pairing.gd")

var _b: Base
var _host: Node


class Hub:
	extends RefCounted
	var hub: PKeyCloudTransfer
	var offers: Array = []
	var dest := ""
	var results: Array = []

	func _init(dir: String, p_dest: String) -> void:
		dest = p_dest
		hub = PKeyCloudTransfer.new({"store_dir": func() -> String: return dir, "budget_usec": 0})
		hub.on_offer(Callable(self, "_on_offer"))
		hub.result.connect(func(r: Dictionary) -> void: results.append(r))

	func _on_offer(offer: PKeyTransferOffer) -> void:
		offers.append(offer)
		offer.accept(dest, true)


func run(t: PKeyTestContext) -> void:
	_b = Base.new()
	_host = Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	_b._host = _host
	await _idle(t)
	await _open(t)
	await _transfer(t)
	await _revoke(t)
	await _gate_off(t)
	await _b._frames(20)
	PKeyCloudLocalLinks.reset_budgets()
	_host.queue_free()


## Two devices that have paired: a made the window, b joined. Both hold one link.
func _paired(bus: Pairing.Bus) -> Array:
	PKeyCloudLocalLinks.reset_budgets()
	var a := _b._device(bus)
	var b := _b._device(bus)
	var r: PKeyResult = await a.links.pair(a.pair_options(["docs", "files"], "Anna"))
	if not r.ok or a.codes.is_empty():
		return []
	var holder := {"r": null}
	var run := func() -> void:
		holder["r"] = await b.links.join(
			b.join_options(["docs", "files"], "Bo", a.codes[0]["code"]).merged(
				{"browse_seconds": 15}
			)
		)
	run.call()
	await _b._until(func() -> bool: return a.offers.size() == 1 and b.offers.size() == 1)
	if a.offers.is_empty() or b.offers.is_empty():
		return []
	b.offers[0].confirm()
	a.offers[0].confirm()
	await _b._until(func() -> bool: return holder["r"] != null and a.ended.size() == 1)
	if holder["r"] == null or not holder["r"].ok:
		return []
	await _b._frames(5)
	return [a, b]


func _stop(devs: Array) -> void:
	for d: Base.Dev in devs:
		d.links.stop_all()


func _id_of(d: Base.Dev) -> String:
	return str(_b._held(d)[0]["id"])


# -- a listener that binds nothing -------------------------------------------------------------------


func _idle(t: PKeyTestContext) -> void:
	var bus := Pairing.Bus.new()
	var d := _b._device(bus)
	d.links.on_link(func(_s: PKeyConnectSession) -> void: pass)
	d.links.serve()
	t.check(
		"idle: with no link held nothing is listening or advertised",
		d.links._lan == null and bus.adverts.is_empty()
	)
	d.links._src.store.add(_b._row(10, "Anna"))
	d.links.serve()
	t.check(
		"idle: a held link starts the listener and advertises one m=l name",
		d.links._lan != null and d.links._lan.advert_names().size() == 1 and bus.adverts.size() == 1
	)
	var advert: Dictionary = bus.adverts[0]["advert"]
	t.check(
		"idle: the advert is v=1 and m=l on the listener's port",
		advert["txt"] == ["v=1", "m=l"] and int(advert["port"]) == d.links._lan.port()
	)
	var id := str(_b._held(d)[0]["id"])
	d.links.set_reachable(id, false)
	t.check(
		"idle: a link that is not reachable has no advert",
		d.links._lan != null and d.links._lan.advert_names().is_empty()
	)
	d.links.set_reachable(id, true)
	t.check(
		"idle: reachable again, it is advertised again", d.links._lan.advert_names().size() == 1
	)
	d.links.remove(id)
	t.check("idle: forgetting the last link stops the listener", d.links._lan == null)
	var closed := await d.links.open(id)
	t.check(
		"open: an unknown link is link-unknown",
		not closed.ok and closed.code == PKeyConstants.ErrorCode.LINK_UNKNOWN
	)
	_b._manifest(d.core, false)
	var off := await d.links.open(id)
	t.check(
		"open: with the gate off it is local-pairing-off",
		not off.ok and off.code == PKeyConstants.ErrorCode.LOCAL_PAIRING_OFF
	)
	var web := _b._device(bus, true, true)
	var wr := await web.links.open("x")
	t.check(
		"open: on web it is connect-unavailable",
		not wr.ok and wr.code == PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE
	)
	_stop([d])


# -- opening the link both ways ----------------------------------------------------------------------


func _open(t: PKeyTestContext) -> void:
	var bus := Pairing.Bus.new()
	var devs := await _paired(bus)
	if devs.is_empty():
		t.check("open: the devices pair", false)
		return
	var a: Base.Dev = devs[0]
	var b: Base.Dev = devs[1]
	t.check(
		"open: after the pairing each device listens and advertises its m=l name",
		(
			a.links._lan != null
			and b.links._lan != null
			and a.links._lan.advert_names().size() == 1
			and b.links._lan.advert_names().size() == 1
		)
	)
	var got_a: Array = []
	var got_b: Array = []
	a.links.on_link(func(s: PKeyConnectSession) -> void: got_a.append(s))
	b.links.on_link(func(s: PKeyConnectSession) -> void: got_b.append(s))
	await _b._until(
		func() -> bool: return a.links._lan.seen().size() == 1 and b.links._lan.seen().size() == 1
	)
	t.check(
		"open: each device saw the other's advert",
		a.links._lan.seen() == [_id_of(a)] and b.links._lan.seen() == [_id_of(b)]
	)
	t.check("open: a sighting moved the link's last-seen time", _b._held(a)[0]["last_seen"] != null)
	# b opens the link to a.
	var first: PKeyResult = await b.links.open(_id_of(b))
	await _b._until(func() -> bool: return got_a.size() == 1)
	t.check(
		"open: b opens the link and a's on_link fires with a session",
		first.ok and got_a.size() == 1
	)
	if not first.ok or got_a.is_empty():
		_stop(devs)
		return
	var sb: PKeyConnectSession = first.detail
	var sa: PKeyConnectSession = got_a[0]
	t.check(
		"open: each session names its link, not a device, with the categories both listed",
		(
			sb.local["id"] == _id_of(b)
			and sa.local["id"] == _id_of(a)
			and sb.peer_device_id == ""
			and sb.local["categories"] == ["docs", "files"]
			and sb.local["label"] == "Anna"
			and sa.local["label"] == "Bo"
		)
	)
	t.check(
		"open: the session pinned the peer's link key",
		sb.peer_static.size() == 32 and sb.role == "initiator" and sa.role == "responder"
	)
	var sent: PKeyResult = sb.send("hello".to_utf8_buffer())
	var heard: PKeyResult = await sa.receive()
	t.check(
		"open: a message crosses b to a",
		(
			sent.ok
			and heard.ok
			and (heard.detail["body"] as PackedByteArray).get_string_from_utf8() == "hello"
		)
	)
	var back: PKeyResult = sa.send("hi".to_utf8_buffer())
	var heard_b: PKeyResult = await sb.receive()
	t.check(
		"open: and a to b",
		(
			back.ok
			and heard_b.ok
			and (heard_b.detail["body"] as PackedByteArray).get_string_from_utf8() == "hi"
		)
	)
	var again: PKeyResult = await b.links.open(_id_of(b))
	t.check("open: the link can be opened again", again.ok)
	# a opens the link to b.
	var second: PKeyResult = await a.links.open(_id_of(a))
	await _b._until(func() -> bool: return got_b.size() >= 1)
	t.check("open: a opens the link and b's on_link fires too", second.ok and got_b.size() >= 1)
	# Two callers at once share one dial.
	var holder := [null, null]
	var one := func() -> void: holder[0] = await a.links.open(_id_of(a))
	var two := func() -> void: holder[1] = await a.links.open(_id_of(a))
	one.call()
	two.call()
	await _b._until(func() -> bool: return holder[0] != null and holder[1] != null)
	t.check(
		"open: callers at once get the same session",
		holder[0].ok and holder[1].ok and holder[0].detail == holder[1].detail
	)
	_stop(devs)


# -- a failed dial and its cooldown ------------------------------------------------------------------


func _cooldown(t: PKeyTestContext, a: Base.Dev, b: Base.Dev) -> void:
	# b stops listening; a still sees its advert, dials the old port and is refused.
	var id := _id_of(a)
	b.links.stop_all()
	await _b._frames(3)
	var failed: PKeyResult = await a.links.open(id)
	t.check("cooldown: a dial that reaches nothing fails", not failed.ok)
	var held: PKeyResult = await a.links.open(id)
	t.check(
		"cooldown: it is not repeated at once: busy",
		not held.ok and held.code == PKeyConstants.ErrorCode.RATE_LIMITED
	)
	_b._clock[0] += PKeyCloudLocalLinks.DIAL_BACKOFF_CAP_SECONDS + 1.0
	var later: PKeyResult = await a.links.open(id)
	t.check(
		"cooldown: after the wait it dials again",
		not later.ok and later.code != PKeyConstants.ErrorCode.RATE_LIMITED
	)


# -- Direct Transfer over a mode-l session -----------------------------------------------------------


func _transfer(t: PKeyTestContext) -> void:
	var bus := Pairing.Bus.new()
	var devs := await _paired(bus)
	if devs.is_empty():
		t.check("transfer: the devices pair", false)
		return
	var a: Base.Dev = devs[0]
	var b: Base.Dev = devs[1]
	var dir := "user://local-xfer-%s" % Crypto.new().generate_random_bytes(5).hex_encode()
	DirAccess.make_dir_recursive_absolute(dir)
	var ha := Hub.new(dir.path_join("a"), dir.path_join("a.out"))
	var hb := Hub.new(dir.path_join("b"), dir.path_join("b.out"))
	a.links.adopt = Callable(ha.hub, "attach")
	b.links.adopt = Callable(hb.hub, "attach")
	# The listener reads `adopt` when it starts: start it again with Direct Transfer on.
	a.links._stop_lan()
	b.links._stop_lan()
	a.links.on_link(func(_s: PKeyConnectSession) -> void: pass)
	b.links.on_link(func(_s: PKeyConnectSession) -> void: pass)
	await _b._until(
		func() -> bool: return a.links._lan.seen().size() == 1 and b.links._lan.seen().size() == 1
	)
	var opened: PKeyResult = await a.links.open(_id_of(a))
	if not opened.ok:
		t.check("transfer: the link opens", false)
		_stop(devs)
		return
	var data := PackedByteArray()
	for i in 3000:
		data.append(i % 251)
	var sent: PKeyResult = await ha.hub.send(
		opened.detail, data, {"name": "pic.bin", "category": "docs"}
	)
	await _b._until(func() -> bool: return not hb.results.is_empty() and not ha.results.is_empty())
	t.check(
		"transfer: the offer names a local link",
		(
			sent.ok
			and hb.offers.size() == 1
			and hb.offers[0].from["kind"] == "local"
			and hb.offers[0].from["id"] == _id_of(b)
		)
	)
	t.check(
		"transfer: the file arrives intact over mode l",
		sent.ok and FileAccess.get_file_as_bytes(hb.dest) == data,
		str(hb.results)
	)
	# A category the link does not list is refused before the receiver is asked.
	var bad: PKeyResult = await ha.hub.send(
		opened.detail, data, {"name": "x.bin", "category": "music"}
	)
	await _b._frames(40)
	t.check(
		"transfer: a category the link does not list is not offered",
		bad.ok and hb.offers.size() == 1
	)
	await _cooldown(t, a, b)
	_stop(devs)


# -- remove ends the session peer_revoked ------------------------------------------------------------


func _revoke(t: PKeyTestContext) -> void:
	var bus := Pairing.Bus.new()
	var devs := await _paired(bus)
	if devs.is_empty():
		t.check("revoke: the devices pair", false)
		return
	var a: Base.Dev = devs[0]
	var b: Base.Dev = devs[1]
	var got: Array = []
	a.links.on_link(func(s: PKeyConnectSession) -> void: got.append(s))
	await _b._until(func() -> bool: return b.links._lan.seen().size() == 1)
	var opened: PKeyResult = await b.links.open(_id_of(b))
	await _b._until(func() -> bool: return got.size() == 1)
	if not opened.ok or got.is_empty():
		t.check("revoke: the link opens", false)
		_stop(devs)
		return
	var sb: PKeyConnectSession = opened.detail
	var sa: PKeyConnectSession = got[0]
	var id_a := _id_of(a)
	var removed := a.links.remove(id_a)
	await _b._until(func() -> bool: return sa.is_closed() and sb.is_closed())
	t.check(
		"revoke: remove ends the open session with peer_revoked",
		removed.ok and sa.closed_info()["code"] == PKeyPeerSession.PEER_REVOKED
	)
	t.check(
		"revoke: the peer hears it",
		(
			sb.is_closed()
			and sb.closed_info()["code"] == PKeyPeerSession.PEER_REVOKED
			and sb.closed_info()["by_peer"]
		)
	)
	t.check(
		"revoke: a forgot the link and stopped listening",
		_b._held(a).is_empty() and a.links._lan == null
	)
	var retry: PKeyResult = await b.links.open(_id_of(b))
	t.check("revoke: a dial under the forgotten link is not admitted", not retry.ok)
	_stop(devs)


# -- the gate going off ------------------------------------------------------------------------------


func _gate_off(t: PKeyTestContext) -> void:
	var bus := Pairing.Bus.new()
	var devs := await _paired(bus)
	if devs.is_empty():
		t.check("gate: the devices pair", false)
		return
	var a: Base.Dev = devs[0]
	var b: Base.Dev = devs[1]
	var got: Array = []
	a.links.on_link(func(s: PKeyConnectSession) -> void: got.append(s))
	await _b._until(func() -> bool: return b.links._lan.seen().size() == 1)
	var opened: PKeyResult = await b.links.open(_id_of(b))
	await _b._until(func() -> bool: return got.size() == 1)
	if not opened.ok or got.is_empty():
		t.check("gate: the link opens", false)
		_stop(devs)
		return
	var sb: PKeyConnectSession = opened.detail
	var sa: PKeyConnectSession = got[0]
	var live_adverts := bus.adverts.filter(
		func(e: Dictionary) -> bool:
			return e["handle"].stops == 0 and (e["advert"]["txt"] as Array).has("m=l")
	)
	t.check("gate: both devices advertise m=l before", live_adverts.size() == 2)
	_b._manifest(a.core, false)
	a.core.discovery_changed.emit()
	await _b._until(func() -> bool: return sa.is_closed() and sb.is_closed())
	t.check(
		"gate: the session ends with peer_bye",
		(
			sa.closed_info()["code"] == PKeyPeerSession.PEER_BYE
			and sb.closed_info()["code"] == PKeyPeerSession.PEER_BYE
		)
	)
	t.check(
		"gate: a's m=l advert is withdrawn and it listens no more",
		a.links._lan == null and a.links._src.store.count().detail == 1
	)
	var closed_off: PKeyResult = await b.links.open(_id_of(b))
	t.check("gate: a dial to a device that turned it off fails", not closed_off.ok)
	var refused: PKeyResult = await a.links.open(_id_of(a))
	t.check(
		"gate: open on the device with the gate off is local-pairing-off",
		refused.code == PKeyConstants.ErrorCode.LOCAL_PAIRING_OFF
	)
	_b._manifest(a.core, true)
	a.core.discovery_changed.emit()
	t.check("gate: it listens again when the gate comes back", a.links._lan != null)
	_stop(devs)
