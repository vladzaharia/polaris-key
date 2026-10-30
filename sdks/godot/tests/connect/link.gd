extends RefCounted
# @pkey-feature connect.noise connect.protocol
# `PKeyPeerLink`, `PKeyPeerPump` and the pipes (CC-14.10a): two links over the in-memory pipe with the
# pump's inline mode forced, the same over real `WorkerThreadPool` tasks (at most two at once), over
# loopback TCP, and the link's rules: 16 KiB handshake frames, the 30 s handshake deadline, a zero
# length frame, a pipe that goes away, backpressure and the CLOSE that reaches the peer first.

var _pair: Dictionary
var _disc := PackedByteArray()


class Rec extends RefCounted:
	var established: Array = []
	var records: Array = []
	var closed: Array = []
	var sas: Array = []


	func watch(link: PKeyPeerLink) -> Rec:
		link.established.connect(func(info: Dictionary) -> void: established.append(info))
		link.record.connect(func(type: int, body: PackedByteArray) -> void: records.append([type, body]))
		link.closed.connect(func(code: StringName, by_peer: bool) -> void: closed.append([code, by_peer]))
		link.sas.connect(func(code: int, display: String) -> void: sas.append([code, display]))
		return self


func run(t: PKeyTestContext) -> void:
	_pair = PKeyTestPeers.pair(1)
	_disc = PKeyTestPeers.random32()
	await _inline(t)
	await _threaded(t)
	await _rules(t)
	await _lost_pipe(t)
	await _tcp(t)
	await _small_things(t)


func _a() -> Dictionary:
	return _pair["a"]


func _b() -> Dictionary:
	return _pair["b"]


## The session options of a mode-a device; `holder` answers the held roster (none).
func _account_opts(role: String, d: Dictionary, holder: PKeyTestPeers.Peer, extra := {}) -> Dictionary:
	var o := {
		"mode": "a", "role": role, "slug": PKeyTestPeers.SLUG, "static_key": d["priv"], "caps": ["app/1"],
		"hello": {"platform": "test", "app": "demo"}, "now": Callable(holder, "now"), "mono": Callable(holder, "mono"),
		"account": PKeyTestPeers.account(d, holder, [_disc]),
	}
	for k in extra:
		o[k] = extra[k]
	return o


## Two links over a pipe pair, A dialling and B answering, under `pump`.
func _links(pump: PKeyPeerPump, pipes: Array, options := {}, extra_a := {}, extra_b := {}) -> Array:
	var ha := PKeyTestPeers.Peer.new()
	var hb := PKeyTestPeers.Peer.new()
	var la := PKeyPeerLink.create(pipes[0], _account_opts("initiator", _a(), ha, extra_a), _with_pump(options, pump))
	var lb := PKeyPeerLink.create(pipes[1], _account_opts("responder", _b(), hb, extra_b), _with_pump(options, pump))
	if not la.ok or not lb.ok:
		return []
	pump.add(la.detail)
	pump.add(lb.detail)
	# The holders are kept alive with the links: the session's clocks are Callables on them.
	return [la.detail, lb.detail, ha, hb]


static func _with_pump(options: Dictionary, pump: PKeyPeerPump) -> Dictionary:
	var o := options.duplicate()
	o["pump"] = pump
	return o


