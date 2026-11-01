extends RefCounted
# @pkey-feature connect.transfer
# Direct Transfer end to end (CC-20b.G3; WIRE-CONTRACT-V5 section 15.11): `PKeyCloudTransfer` over two
# real sessions. First over the in-memory pipe, two links under one pump (inline and on worker threads):
# delivery, a decline (no handler, the handler, an unusable destination), a cancel mid-stream, a quota
# refusal, `busy` on a fifth transfer, resume after a dropped session, a re-offer of delivered content,
# the records the session routes to the transfer layer only, and the purges. Then through `PKeyCloudConnect`
# over the fake relay room: send by device id, the capability and the inbound session kept for a handler.

const CC := preload("res://tests/connect/cloud_connect.gd")
const ID_A := "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
const ID_B := "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
const XID := "D9FghtxWIhxlaxzwysyg4w"

var _pair: Dictionary
var _disc := PackedByteArray()
var _root := ""
var _n := 0
var _host: Node


## One hub with what it saw.
class Half extends RefCounted:
	var hub: PKeyCloudTransfer
	var results: Array = []
	var offers: Array = []
	var dest := ""
	var overwrite := false
	var mode := "accept"
	var dir := ""


	func _init(p_dir: String, quota := -1, pump: PKeyPeerPump = null) -> void:
		dir = p_dir
		var o := {"store_dir": func() -> String: return p_dir.path_join("transfers"), "budget_usec": 0}
		if quota >= 0:
			o["quota"] = quota
		if pump != null:
			o["offload"] = Callable(pump, "offload")
		hub = PKeyCloudTransfer.new(o)
		hub.result.connect(func(r: Dictionary) -> void: results.append(r))


	func listen() -> void:
		hub.on_offer(Callable(self, "_on_offer"))


	func _on_offer(offer: PKeyTransferOffer) -> void:
		offers.append(offer)
		if mode == "accept":
			offer.accept(dest, overwrite)
		elif mode == "decline":
			offer.decline()


## Two sessions over a memory pipe pair.
class Rig extends RefCounted:
	var sa: PKeyConnectSession
	var sb: PKeyConnectSession
	var keep: Array = []


func run(t: PKeyTestContext) -> void:
	_pair = PKeyTestPeers.pair(1)
	_disc = PKeyTestPeers.random32()
	_root = "user://xfer-e2e-%s" % Crypto.new().generate_random_bytes(5).hex_encode()
	DirAccess.make_dir_recursive_absolute(_root)
	_host = Node.new()
	_tree().root.add_child(_host)
	await _delivery(t, false)
	await _delivery(t, true)
	await _declines(t)
	await _cancel(t)
	await _quota_and_busy(t)
	await _resume(t)
	await _delivered_again(t)
	await _routing(t)
	await _purges(t)
	await _relay(t)
	_host.queue_free()
	_rm_tree(_root)


# helpers

func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _frames(n: int) -> void:
	for i in n:
		await _tree().process_frame


func _until(cond: Callable, frames := 1500) -> bool:
	var n := 0
	while n < frames and not cond.call():
		await _tree().process_frame
		n += 1
	return cond.call()


func _dir() -> String:
	_n += 1
	var d := _root.path_join("d%d" % _n)
	DirAccess.make_dir_recursive_absolute(d)
	return d


