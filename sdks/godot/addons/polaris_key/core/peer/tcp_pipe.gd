@tool
class_name PKeyPeerTcpPipe
extends PKeyPeerPipe
## A `PKeyPeerPipe` over a `StreamPeerTCP` (CC-14.10a), non-blocking both ways. Reads take at most
## 64 KiB a poll, and none while a chunk is still waiting unread (so a paused link leaves the rest in
## the kernel and the peer's window closes); writes go to a queue of at most 16 MiB that `poll`
## flushes with partial puts, so a slow peer never blocks a frame. `close` lets the queue drain, for at most a second, so the CLOSE
## record that names a session's end reaches the peer before the socket drops.
##
## The socket is left alone until `poll` finds it connected: a dial that is still connecting is
## `is_open` and takes writes, which wait in the queue.

const READ_CHUNK := 65536
const MAX_OUT := 16 * 1024 * 1024
const LINGER_MS := 1000

var _peer: StreamPeerTCP
var _in := PackedByteArray()
var _out := PackedByteArray()
var _dead := false
var _closing := false
var _linger_until := 0


## A pipe over a socket that is connected or connecting. Null when `peer` is not a live socket.
static func from_peer(peer: StreamPeerTCP) -> PKeyPeerTcpPipe:
	if peer == null or peer.get_status() == StreamPeerTCP.STATUS_NONE or peer.get_status() == StreamPeerTCP.STATUS_ERROR:
		return null
	return PKeyPeerTcpPipe.new(peer)


## Dials `host` and `port`. Null when the dial cannot start (a bad address, no network).
static func dial(host: String, port: int) -> PKeyPeerTcpPipe:
	var peer := StreamPeerTCP.new()
	if peer.connect_to_host(host, port) != OK:
		return null
	return PKeyPeerTcpPipe.new(peer)


func _init(peer: StreamPeerTCP = null) -> void:
	_peer = peer
	if _peer == null:
		_dead = true
	else:
		_peer.set_no_delay(true)


func _to_string() -> String:
	return "PKeyPeerTcpPipe()"


func poll() -> void:
	if _dead:
		return
	_peer.poll()
	match _peer.get_status():
		StreamPeerTCP.STATUS_CONNECTED:
			_pull()
			_flush()
		StreamPeerTCP.STATUS_CONNECTING:
			pass
		_:
			_dead = true
	if _closing and not _dead and (_out.is_empty() or Time.get_ticks_msec() >= _linger_until):
		_peer.disconnect_from_host()
		_dead = true


func read() -> PackedByteArray:
	var out := _in
	_in = PackedByteArray()
	return out


func write(bytes: PackedByteArray) -> bool:
	if _dead or _closing or _out.size() + bytes.size() > MAX_OUT:
		return false
	_out.append_array(bytes)
	if _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_flush()
	return true


func is_open() -> bool:
	return not _dead or not _in.is_empty()


func close() -> void:
	if _closing or _dead:
		return
	_closing = true
	_linger_until = Time.get_ticks_msec() + LINGER_MS


func abort() -> void:
	if _peer != null:
		_peer.disconnect_from_host()
	_dead = true
	_out = PackedByteArray()


func is_finished() -> bool:
	return _dead


func remote_address() -> String:
	return _peer.get_connected_host() if _peer != null else ""


## Bytes pulled from the socket and not yet read.
func buffered() -> int:
	return _in.size()


func remote_port() -> int:
	return _peer.get_connected_port() if _peer != null else 0


func _pull() -> void:
	# At most one chunk waits unread. A paused link reads nothing, so the rest stays in the kernel,
	# whose window then closes on the peer (R-6G B1); without this a paused link buffered every byte.
	var n := mini(_peer.get_available_bytes(), READ_CHUNK - _in.size())
	if n <= 0:
		return
	var got := _peer.get_partial_data(n)
	if got[0] != OK:
		_dead = true
		return
	_in.append_array(got[1])


func _flush() -> void:
	if _out.is_empty():
		return
	var put := _peer.put_partial_data(_out)
	if put[0] != OK:
		_dead = true
		return
	var sent: int = put[1]
	_out = _out.slice(sent) if sent < _out.size() else PackedByteArray()
