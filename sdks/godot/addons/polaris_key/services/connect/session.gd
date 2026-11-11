@tool
class_name PKeyConnectSession
extends RefCounted
## One open Cloud Connect session as the host sees it (CC-14.10b; WIRE-CONTRACT-V5 sections 15.5 and
## 15.6), ported from `ConnectSession` and `routeRecord` in sdk-node `connect/session.ts` and the
## Python `connect/session.py`.
##
## The engine (`PKeyPeerSession`) and its pipe binding (`PKeyPeerLink`) own the handshake, admission,
## records and rekey; this is the handle the host holds: `send`, `receive`, the `message` and `closed`
## signals, `close`. `link` is anything with `send_record`, `close` and, optionally, `pause`: a
## `PKeyPeerLink`, or the relay's session (CC-14.14).
##
## Rules this class keeps:
##  - the host sees only the APP range (0x0100 to 0x7FFF). An APP-critical type (0x8100 to 0xFFFD) it
##    cannot understand closes the session with `peer_unknown_critical`; other types the session does
##    not own are ignored (G9, `route_record`);
##  - the six Direct Transfer types (0x0020 to 0x0025) belong to the transfer layer: they reach the port
##    `attach_xfer` returned a writer for and nothing else (a session with `xfer/1` and no port closes
##    `peer_not_allowed`; a link session holds a few until Direct Transfer takes it), and the host's `send` and `send_record` refuse them;
##  - messages the host has not read yet are bounded (G10): the pipe pauses at 4 MiB queued and
##    resumes under 1 MiB; at 8 MiB, or at 256 queued messages, the session closes `peer_busy`; all
##    sessions together hold at most 32 MiB (`Budget`);
##  - every failure is a PKeyResult with a registered code and a reason (`PKeyConnectErrors.lan`);
##    nothing reaches the host before the session is open;
##  - `str()` names the peer and the path, never a key, a nonce or a record.
##
## Delivery. A message goes to the `message` signal when something is connected to it, else it is
## queued for `receive()`. The main thread only.

## A message, instead of queueing it, when something is connected to this signal.
signal message(type: int, body: PackedByteArray)
## The session ended, once. `code` is a `peer_*` close code, `handshake_failed` or `connection_lost`.
signal closed(code: StringName, by_peer: bool)
signal woke

const APP_DEFAULT_TYPE := 0x0100
const APP_FIRST := 0x0100
const APP_LAST := 0x7fff
const XFER_FIRST := 0x0020
const XFER_LAST := 0x0025
const CRITICAL_FIRST := 0x8100
const CRITICAL_LAST := 0xfffd
const MAX_QUEUED_MESSAGES := 256
const QUEUE_PAUSE_BYTES := 4 * 1024 * 1024
const QUEUE_RESUME_BYTES := 1024 * 1024
const QUEUE_MAX_BYTES := 8 * 1024 * 1024
const TOTAL_QUEUE_BYTES := 32 * 1024 * 1024
## Transfer records a link session receives before Direct Transfer has taken it (see `route_record`).
const MAX_HELD_XFER := 8
const MAX_HELD_XFER_BYTES := 1024 * 1024

## Process-wide, for sessions made without a budget of their own.
static var shared_budget := Budget.new()

var peer_device_id: String
var caps: Array
## The peer's HELLO display data {label?, platform, app, max_message}, authenticated in mode a.
var hello: Dictionary
var role: String
## The peer's static key (32 raw bytes), as certified by the handshake; empty until set.
var peer_static := PackedByteArray()
var remote_address: String
## "lan" or "relay".
var path: String
## A session opened under an inter-account link (mode c): {id, label?, categories?, pending?}, with no device id.
## Empty otherwise.
var contact: Dictionary = {}
## A one-way tag of the secret the session opened under (not the secret); "" for a session with no link.
var contact_tag := ""
## A session opened under a local link (mode l, section 15.12): {id, label?, categories}, with no device id. Empty otherwise.
var local: Dictionary = {}
## A one-way tag of the link secret the session opened under (not the secret); "" for a session with no local link.
var local_tag := ""

