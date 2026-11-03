extends RefCounted
# @pkey-feature connect.transfer
# `PKeyPeerXferEndpoint` (Direct Transfer, WIRE-CONTRACT-V5 section 15.11): the `ending` and `resume`
# sections of `peer-matrix.json` again, this time through the endpoint (the machine behind its ports, with
# the records decoded from the bytes it sends, the effects its store port saw and the events the host got),
# and what the corpus cannot say: the order of effects, records and events, a store or session port that
# fails, a source that cannot be read, a queue that overflows, a call from inside a handler, work that
# leaves the main thread, and a session that ends under it. Reads res://tests/corpus/v2/peer-matrix.json
# (generator-owned; never edit it).

const XF := preload("res://tests/connect/xfer.gd")
const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const ID_A := "D9FghtxWIhxlaxzwysyg4w"
const ID_B := "mM6QZzGG1pHeEeIOBHXPjQ"


## An endpoint and everything its ports saw since the last `reset`.
class Rig extends RefCounted:
	var at := 0.0
	var step := {}
	var closing := false
	var closes: Array = []
	var errors := 0
	var finished := 0
	var order: Array = []
	var fail_apply := false
	var fail_send := false
	var fail_read := false
	var no_room := false
	var ep: PKeyPeerXferEndpoint
	var machine: PKeyPeerXfer.Machine
	var offload: Callable
	var offload_calls := 0


	func _init(m: PKeyPeerXfer.Machine, p_offload := Callable()) -> void:
		offload = Callable(self, "_offload") if p_offload.is_valid() else Callable()
		machine = m
		reset()
		ep = make()
		ep.bind(m)


	func make() -> PKeyPeerXferEndpoint:
		var o := {
			"send": Callable(self, "_send"), "close": Callable(self, "_close"), "read": Callable(self, "_read"),
			"apply": Callable(self, "_apply"), "now": Callable(self, "_now"), "timer": Callable(self, "_timer"),
			"budget_usec": 0,
			"events": {
				"ask": func(a: Dictionary) -> void: _note("ask", a),
				"withdraw": func(id: String) -> void: _note("withdraw", id),
				"result": func(r: Dictionary) -> void: _note("result", r),
				"refused": func(id: String, why: String) -> void: _note("refused", [id, why]),
				"error": func(_why: String) -> void: errors += 1,
				"finished": func() -> void: finished += 1,
			},
		}
		if offload.is_valid():
			o["offload"] = offload
		return PKeyPeerXferEndpoint.new(o)


	func reset() -> void:
		step = PKeyPeerXfer.Machine.blank()


	func _to_string() -> String:
		return "Rig()"


	func _now() -> float:
		return at


	func _timer(_seconds: float, _fn: Callable) -> Callable:
		return Callable()


	func _offload(work: Callable) -> Variant:
		offload_calls += 1
		return work.call()


	func _note(kind: String, v: Variant) -> void:
		order.append(kind)
		if closing:
			return
		match kind:
			"ask":
				step["ask"] = v
			"withdraw":
				(step["withdraw"] as Array).append(v)
			"result":
				(step["results"] as Array).append(v)
			"refused":
				step["refused"] = (v as Array)[1]


	func _close(code: StringName) -> void:
		order.append("close")
		closes.append(code)
		if not closing:
			step["close"] = String(code)
		closing = true


	func _read(_id: String, offset: int, length: int) -> Variant:
		if fail_read:
			return null
		return XF._content(offset, offset + length)


	func _apply(e: Dictionary) -> PKeyResult:
		order.append("effect")
		if fail_apply:
			return PKeyResult.failure(&"store-failed", "no")
		if no_room and (e.has("create") or e.has("truncate")):
			return PKeyResult.failure(&"store-failed", "no room", {"reason": "space"})
		if closing or e.has("write"):
			return PKeyResult.success()
		var d := e.duplicate()
		d.erase("meta")
		(step["partial"] as Array).append(d)
		return PKeyResult.success()


	func _send(type: int, body: PackedByteArray) -> PKeyResult:
		order.append("record")
		if fail_send:
			return PKeyResult.failure(&"state", "closed")
		if closing:
			return PKeyResult.success()
		(step["send"] as Array).append(decode(type, body))
		return PKeyResult.success()


	static func decode(type: int, body: PackedByteArray) -> Dictionary:
		if type == PKeyPeerXfer.CHUNK:
			return {
				"t": "CHUNKS", "id": PKeyB64Url.encode(body.slice(0, 16)),
				"offset": (body[20] << 24) | (body[21] << 16) | (body[22] << 8) | body[23], "bytes": body.size() - 24,
			}
		var o: Dictionary = JSON.parse_string(body.get_string_from_utf8())
		var names := {
			PKeyPeerXfer.OFFER: "OFFER", PKeyPeerXfer.ACCEPT: "ACCEPT", PKeyPeerXfer.ACK: "ACK",
			PKeyPeerXfer.DONE: "DONE", PKeyPeerXfer.CANCEL: "CANCEL",
		}
		o["t"] = names[type]
		return o


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var x: Dictionary = (j.data as Dictionary)["xfer"]
	var ran := 0
	var rows := 0
	for s in ["ending", "resume"]:
		for r in x[s]:
			rows += 1
			ran += int(_row(t, s, r))
	t.check("every ending and resume row ran green through the endpoint", rows == 77 and ran == 77, "%d/%d" % [ran, rows])
	await _order(t)
	await _failures(t)
	await _queues(t)
	await _offloading(t)
	await _closing(t)
	_delivery(t)
	_misc(t)


