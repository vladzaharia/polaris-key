@tool
class_name PKeyPeerLocalWindow
extends RefCounted
## WIRE-CONTRACT-V5 section 15.12, "The pairing window": the shower's window over events with a monotonic time in
## seconds, ported from `PairingWindow` in `packages/client-core/src/peer/local.ts`. No I/O and no clock of its own.
##
## A C1 that is admitted hands out an attempt id; one attempt holds the window from its C1 until its guess or
## `ATTEMPT_SECONDS`. A guess is counted before its tag is tried: the session asks `begin_guess(id, t)`, a permit
## given once, to the holder's own attempt only; a guess that opens is refunded (`guess_opened`) and the attempt
## becomes the session; one that does not, and a permitted attempt whose connection ends (`abandon`) or runs out
## its 30 s, is a failed guess (`guess_failed`): the password and the QR secret rotate. The window is `rotating`
## until `rotated`. A refused C1 and an attempt that never reached its guess count nothing. At most 5 C1s a
## minute are admitted, counted when admitted; a busy C1 is never counted. The window expires `PAIR_SECONDS` after
## it opened. Attempt ids never repeat.
##
## An outcome is a Dictionary: `result` (absent for none), `id`, `host` and `rotate` (a bool, always present).
## `state()` answers {open, holder, failures, rotations, closed}; `holder` and `closed` are "" when none.

const PAIR_SECONDS := 300
const PAIR_FAILURES := 5
const C1_PER_WINDOW := 5
const C1_WINDOW_SECONDS := 60
## From the first byte (C1 included) to the transport.
const ATTEMPT_SECONDS := 30

var _open := false
var _opened_at := 0.0
var _holder := ""
var _attempt: Dictionary = {}
var _next_id := 1
var _failures := 0
var _rotations := 0
var _closed := ""
var _admits: Array[float] = []


func _to_string() -> String:
	return "PKeyPeerLocalWindow(%s)" % ("open" if _open else "closed")


static func _none() -> Dictionary:
	return {"rotate": false}


static func _res(result: String, extra := {}) -> Dictionary:
	var out := {"result": result, "rotate": false}
	out.merge(extra, true)
	return out


func state() -> Dictionary:
	return {"open": _open, "holder": _holder, "failures": _failures, "rotations": _rotations, "closed": _closed}


## Apply the clocks: the window's expiry and an attempt's deadline.
func tick(t: float) -> Dictionary:
	var out := _none()
	if _open and t - _opened_at >= PAIR_SECONDS:
		_open = false
		_closed = "expired"
		if _holder == "attempt":
			_drop()
		if _holder == "rotating":
			_holder = ""
	if _holder == "attempt" and not _attempt.is_empty() and t - float(_attempt["at"]) >= ATTEMPT_SECONDS:
		if _attempt["guessed"]:
			out = _failed()
		else:
			_drop()
	return out


func _drop() -> void:
	_attempt = {}
	_holder = ""


func _is_holder(id: int) -> bool:
	return _open and _holder == "attempt" and not _attempt.is_empty() and int(_attempt["id"]) == id


## One window per device per product: an open window, or a session still running, answers `already-open`.
func open(t: float) -> Dictionary:
	tick(t)
	if _open or _holder == "session":
		return _res("already-open")
	_open = true
	_opened_at = t
	_holder = ""
	_attempt = {}
	_failures = 0
	_rotations = 0
	_closed = ""
	_admits = []
	return _res("opened")


## A C1 arrived; `valid` is whether it passed the frame and share checks.
func c1(t: float, valid: bool) -> Dictionary:
	tick(t)
	if not _open:
		return _res("closed")
	if _holder != "":
		return _res("busy")
	var kept: Array[float] = []
	for a in _admits:
		if t - a < C1_WINDOW_SECONDS:
			kept.append(a)
	_admits = kept
	if _admits.size() >= C1_PER_WINDOW:
		return _res("limited")
	_admits.append(t)
	if not valid:
		return _res("refused")
	var id := _next_id
	_next_id += 1
	_holder = "attempt"
	_attempt = {"id": id, "at": t, "guessed": false}
	return _res("attempt", {"id": id})


## The permit to try message 1's tag: true once, for the holder's own attempt, while the window is open and the
## attempt's 30 s have not run out; the guess is counted now. False otherwise: the session must not try the tag.
func begin_guess(id: int, t: float) -> bool:
	tick(t)
	if not _is_holder(id) or _attempt["guessed"]:
		return false
	_attempt["guessed"] = true
	_failures += 1
	return true


## The permitted guess opened: the count is refunded and the attempt is the session.
func guess_opened(id: int, t: float) -> Dictionary:
	tick(t)
	if not _is_holder(id) or not _attempt["guessed"]:
		return _none()
	_failures -= 1
	_attempt = {}
	_holder = "session"
	return _res("transport")


## The permitted guess did not open.
func guess_failed(id: int, t: float) -> Dictionary:
	tick(t)
	if not _is_holder(id) or not _attempt["guessed"]:
		return _none()
	return _failed()


func _failed() -> Dictionary:
	_attempt = {}
	if _failures >= PAIR_FAILURES:
		_open = false
		_closed = "too-many-tries"
		_holder = ""
		return _res("too-many-tries", {"host": "pairing-code-failed"})
	_rotations += 1
	_holder = "rotating"
	return _res("failed", {"rotate": true})


## Message 1 of `id`: the permit, then the verdict. Null when not permitted: nothing is tried, nothing changes.
func msg1(id: int, t: float, opens: bool) -> Variant:
	if not begin_guess(id, t):
		return null
	return guess_opened(id, t) if opens else guess_failed(id, t)


## The attempt's connection closed or timed out. A permitted guess with no verdict is failed.
func abandon(id: int, t: float) -> Dictionary:
	tick(t)
	if not _is_holder(id):
		return _none()
	if _attempt["guessed"]:
		return _failed()
	_drop()
	return _none()


## The new code, QR secret and both generators are ready: the window takes the next C1.
func rotated(t: float) -> void:
	tick(t)
	if _holder == "rotating":
		_holder = ""


## The held session ended. A stored link closes the window; any other end rotates and holds the window until
## `rotated`.
func session_end(t: float, stored: bool) -> Dictionary:
	tick(t)
	if _holder != "session":
		return _none()
	_holder = ""
	if stored:
		_open = false
		_closed = "stored"
		return _none()
	if not _open:
		return _none()
	_rotations += 1
	_holder = "rotating"
	return {"rotate": true}


## The person closed the window.
func close(t: float) -> Dictionary:
	tick(t)
	if _open:
		_open = false
		_closed = "person"
		if _holder == "attempt" or _holder == "rotating":
			_drop()
	return _none()
