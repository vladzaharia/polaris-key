@tool
class_name PKeyPeerLink
extends RefCounted
## One `PKeyPeerSession` bound to one `PKeyPeerPipe` (CC-14.10a), ported from sdk-node's `SocketLink`
## (`connect/session.ts`). The link frames what the session sends (`u16be length || Noise message`),
## cuts what the pipe delivers into frames with `PKeyPeerFrame.Reader`, feeds them to the session in
## order and runs the clocks. It is polled once a frame, by a `PKeyPeerPump`.
##
## Rules this class keeps:
##  - a frame longer than HANDSHAKE_FRAME_MAX (16 KiB) before the session is established closes it
##    `handshake_failed`; a zero-length frame, wherever it occurs, closes it `peer_bad_frame`;
##  - a link that has not established within HANDSHAKE_MS (30 s, a monotonic clock) is closed
##    `peer_timeout`;
##  - work per poll is bounded (R-6G N1): frames are fed to the session until BUDGET_BYTES of them or
##    BUDGET_USEC have gone in, at least one; the rest wait in a backlog, and the pipe is not read again
##    until the backlog is empty, so what a busy peer sends waits in the transport, not in memory;
##  - a write the pipe refuses (its queue is full) ends the link `peer_busy` and refuses later sends
##    (R-6G N2): a frame is never lost under a counter that went on;
##  - a pipe that goes away under a live session closes it, and the `closed` signal then says
##    `connection_lost`; frames that arrived before the pipe closed are still handled first;
##  - backpressure: `pause(true)` stops reading the pipe, so the peer's data waits in the transport;
##  - nothing reaches a signal before the session says so, and no signal carries a key, certificate
##    or Noise message.
##
## A session event becomes the signal of the same name. The session's callbacks are Callables on this
## object, which hold no reference to it, so a link and its session do not keep each other alive.

## The session is established (modes v and p: the code is still to come). `info` is the session's
## `established` event.
signal established(info: Dictionary)
## A record the host owns, once the session is open.
signal record(record_type: int, body: PackedByteArray)
## Modes v and p: the code both screens show.
signal sas(code: int, display: String)
## Mode a: a roster that replaced the held one at `epoch`; the host stores it.
signal ring(jws: String, epoch: int)
## Mode a: a `TRUST` document the peer sent. Not verified here.
signal trust(jws: String)
## Mode a: the peer is on a newer roster than the held one.
signal ring_wanted
## The link ended, once. `code` is a `peer_*` close code, `handshake_failed` or `connection_lost`.
signal closed(code: StringName, by_peer: bool)

const HANDSHAKE_FRAME_MAX := 16384
const HANDSHAKE_MS := 30000
## Frame bytes and microseconds one poll spends on one link (the first frame is always taken).
const BUDGET_BYTES := 16384
const BUDGET_USEC := 6000
const CONNECTION_LOST := &"connection_lost"

var session: PKeyPeerSession

var _pipe: PKeyPeerPipe
var _reader := PKeyPeerFrame.Reader.new()
var _mono_ms: Callable
var _deadline_ms := 0
var _established := false
var _ended := false
var _lost := false
var _paused := false
var _destroyed := false
var _backlog: Array = []
var _send_failed := false
var _usec: Callable


## A link over `pipe` for the session `session_options` describe (see PKeyPeerSession; `send` and
## `on_event` are the link's own). `options`: `pump` (its `offload` becomes the session's), `mono_ms`
## (a Callable returning monotonic milliseconds), `handshake_ms`. ok with the link.
static func create(pipe: PKeyPeerPipe, session_options: Dictionary, options := {}) -> PKeyResult:
	if pipe == null:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "Peer link: no pipe.")
	var link := PKeyPeerLink.new(pipe, options)
	var o := session_options.duplicate()
	o["send"] = Callable(link, "_on_send")
	o["on_event"] = Callable(link, "_on_event")
	var pump: Variant = options.get("pump")
	if pump is PKeyPeerPump and not o.has("offload"):
		o["offload"] = Callable(pump, "offload")
	var made := PKeyPeerSession.create(o)
	if not made.ok:
		return made
	link.session = made.detail
	return PKeyResult.success(link)


