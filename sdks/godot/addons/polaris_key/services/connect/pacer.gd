@tool
class_name PKeyConnectPacer
extends RefCounted
## Outgoing pacing for the relay socket (CC-14.14, decision D-9; WIRE-CONTRACT-V5 section 15.7, G17), ported
## from the Python `connect/pacer.py` and sdk-node's relay outbox. The room allows a client 200 messages a
## second with a burst of 400 and answers a client that exceeds it with LIMIT 1 and, if it persists, a close;
## this client stays under it:
##
##  - a token bucket on every outgoing envelope: 180 a second with a burst of 360 (0.9 of the room's
##    numbers);
##  - LIMIT 1 halves the rate for 10 seconds;
##  - the queue behind the socket holds at most 8 MiB (`Outbox`). A session message that would go beyond it
##    is refused, and the session ends `peer_busy`; handshake and control envelopes (and the last records of a
##    session that is closing) are forced in, since refusing one would stall a session without telling the
##    host.
##
## Pure bookkeeping over an injected clock: nothing here touches a socket.

const RATE := 180.0
const BURST := 360.0
const HALVED_SECONDS := 10.0
const MAX_QUEUED_BYTES := 8 * 1024 * 1024

var _rate: float
var _burst: float
var _clock: Callable
var _tokens: float
var _at: float
var _halved_until := -INF


## `clock` returns monotonic seconds (empty: the engine's tick counter).
func _init(rate := RATE, burst := BURST, clock: Callable = Callable()) -> void:
	_rate = rate
	_burst = burst
	_clock = clock
	_tokens = burst
	_at = _now()


func _to_string() -> String:
	return "PKeyConnectPacer()"


## The rate in force now: half the base rate while a LIMIT 1 is being honoured.
func rate() -> float:
	return _rate / 2.0 if _now() < _halved_until else _rate


## LIMIT 1: send at half the rate for `seconds`.
func halve(seconds := HALVED_SECONDS) -> void:
	_refill()
	_halved_until = _now() + seconds
	_tokens = minf(_tokens, _burst / 2.0)


## 0.0 when a token was taken; else how many seconds until one is available.
func try_take() -> float:
	_refill()
	if _tokens >= 1.0:
		_tokens -= 1.0
		return 0.0
	return (1.0 - _tokens) / rate()


func _refill() -> void:
	var now := _now()
	if now > _at:
		_tokens = minf(_burst, _tokens + (now - _at) * rate())
	_at = now


func _now() -> float:
	return float(_clock.call()) if _clock.is_valid() else float(Time.get_ticks_msec()) / 1000.0


## The envelopes waiting for the socket, with their byte count. `put` refuses (false) a non-forced item
## that would take the queue past `max_bytes`.
class Outbox extends RefCounted:
	var max_bytes: int
	var _q: Array[PackedByteArray] = []
	var _bytes := 0


	func _init(p_max_bytes := PKeyConnectPacer.MAX_QUEUED_BYTES) -> void:
		max_bytes = p_max_bytes


	func _to_string() -> String:
		return "PKeyConnectPacer.Outbox()"


	## Bytes queued.
	func queued() -> int:
		return _bytes


	func size() -> int:
		return _q.size()


	func is_empty() -> bool:
		return _q.is_empty()


	func room_for(n: int) -> bool:
		return _bytes + n <= max_bytes


	func put(data: PackedByteArray, force := false) -> bool:
		if not force and not room_for(data.size()):
			return false
		_q.append(data)
		_bytes += data.size()
		return true


	func pop() -> PackedByteArray:
		var data: PackedByteArray = _q.pop_front()
		_bytes -= data.size()
		return data
