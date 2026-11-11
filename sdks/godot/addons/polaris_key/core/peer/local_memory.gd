@tool
class_name PKeyPeerLocalMemory
extends RefCounted
## WIRE-CONTRACT-V5 section 15.12, "The code": the nameplates this device showed for one product in windows that
## closed less than `SECONDS` (300) ago, in memory, ported from `NameplateMemory` in
## `packages/client-core/src/peer/local.ts`. The shower's draw skips them, so a renewed window never reuses the
## nameplate of the window just closed, whose dials a joiner may have spent. Hold one per product for the life of
## the process. Times are monotonic seconds.

const SECONDS := 300

var _closed := {}


func _to_string() -> String:
	return "PKeyPeerLocalMemory(%d)" % _closed.size()


## The window that showed `nameplate` closed at the monotonic time `t`.
func shown(nameplate: String, t: float) -> void:
	_closed[nameplate] = maxf(t, float(_closed.get(nameplate, t)))


## The nameplates of windows that closed less than 300 s before `t`.
func recent(t: float) -> Array:
	for n: String in _closed.keys():
		if t - float(_closed[n]) >= SECONDS:
			_closed.erase(n)
	return _closed.keys()


## The shower's draw, in two tiers. First among the nameplates this memory does not hold: the adverts of other
## windows are not authenticated, so they never steer it. Only when it holds all 100, the one that closed longest
## ago (the lowest on a tie), with no byte read. "" when the source runs out.
func draw(source: Callable, t: float) -> String:
	var held := recent(t)
	if held.size() < 100:
		return PKeyPeerLocal.draw_nameplate(source, held)
	var keys := _closed.keys()
	keys.sort()
	var best := ""
	var at := INF
	for n: String in keys:
		if float(_closed[n]) < at:
			best = n
			at = float(_closed[n])
	return best


## The SDK's renewal floor (section 15.12, "The code"): refuse a new window for this long after a hard end. One
## per product for the life of the process, beside the dial budget. After a `too-many-tries` end, or the second
## `wrong-code` end within 600 s, no window opens for 30 s, so a host that renews with no person cannot give a
## guesser windows at machine speed. Times are monotonic seconds. In memory only.
class RenewFloor extends RefCounted:
	const COOLDOWN_SECONDS := 30
	const WRONG_SECONDS := 600
	const WRONG_LIMIT := 2

	var _until := -INF
	var _wrong: Array[float] = []


	func _to_string() -> String:
		return "PKeyPeerLocalMemory.RenewFloor()"


	## A window ended at `t`: "too-many-tries" (the fifth failed guess) or "wrong-code" (any other end of a
	## window that had counted a failed guess, a renewal's replacement included).
	func ended(end: String, t: float) -> void:
		if end == "wrong-code":
			var kept: Array[float] = []
			for w in _wrong:
				if t - w < WRONG_SECONDS:
					kept.append(w)
			kept.append(t)
			_wrong = kept
			if _wrong.size() < WRONG_LIMIT:
				return
		_until = maxf(_until, t + COOLDOWN_SECONDS)


	## Whether a window may open at `t`, and else the whole seconds until it may: {allowed, retry_in}.
	func check(t: float) -> Dictionary:
		if t >= _until:
			return {"allowed": true, "retry_in": 0}
		return {"allowed": false, "retry_in": ceili(_until - t)}