# the corpus rows

func _row(t: PKeyTestContext, section: String, row: Dictionary) -> bool:
	var xf := XF.new()
	var rig := Rig.new(xf.machine_of(row["ctx"]))
	var got: Array = []
	var wants: Array = []
	for w in row["want"]:
		var q: Dictionary = XF._norm(w)
		q.erase("drop")
		wants.append(XF._merge(q))
	for st in row["steps"]:
		rig.at = float(st["at"])
		rig.reset()
		if st.has("host"):
			match String(st["host"]):
				"tick":
					rig.ep.tick()
				"offer":
					rig.ep.offer({
						"id": st["id"], "size": int(st["size"]), "chunk": int(st["chunk"]),
						"sha256": st["sha256"], "cat": st.get("cat"), "seekable": st.get("seekable", true),
					})
				"consent":
					rig.ep.consent(st["id"], st["answer"])
				"cancel":
					rig.ep.cancel(st["id"])
				"close":
					rig.ep.closed()
				"newSession":
					rig.machine.new_session(rig.at)
					rig.closing = false
					rig.ep = rig.make()
					rig.ep.bind(rig.machine)
				_:
					return t.check("%s/%s: host step" % [section, row["id"]], false, String(st["host"]))
		else:
			match String(st["rx"]):
				"PING":
					rig.ep.tick()
				"OFFER":
					rig.ep.receive(PKeyPeerXfer.OFFER, String(st["body"]).to_utf8_buffer())
				"ACCEPT", "ACK":
					var ty := PKeyPeerXfer.ACCEPT if st["rx"] == "ACCEPT" else PKeyPeerXfer.ACK
					rig.ep.receive(ty, PKeyPeerXfer.offset_body(st["id"], int(st["offset"])))
				"CHUNK":
					var off := int(st["offset"])
					var data := XF._content(off, off + int(st["length"]), st.get("data") == "corrupt")
					rig.ep.receive(PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(st["id"], off, data))
				"DONE":
					rig.ep.receive(PKeyPeerXfer.DONE, PKeyPeerXfer.done_body(st["id"], st.get("sha256", "")))
				"CANCEL":
					rig.ep.receive(PKeyPeerXfer.CANCEL, PKeyPeerXfer.cancel_body(st["id"], st["reason"]))
				_:
					return t.check("%s/%s: rx step" % [section, row["id"]], false, String(st["rx"]))
		got.append(XF._merge(XF._want(rig.step)))
	return t.check("endpoint %s/%s" % [section, row["id"]], XF._same(got, wants), JSON.stringify(got) + " != " + JSON.stringify(wants))


