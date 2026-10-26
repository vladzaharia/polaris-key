class_name PKeySignInSession
extends PKeyResult
## One device-code sign-in (RFC 8628): what `PolarisKey.identity.sign_in.start()` returns. It holds
## the code the player types, the two verification URLs and the poll credential the SDK keeps
## using, and settles through `wait()`. A PKeyResult: when the sign-in could not start, `ok` is
## false and `code` says why (`service-unavailable` before any request when Identity is off or
## not set up, and for a start the Worker answers 404; `rate_limited`, `invalid-response`, a
## transport code, ...), and `wait()` returns that failure as an outcome.
##
##   var s := await PolarisKey.identity.sign_in.start({device_name = "Deck"})
##   show(s.user_code, s.verification_uri_complete)      # the code, the page, the QR code
##   var outcome := await s.wait()                       # the paced poll, until it settles
##
##   wait()            poll until the sign-in settles (a PKeySignInOutcome; a settled session
##                     answers the same outcome again). With `confirm_identity` it also returns at
##                     `choose`: show the identity, call `accept()`, then `wait()` again.
##   outcome           emitted by every outcome `wait()` produces except `pending`
##   cancel()          stop at once: the wait wakes, sends no further poll and ends `cancelled`
##   accept(attach)    the player accepted the identity `choose` showed, on the device
##   reopen()          open the verification page in the system browser again
##
## Polling rules (P1b-08's, the same in every SDK): wait at least `interval` seconds between polls
## (never under one second, never past the code's lifetime); a `slow_down` (HTTP 429) lengthens the
## interval to the one it returns, or adds five seconds to the CURRENT interval when it returns
## none (RFC 8628 §3.5), and never shortens it; a poll that got no answer, or a 5xx, is retried at
## the SAME interval; stop at `expires_at` without asking the server, or on `timeout`, `error`,
## 401, `ready` or `cancel()`. Every poll carries the device id that `X-PKey-Device` carries.
##
## The opt-in attach (P1-07): with `confirm_identity`, the polls ask the Worker to hold the flow at
## the signed-in identity. When the player has signed in and the device holds a licence that can
## be attached (`attachable`), `wait()` returns `choose`; call `accept(attach_license)` and
## `wait()` again (or `cancel()`). With nothing to attach the SDK answers the hold with "no"
## itself (D-10), and a plain `ready` never asks. Nothing is minted or merged until the player
## accepts ON THE DEVICE; a stranger who confirmed the code on their own phone can never trigger
## the attach (they do not hold the device code).
##
## Show the player, from largest to smallest: `user_code`; `verification_uri_complete` as a QR
## code (PKeyQrRect) and as the link "Open browser" opens; `verification_uri` as the short URL to
## type. Never show `device_code`: it is the secret that redeems the flow. It never prints:
## `str(session)` shows `[redacted]` in its place. Do not put it in a URL, a log line, `var_to_str`
## or a save file.

## `wait()` produced `result` (`choose`, `signed_in` or any ending): the same value `wait()` returns.
signal outcome(result: PKeySignInOutcome)

## Wakes the paced wait early (cancel, a decision); internal.
signal _woke

const REDACTED := "[redacted]"
## A decision answered `confirm` again (a stale read on the server) is re-sent this many times
## before the player is asked again.
const MAX_DECISION_RESENDS := 3

## The channel this session runs on (the device code; the redirect channel is I-10b.5's).
var channel: StringName = &"device-code"
## The poll credential. Never show it, never put it in a URL.
var device_code := ""
## What the player types on the verification page, e.g. `WDJB-MJHT`.
var user_code := ""
## The page the player opens and types the code into.
var verification_uri := ""
## The same page with the code pre-filled: the payload for a QR code or a link.
var verification_uri_complete := ""
## Seconds the code lives for, as the server advertised it (rounded up).
var expires_in := 0
## The minimum seconds between polls, as the server advertised it (rounded up).
var interval := 0
## Epoch seconds on THIS client's clock when the code expires: the start's now plus
## `expires_in`. Polling stops here without asking the server again.
var expires_at := 0.0
## The flow holds at the signed-in identity until the player accepts it on the device
## (`choose`, then `accept()`), which also offers attaching this device's anonymous licence. Set
## by `sign_in.start({confirm_identity = true})`.
var confirm_identity := false
## The label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1): the Worker's echo, else (an older
## Worker) the label sent; "" when there is none. Show it under the code.
var device_name := ""

