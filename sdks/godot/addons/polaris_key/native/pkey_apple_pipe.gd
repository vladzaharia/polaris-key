@tool
class_name PKeyApplePipe
extends PKeyPeerPipe
## A `PKeyPeerPipe` over a native Bonjour socket (CC-14b.5, D-16): the bytes cross on the Apple binary
## entry (`bj_send`, and `bj_data` events drained by `PKeyAppleMdns.poll`), never as JSON or base64.
## The Swift side owns the socket, the address rule (G6), the unauthenticated limits (G7) and the
## 30 s pre-admission close; this class only moves bytes.
##
## Flow control (both ways, bounded):
##  - in: Swift holds at most 256 KiB unread per pipe. `read()` hands over what arrived and returns the
##    credit (`bj_credit`) so reading resumes; a peer that sends faster than the host reads is stopped
##    by TCP. If more than MAX_IN accumulates anyway the pipe is aborted.
##  - out: `write` is accepted while Swift's queue (4 MiB) has room, as `PKeyPeerTcpPipe` does; a full
##    queue is `false` (the session ends `peer_busy`).
##
## A dialled pipe is `is_open` from the start and takes writes, which wait natively for the connection,
## as a connecting TCP pipe does. `close()` lets what is queued be sent; `abort()` drops it. An accepted
## pipe is admitted natively by `admit()` once its session is open (it then no longer counts against the
## pre-admission limits).

const MAX_IN := 1024 * 1024
const BIN_OK := 1
const BIN_NONE := 0

var _lane: PKeyAppleMdns
var _id := 0
var _in := PackedByteArray()
var _remote := ""
var _eof := false
var _closing := false
var _dead := false
var _opened := false
var _reason := ""


func _init(lane: PKeyAppleMdns = null, id := 0, remote := "", opened := false) -> void:
	_lane = lane
	_id = id
	_remote = remote
	_opened = opened
	if lane == null:
		_dead = true


func _to_string() -> String:
	return "PKeyApplePipe()"


## The native pipe id (not a secret, but nothing else about the socket is shown).
func id() -> int:
	return _id


## True once the connection is up (an accepted pipe starts up; a dialled one when `bj_open` arrives).
func is_connected_native() -> bool:
	return _opened and not _dead


## "" while it lives; why it ended: eof, error, refused, timeout, closed or unresolvable.
func end_reason() -> String:
	return _reason


func read() -> PackedByteArray:
	var out := _in
	_in = PackedByteArray()
	if not out.is_empty() and not _dead and _lane != null:
		_lane.credit(_id, out.size())
	return out


func write(bytes: PackedByteArray) -> bool:
	if _dead or _closing or _eof or _lane == null:
		return false
	if bytes.is_empty():
		return true
	return _lane.send(_id, bytes)


func is_open() -> bool:
	return not (_dead or _eof) or not _in.is_empty()


func close() -> void:
	if _closing or _dead or _lane == null:
		return
	_closing = true
	_lane.close_pipe(_id, false)
	_dead = true
	_lane.release(_id)


func abort() -> void:
	if _lane != null and not _dead:
		_lane.close_pipe(_id, true)
		_lane.release(_id)
	_dead = true
	_in = PackedByteArray()


func is_finished() -> bool:
	return _dead or (_eof and _in.is_empty())


func remote_address() -> String:
	return _remote


## Bytes received and not yet read.
func buffered() -> int:
	return _in.size()


## The session is open: the socket leaves the pre-admission limits.
func admit() -> void:
	if not _dead and _lane != null:
		_lane.admit(_id)


# ── called by the lane ─────────────────────────────────────────────────────────────────────


func _on_open() -> void:
	_opened = true


func _on_data(bytes: PackedByteArray) -> void:
	if _dead:
		return
	_in.append_array(bytes)
	if _in.size() > MAX_IN:
		abort()
		_reason = "overflow"


func _on_closed(reason: String) -> void:
	_eof = true
	_reason = reason
	if reason != "eof":
		_dead = true
		_in = PackedByteArray()