# what the corpus cannot say

func _machine(handler := "accept", opts := {}) -> PKeyPeerXfer.Machine:
	var o := {
		"mode": "a", "caps": ["xfer/1"], "max_message": 1048576, "peer_key": XF._key(),
		"handler": func(_a: Dictionary) -> String: return handler,
	}
	o.merge(opts, true)
	return PKeyPeerXfer.Machine.new(o)


static func _sha(n: int) -> String:
	var h := PKeyPeerXfer.new_hasher()
	h.update(XF._content(0, n))
	return h.finish().hex_encode()


func _offer_body(id: String, size: int, chunk: int) -> PackedByteArray:
	return PKeyPeerXfer.offer_body({"id": id, "size": size, "chunk": chunk, "sha256": _sha(size)})


func _order(t: PKeyTestContext) -> void:
	# A received transfer: effects before records before events, in each output.
	var rig := Rig.new(_machine("ask"))
	rig.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 10, 4))
	t.check("order: an OFFER asked about is an event and nothing else", rig.order == ["ask"])
	rig.order.clear()
	rig.ep.consent(ID_A, "accept")
	t.check("order: a consent is the effect, then the record", rig.order == ["effect", "record"], str(rig.order))
	rig.order.clear()
	rig.ep.cancel(ID_A)
	t.check("order: a cancel is the record after its effect, the event last", rig.order == ["effect", "record", "result"], str(rig.order))
	# A sent transfer: the offer, then the content once accepted, then DONE; the sizes are the chunk's.
	var tx := Rig.new(_machine())
	tx.ep.offer({"id": ID_B, "size": 10, "chunk": 4, "sha256": _sha(10)})
	tx.reset()
	tx.ep.receive(PKeyPeerXfer.ACCEPT, PKeyPeerXfer.offset_body(ID_B, 0))
	var sent := (tx.step["send"] as Array)
	t.check("order: the content goes out in chunks of the offer's size, then DONE", sent.size() == 4 and sent[0]["t"] == "CHUNKS"
			and sent[0]["bytes"] == 4 and sent[2]["bytes"] == 2 and sent[3]["t"] == "DONE", str(sent))
	var all := tx.order.filter(func(k: String) -> bool: return k == "record")
	t.check("order: an offer, three chunks and DONE are five records", all.size() == 5, str(all.size()))
	tx.ep.receive(PKeyPeerXfer.DONE, PKeyPeerXfer.done_body(ID_B))
	t.check("order: the sender's result is the last event", tx.order.back() == "result")


