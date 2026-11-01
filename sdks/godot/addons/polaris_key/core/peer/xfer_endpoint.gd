@tool
class_name PKeyPeerXferEndpoint
extends RefCounted
## WIRE-CONTRACT-V5 section 15.11: runs a `PKeyPeerXfer.Machine` over a session (CC-20b.G3). Ported from
## `packages/client-core/src/peer/xferEndpoint.ts` and Python `core/peer_xfer_endpoint.py`.
##
## The machine decides; this layer performs what it asks, in this order: effects on the partial files,
## then the records, then the events for the host. It reads the sender's bytes and stores the receiver's
## through ports. Nothing here knows a path, a key or a socket.
##
## Calls. `receive`, `offer`, `consent`, `cancel`, `tick` and `closed` only queue a call and start the
## drain. One drain coroutine takes the calls in order, so the machine and the ports are never used by two
## callers at once, and a host callback that calls back in (an `ask` handler that answers at once) only
## queues. A call that can re-read the kept bytes (an `OFFER` record, a consent to accept) and an effect
## that copies a whole file (`finalize`) leave the main thread through `offload` (PKeyPeerPump.offload;
## inline when there is none). While one runs the main thread touches neither the machine nor the store
## through this object. The only other thing a long transfer costs the frame is reading and sealing
## chunks: after `budget_usec` of that the drain waits a frame (`frame`; 0 turns it off).
##
## Failures. A source that cannot be read ends that transfer without its `DONE`. A store or session port
## that fails (an effect refused, a record that cannot be sent) closes the session `peer_bye`, keeps the
## partials, tells the host (`error`) and ends the endpoint: every live transfer reports `closed` and the
## machine never stays asking. A session that ended under it (`closed()`) is not a failure. Records that
## arrive before `bind` are held, at most MAX_QUEUED_BEFORE_BIND, and more close the session `peer_busy`;
## after it the same happens at MAX_QUEUED.
##
## Options (`_init`): `send` (Callable(type, body) -> PKeyResult), `close` (Callable(code)), `read`
## (Callable(id, offset, length) -> PackedByteArray, or anything else for a failure), `apply`
## (Callable(effect) -> PKeyResult, or a Callable job that returns one: the endpoint runs the job through
## `offload`), `events` ({ask, withdraw, result, refused, error, finished} Callables, all optional), `now`
## (Callable() -> epoch seconds), `timer` (Callable(seconds, fn) -> a Callable that cancels), `offload`,
## `frame` (Callable, a coroutine that waits one frame) and `budget_usec`.

const MAX_QUEUED_BEFORE_BIND := 16
const MAX_QUEUED := 256
const BUDGET_USEC := 8000

var _machine: PKeyPeerXfer.Machine = null
var _send: Callable
var _close: Callable
var _read: Callable
var _apply: Callable
var _events: Dictionary
var _now: Callable
var _timer: Callable
var _offload: Callable
var _frame: Callable
var _budget_usec := BUDGET_USEC
var _queue: Array = []
var _draining := false
var _dead := false
var _failed := false
var _gone := false
var _closed_sent := false
var _finished := false
var _chunk := {}
var _cancel_timer := Callable()
var _step_began := 0


func _init(options := {}) -> void:
	_send = options.get("send", Callable())
	_close = options.get("close", Callable())
	_read = options.get("read", Callable())
	_apply = options.get("apply", Callable())
	_events = options.get("events", {})
	_now = options.get("now", Callable())
	_timer = options.get("timer", Callable(self, "_scene_timer"))
	_offload = options.get("offload", Callable())
	_frame = options.get("frame", Callable())
	_budget_usec = int(options.get("budget_usec", BUDGET_USEC))
	if not _frame.is_valid() and _budget_usec > 0:
		_frame = Callable(self, "_next_frame")
	# The NFC tables load on first use; load them here, on the calling thread, before a worker reads them.
	PKeyDeviceLabel.clean_name("é")


func _to_string() -> String:
	return "PKeyPeerXferEndpoint()"


## Starts the machine's work: the records held so far are processed now.
func bind(machine: PKeyPeerXfer.Machine) -> void:
	if _machine != null or _dead:
		return
	_machine = machine
	_kick()


# -- the calls ----------------------------------------------------------------------------------


## A record of the session: one of the six types.
func receive(type: int, body: PackedByteArray) -> void:
	if _dead or not PKeyPeerXfer.is_xfer_type(type):
		return
	_enqueue({"k": "receive", "type": type, "body": body})


## The host sends an `OFFER` (the machine's `offer` arguments: `id`, `size`, `chunk`, `sha256`, and
## optionally `cat`, `name`, `type`, `seekable`). A refusal (too many live transfers, a bad argument) is
## the `refused` event.
func offer(a: Dictionary) -> void:
	if _dead:
		return
	_enqueue({"k": "offer", "a": a})