func _inline(t: PKeyTestContext) -> void:
	var pump := PKeyPeerPump.new(null, false)
	t.check("inline: a pump with threads off says so", not pump.uses_threads())
	var pipes := PKeyPeerMemoryPipe.pair()
	var made := _links(pump, pipes)
	var la: PKeyPeerLink = made[0]
	var lb: PKeyPeerLink = made[1]
	var ra := Rec.new().watch(la)
	var rb := Rec.new().watch(lb)
	await la.start()
	for i in 10:
		pump.poll_once()
	t.check("inline: both links are established over the memory pipe", ra.established.size() == 1 and rb.established.size() == 1 and la.is_established())
	t.check("inline: the work ran inline, on this thread, five steps", pump.inline_run == 5 and pump.tasks_run == 0, "%d %d" % [pump.inline_run, pump.tasks_run])
	t.check("inline: the established event is the session's", ra.established[0]["peer_device_id"] == PKeyTestPeers.ID_B and ra.established[0]["hello_authenticated"] == true)

	t.check("inline: a record goes across", la.send_record(0x0100, "hi".to_utf8_buffer()).ok)
	pump.poll_once()
	t.check("inline: and arrives with its type", rb.records.size() == 1 and rb.records[0][0] == 0x0100 and (rb.records[0][1] as PackedByteArray).get_string_from_utf8() == "hi")
	# A message over a frame (but under 64 KiB) after the handshake is not held to the 16 KiB bound.
	var big := PackedByteArray()
	big.resize(40000)
	big.fill(7)
	la.send_record(0x0101, big)
	pump.poll_once()
	t.check("inline: a 40,000-byte record after the handshake arrives whole", rb.records.size() == 2 and rb.records[1][1] == big)

	# Backpressure: a paused link reads nothing, and picks everything up when resumed.
	lb.pause(true)
	t.check("inline: pause is reported", lb.is_paused())
	la.send_record(0x0102, "one".to_utf8_buffer())
	la.send_record(0x0102, "two".to_utf8_buffer())
	pump.poll_once()
	pump.poll_once()
	t.check("inline: a paused link delivers nothing", rb.records.size() == 2)
	lb.pause(false)
	pump.poll_once()
	var resumed := rb.records.size() == 4 and (rb.records[2][1] as PackedByteArray).get_string_from_utf8() == "one"
	t.check("inline: and resumes in order", resumed and (rb.records[3][1] as PackedByteArray).get_string_from_utf8() == "two")

	# Close: the CLOSE record reaches the peer, both links end once, the pump lets go of both.
	la.close()
	for i in 4:
		pump.poll_once()
	t.check("inline: close() ends the closer as peer_bye", ra.closed == [[&"peer_bye", false]], str(ra.closed))
	t.check("inline: and the peer sees the CLOSE", rb.closed == [[&"peer_bye", true]], str(rb.closed))
	t.check("inline: the pump let go of both links", pump.count() == 0)
	t.check("inline: a send after the end is refused", la.send_record(0x0100, PackedByteArray()).code == &"state")


func _wait_until(cond: Callable, frames := 600) -> int:
	var tree := Engine.get_main_loop() as SceneTree
	var n := 0
	while n < frames and not cond.call():
		await tree.process_frame
		n += 1
	return n