func _failures(t: PKeyTestContext) -> void:
	# A store that refuses an effect closes that session peer_bye, tells the host and ends the endpoint.
	var rig := Rig.new(_machine())
	rig.fail_apply = true
	rig.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 10, 4))
	t.check("failure: a refused effect closes the session peer_bye", rig.closes == [&"peer_bye"] and rig.errors == 1)
	t.check("failure: and ends the endpoint", rig.ep.is_dead() and rig.finished == 1)
	rig.ep.consent(ID_A, "accept")
	t.check("failure: a later call does nothing", rig.closes.size() == 1)
	# The machine never stays asking: a failing store while accepting reports the transfer closed.
	var asking := Rig.new(_machine("ask"))
	asking.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 10, 4))
	asking.fail_apply = true
	asking.ep.consent(ID_A, "accept")
	t.check("failure: consenting into a failing store closes the session", asking.closes == [&"peer_bye"] and asking.errors == 1)
	t.check("failure: and nothing is left live", asking.machine.live() == 0)
	# No room at accept: that one transfer is cancelled with quota, no ACCEPT goes out, the session stays.
	var full := Rig.new(_machine("ask"))
	full.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 10, 4))
	full.no_room = true
	full.reset()
	full.ep.consent(ID_A, "accept")
	var sent_full: Array = []
	for s in full.step["send"]:
		sent_full.append(String(s["t"]) + ":" + String(s.get("reason", "")))
	t.check("failure: no room at accept cancels that transfer with quota and sends no ACCEPT", sent_full == ["CANCEL:quota"], str(sent_full))
	t.check("failure: and the session stays", full.closes.is_empty() and full.errors == 0 and not full.ep.is_dead())
	t.check("failure: and nothing is left live or kept", full.machine.live() == 0 and full.machine.partials().is_empty())
	full.no_room = false
	full.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_B, 10, 4))
	t.check("failure: the next offer on the same session is asked", full.step["ask"] != null and full.step["ask"]["id"] == ID_B)
	# A record that cannot be sent is a session failure too.
	var tx := Rig.new(_machine())
	tx.fail_send = true
	tx.ep.offer({"id": ID_B, "size": 10, "chunk": 4, "sha256": _sha(10)})
	t.check("failure: a record that cannot be sent closes peer_bye", tx.closes == [&"peer_bye"] and tx.errors == 1 and tx.machine.live() == 0)
	# A source that cannot be read cancels the transfer without its DONE, and the session stays.
	var src := Rig.new(_machine())
	src.fail_read = true
	src.ep.offer({"id": ID_B, "size": 10, "chunk": 4, "sha256": _sha(10)})
	src.ep.receive(PKeyPeerXfer.ACCEPT, PKeyPeerXfer.offset_body(ID_B, 0))
	var kinds := (src.step["send"] as Array).map(func(s: Dictionary) -> String: return s["t"])
	t.check("failure: a source that cannot be read cancels without DONE", kinds.has("CANCEL") and not kinds.has("DONE") and not kinds.has("CHUNKS"), str(kinds))
	t.check("failure: and the session is not closed", src.closes.is_empty() and not src.ep.is_dead())
	var results: Array = src.step["results"]
	t.check("failure: the transfer reports cancelled", results.size() == 1 and results[0]["outcome"] == "cancelled")


func _queues(t: PKeyTestContext) -> void:
	# Records that arrive before bind are held, at most 16, then the session closes peer_busy.
	var closes: Array = []
	var held := PKeyPeerXferEndpoint.new({
		"close": func(c: StringName) -> void: closes.append(c), "budget_usec": 0,
		"timer": func(_s: float, _f: Callable) -> Callable: return Callable(),
	})
	var body := PKeyPeerXfer.offset_body(ID_A, 0)
	for i in PKeyPeerXferEndpoint.MAX_QUEUED_BEFORE_BIND:
		held.receive(PKeyPeerXfer.ACK, body)
	t.check("queue: sixteen records wait for bind", held.queued() == 16 and closes.is_empty())
	held.receive(PKeyPeerXfer.ACK, body)
	t.check("queue: the seventeenth closes the session peer_busy", closes == [&"peer_busy"] and held.is_dead())
	# Held records are processed in order once bound.
	var early := Rig.new(_machine())
	early.ep = early.make()
	early.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 10, 4))
	t.check("queue: nothing is performed before bind", early.order.is_empty() and early.ep.queued() == 1)
	early.ep.bind(early.machine)
	t.check("queue: a record held before bind is processed at bind", XF._same(early.step["send"], [{"t": "ACCEPT", "id": ID_A, "offset": 0}]))
	# A call made from inside a handler only queues; it runs after the current output.
	var m2 := _machine("ask")
	var holder: Array = [null]
	var chained := PKeyPeerXferEndpoint.new({
		"send": func(_ty: int, _b: PackedByteArray) -> PKeyResult: return PKeyResult.success(),
		"apply": func(_e: Dictionary) -> PKeyResult: return PKeyResult.success(),
		"budget_usec": 0, "timer": func(_s: float, _f: Callable) -> Callable: return Callable(),
		"events": {"ask": func(a: Dictionary) -> void: (holder[0] as PKeyPeerXferEndpoint).consent(a["id"], "accept")},
	})
	holder[0] = chained
	chained.bind(m2)
	chained.receive(PKeyPeerXfer.OFFER, _offer_body(ID_B, 10, 4))
	t.check("queue: an answer given inside the ask handler is taken after it", m2.live() == 1 and m2.partials().size() == 1 and not chained.is_dead())
	t.check("queue: and the queue is empty after", chained.queued() == 0)
	await Engine.get_main_loop().process_frame