var _identity: PKeyIdentity = null
var _cancelled := false
var _running := false
var _held := false
var _decision: Variant = null
var _resends := 0
var _interval := 0
var _sleep_gen := 0
var _settled: PKeySignInOutcome = null
## The start's failure as an outcome (a session with `ok == false`), built once.
var _failure: PKeySignInOutcome = null


## `start()` builds it. Tests and the kit's snapshots build a displayable one with `new(true)`.
func _init(p_ok := true, p_code: StringName = &"", p_message := "", p_detail: Variant = null) -> void:
	super._init(p_ok, p_code, p_message, p_detail)


## Poll until the sign-in settles. See the class doc for the endings; a failed session returns its
## failure.
func wait() -> PKeySignInOutcome:
	if not ok:
		if _failure == null:
			_failure = _start_failure()
			outcome.emit(_failure)
		return _failure
	if _settled != null:
		return _settled
	if _running:
		return await outcome
	if _identity == null:
		return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, "This session has no SDK behind it.")
	_running = true
	var result := await _loop()
	_running = false
	_publish(result)
	return result


## Stop the sign-in now: a wait in progress wakes, sends no further poll and ends `cancelled`; a
## later `wait()` answers `cancelled`. Also declines a pending identity confirmation. Safe to call
## at any time, and a no-op once the sign-in settled.
func cancel() -> void:
	if _settled != null or _cancelled:
		return
	_cancelled = true
	_held = false
	_woke.emit()
	if not _running and ok:
		_publish(_cancelled_outcome())


## The player accepted the identity `choose` showed, on the device. `attach_license`: also attach
## this device's anonymous licence to the account (only meaningful when the outcome said
## `attachable`). The next `wait()` sends the decision. False when no choice is waiting.
func accept(attach_license := false) -> bool:
	if not _held or _cancelled or _settled != null:
		return false
	_decision = attach_license
	_held = false
	_woke.emit()
	return true


## Open `verification_uri_complete` in the system browser again (on web: `window.open`, which
## popup blockers eat outside an input event, so always render the link and the QR code as well).
## True when the browser was asked to open it.
func reopen() -> bool:
	return _identity != null and _identity.open_in_browser(self) == OK


## One poll, unpaced, for the transcript replayer: `identity._poll`'s answer ({status, ...}).
func _poll_once() -> Dictionary:
	if _identity == null:
		return {"status": "error", "code": PKeyErrors.NOT_CONFIGURED, "message": "This session has no SDK behind it.", "status_code": 0}
	return await _identity._poll(self, interval, null)


## True while `wait()` is polling.
func is_waiting() -> bool:
	return _running


func _publish(result: PKeySignInOutcome) -> void:
	if result.kind != PKeySignInOutcome.KIND_CHOOSE:
		_settled = result
	outcome.emit(result)