func consent(id: String, answer: String) -> void:
	if _dead:
		return
	_enqueue({"k": "consent", "id": id, "answer": answer})


func cancel(id: String) -> void:
	if _dead:
		return
	_enqueue({"k": "cancel", "id": id})


## The clock only moves (the timer calls this).
func tick() -> void:
	if _dead:
		return
	_enqueue({"k": "tick"})


## The session closed: every live transfer ends `closed` and the partials stay. Calls not yet taken are
## dropped.
func closed() -> void:
	if _gone:
		return
	_gone = true
	if _machine == null:
		_dead = true
		_queue.clear()
		_finish()
		return
	if _dead and _queue.is_empty() and not _draining:
		return
	_dead = true
	_disarm()
	_drop_pending()
	_queue.push_front({"k": "abandon"})
	_kick()


## True once the endpoint takes no more calls.
func is_dead() -> bool:
	return _dead


## The calls waiting.
func queued() -> int:
	return _queue.size()


# -- the drain ----------------------------------------------------------------------------------


func _enqueue(c: Dictionary) -> void:
	var cap := MAX_QUEUED if _machine != null else MAX_QUEUED_BEFORE_BIND
	if _queue.size() >= cap:
		_dead = true
		_queue.clear()
		_disarm()
		_close_session(&"peer_busy")
		if _machine != null:
			_queue.append({"k": "abandon"})
			_kick()
		else:
			_finish()
		return
	_queue.append(c)
	_kick()


func _kick() -> void:
	if _draining or _machine == null:
		return
	_draining = true
	await _drain()
	_draining = false
	if _dead and _queue.is_empty():
		_finish()


func _drain() -> void:
	while not _queue.is_empty():
		var c: Dictionary = _queue.pop_front()
		if _dead and c["k"] != "abandon":
			continue
		await _process(c)


func _drop_pending() -> void:
	_queue = _queue.filter(func(c: Dictionary) -> bool: return c["k"] == "abandon")


func _process(c: Dictionary) -> void:
	_step_began = Time.get_ticks_usec()
	var out: Dictionary = await _step(c)
	var offered := ""
	if c["k"] == "offer":
		offered = String((c["a"] as Dictionary).get("id", ""))
		if out["refused"] == "":
			_chunk[offered] = int((c["a"] as Dictionary)["chunk"])
	await _perform(out, offered)
	if _failed:
		return
	if out["close"] != &"":
		# A close ends the endpoint; the transfers still live report `closed` after it.
		_dead = true
		_disarm()
		_drop_pending()
		_close_session(out["close"])
		await _perform(_machine.abandon(_clock()), "")
	elif c["k"] == "abandon":
		_dead = true
		_disarm()
	else:
		_arm()


## The machine's answer to one call, from a worker thread when the call may re-read kept bytes.
func _step(c: Dictionary) -> Dictionary:
	var k: String = c["k"]
	var heavy: bool = (k == "receive" and c["type"] == PKeyPeerXfer.OFFER) or (k == "consent" and c["answer"] != "decline")
	if heavy and _offload.is_valid():
		var work := func() -> Dictionary: return _invoke(c)
		var out: Dictionary = await _offload.call(work)
		return out
	return _invoke(c)


func _invoke(c: Dictionary) -> Dictionary:
	var at := _clock()
	var out: Dictionary = PKeyPeerXfer.Machine.blank()
	match String(c["k"]):
		"receive":
			out = _machine.receive(at, c["type"], c["body"])
		"offer":
			out = _machine.offer(at, c["a"])
		"consent":
			out = _machine.consent(at, c["id"], c["answer"])
		"cancel":
			out = _machine.cancel(at, c["id"])
		"fail":
			out = _machine.fail(at, c["id"])
		"tick":
			out = _machine.tick(at)
		"abandon":
			out = _machine.abandon(at)
	return out


# -- performing an output ------------------------------------------------------------------------


## Effects, then records, then events. A failed port ends the session and skips the rest of this output.
func _perform(out: Dictionary, offered: String) -> void:
	var failed := {}
	if not _failed:
		for e: Dictionary in out["partial"]:
			var r: Variant = _apply.call(e) if _apply.is_valid() else null
			if r is Callable:
				r = await _worker(r)
			if r is PKeyResult and not (r as PKeyResult).ok:
				await _fail("the store refused an effect")
				return
		if _machine != null and not out["delivered"].is_empty():
			_machine.remember_delivered(out["delivered"], _clock())
		for s: Dictionary in out["send"]:
			if not await _perform_send(s, failed):
				return
	for id: String in out["withdraw"]:
		_emit("withdraw", [id])
	if out["ask"] != null:
		_emit("ask", [out["ask"]])
	if out["refused"] != "" and offered != "":
		_emit("refused", [offered, out["refused"]])
	for r: Dictionary in out["results"]:
		_emit("result", [r])
	for id: String in failed:
		if not _dead:
			_queue.push_front({"k": "fail", "id": id})