func _offloading(t: PKeyTestContext) -> void:
	var rig := Rig.new(_machine(), Callable(self, "_x"))
	rig.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 10, 4))
	t.check("offload: an OFFER record is handled through offload", rig.offload_calls == 1 and XF._same(rig.step["send"], [{"t": "ACCEPT", "id": ID_A, "offset": 0}]))
	rig.ep.receive(PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(ID_A, 0, XF._content(0, 4)))
	t.check("offload: a chunk is not", rig.offload_calls == 1)
	var asking := Rig.new(_machine("ask"), Callable(self, "_x"))
	asking.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 10, 4))
	asking.ep.consent(ID_A, "accept")
	t.check("offload: accepting is, declining is not", asking.offload_calls == 2)
	asking.ep.consent(ID_B, "decline")
	t.check("offload: a decline stays on the main thread", asking.offload_calls == 2)
	# An effect that is a job (a finalize) runs through offload too, and its result decides.
	var jobs := [0]
	var job_rig := Rig.new(_machine(), Callable(self, "_x"))
	var o := {
		"send": Callable(job_rig, "_send"), "close": Callable(job_rig, "_close"), "read": Callable(job_rig, "_read"),
		"now": Callable(job_rig, "_now"), "budget_usec": 0, "offload": Callable(job_rig, "_offload"),
		"timer": Callable(job_rig, "_timer"),
		"apply": func(e: Dictionary) -> Variant:
			if e.has("finalize"):
				return func() -> PKeyResult:
					jobs[0] += 1
					return PKeyResult.success()
			return PKeyResult.success(),
		"events": {"result": func(r: Dictionary) -> void: job_rig._note("result", r)},
	}
	var ep := PKeyPeerXferEndpoint.new(o)
	var m := _machine()
	ep.bind(m)
	ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 4, 4))
	ep.receive(PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(ID_A, 0, XF._content(0, 4)))
	var calls_before := job_rig.offload_calls
	ep.receive(PKeyPeerXfer.DONE, PKeyPeerXfer.done_body(ID_A, _sha(4)))
	t.check("offload: a finalize runs as a job through offload", jobs[0] == 1 and job_rig.offload_calls == calls_before + 1, "%d %d" % [jobs[0], job_rig.offload_calls - calls_before])
	t.check("offload: and the result follows it", job_rig.step["results"] == [{"id": ID_A, "outcome": "delivered"}])
	# A job that fails ends the session like any refused effect.
	var bad := Rig.new(_machine(), Callable(self, "_x"))
	var closed_by: Array = []
	var ep2 := PKeyPeerXferEndpoint.new({
		"send": Callable(bad, "_send"), "close": func(c: StringName) -> void: closed_by.append(c), "budget_usec": 0,
		"apply": func(e: Dictionary) -> Variant:
			if e.has("finalize"):
				return func() -> PKeyResult: return PKeyResult.failure(&"store-failed", "no")
			return PKeyResult.success(),
		"timer": Callable(bad, "_timer"),
	})
	ep2.bind(bad.machine)
	ep2.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 4, 4))
	ep2.receive(PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(ID_A, 0, XF._content(0, 4)))
	ep2.receive(PKeyPeerXfer.DONE, PKeyPeerXfer.done_body(ID_A, _sha(4)))
	t.check("offload: a failing job closes the session peer_bye", closed_by == [&"peer_bye"] and ep2.is_dead())
	await Engine.get_main_loop().process_frame


func _x(work: Callable) -> Variant:
	return work.call()