func _threaded(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var pump := PKeyPeerPump.new(tree, true)
	if not pump.uses_threads():
		t.info("threaded: this runtime has no threads; the inline mode is what runs")
	var pipes := PKeyPeerMemoryPipe.pair()
	var made := _links(pump, pipes)
	var la: PKeyPeerLink = made[0]
	var lb: PKeyPeerLink = made[1]
	var ra := Rec.new().watch(la)
	var rb := Rec.new().watch(lb)
	var worst := [0]
	var last := [Time.get_ticks_msec()]
	var tick := func() -> void:
		var now := Time.get_ticks_msec()
		worst[0] = maxi(worst[0], now - last[0])
		last[0] = now
	tree.process_frame.connect(tick)
	var started := Time.get_ticks_msec()
	la.start()
	var frames := await _wait_until(func() -> bool: return ra.established.size() == 1 and rb.established.size() == 1)
	tree.process_frame.disconnect(tick)
	t.info("threaded: handshake in %d frames, %d ms, worst frame %d ms" % [frames, Time.get_ticks_msec() - started, worst[0]])
	t.check("threaded: both links are established by frame polling alone", ra.established.size() == 1 and rb.established.size() == 1)
	if pump.uses_threads():
		t.check("threaded: five tasks ran, none inline", pump.tasks_run == 5 and pump.inline_run == 0, "%d %d" % [pump.tasks_run, pump.inline_run])
		t.check("threaded: they ran off this thread", pump.last_thread != 0 and pump.last_thread != OS.get_thread_caller_id())
		t.check("threaded: at most two ran at once", pump.peak_in_flight <= PKeyPeerPump.MAX_TASKS and pump.in_flight == 0)
	la.send_record(0x0100, "x".to_utf8_buffer())
	await _wait_until(func() -> bool: return rb.records.size() == 1)
	t.check("threaded: records flow", rb.records.size() == 1)
	la.close()
	await _wait_until(func() -> bool: return rb.closed.size() == 1 and ra.closed.size() == 1)
	t.check("threaded: and the close reaches the peer", rb.closed == [[&"peer_bye", true]] and ra.closed == [[&"peer_bye", false]])
	await _wait_until(func() -> bool: return pump.count() == 0, 60)
	t.check("threaded: the pump stops listening once it holds nothing", pump.count() == 0)

	# Eight handshakes at once share two tasks.
	pump = PKeyPeerPump.new(tree, true)
	var recs: Array[Rec] = []
	var keep := []
	for i in 8:
		var m := _links(pump, PKeyPeerMemoryPipe.pair())
		keep.append(m)
		recs.append(Rec.new().watch(m[0]))
		recs.append(Rec.new().watch(m[1]))
		m[0].start()
	var burst := await _wait_until(func() -> bool: return recs.all(func(r: Rec) -> bool: return r.established.size() == 1), 1500)
	t.info("threaded: eight handshakes together took %d frames" % burst)
	t.check("threaded: all sixteen links establish", recs.all(func(r: Rec) -> bool: return r.established.size() == 1))
	if pump.uses_threads():
		t.check("threaded: and never more than two tasks ran at once", pump.peak_in_flight <= PKeyPeerPump.MAX_TASKS and pump.tasks_run == 40, "%d %d" % [pump.peak_in_flight, pump.tasks_run])
	for m in keep:
		m[0].destroy()
		m[1].destroy()

	# A close asked for while a step runs waits for it.
	pump = PKeyPeerPump.new(tree, true)
	made = _links(pump, PKeyPeerMemoryPipe.pair())
	var lc: PKeyPeerLink = made[0]
	var rc := Rec.new().watch(lc)
	lc.start()
	lc.close()
	await _wait_until(func() -> bool: return rc.closed.size() == 1, 120)
	t.check("threaded: a close during the first step lands once the step ends", rc.closed == [[&"peer_bye", false]], str(rc.closed))
	lc.destroy()
	made[1].destroy()


func _rules(t: PKeyTestContext) -> void:
	# More than 16 KiB in a handshake frame closes handshake_failed; the bound is on the link.
	var pump := PKeyPeerPump.new(null, false)
	var pipes := PKeyPeerMemoryPipe.pair()
	var made := _links(pump, pipes)
	var lb: PKeyPeerLink = made[1]
	var rb := Rec.new().watch(lb)
	var junk := PackedByteArray()
	junk.resize(PKeyPeerLink.HANDSHAKE_FRAME_MAX + 1)
	pipes[0].write(PKeyPeerFrame.encode(junk))
	pump.poll_once()
	t.check("rules: a handshake frame over 16 KiB closes handshake_failed", rb.closed == [[&"handshake_failed", false]], str(rb.closed))
	t.check("rules: and the responder said nothing back", (pipes[0] as PKeyPeerMemoryPipe).read().is_empty())

	# A zero-length frame before the session is up.
	pipes = PKeyPeerMemoryPipe.pair()
	made = _links(pump, pipes)
	rb = Rec.new().watch(made[1])
	pipes[0].write(PackedByteArray([0, 0]))
	pump.poll_once()
	t.check("rules: a zero-length frame closes peer_bad_frame", rb.closed == [[&"peer_bad_frame", false]], str(rb.closed))

	# And after it, with the CLOSE reaching the peer.
	pipes = PKeyPeerMemoryPipe.pair()
	made = _links(pump, pipes)
	var la: PKeyPeerLink = made[0]
	lb = made[1]
	var ra := Rec.new().watch(la)
	rb = Rec.new().watch(lb)
	await la.start()
	for i in 10:
		pump.poll_once()
	pipes[0].write(PackedByteArray([0, 0]))
	for i in 4:
		pump.poll_once()
	t.check("rules: a zero-length frame in a live session closes it peer_bad_frame", rb.closed == [[&"peer_bad_frame", false]], str(rb.closed))
	t.check("rules: and the CLOSE names it to the peer", ra.closed == [[&"peer_bad_frame", true]], str(ra.closed))

	# The 30 s handshake deadline, on a monotonic clock the test moves.
	var now := [0]
	var clock := func() -> int: return now[0]
	pipes = PKeyPeerMemoryPipe.pair()
	made = _links(pump, pipes, {"mono_ms": clock})
	rb = Rec.new().watch(made[1])
	now[0] = 29999
	pump.poll_once()
	t.check("rules: 29.999 s into a handshake is still open", rb.closed.is_empty())
	now[0] = 30000
	pump.poll_once()
	t.check("rules: 30 s closes handshake_failed", rb.closed == [[&"handshake_failed", false]], str(rb.closed))
	# Established links have no handshake deadline.
	pipes = PKeyPeerMemoryPipe.pair()
	now[0] = 0
	made = _links(pump, pipes, {"mono_ms": clock})
	la = made[0]
	lb = made[1]
	ra = Rec.new().watch(la)
	rb = Rec.new().watch(lb)
	await la.start()
	for i in 10:
		pump.poll_once()
	now[0] = 1000000
	pump.poll_once()
	t.check("rules: an established link has no handshake deadline", ra.closed.is_empty() and rb.closed.is_empty() and la.is_established())
	# The deadline option.
	pipes = PKeyPeerMemoryPipe.pair()
	now[0] = 0
	made = _links(pump, pipes, {"mono_ms": clock, "handshake_ms": 5000})
	rb = Rec.new().watch(made[1])
	now[0] = 5000
	pump.poll_once()
	t.check("rules: the deadline is an option", rb.closed == [[&"handshake_failed", false]])


func _lost_pipe(t: PKeyTestContext) -> void:
	# A pipe that closes under a live session ends it as connection_lost, after what arrived first.
	var pump := PKeyPeerPump.new(null, false)
	var pipes := PKeyPeerMemoryPipe.pair()
	var made := _links(pump, pipes)
	var la: PKeyPeerLink = made[0]
	var lb: PKeyPeerLink = made[1]
	var rb := Rec.new().watch(lb)
	await la.start()
	for i in 10:
		pump.poll_once()
	la.send_record(0x0100, "last words".to_utf8_buffer())
	pipes[0].close()
	pump.poll_once()
	pump.poll_once()
	t.check("lost: frames sent before the pipe closed are delivered first", rb.records.size() == 1 and (rb.records[0][1] as PackedByteArray).get_string_from_utf8() == "last words")
	t.check("lost: then the link ends as connection_lost, not by the peer", rb.closed == [[&"connection_lost", false]], str(rb.closed))
	t.check("lost: and the pump lets go", pump.count() <= 1)
	# A pipe that was never open ends a link that has not started.
	pipes = PKeyPeerMemoryPipe.pair()
	pipes[0].close()
	made = _links(pump, pipes)
	var rb2 := Rec.new().watch(made[1])
	pump.poll_once()
	t.check("lost: a pipe closed before anything is connection_lost", rb2.closed == [[&"connection_lost", false]], str(rb2.closed))
	# destroy() ends a link at once, once.
	pipes = PKeyPeerMemoryPipe.pair()
	made = _links(pump, pipes)
	var rc := Rec.new().watch(made[0])
	made[0].destroy()
	made[0].destroy()
	t.check("lost: destroy() reports one close and is polled no more", rc.closed == [[&"peer_bye", false]] and not made[0].poll())


func _tcp(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var server := TCPServer.new()
	if server.listen(0, "127.0.0.1") != OK:
		t.check("tcp: a loopback listener opens", false)
		return
	var port := server.get_local_port()
	var dial := PKeyPeerTcpPipe.dial("127.0.0.1", port)
	t.check("tcp: a dial starts", dial != null)
	await _wait_until(func() -> bool: return server.is_connection_available(), 200)
	var accepted := server.take_connection()
	t.check("tcp: the listener accepts", accepted != null)
	var answer := PKeyPeerTcpPipe.from_peer(accepted)
	var pump := PKeyPeerPump.new(tree, true)
	var made := _links(pump, [dial, answer])
	var la: PKeyPeerLink = made[0]
	var lb: PKeyPeerLink = made[1]
	var ra := Rec.new().watch(la)
	var rb := Rec.new().watch(lb)
	la.start()
	await _wait_until(func() -> bool: return ra.established.size() == 1 and rb.established.size() == 1, 800)
	t.check("tcp: both links are established over loopback", ra.established.size() == 1 and rb.established.size() == 1)
	t.check("tcp: the pipe knows the peer's address", dial.remote_address() == "127.0.0.1" and answer.remote_address() == "127.0.0.1")
	var big := PackedByteArray()
	big.resize(150000)
	big.fill(0x42)
	la.send_record(0x0100, big)
	lb.send_record(0x0100, "pong".to_utf8_buffer())
	await _wait_until(func() -> bool: return rb.records.size() == 1 and ra.records.size() == 1, 800)
	t.check("tcp: a 150,000-byte message crosses in pieces and arrives whole", rb.records.size() == 1 and rb.records[0][1] == big)
	t.check("tcp: and the small one the other way", ra.records.size() == 1 and (ra.records[0][1] as PackedByteArray).get_string_from_utf8() == "pong")
	# close(): the CLOSE record is flushed before the socket drops.
	la.close()
	await _wait_until(func() -> bool: return ra.closed.size() == 1 and rb.closed.size() == 1, 400)
	t.check("tcp: the CLOSE reaches the peer before the socket drops", rb.closed == [[&"peer_bye", true]] and ra.closed == [[&"peer_bye", false]], "%s %s" % [ra.closed, rb.closed])
	await _wait_until(func() -> bool: return pump.count() == 0, 200)
	t.check("tcp: both links finish and the pump lets go", pump.count() == 0)
	# A peer that vanishes without a CLOSE is connection_lost.
	var dial2 := PKeyPeerTcpPipe.dial("127.0.0.1", port)
	await _wait_until(func() -> bool: return server.is_connection_available(), 200)
	var answer2 := PKeyPeerTcpPipe.from_peer(server.take_connection())
	made = _links(pump, [dial2, answer2])
	var rd := Rec.new().watch(made[0])
	var re := Rec.new().watch(made[1])
	made[0].start()
	await _wait_until(func() -> bool: return rd.established.size() == 1 and re.established.size() == 1, 800)
	dial2.abort()
	await _wait_until(func() -> bool: return re.closed.size() == 1, 400)
	t.check("tcp: a socket dropped under a live session is connection_lost", re.closed == [[&"connection_lost", false]], str(re.closed))
	made[0].destroy()
	made[1].destroy()
	server.stop()
	# A refused dial: nothing listens.
	var nothing := PKeyPeerTcpPipe.dial("127.0.0.1", port)
	var rn := PKeyTestPeers.Peer.new()
	var ln := PKeyPeerLink.create(nothing, _account_opts("initiator", _a(), rn), {"pump": pump})
	if ln.ok:
		var rl := Rec.new().watch(ln.detail)
		pump.add(ln.detail)
		ln.detail.start()
		await _wait_until(func() -> bool: return rl.closed.size() == 1, 400)
		t.check("tcp: a dial nobody answers ends the link", rl.closed.size() == 1 and rl.established.is_empty(), str(rl.closed))
		ln.detail.destroy()


func _small_things(t: PKeyTestContext) -> void:
	var pump := PKeyPeerPump.new(null, false)
	var pipes := PKeyPeerMemoryPipe.pair()
	var made := _links(pump, pipes)
	t.check("small: str() shows nothing of the session", str(made[0]) == "PKeyPeerLink()" and str(pump) == "PKeyPeerPump()" and str(pipes[0]) == "PKeyPeerMemoryPipe()")
	t.check("small: a link needs a pipe", not PKeyPeerLink.create(null, {}).ok)
	t.check("small: and valid session options", not PKeyPeerLink.create(pipes[0], {"mode": "x"}).ok)
	t.check("small: the base pipe is closed", not PKeyPeerPipe.new().is_open() and PKeyPeerPipe.new().is_finished() and not PKeyPeerPipe.new().write(PackedByteArray([1])))
	var closed := PKeyPeerMemoryPipe.pair()
	closed[0].close()
	t.check("small: a closed memory pipe refuses writes in both directions", not closed[0].write(PackedByteArray([1])) and not closed[1].write(PackedByteArray([1])))
	var m := PKeyPeerMemoryPipe.pair()
	m[0].write(PackedByteArray([1, 2, 3]))
	m[0].close()
	t.check("small: what was written before a close is still read, then the pipe is over", m[1].is_open() and m[1].read() == PackedByteArray([1, 2, 3]) and not m[1].is_open())
	t.check("small: a TCP pipe over no socket is dead", PKeyPeerTcpPipe.from_peer(null) == null and not PKeyPeerTcpPipe.new().is_open())
	var tcp := PKeyPeerTcpPipe.new()
	t.check("small: and refuses writes", not tcp.write(PackedByteArray([1])))
	t.check("small: the links are polled by the pump", pump.count() == 2)
	pump.add(made[0])
	t.check("small: a link is added once", pump.count() == 2)
	pump.remove(made[0])
	pump.remove(made[1])
	t.check("small: and can be removed", pump.count() == 0)
