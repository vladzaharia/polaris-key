@tool
class_name PKeyPeerLimiter
extends RefCounted
## The approver's admission (WIRE-CONTRACT-V5 section 15.6, CC-14.9; sdk-node `HandshakeLimiter`): at
## most `max_per_minute` handshakes a minute per advert (default 5) and at most `max_pending`
## sessions waiting on a code (default 4). One limiter belongs to one advert.
##
## The clock is monotonic (`Time.get_ticks_msec`), never the wall clock, so a clock change cannot
## reopen the window. An attempt counts only when `begin()` is called, which a session does when its
## first message arrives. `begin()` answers a Ticket while one more session may start, null when it
## may not. The ticket's `release()` ends the wait (a person confirmed, or the session ended); it is
## idempotent.

const WINDOW_SECONDS := 60.0

var _max_per_minute: int
var _max_pending: int
var _clock: Callable
var _stamps: Array[float] = []
var _pending := 0
## The shared listener's trial runs on a worker task (CC-19b.G2), so the counters are guarded.
var _lock := Mutex.new()


## `clock` returns monotonic seconds (empty: the engine's tick counter).
func _init(max_per_minute := 5, max_pending := 4, clock: Callable = Callable()) -> void:
	_max_per_minute = max_per_minute
	_max_pending = max_pending
	_clock = clock


func _to_string() -> String:
	return "PKeyPeerLimiter()"


## Sessions that have begun and not been released.
func pending() -> int:
	_lock.lock()
	var n := _pending
	_lock.unlock()
	return n


## A Ticket when one more session may start now; null when it may not.
func begin() -> Ticket:
	var t := _now()
	_lock.lock()
	var kept: Array[float] = []
	for s in _stamps:
		if t - s < WINDOW_SECONDS:
			kept.append(s)
	_stamps = kept
	if _stamps.size() >= _max_per_minute or _pending >= _max_pending:
		_lock.unlock()
		return null
	_stamps.append(t)
	_pending += 1
	_lock.unlock()
	return Ticket.new(self)


func _now() -> float:
	return float(_clock.call()) if _clock.is_valid() else float(Time.get_ticks_msec()) / 1000.0


func _release() -> void:
	_lock.lock()
	_pending = maxi(0, _pending - 1)
	_lock.unlock()


## One waiting session's slot.
class Ticket extends RefCounted:
	var _owner: PKeyPeerLimiter
	var _done := false


	func _init(owner: PKeyPeerLimiter) -> void:
		_owner = owner


	func _to_string() -> String:
		return "PKeyPeerLimiter.Ticket()"


	func release() -> void:
		if _done:
			return
		_done = true
		_owner._release()