func _bytes(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	for i in n:
		b[i] = (i * 31 + 7) & 0xFF
	return b


func _account_opts(role: String, d: Dictionary, holder: PKeyTestPeers.Peer, caps: Array) -> Dictionary:
	return {
		"mode": "a", "role": role, "slug": PKeyTestPeers.SLUG, "static_key": d["priv"], "caps": caps,
		"hello": {"platform": "test", "app": "demo", "label": "Den"}, "now": Callable(holder, "now"), "mono": Callable(holder, "mono"),
		"account": PKeyTestPeers.account(d, holder, [_disc]),
	}


## Two sessions under `pump`, A dialling. `hub_a` and `hub_b` take their transfer port as the sessions are made.
func _sessions(pump: PKeyPeerPump, a: Half, b: Half, caps_a := ["app/1", "xfer/1"], caps_b := ["app/1", "xfer/1"]) -> Rig:
	var rig := Rig.new()
	var pipes := PKeyPeerMemoryPipe.pair()
	var ha := PKeyTestPeers.Peer.new()
	var hb := PKeyTestPeers.Peer.new()
	var la := PKeyPeerLink.create(pipes[0], _account_opts("initiator", _pair["a"], ha, caps_a), {"pump": pump})
	var lb := PKeyPeerLink.create(pipes[1], _account_opts("responder", _pair["b"], hb, caps_b), {"pump": pump})
	if not la.ok or not lb.ok:
		return null
	var budget := PKeyConnectSession.Budget.new()
	var att_a := PKeyConnectChannel.attach(la.detail, null, "initiator", "", "lan", budget, Callable(a.hub, "attach") if a != null else Callable())
	var att_b := PKeyConnectChannel.attach(lb.detail, null, "responder", "", "lan", budget, Callable(b.hub, "attach") if b != null else Callable())
	pump.add(la.detail)
	pump.add(lb.detail)
	(la.detail as PKeyPeerLink).start()
	var ra: PKeyResult = await att_a.wait_opened()
	var rb: PKeyResult = await att_b.wait_opened()
	rig.keep = [la, lb, att_a, att_b, ha, hb]
	if not ra.ok or not rb.ok:
		return null
	rig.sa = ra.detail
	rig.sb = rb.detail
	return rig


func _read(path: String) -> PackedByteArray:
	return FileAccess.get_file_as_bytes(path)


func _rm_tree(path: String) -> void:
	for f in DirAccess.get_files_at(path):
		DirAccess.remove_absolute(path.path_join(f))
	for d in DirAccess.get_directories_at(path):
		_rm_tree(path.path_join(d))
	DirAccess.remove_absolute(path)


func _partial_bytes(side: Half, session: PKeyConnectSession) -> int:
	var store := side.hub._get_store()
	var n := 0
	for p: Dictionary in store.partials(session.peer_static):
		n += int(p["bytes"])
	return n


# delivery

func _delivery(t: PKeyTestContext, threads: bool) -> void:
	var tag := "threads" if threads else "inline"
	var pump := PKeyPeerPump.new(_tree(), threads)
	var a := Half.new(_dir(), -1, pump)
	var b := Half.new(_dir(), -1, pump)
	b.dest = b.dir.path_join("got.bin")
	b.listen()
	var rig := await _sessions(pump, a, b)
	if not t.check("%s: two sessions with a transfer port on each side" % tag, rig != null and a.hub._wires.size() == 1 and b.hub._wires.size() == 1):
		return
	var data := _bytes(150000)
	var sent := [0]
	var opts := {
		"name": "pic.bin", "type": "application/octet-stream", "category": "docs", "chunk": 20000,
		"on_start": func(_h: PKeyTransferHandle) -> void: sent[0] += 1,
	}
	var started: PKeyResult = await a.hub.send(rig.sa, data, opts)
	if not t.check("%s: send answers a handle" % tag, started.ok and started.detail is PKeyTransferHandle, str(started)):
		return
	var handle: PKeyTransferHandle = started.detail
	t.check("%s: on_start ran once, before the content was hashed" % tag, sent[0] == 1)
	var done: PKeyResult = await handle.wait()
	t.check("%s: the transfer is delivered" % tag, done.ok and done.detail["outcome"] == "delivered" and done.detail["direction"] == "out", str(done))
	await _until(func() -> bool: return not b.results.is_empty())
	t.check("%s: the file is the content, byte for byte" % tag, _read(b.dest) == data)
	t.check("%s: the receiver's result names the file" % tag, b.results.size() == 1 and b.results[0]["delivered"] and b.results[0]["direction"] == "in"
			and b.results[0]["path"] == b.dest, str(b.results))
	t.check("%s: and the sender's the same transfer" % tag, a.results.size() == 1 and a.results[0]["id"] == handle.id)
	var offer: PKeyTransferOffer = b.offers[0]
	t.check("%s: the offer carries the cleaned name, type, size and who sent it" % tag, offer.name == "pic.bin"
			and offer.type == "application/octet-stream" and offer.size == 150000 and offer.category == "docs" and offer.from["kind"] == "device"
					and offer.from["id"] == ID_A and offer.from["label"] == "Den", str(offer.from))
	t.check("%s: and its path once accepted" % tag, offer.path == b.dest)
	t.check("%s: no partial and no temporary file is left" % tag, _partial_bytes(b, rig.sb) == 0 and not _has_temp(b.dir))
	if threads:
		t.check("threads: the hash and the delivery went through the pump", pump.tasks_run >= 2, str(pump.tasks_run))
	rig.sa.close()
	await _until(func() -> bool: return rig.sb.is_closed())
	t.check("%s: closing the session lets go of the wires" % tag, await _until(func() -> bool: return a.hub._wires.is_empty() and b.hub._wires.is_empty()))
	await _frames(3)


func _has_temp(dir: String) -> bool:
	for f in DirAccess.get_files_at(dir):
		if f.begins_with(".pkey-xfer-"):
			return true
	return false


# declines

func _declines(t: PKeyTestContext) -> void:
	var pump := PKeyPeerPump.new(_tree(), false)
	var a := Half.new(_dir(), -1, pump)
	var b := Half.new(_dir(), -1, pump)
	b.dest = b.dir.path_join("x.bin")
	var rig := await _sessions(pump, a, b)
	if not t.check("decline: sessions are up", rig != null):
		return
	var data := _bytes(5000)
	var r1: PKeyResult = (await a.hub.send(rig.sa, data, {"chunk": 1000}))
	var w1: PKeyResult = await (r1.detail as PKeyTransferHandle).wait()
	t.check("decline: with no handler the offer is declined", not w1.ok and w1.code == &"transfer-cancelled" and w1.detail["reason"] == "declined", str(w1))
	t.check("decline: and the receiver is told nothing", b.results.is_empty() and b.offers.is_empty() and not FileAccess.file_exists(b.dest))
	b.listen()
	b.mode = "decline"
	var r2: PKeyResult = await a.hub.send(rig.sa, data)
	var w2: PKeyResult = await (r2.detail as PKeyTransferHandle).wait()
	t.check("decline: the handler's decline reaches the sender", not w2.ok and w2.detail["reason"] == "declined" and b.offers.size() == 1)
	# An unusable destination declines before the person's answer is taken.
	b.mode = "accept"
	b.dest = b.dir.path_join("missing-dir/x.bin")
	var r3: PKeyResult = await a.hub.send(rig.sa, data)
	var w3: PKeyResult = await (r3.detail as PKeyTransferHandle).wait()
	t.check("decline: a destination in a missing directory declines", not w3.ok and w3.detail["reason"] == "declined")
	b.dest = b.dir
	var r4: PKeyResult = await a.hub.send(rig.sa, data)
	var w4: PKeyResult = await (r4.detail as PKeyTransferHandle).wait()
	t.check("decline: a directory is never replaced", not w4.ok and w4.detail["reason"] == "declined" and DirAccess.dir_exists_absolute(b.dir))
	b.dest = b.dir.path_join("exists.bin")
	var keep := FileAccess.open(b.dest, FileAccess.WRITE)
	keep.store_string("mine")
	keep = null
	var r5: PKeyResult = await a.hub.send(rig.sa, data)
	var w5: PKeyResult = await (r5.detail as PKeyTransferHandle).wait()
	t.check("decline: an existing file declines and stays as it was", not w5.ok and FileAccess.get_file_as_string(b.dest) == "mine")
	b.overwrite = true
	var r6: PKeyResult = await a.hub.send(rig.sa, data)
	var w6: PKeyResult = await (r6.detail as PKeyTransferHandle).wait()
	await _until(func() -> bool: return not b.results.is_empty())
	t.check("decline: with overwrite the file is replaced", w6.ok and _read(b.dest) == data)
	# A handler that waits: the answer comes later, and an unanswered offer is withdrawn when the peer cancels.
	b.mode = "hold"
	b.overwrite = false
	b.dest = b.dir.path_join("later.bin")
	b.offers.clear()
	var r7: PKeyResult = await a.hub.send(rig.sa, data)
	var h7: PKeyTransferHandle = r7.detail
	await _until(func() -> bool: return b.offers.size() == 1)
	var held: PKeyTransferOffer = b.offers[0]
	held.accept(b.dest)
	var w7: PKeyResult = await h7.wait()
	t.check("decline: an offer may be answered after the handler returned", w7.ok and _read(b.dest) == data and held.path == b.dest)
	held.accept(b.dest)
	held.decline()
	t.check("decline: a second answer does nothing", _read(b.dest) == data)
	var r8: PKeyResult = await a.hub.send(rig.sa, data)
	var h8: PKeyTransferHandle = r8.detail
	await _until(func() -> bool: return b.offers.size() == 2)
	var open_offer: PKeyTransferOffer = b.offers[1]
	h8.cancel()
	await _until(func() -> bool: return open_offer.withdrawn)
	t.check("decline: the peer ending an unanswered offer withdraws it", open_offer.withdrawn)
	open_offer.accept(b.dir.path_join("late.bin"))
	await _frames(3)
	t.check("decline: and a late answer is ignored", not FileAccess.file_exists(b.dir.path_join("late.bin")))
	rig.sa.close()
	await _frames(5)


# cancel

func _cancel(t: PKeyTestContext) -> void:
	var pump := PKeyPeerPump.new(_tree(), false)
	var a := Half.new(_dir(), -1, pump)
	var b := Half.new(_dir(), -1, pump)
	b.dest = b.dir.path_join("big.bin")
	b.listen()
	var rig := await _sessions(pump, a, b)
	if not t.check("cancel: sessions are up", rig != null):
		return
	var data := Crypto.new().generate_random_bytes(2_000_000)
	var r: PKeyResult = await a.hub.send(rig.sa, data, {"chunk": 8000})
	var h: PKeyTransferHandle = r.detail
	await _until(func() -> bool: return _partial_bytes(b, rig.sb) > 0)
	h.cancel()
	var w: PKeyResult = await h.wait()
	t.check("cancel: the sender's handle ends cancelled", not w.ok and w.detail["reason"] == "cancelled", str(w))
	await _until(func() -> bool: return not b.results.is_empty())
	t.check("cancel: the receiver is told, and keeps nothing", b.results[0]["outcome"] == "cancelled" and b.results[0]["reason"] == "cancelled"
			and _partial_bytes(b, rig.sb) == 0 and not FileAccess.file_exists(b.dest))
	# The receiver cancels by id.
	b.results.clear()
	var r2: PKeyResult = await a.hub.send(rig.sa, data, {"chunk": 8000})
	var h2: PKeyTransferHandle = r2.detail
	await _until(func() -> bool: return _partial_bytes(b, rig.sb) > 0)
	b.hub.cancel(h2.id)
	var w2: PKeyResult = await h2.wait()
	t.check("cancel: the receiver's cancel(id) ends the sender's handle too", not w2.ok and w2.detail["reason"] == "cancelled")
	b.hub.cancel("nothing")
	t.check("cancel: and cancel of an unknown id does nothing", not rig.sb.is_closed())
	rig.sa.close()
	await _frames(5)


# quota and busy

func _quota_and_busy(t: PKeyTestContext) -> void:
	var pump := PKeyPeerPump.new(_tree(), false)
	var a := Half.new(_dir(), -1, pump)
	var b := Half.new(_dir(), 100000, pump)
	b.dest = b.dir.path_join("q.bin")
	b.listen()
	var rig := await _sessions(pump, a, b)
	if not t.check("quota: sessions are up", rig != null):
		return
	var r: PKeyResult = await a.hub.send(rig.sa, _bytes(200000), {"chunk": 20000})
	var w: PKeyResult = await (r.detail as PKeyTransferHandle).wait()
	t.check("quota: content over the quota is refused with quota", not w.ok and w.detail["reason"] == "quota", str(w))
	t.check("quota: and the person is never asked", b.offers.is_empty())
	var small: PKeyResult = await a.hub.send(rig.sa, _bytes(50000), {"chunk": 10000})
	var ws: PKeyResult = await (small.detail as PKeyTransferHandle).wait()
	t.check("quota: content within it is delivered", ws.ok)
	rig.sa.close()
	await _frames(5)
	# Busy: the sender holds at most four live transfers on a session; the fifth ends busy at once.
	var c := Half.new(_dir(), -1, pump)
	var d := Half.new(_dir(), -1, pump)
	var rig2 := await _sessions(pump, c, d)
	if not t.check("busy: sessions are up", rig2 != null):
		return
	var handles: Array = []
	for i in 5:
		var s: PKeyResult = await c.hub.send(rig2.sa, _bytes(1000), {"chunk": 500})
		handles.append(s.detail)
	var fifth: PKeyTransferHandle = handles[4]
	t.check("busy: the fifth transfer ends busy at once", fifth.is_done() and fifth.result["reason"] == "busy" and not fifth.result["delivered"], str(fifth.result))
	t.check("busy: the first four are live", not (handles[0] as PKeyTransferHandle).is_done())
	for i in 4:
		await (handles[i] as PKeyTransferHandle).wait()
	t.check("busy: and are declined by a peer with no handler", (handles[0] as PKeyTransferHandle).result["reason"] == "declined")
	rig2.sa.close()
	await _frames(5)


# resume

func _resume(t: PKeyTestContext) -> void:
	var pump := PKeyPeerPump.new(_tree(), false)
	var a := Half.new(_dir(), -1, pump)
	var b := Half.new(_dir(), -1, pump)
	b.dest = b.dir.path_join("resumed.bin")
	b.listen()
	var rig := await _sessions(pump, a, b)
	if not t.check("resume: sessions are up", rig != null):
		return
	var data := Crypto.new().generate_random_bytes(3_000_000)
	var id := "mM6QZzGG1pHeEeIOBHXPjQ"
	var r: PKeyResult = await a.hub.send(rig.sa, data, {"chunk": 20000, "id": id})
	var h: PKeyTransferHandle = r.detail
	await _until(func() -> bool: return _partial_bytes(b, rig.sb) >= 60000)
	var kept := _partial_bytes(b, rig.sb)
	rig.sa.close()
	var closed: PKeyResult = await h.wait()
	t.check("resume: a dropped session ends the sender's handle closed", not closed.ok and h.result["outcome"] == "closed", str(h.result))
	await _until(func() -> bool: return b.results.size() == 1)
	t.check("resume: and the receiver's too, keeping the partial", b.results[0]["outcome"] == "closed" and _partial_bytes(b, rig.sb) > 0
			and not FileAccess.file_exists(b.dest), str(b.results))
	t.check("resume: nothing is held by the closed session", await _until(func() -> bool: return b.hub._wires.is_empty()))
	var rig2 := await _sessions(pump, a, b)
	if not t.check("resume: a new pair of sessions is up", rig2 != null):
		return
	var first := [-1]
	var orig: Callable = rig2.sb._xfer
	rig2.sb._xfer = func(ty: int, body: PackedByteArray) -> void:
		if ty == PKeyPeerXfer.CHUNK and first[0] < 0:
			first[0] = (body[20] << 24) | (body[21] << 16) | (body[22] << 8) | body[23]
		orig.call(ty, body)
	b.results.clear()
	var again: PKeyResult = await a.hub.send(rig2.sa, data, {"chunk": 20000, "id": id})
	var w: PKeyResult = await (again.detail as PKeyTransferHandle).wait()
	await _until(func() -> bool: return not b.results.is_empty())
	t.check("resume: the same transfer on a new session is delivered", w.ok and _read(b.dest) == data)
	t.check("resume: from the verified offset, not from 0", first[0] > 0 and first[0] % 20000 == 0 and kept > 0, "%d %d" % [first[0], kept])
	rig2.sa.close()
	await _frames(5)


# a re-offer of delivered content

func _delivered_again(t: PKeyTestContext) -> void:
	var pump := PKeyPeerPump.new(_tree(), false)
	var a := Half.new(_dir(), -1, pump)
	var b := Half.new(_dir(), -1, pump)
	b.dest = b.dir.path_join("once.bin")
	b.listen()
	var data := _bytes(70000)
	var rig := await _sessions(pump, a, b)
	var first: PKeyResult = await a.hub.send(rig.sa, data, {"chunk": 20000, "id": XID})
	await (first.detail as PKeyTransferHandle).wait()
	await _until(func() -> bool: return b.results.size() == 1)
	t.check("again: the first delivery arrived", _read(b.dest) == data and b.offers.size() == 1)
	rig.sa.close()
	await _until(func() -> bool: return a.hub._wires.is_empty() and b.hub._wires.is_empty())
	DirAccess.remove_absolute(b.dest)
	var rig2 := await _sessions(pump, a, b)
	var second: PKeyResult = await a.hub.send(rig2.sa, data, {"chunk": 20000, "id": XID})
	var w: PKeyResult = await (second.detail as PKeyTransferHandle).wait()
	t.check("again: the sender is told it is delivered", w.ok and w.detail["delivered"])
	await _frames(5)
	t.check("again: the receiver's handler is not asked again", b.offers.size() == 1)
	t.check("again: no host event and no file the second time", b.results.size() == 1 and not FileAccess.file_exists(b.dest))
	t.check("again: no partial was made", _partial_bytes(b, rig2.sb) == 0)
	rig2.sa.close()
	await _until(func() -> bool: return a.hub._wires.is_empty() and b.hub._wires.is_empty())
	# Forgetting the peer (a link removed, a device that left the roster) asks again.
	b.hub.forget_peer(rig2.sb.peer_static)
	var rig3 := await _sessions(pump, a, b)
	var third: PKeyResult = await a.hub.send(rig3.sa, data, {"chunk": 20000, "id": XID})
	var w3: PKeyResult = await (third.detail as PKeyTransferHandle).wait()
	await _until(func() -> bool: return b.results.size() == 2)
	t.check("again: after the peer was forgotten the content is received again", w3.ok and b.offers.size() == 2 and _read(b.dest) == data)
	rig3.sa.close()
	await _frames(5)


# routing

func _routing(t: PKeyTestContext) -> void:
	var pump := PKeyPeerPump.new(_tree(), false)
	var a := Half.new(_dir(), -1, pump)
	var b := Half.new(_dir(), -1, pump)
	var rig := await _sessions(pump, a, b)
	t.check("routing: the host's send refuses the transfer types",
			rig.sa.send_record(0x0020, PackedByteArray()).code == &"invalid-argument" or not rig.sa.send_record(0x0020, PackedByteArray()).ok)
	t.check("routing: and its send is for the APP range only", not rig.sa.send(PackedByteArray(), 0x0021).ok)
	t.check("routing: the port is taken once", not rig.sa.attach_xfer(func(_ty: int, _b: PackedByteArray) -> void: pass).is_valid())
	rig.sa.close()
	await _frames(5)
	# Without the capability on one side a transfer record closes the session peer_not_allowed.
	var c := Half.new(_dir(), -1, pump)
	var d := Half.new(_dir(), -1, pump)
	var rig2 := await _sessions(pump, c, d, ["app/1"], ["app/1", "xfer/1"])
	t.check("routing: a capability only one side lists is not in the session", rig2 != null and not rig2.sa.caps.has("xfer/1")
			and not rig2.sb.caps.has("xfer/1") and c.hub._wires.is_empty() and d.hub._wires.is_empty())
	var link: PKeyPeerLink = rig2.keep[0].detail
	link.send_record(PKeyPeerXfer.ACK, PKeyPeerXfer.offset_body(XID, 0))
	await _until(func() -> bool: return rig2.sb.is_closed())
	t.check("routing: a transfer record without the capability closes the session", rig2.sb.closed_info()["code"] == &"peer_not_allowed", str(rig2.sb.closed_info()))
	await _frames(3)
	# With the capability and no port the session closes too.
	var e := Half.new(_dir(), -1, pump)
	var rig3 := await _sessions(pump, e, null)
	t.check("routing: a session listing xfer/1 with no port on one side still opens", rig3 != null and e.hub._wires.size() == 1)
	var send_r: PKeyResult = await e.hub.send(rig3.sa, _bytes(100))
	var h3: PKeyTransferHandle = send_r.detail
	await _until(func() -> bool: return rig3.sb.is_closed() or rig3.sa.is_closed())
	t.check("routing: a peer with the capability and no port closes the session peer_not_allowed",
			(rig3.sb.closed_info().get("code") == &"peer_not_allowed" or rig3.sa.closed_info().get("code") == &"peer_not_allowed"))
	await h3.wait()
	t.check("routing: and the sender's handle ends", h3.is_done())
	await _frames(3)


# purges

func _purges(t: PKeyTestContext) -> void:
	var pump := PKeyPeerPump.new(_tree(), false)
	var a := Half.new(_dir(), -1, pump)
	var b := Half.new(_dir(), -1, pump)
	b.dest = b.dir.path_join("p.bin")
	b.listen()
	var rig := await _sessions(pump, a, b)
	var data := Crypto.new().generate_random_bytes(2_000_000)
	var r: PKeyResult = await a.hub.send(rig.sa, data, {"chunk": 8000})
	await _until(func() -> bool: return _partial_bytes(b, rig.sb) > 0)
	rig.sa.close()
	await _until(func() -> bool: return b.hub._wires.is_empty())
	t.check("purge: a dropped session leaves a partial", _partial_bytes(b, rig.sb) > 0)
	b.hub.forget_peer(rig.sb.peer_static)
	t.check("purge: forgetting the peer deletes its partials", _partial_bytes(b, rig.sb) == 0)
	var rig2 := await _sessions(pump, a, b)
	var r2: PKeyResult = await a.hub.send(rig2.sa, data, {"chunk": 8000})
	await _until(func() -> bool: return _partial_bytes(b, rig2.sb) > 0)
	var purged := b.hub.purge()
	t.check("purge: purge() deletes every partial", purged.ok and _partial_bytes(b, rig2.sb) == 0)
	t.check("purge: and closes the sessions that were transferring", await _until(func() -> bool: return rig2.sb.is_closed() and rig2.sa.is_closed()))
	var w2: PKeyResult = await (r2.detail as PKeyTransferHandle).wait()
	t.check("purge: the sender's handle ended", not w2.ok and (r2.detail as PKeyTransferHandle).is_done())
	await _frames(3)
	# The old session handle and its effects: nothing recreates a purged partial.
	t.check("purge: a late effect from before the purge recreated nothing", _partial_bytes(b, rig2.sb) == 0)
	rig2.sa.close()
	await _frames(3)
	t.check("purge: on a hub with no state directory it is ok", PKeyCloudTransfer.new().purge().ok)
	t.check("purge: a hub prints only a count", str(a.hub).begins_with("PKeyCloudTransfer(sessions="))
	var no_dir := PKeyCloudTransfer.new()
	var nr: PKeyResult = await no_dir.send("device-x", _bytes(10))
	t.check("send: a device id with Cloud Connect not started fails not_started", PKeyConnectErrors.reason_of(nr) == "not_started")
	var bad: PKeyResult = await no_dir.send({"link": "lnk"}, _bytes(10))
	t.check("send: a link this device does not hold is link-unknown", bad.code == &"link-unknown")
	var wrong: PKeyResult = await no_dir.send(5, _bytes(10))
	t.check("send: a peer of another kind is invalid-argument", wrong.code == &"invalid-argument")
	var arg := PKeyCloudTransfer.new()
	for o in [{"type": "x"}, {"category": "Bad Cat"}, {"chunk": 0}, {"id": "short"}, {"name": 5}, {"name": "n".repeat(256)}]:
		var rr: PKeyResult = await arg.send(rig2.sa, _bytes(10), o)
		t.check("send: option %s is refused" % str(o.keys()[0]), not rr.ok and rr.code == &"invalid-argument", str(rr))
	var unreadable: PKeyResult = await arg.send(rig2.sa, "/definitely/not/here.bin")
	t.check("send: a path that cannot be read is invalid-argument", unreadable.code == &"invalid-argument")
	var stream: PKeyResult = await arg.send(rig2.sa, FileAccess.open(_root.path_join("nope"), FileAccess.WRITE))
	t.check("send: a stream is not a source", stream.code == &"invalid-argument")


# through Cloud Connect over the fake relay room

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
	s.keys = CC.FakeKeys.new(d["priv"])
	return s


func _node(d: Dictionary, core: PKeyCore, store_root: String) -> CC.Device:
	var n := CC.Device.new()
	n.env = CC.Env.new()
	n.env.source = _source(d)
	n.client = CC.StubClient.new(core, PKeyConnectState.new("djdl", "user://pkey", true), null)
	n.client.device_id = d["id"]
	n.api = PKeyCloudConnect.new(core, n.client, {"tree": _tree(), "store_root": store_root})
	return n


func _relay(t: PKeyTestContext) -> void:
	var clock := [PKeyTestPeers.NOW]
	var opts := PKeyTestFixtures.options("https://key.plrs.im", PKeyMemoryStore.new(ID_A, "pkeyt_x"), clock, "djdl", PKeyTestPeers.trust())
	var core: PKeyCore = PKeyCore.create(opts, _host, "0.0.0").detail
	core.discovery_manifest = {"services": {"connect": {"enabled": true, "relay": true, "endpoints": {"ticket": "y"}}}}
	var room := PKeyRelayFakeRoom.new()
	var a := _node(_pair["a"], core, _dir())
	var b := _node(_pair["b"], core, _dir())
	var ra: PKeyResult = await a.api.start({"source": a.env.src(), "lan": false, "relay": {"opener": room.opener_for(PKeyPeerAdvert.device_id_bytes(ID_A)), "ping_seconds": 100000.0}})
	var rb: PKeyResult = await b.api.start({"source": b.env.src(), "lan": false, "relay": {"opener": room.opener_for(PKeyPeerAdvert.device_id_bytes(ID_B)), "ping_seconds": 100000.0}})
	if not t.check("relay: both start", ra.ok and rb.ok):
		return
	await _until(func() -> bool: return a.api.status()["relay"] == "open" and b.api.status()["relay"] == "open")
	var dest := _dir().path_join("relayed.bin")
	var seen: Array = []
	var results: Array = []
	b.api.transfer.result.connect(func(r: Dictionary) -> void: results.append(r))
	b.api.transfer.on_offer(func(o: PKeyTransferOffer) -> void:
		seen.append(o)
		o.accept(dest))
	t.check("relay: a handler keeps an inbound session open with no channel listener", b.api.transfer.listening())
	var data := _bytes(90000)
	var sent: PKeyResult = await a.api.transfer.send(ID_B, data, {"name": "r.bin", "chunk": 30000})
	if not t.check("relay: send by device id opens a session over the relay", sent.ok, str(sent)):
		a.api.stop()
		b.api.stop()
		return
	var done: PKeyResult = await (sent.detail as PKeyTransferHandle).wait()
	await _until(func() -> bool: return not results.is_empty())
	t.check("relay: the content is delivered over the relay", done.ok and _read(dest) == data and results[0]["delivered"], str(done))
	t.check("relay: the offer names the sender", seen.size() == 1 and seen[0].from["id"] == ID_A and seen[0].name == "r.bin")
	# The unset Callable the handler answered.
	var unset: Callable = b.api.transfer.on_offer(func(_o: PKeyTransferOffer) -> void: pass)
	unset.call()
	t.check("relay: unsetting the handler stops listening", not b.api.transfer.listening())
	# Sign-out purges and stops.
	var out := b.api._sign_out_step()
	t.check("relay: sign-out stops Cloud Connect and purges the transfers", out.ok and not b.api.status()["running"])
	a.api.stop()
	await _frames(5)
	# transfer = false lists no capability.
	var off_room := PKeyRelayFakeRoom.new()
	var c := _node(_pair["a"], core, _dir())
	var d := _node(_pair["b"], core, _dir())
	await c.api.start({"source": c.env.src(), "lan": false, "transfer": false, "relay": {"opener": off_room.opener_for(PKeyPeerAdvert.device_id_bytes(ID_A)), "ping_seconds": 100000.0}})
	await d.api.start({"source": d.env.src(), "lan": false, "relay": {"opener": off_room.opener_for(PKeyPeerAdvert.device_id_bytes(ID_B)), "ping_seconds": 100000.0}})
	await _until(func() -> bool: return c.api.status()["relay"] == "open" and d.api.status()["relay"] == "open")
	d.api.transfer.on_offer(func(o: PKeyTransferOffer) -> void: o.accept(dest))
	d.api.channel.connect(func(_s: PKeyConnectSession) -> void: pass)
	var no: PKeyResult = await c.api.transfer.send(ID_B, _bytes(100))
	t.check("relay: with transfer = false the peer did not offer Direct Transfer", not no.ok and no.code == &"peer_not_allowed", str(no))
	c.api.stop()
	d.api.stop()
	await _frames(5)
