@tool
class_name PKeyConnectRelayPipe
extends PKeyPeerPipe
## The pipe of a relay session (CC-14.14): the room delivers whole Noise messages (`deliver`) and takes whole ones
## (`write` is what the link frames, un-framed here and sent as a SEND envelope through `sender`). The messages
## the room delivered and the link has not read wait here, counted in a budget shared by every session (G10);
## `read` hands the link at most one 64 KiB chunk of whole frames a poll, as the TCP pipe does, or the one frame
## when it is larger.

## Unread messages one session may hold before it ends `peer_busy`.
const MAX_BUFFER := 9 * 1024 * 1024
const READ_CHUNK := 65536

var peer := PackedByteArray()
var session_id := 0
## Callable(peer, session_id, noise, force) -> bool: queue a SEND; false when the queue refuses it.
var sender: Callable
## Callable() -> bool: the session is closing, so its last records are never refused.
var closing: Callable

## The bytes of every session's unread messages count here (G10), beside the sessions' own queues.
var budget: PKeyConnectSession.Budget

var _q: Array[PackedByteArray] = []
var _queued := 0
var _reader := PKeyPeerFrame.Reader.new()
var _open := true


func _to_string() -> String:
	return "PKeyConnectRelay.RelayPipe()"


## One Noise message from the room. False when too much waits unread.
func deliver(noise: PackedByteArray) -> bool:
	var frame := PKeyPeerFrame.encode(noise)
	if frame.is_empty() or _queued + frame.size() > MAX_BUFFER:
		return false
	if budget != null and not budget.reserve(frame.size()):
		return false
	_q.append(frame)
	_queued += frame.size()
	return true


## At most one 64 KiB chunk of whole frames, or the one frame when it is larger; the rest waits.
func read() -> PackedByteArray:
	if _q.is_empty():
		return PackedByteArray()
	var out := _q.pop_front()
	while not _q.is_empty() and out.size() + _q[0].size() <= READ_CHUNK:
		out.append_array(_q.pop_front())
	_queued -= out.size()
	if budget != null:
		budget.release(out.size())
	return out


## Let the unread messages go (and their share of the budget).
func release() -> void:
	if budget != null:
		budget.release(_queued)
	_q = []
	_queued = 0


func write(bytes: PackedByteArray) -> bool:
	if not _open:
		return false
	var cut := _reader.push(bytes)
	if not cut["ok"]:
		return false
	var force: bool = closing.is_valid() and bool(closing.call())
	for noise: PackedByteArray in cut["frames"]:
		if not bool(sender.call(peer, session_id, noise, force)):
			return false
	return true


func is_open() -> bool:
	return _open or not _q.is_empty()


## The room dropped the peer or the socket went: the link ends `connection_lost`.
func lost() -> void:
	_open = false


func close() -> void:
	_open = false
	release()


func abort() -> void:
	_open = false
	release()


func is_finished() -> bool:
	return not _open


func remote_address() -> String:
	return "relay"
