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
## Message 1s a minute one source group may send a listener that holds no account key (section 15.10).
const GROUP_PER_MINUTE := 2

var _max_per_minute: int
var _max_pending: int
var _clock: Callable
var _stamps: Array[float] = []
var _pending := 0
var _group_max := GROUP_PER_MINUTE
## Per source group, the message 1s of the last minute (`begin_local`).
var _groups := {}
## The shared listener's trial runs on a worker task (CC-19b.G2), so the counters are guarded.
var _lock := Mutex.new()


## `clock` returns monotonic seconds (empty: the engine's tick counter).
func _init(max_per_minute := 5, max_pending := 4, clock: Callable = Callable(), group_max := GROUP_PER_MINUTE) -> void:
	_max_per_minute = max_per_minute
	_max_pending = max_pending
	_clock = clock
	_group_max = group_max


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


## The admission of a listener that holds no account key (section 15.10, "Admission"): the group's budget
## (`group_max` a minute, counted as the message 1 arrives) comes first, then the shared limit, which counts only
## failed trials (and the sessions waiting on message 3). A refusal costs no trial. Answers {ok = false, by =
## "group" | "shared"}, or {ok = true, admission} whose `hit()` refunds the group's count, takes a waiting slot
## and answers its Ticket, and whose `miss()` spends the shared budget.
func begin_local(group: String) -> Dictionary:
	var t := _now()
	_lock.lock()
	var kept: Array[float] = []
	for s in _stamps:
		if t - s < WINDOW_SECONDS:
			kept.append(s)
	_stamps = kept
	for g: String in _groups.keys():
		var live: Array = (_groups[g] as Array).filter(func(s: float) -> bool: return t - s < WINDOW_SECONDS)
		if live.is_empty():
			_groups.erase(g)
		else:
			_groups[g] = live
	var mine: Array = _groups.get(group, [])
	var by := ""
	if mine.size() >= _group_max:
		by = "group"
	elif _stamps.size() >= _max_per_minute or _pending >= _max_pending:
		by = "shared"
	if by != "":
		_lock.unlock()
		return {"ok": false, "by": by}
	mine.append(t)
	_groups[group] = mine
	_lock.unlock()
	return {"ok": true, "admission": LocalAdmission.new(self, group, t)}


func _now() -> float:
	return float(_clock.call()) if _clock.is_valid() else float(Time.get_ticks_msec()) / 1000.0


func _take_local(group: String, at: float) -> Ticket:
	_lock.lock()
	var live: Array = _groups.get(group, [])
	var i := live.rfind(at)
	if i >= 0:
		live.remove_at(i)
		if live.is_empty():
			_groups.erase(group)
	_pending += 1
	_lock.unlock()
	return Ticket.new(self)


func _spend_failed() -> void:
	var t := _now()
	_lock.lock()
	_stamps.append(t)
	_lock.unlock()


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


## One message 1 the listener admitted: its trial's verdict is `hit()` or `miss()`, once.
class LocalAdmission extends RefCounted:
	var _owner: PKeyPeerLimiter
	var _group: String
	var _at: float
	var _settled := false


	func _init(owner: PKeyPeerLimiter, group: String, at: float) -> void:
		_owner = owner
		_group = group
		_at = at


	func _to_string() -> String:
		return "PKeyPeerLimiter.LocalAdmission()"


	## The trial opened: the group's count is refunded and a waiting slot is taken. The Ticket gives it back; a
	## second verdict answers null.
	func hit() -> Ticket:
		if _settled:
			return null
		_settled = true
		return _owner._take_local(_group, _at)


	## The trial failed: the shared budget is spent.
	func miss() -> void:
		if _settled:
			return
		_settled = true
		_owner._spend_failed()