func _init(pipe: PKeyPeerPipe, options := {}) -> void:
	_pipe = pipe
	_mono_ms = options.get("mono_ms", Callable())
	_usec = options.get("usec", Callable())
	_deadline_ms = _mono() + int(options.get("handshake_ms", HANDSHAKE_MS))


func _to_string() -> String:
	return "PKeyPeerLink()"


## The initiator: write message 1. A coroutine. A responder's link needs no start.
func start() -> void:
	await session.start()


func is_established() -> bool:
	return _established


func is_ended() -> bool:
	return _ended


## Stop (true) or resume (false) reading the pipe.
func pause(on: bool) -> void:
	_paused = on


func is_paused() -> bool:
	return _paused


## Send one host record. See PKeyPeerSession.send_record.
func send_record(type: int, body: PackedByteArray) -> PKeyResult:
	if _send_failed:
		return PKeyResult.failure(&"state", "The connection cannot take more.")
	return session.send_record(type, body)


## Close the session with a code (it sends CLOSE once it can) and, once the CLOSE has gone, the pipe.
func close(code: StringName = PKeyPeerSession.PEER_BYE) -> void:
	session.close(code)


## Drop the pipe now, with no goodbye (the sign-out bound's force path).
func destroy() -> void:
	_destroyed = true
	_pipe.abort()
	_backlog = []
	# The session lets go of its clocks, its approver slot and its secrets (R-6G N3).
	session.abort()
	if not _ended:
		_ended = true
		closed.emit(PKeyPeerSession.PEER_BYE, false)


## One round of work, once a frame. False when the link is finished and the pump can let go of it.
func poll() -> bool:
	if _destroyed:
		return false
	_pipe.poll()
	if not _ended:
		_read()
		if not _ended and _deadline_ms > 0 and _mono() >= _deadline_ms:
			_deadline_ms = 0
			session.close(PKeyPeerSession.PEER_TIMEOUT)
		if not _ended and _send_failed and not _lost and _pipe.is_open():
			session.close(PKeyPeerSession.PEER_BUSY)
		session.tick()
		if not _ended and not _lost and _backlog.is_empty() and not _pipe.is_open():
			_lost = true
			session.close(PKeyPeerSession.PEER_BYE)
	if _ended:
		_pipe.close()
		return not _pipe.is_finished()
	return true


func _read() -> void:
	if _paused:
		return
	if _backlog.is_empty():
		var chunk := _pipe.read()
		if chunk.is_empty():
			return
		var cut := _reader.push(chunk)
		if not cut["ok"]:
			session.close(PKeyPeerSession.PEER_BAD_FRAME)
			return
		_backlog = cut["frames"]
	var began := _micros()
	var bytes := 0
	while not _backlog.is_empty() and not _paused and not _ended:
		var frame: PackedByteArray = _backlog.pop_front()
		if not _established and frame.size() > HANDSHAKE_FRAME_MAX:
			_backlog = []
			session.close(PKeyPeerSession.HANDSHAKE_FAILED)
			return
		# The session queues what it cannot take yet and keeps the order.
		session.receive(frame)
		bytes += frame.size()
		if bytes >= BUDGET_BYTES or _micros() - began >= BUDGET_USEC:
			break
	if _ended:
		_backlog = []


func _micros() -> int:
	return int(_usec.call()) if _usec.is_valid() else Time.get_ticks_usec()


func _on_send(noise: PackedByteArray) -> void:
	var frame := PKeyPeerFrame.encode(noise)
	if not frame.is_empty() and not _pipe.write(frame):
		_send_failed = true


func _on_event(e: Dictionary) -> void:
	match e["type"]:
		&"established":
			_established = true
			_deadline_ms = 0
			established.emit(e)
		&"sas":
			sas.emit(e["code"], e["display"])
		&"record":
			record.emit(e["record_type"], e["body"])
		&"ring":
			ring.emit(e["jws"], e["epoch"])
		&"trust_unverified":
			trust.emit(e["jws"])
		&"ring_wanted":
			ring_wanted.emit()
		&"closed":
			_finish(e["code"], e["by_peer"])


func _finish(code: StringName, by_peer: bool) -> void:
	if _ended:
		return
	_ended = true
	_deadline_ms = 0
	closed.emit(CONNECTION_LOST if _lost and not by_peer else code, by_peer)


func _mono() -> int:
	return int(_mono_ms.call()) if _mono_ms.is_valid() else Time.get_ticks_msec()