var _link: Object
var _budget: Budget
var _queue: Array = []
var _bytes := 0
var _paused := false
var _ended := false
var _xfer: Callable
var _held_xfer: Array = []
var _held_xfer_bytes := 0
var _end_code: StringName = &""
var _end_by_peer := false


func _init(p_link: Object, p_peer_device_id: String, p_caps: Array, p_hello: Dictionary, p_role: String,
		p_remote_address := "", p_path := "lan", p_budget: Budget = null) -> void:
	_link = p_link
	peer_device_id = p_peer_device_id
	caps = p_caps.duplicate()
	hello = p_hello.duplicate()
	role = p_role
	remote_address = p_remote_address
	path = p_path
	_budget = p_budget if p_budget != null else shared_budget


func _to_string() -> String:
	return "PKeyConnectSession(peer=%s path=%s role=%s)" % [peer_device_id, path, role]


## True once the session has ended.
func is_closed() -> bool:
	return _ended


## Why it ended, {code, by_peer}; an empty Dictionary while it is open.
func closed_info() -> Dictionary:
	return {"code": _end_code, "by_peer": _end_by_peer} if _ended else {}


## Send one message (up to the peer's `max_message`, at most 1 MiB) as an APP record. ok, or a LAN
## failure: `bad_type` (not 0x0100 to 0x7FFF), `closed`, `too_large`.
func send(body: PackedByteArray, type := APP_DEFAULT_TYPE) -> PKeyResult:
	if type < APP_FIRST or type > APP_LAST:
		return PKeyConnectErrors.lan("bad_type", "Application types are 0x0100 to 0x7FFF.")
	return _send(type, body)


## Send a record of any type the session does not own (a peer document, a later transfer type). The
## engine refuses HELLO, CLOSE, REKEY and SAS records.
func send_record(type: int, body: PackedByteArray) -> PKeyResult:
	if type >= XFER_FIRST and type <= XFER_LAST:
		return PKeyConnectErrors.lan("bad_type", "Transfer records belong to the transfer layer.")
	return _send(type, body)


## The transfer port (section 15.11): `on_record` (Callable(type, body)) becomes the one reader of the six
## xfer types, and the answer is their one writer (Callable(type, body) -> PKeyResult). Only for an open
## session that lists `xfer/1`, and once; otherwise the answer is an empty Callable.
func attach_xfer(on_record: Callable) -> Callable:
	if _ended or _link == null or _xfer.is_valid() or not caps.has(PKeyPeerXfer.CAP) or not on_record.is_valid():
		return Callable()
	_xfer = on_record
	return Callable(self, "_write_xfer")


## Hand the transfer port the records that came in before it was taken (a link session is taken by Direct
## Transfer after its link has been checked, a moment after the peer may have started).
func flush_xfer() -> void:
	var held := _held_xfer
	_held_xfer = []
	_held_xfer_bytes = 0
	for r: Array in held:
		if _xfer.is_valid():
			_xfer.call(r[0], r[1])


func _hold_xfer(type: int, body: PackedByteArray) -> bool:
	if _ended or (contact.is_empty() and local.is_empty()) or not caps.has(PKeyPeerXfer.CAP) or _xfer.is_valid():
		return false
	if _held_xfer.size() >= MAX_HELD_XFER or _held_xfer_bytes + body.size() > MAX_HELD_XFER_BYTES:
		return false
	_held_xfer.append([type, body])
	_held_xfer_bytes += body.size()
	return true


func _write_xfer(type: int, body: PackedByteArray) -> PKeyResult:
	if type < XFER_FIRST or type > XFER_LAST:
		return PKeyConnectErrors.lan("bad_type", "Not a transfer type.")
	return _send(type, body)


func _send(type: int, body: PackedByteArray) -> PKeyResult:
	if _ended or _link == null:
		return PKeyConnectErrors.lan("closed", "The session is closed.")
	var r: PKeyResult = _link.send_record(type, body)
	if r.ok:
		return r
	if r.code == &"too_large":
		return PKeyConnectErrors.lan("too_large", "The message is larger than the peer accepts.")
	return PKeyConnectErrors.lan("closed", "The session is closed.")