func _closing(t: PKeyTestContext) -> void:
	# The session ended: every live transfer reports closed, a partial is kept, calls not yet taken are dropped.
	var rig := Rig.new(_machine("ask"))
	rig.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 10, 4))
	rig.ep.consent(ID_A, "accept")
	rig.reset()
	rig.ep.closed()
	t.check("closing: a live received transfer reports closed", rig.step["results"] == [{"id": ID_A, "outcome": "closed"}])
	t.check("closing: and its partial is kept", rig.step["partial"].size() == 1 and rig.step["partial"][0].has("keep"))
	t.check("closing: the endpoint is over and finished once", rig.ep.is_dead() and rig.finished == 1)
	rig.ep.closed()
	rig.ep.receive(PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(ID_A, 0, XF._content(0, 4)))
	t.check("closing: a second close and later records do nothing", rig.finished == 1 and rig.closes.is_empty())
	# Asking is withdrawn, not reported.
	var asking := Rig.new(_machine("ask"))
	asking.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 10, 4))
	asking.reset()
	asking.ep.closed()
	t.check("closing: a question still open is withdrawn", asking.step["withdraw"] == [ID_A] and (asking.step["results"] as Array).is_empty())
	# A session that ended is not a failure: a record that cannot be sent says nothing.
	var gone := Rig.new(_machine())
	gone.ep.offer({"id": ID_B, "size": 10, "chunk": 4, "sha256": _sha(10)})
	gone.fail_send = true
	gone.ep.closed()
	t.check("closing: an ended session is not reported as an error", gone.errors == 0 and gone.closes.is_empty())
	# A fault by the peer closes the session and ends the endpoint after the records of that output.
	var fault := Rig.new(_machine())
	fault.ep.receive(PKeyPeerXfer.ACK, PKeyPeerXfer.offset_body(ID_B, 0))
	t.check("closing: a record for an unknown id closes peer_bad_frame", fault.closes == [&"peer_bad_frame"] and fault.ep.is_dead() and fault.finished == 1)
	await Engine.get_main_loop().process_frame


func _receive_all(rig: Rig, id: String, size: int, chunk: int) -> void:
	rig.ep.receive(PKeyPeerXfer.OFFER, _offer_body(id, size, chunk))
	for off in range(0, size, chunk):
		rig.ep.receive(PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(id, off, XF._content(off, mini(size, off + chunk))))
	rig.ep.receive(PKeyPeerXfer.DONE, PKeyPeerXfer.done_body(id, _sha(size)))


func _delivery(t: PKeyTestContext) -> void:
	# Delivered memory records only delivered content: a refused finalize records nothing, a done one does.
	var mem := PKeyPeerXferDelivered.new()
	var key := XF._key()
	var opts := {"delivered": mem.for_peer(key)}
	var bad := Rig.new(_machine("accept", opts))
	bad.fail_apply = false
	_receive_all(bad, ID_A, 2500, 1000)
	t.check("delivery: a finalize that succeeds is remembered", mem.for_peer(key).has(ID_A, _sha(2500), 2500, bad.at))
	var mem2 := PKeyPeerXferDelivered.new()
	var failing := Rig.new(_machine("accept", {"delivered": mem2.for_peer(key)}))
	failing.ep.receive(PKeyPeerXfer.OFFER, _offer_body(ID_A, 2500, 1000))
	for off in range(0, 2500, 1000):
		failing.ep.receive(PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(ID_A, off, XF._content(off, mini(2500, off + 1000))))
	failing.fail_apply = true
	failing.ep.receive(PKeyPeerXfer.DONE, PKeyPeerXfer.done_body(ID_A, _sha(2500)))
	t.check("delivery: a finalize that fails closes the session", failing.closes == [&"peer_bye"])
	t.check("delivery: and records nothing", not mem2.for_peer(key).has(ID_A, _sha(2500), 2500, failing.at))


func _misc(t: PKeyTestContext) -> void:
	t.check("misc: an endpoint prints nothing", str(PKeyPeerXferEndpoint.new()) == "PKeyPeerXferEndpoint()")
	var e := PKeyPeerXferEndpoint.new({"budget_usec": 0})
	e.receive(0x0100, PackedByteArray())
	t.check("misc: a record that is not an xfer type is ignored", e.queued() == 0)