## False when a port failed.
func _perform_send(s: Dictionary, failed: Dictionary) -> bool:
	var t: String = s["t"]
	var id: String = s["id"]
	if (t == "CHUNKS" or t == "DONE") and failed.has(id):
		return true
	var type := PKeyPeerXfer.OFFER
	var body := PackedByteArray()
	match t:
		"OFFER":
			body = PKeyPeerXfer.offer_body(s)
		"ACCEPT":
			type = PKeyPeerXfer.ACCEPT
			body = PKeyPeerXfer.offset_body(id, int(s["offset"]))
		"ACK":
			type = PKeyPeerXfer.ACK
			body = PKeyPeerXfer.offset_body(id, int(s["offset"]))
		"DONE":
			type = PKeyPeerXfer.DONE
			body = PKeyPeerXfer.done_body(id, String(s.get("sha256", "")))
		"CANCEL":
			type = PKeyPeerXfer.CANCEL
			body = PKeyPeerXfer.cancel_body(id, String(s["reason"]))
		_:
			return await _send_chunks(s, failed)
	return await _write(type, body)


## The CHUNK records of one `CHUNKS` send. False when a port failed; a source that cannot be read marks the
## transfer failed (no `DONE` goes out for it) and is not a port failure.
func _send_chunks(s: Dictionary, failed: Dictionary) -> bool:
	var id: String = s["id"]
	var chunk: int = _chunk.get(id, 0)
	var at: int = s["offset"]
	var end: int = at + int(s["bytes"])
	while at < end:
		var n := mini(chunk, end - at)
		var data: Variant = _read.call(id, at, n) if _read.is_valid() else null
		if not data is PackedByteArray or (data as PackedByteArray).size() != n:
			failed[id] = true
			return true
		if not await _write(PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(id, at, data)):
			return false
		at += n
		if _frame.is_valid() and _budget_usec > 0 and Time.get_ticks_usec() - _step_began > _budget_usec:
			await _frame.call()
			_step_began = Time.get_ticks_usec()
	return true


func _write(type: int, body: PackedByteArray) -> bool:
	if _gone:
		return true
	var r: Variant = _send.call(type, body) if _send.is_valid() else null
	if r is PKeyResult and not (r as PKeyResult).ok:
		await _fail("a record could not be sent")
		return false
	return true


func _worker(job: Callable) -> Variant:
	if _offload.is_valid():
		return await _offload.call(job)
	return job.call()


## A port failed under the machine: tell the host, close the session, keep the partials. A session that
## had already ended says nothing.
func _fail(why: String) -> void:
	if _failed:
		return
	_failed = true
	_dead = true
	_disarm()
	_drop_pending()
	if not _gone:
		_emit("error", [why])
		_close_session(&"peer_bye")
	await _perform(_machine.abandon(_clock()), "")


func _close_session(code: StringName) -> void:
	if _closed_sent:
		return
	_closed_sent = true
	if _close.is_valid():
		_close.call(code)


func _emit(name: String, args: Array) -> void:
	var f: Variant = _events.get(name)
	if f is Callable and (f as Callable).is_valid():
		(f as Callable).callv(args)


func _finish() -> void:
	if _finished:
		return
	_finished = true
	_disarm()
	_emit("finished", [])


func _clock() -> float:
	return float(_now.call()) if _now.is_valid() else Time.get_unix_time_from_system()


# -- the clock ----------------------------------------------------------------------------------


func _disarm() -> void:
	var c := _cancel_timer
	_cancel_timer = Callable()
	if c.is_valid():
		c.call()


## One timer, set for the machine's next wait.
func _arm() -> void:
	_disarm()
	if _dead or _machine == null or not _timer.is_valid():
		return
	var at := _machine.next_deadline()
	if at < 0.0:
		return
	var cancel: Variant = _timer.call(maxf(0.0, at - _clock()), Callable(self, "_fire"))
	if cancel is Callable:
		_cancel_timer = cancel


func _fire() -> void:
	_cancel_timer = Callable()
	tick()


func _scene_timer(seconds: float, fn: Callable) -> Callable:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return Callable()
	var live := [true]
	tree.create_timer(seconds).timeout.connect(func() -> void:
		if live[0]:
			fn.call())
	return func() -> void: live[0] = false


func _next_frame() -> void:
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null:
		await tree.process_frame