## The next message: ok with {type, body}. Fails (`closed`) when the session ends with none waiting.
## A coroutine.
func receive() -> PKeyResult:
	while true:
		if not _queue.is_empty():
			var m: Dictionary = _queue.pop_front()
			var size: int = (m["body"] as PackedByteArray).size()
			_bytes -= size
			_budget.release(size)
			if _paused and _bytes < QUEUE_RESUME_BYTES:
				_paused = false
				_pause(false)
			return PKeyResult.success(m)
		if _ended:
			break
		await woke
	return PKeyConnectErrors.lan("closed", "The session is closed.")


## Close with `peer_bye` (or `peer_busy`, or `peer_revoked` for a link that was removed); the CLOSE record is
## sent first.
func close(code: StringName = PKeyPeerSession.PEER_BYE) -> void:
	if _link != null and not _ended:
		_link.close(code if code == PKeyPeerSession.PEER_BUSY or code == PKeyPeerSession.PEER_REVOKED else PKeyPeerSession.PEER_BYE)


## A newer roster was stored: the session ends `peer_revoked` when it no longer lists the peer.
func recheck(ring_jws: String) -> void:
	if not _ended and _link != null and _link.has_method("recheck"):
		_link.recheck(ring_jws)


## The link's call: one APP-range message arrived.
func deliver(type: int, body: PackedByteArray) -> void:
	if _ended:
		return
	if not message.get_connections().is_empty():
		message.emit(type, body)
		return
	if _queue.size() >= MAX_QUEUED_MESSAGES or _bytes + body.size() > QUEUE_MAX_BYTES or not _budget.reserve(body.size()):
		_busy()
		return
	_queue.append({"type": type, "body": body})
	_bytes += body.size()
	if not _paused and _bytes > QUEUE_PAUSE_BYTES:
		_paused = true
		_pause(true)
	woke.emit()


## The link's call: the session is over. Drops the queue and lets go of the link.
func ended(code: StringName, by_peer: bool) -> void:
	if _ended:
		return
	_ended = true
	_end_code = code
	_end_by_peer = by_peer
	_budget.release(_bytes)
	_queue = []
	_bytes = 0
	_link = null
	_xfer = Callable()
	_held_xfer = []
	_held_xfer_bytes = 0
	woke.emit()
	closed.emit(code, by_peer)


func _pause(on: bool) -> void:
	if _link != null and _link.has_method("pause"):
		_link.pause(on)


func _busy() -> void:
	if _link != null:
		_link.close(PKeyPeerSession.PEER_BUSY)


## A record the engine hands up: the APP range goes to the host's session; an APP-critical type
## (0x8100 to 0xFFFD) the host cannot understand closes the session; the rest is ignored.
static func route_record(link: Object, session: PKeyConnectSession, type: int, body: PackedByteArray) -> void:
	if type >= APP_FIRST and type <= APP_LAST:
		if session != null:
			session.deliver(type, body)
	elif type >= XFER_FIRST and type <= XFER_LAST:
		# The capability was checked by the engine; a port is there or the host listed it for nothing.
		if session != null and session._xfer.is_valid():
			session._xfer.call(type, body)
		elif session != null and session._hold_xfer(type, body):
			pass
		else:
			link.close(PKeyPeerSession.PEER_NOT_ALLOWED)
	elif type >= CRITICAL_FIRST and type <= CRITICAL_LAST:
		link.close(PKeyPeerSession.PEER_UNKNOWN_CRITICAL)


## The bytes all sessions together may hold unread.
class Budget extends RefCounted:
	var limit: int
	var used := 0


	func _init(p_limit := PKeyConnectSession.TOTAL_QUEUE_BYTES) -> void:
		limit = p_limit


	func _to_string() -> String:
		return "PKeyConnectSession.Budget()"


	func reserve(n: int) -> bool:
		if used + n > limit:
			return false
		used += n
		return true


	func release(n: int) -> void:
		used = maxi(0, used - n)
