class_name PKeyClock
extends RefCounted
## The monotonic clock floor (WIRE-CONTRACT-V3 §4.2): a port of `client-core/src/clock.ts`.
##
##   highWaterMark = max(issuedAt) over every RE-VERIFIED artifact: trust manifest, licence
##                   document and config document
##   effectiveNow  = max(systemClock, highWaterMark)
##
## A floor from one document alone is inert (`issuedAt < graceUntil` always), which is why the
## trust manifest is folded in. Never persisted: recomputed at load from the cached JWSs, raised
## on every accept. The system clock is `Time.get_unix_time_from_system()`, floored; tests and
## replays inject `now_source`.

## A Callable returning epoch seconds, or an empty Callable for the system clock.
var now_source: Callable
var _floor := 0.0


func _init(source: Callable = Callable()) -> void:
	now_source = source


static func high_water_mark(issued_ats: Array) -> float:
	var mark := 0.0
	for a in issued_ats:
		if PKeyClaims.is_number(a) and a > mark:
			mark = float(a)
	return mark


static func effective_now(system_now: float, floor_at: float) -> float:
	return maxf(system_now, floor_at)


## The system (or injected) clock, in whole epoch seconds.
func system_now() -> float:
	if now_source.is_valid():
		return float(now_source.call())
	return float(PKeyClaims.system_now())


## The time every gate comparison runs at.
func now() -> float:
	return effective_now(system_now(), _floor)


func high_water() -> float:
	return _floor


## Monotonic: only rises, and only from content whose signature was just checked.
func raise(issued_at: float) -> void:
	if issued_at > _floor:
		_floor = issued_at


## Only alongside wiping every artifact the floor was derived from.
func reset() -> void:
	_floor = 0.0