func _loop() -> PKeySignInOutcome:
	var core := _identity._core()
	if core == null or not core.started:
		return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	if not core.enabled("identity"):
		var off := PKeySignInOutcome.ended(PKeySignInOutcome.KIND_SERVICE_UNAVAILABLE, PKeyErrors.SERVICE_UNAVAILABLE, "The identity service is not enabled for %s." % core.product)
		off.detail = PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_DEVICECODE, "identity")
		return off
	if _interval <= 0:
		_interval = interval
	while true:
		if _cancelled:
			return _cancelled_outcome()
		if core.clock.system_now() >= expires_at:
			return _expired()
		await _sleep(PKeyIdentity.poll_delay(_interval, expires_at - core.clock.system_now()))
		if _cancelled:
			return _cancelled_outcome()
		if core.clock.system_now() >= expires_at:
			return _expired()
		var p := await _identity._poll(self, _interval, _decision)
		if _cancelled and p["status"] != "ready":
			return _cancelled_outcome()
		match p["status"]:
			"pending", "transient":
				continue
			"slow-down":
				_interval = maxi(_interval, int(p["interval"]))
				continue
			"confirm":
				# A decision answered `confirm` again: either the server read a stale record (re-send
				# the same decision) or the licence stopped being attachable (ask the player again).
				if _decision != null and _resends < MAX_DECISION_RESENDS and not (bool(_decision) and not p["attachable"]):
					_resends += 1
					continue
				if not p["attachable"]:
					# D-10: "Is this you?" is for the Keep step on the card only. With no licence to
					# attach there is nothing to ask: answer the server's hold with "no" at once.
					if _decision != null and not bool(_decision):
						return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.INVALID_RESPONSE, "The sign-in stayed on its confirmation after a decision.", 200)
					_decision = false
					_resends = 0
					continue
				_decision = null
				_resends = 0
				_held = true
				return PKeySignInOutcome.choose(p["identity"], p["attachable"])
			"ready":
				return PKeySignInOutcome.signed_in(p["identity"], p["attached"], p["stored"], p["sync"], p.get("subject", ""))
			"timeout":
				return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_EXPIRED, PKeyErrors.SIGN_IN_EXPIRED, "The sign-in code is no longer known to the server; start again.", 200)
			"denied":
				return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_DENIED, PKeyErrors.SIGN_IN_DENIED, "The sign-in was declined; start again.", 200)
			"device-mismatch":
				return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_DEVICE_MISMATCH, p["code"], p["message"], 401)
			_:
				return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, p.get("code", PKeyErrors.HTTP_ERROR), p.get("message", ""), p.get("status_code", 0))
	return _expired()


func _sleep(seconds: float) -> void:
	if _identity.sleeper.is_valid():
		# Tests: the injected sleeper advances a fake clock. A cancel that lands meanwhile is seen
		# by the caller's check after it returns.
		await _identity.sleeper.call(seconds)
		return
	await _hold(seconds)


## A real wait of `seconds` (a SceneTreeTimer that ignores pause and time scale) that cancel()
## and accept() cut short. Re-checked by the caller, so a stale timer firing later can only cause
## one extra check, never a poll.
func _hold(seconds: float) -> void:
	var host := _identity._host
	if host == null or not host.is_inside_tree():
		return
	_sleep_gen += 1
	var gen := _sleep_gen
	var t := host.get_tree().create_timer(maxf(seconds, 0.05), true, false, true)
	t.timeout.connect(func() -> void:
		if gen == _sleep_gen:
			_woke.emit())
	await _woke


func _expired() -> PKeySignInOutcome:
	return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_EXPIRED, PKeyErrors.SIGN_IN_EXPIRED, "The sign-in code expired before the player finished.")


func _cancelled_outcome() -> PKeySignInOutcome:
	return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_CANCELLED, PKeyErrors.CANCELLED, "The sign-in was cancelled.")


## The failed start as the outcome `wait()` answers.
func _start_failure() -> PKeySignInOutcome:
	var status: int = detail.get("status", 0) if detail is Dictionary else 0
	var kind := PKeySignInOutcome.KIND_ERROR
	if code == PKeyErrors.SERVICE_UNAVAILABLE:
		kind = PKeySignInOutcome.KIND_SERVICE_UNAVAILABLE
	elif status == 429:
		kind = PKeySignInOutcome.KIND_RATE_LIMITED
	var failed := PKeySignInOutcome.ended(kind, code, message, status)
	failed.detail = detail
	return failed


func _to_string() -> String:
	if not ok:
		return "PKeySignInSession(%s: %s)" % [code, message]
	return "PKeySignInSession(user_code=%s, verification_uri_complete=%s, device_code=%s, expires_in=%d, interval=%d)" % [
		user_code, verification_uri_complete, REDACTED, expires_in, interval,
	]
