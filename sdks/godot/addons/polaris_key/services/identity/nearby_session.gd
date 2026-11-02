class_name PKeyNearbySignIn
extends RefCounted
## Nearby sign-in on the new device D (WIRE-CONTRACT-V5 section 12.11.5 and 15.6.1): what
## `PolarisKey.identity.sign_in.start_nearby(opts)` answers. D signs in because a signed-in device M nearby
## approves it. The session joins the two halves: the HTTP routes (PKeyIdentityNearbyRoutes: `start`, `poll`)
## and the LAN request Cloud Connect built (PKeyNearbyRequest: the approvers D lists, the code D shows,
## `VOUCH_REQ`). Ported from sdk-node `identity/nearbySession.ts` (reference: Swift `NearbySession.swift`).
##
##   approvers()            who answered nearby: [{id, label (String or null), platform}], at most 8
##   choose(id)             the person tapped one: ok with detail {code}, the code to show ("482 913")
##   code                   the code on screen once chosen, else ""
##   get_result()           what `VOUCH_RESULT` said ("" before it came). Display only
##   wait()                 the paced poll: a PKeySignInOutcome of kind signed_in, expired, cancelled, denied,
##                          service-unavailable or error; asked again it answers the same one
##   confirm_account()      the person saw the signed-in account and says it is theirs
##   decline_account()      it is not: the held records are dropped and the device signs out
##   wrap                   what became of the KEYRING_WRAP M sent: `none`, then `applied` or `refused`
##   wrap_changed(state)    signal: `wrap` changed
##   cancel()               stop; the LAN request closes
##   ended                  signal: the sign-in ended unconfirmed (decline, cancel, the 300 s deadline)
##   approvers_changed(list), result(status)   signals
##
## Rules this file keeps:
##  - the order is `start`, then the LAN request, and the poll is paced from `start`: the first poll is one
##    interval after it. The poll decides the outcome: a token is `signed_in`, `timeout` is `expired`,
##    `access_denied` is `denied`. `VOUCH_RESULT` never signs anyone in and never ends the wait;
##  - one answer: the first terminal outcome is kept and every later `wait()` gets the same;
##  - an unsupported runtime never calls a route for it: the LAN probe runs before `nearby/start`;
##  - unconfirmed until `confirm_account()` (rule 12): the token is held under the unconfirmed mark. A decline,
##    a `cancel()` or the `expires_in`-second deadline (a monotonic timer, from the moment the poll answered)
##    discards the session ONCE (idempotent, serialized): the held records are dropped, the LAN request
##    declines and closes, the Worker is asked to sign out (best effort), and whatever it answered the
##    credential, its mark and its documents go locally. A `ready` poll that lands after such an end discards at
##    once. The peer closing the LAN session is deliberately NOT an end: M closes right after `approved`;
##  - confirm and the deadline decide in one step with no await between the check and the write, so exactly
##    one of them wins; the discard and the confirm act only on the token THIS session's poll stored (a later
##    sign-in made another way is left alone). A decline after the confirmation is a no-op;
##  - the stored subject, the `signedIn` event (and so Cloud Sync and Connect) and the end of the explicit
##    sign-out state wait for `confirm_account()`; a confirm after the end fails with `sign-in-failed`, and a
##    session with no subject is never the signed-in person;
##  - records `0x0030` to `0x003F` reach the session only after `confirm_account()` (the engine holds them).
##    `KEYRING_WRAP` (0x0030) is held for the key ring and zeroed when the session ends; it is adopted
##    (PKeySyncRing.adopt_wrap, which checks it against a fresh read of the ring and the pin) only after
##    `confirm_account()`, and dropped on a decline, a cancel and the deadline. A ring that refuses it leaves the
##    device locked: the server's copy and `unlock()` still work;
##  - the request handle, the proofs, the token and the code are in no `str()`, log or error message.

signal approvers_changed(list: Array)
signal result(status: String)
## The sign-in ended unconfirmed (a decline, a cancel, the deadline); fires once.
signal ended()
## `wait()` produced a terminal outcome: the same value `wait()` returns.
signal outcome(result: PKeySignInOutcome)
## What became of the wrap changed (`applied` or `refused`).
signal wrap_changed(state: String)
## Internal: the pause was cut short, or the discard finished.
signal woke
signal discard_finished
signal wrap_idle

const CHANNEL := &"nearby"
const KEYRING_WRAP_RECORD := 0x0030
const WRAP_NONE := "none"
const WRAP_APPLIED := "applied"
const WRAP_REFUSED := "refused"

## Seconds the request lives, as the Worker said (300).
var expires_in := 0
## When the request lapses on THIS client's clock (epoch seconds).
var expires_at := 0.0
## The label D sent, or "".
var device_name := ""
## The code on screen ("482 913") once an approver is chosen, else "".
var code := ""
## The minimum seconds between polls; a `slow_down` lengthens it.
var interval := 0
## What became of the wrap M sent: `none` until one arrives and is taken, then `applied` or `refused`.
var wrap := WRAP_NONE

var _identity: PKeyIdentity
var _routes: PKeyIdentityNearbyRoutes
var _started: PKeyIdentityNearbyRoutes.Started
var _request: Object
var _links: Array = []
var _lan_open := true
var _lan_declined := false
var _running := false
var _cancelled := false
var _final: PKeySignInOutcome = null
var _signed_in := false
var _confirmed := false
var _ended := false
var _token := ""
var _subject := ""
var _deadline: Callable = Callable()
var _discarding := false
var _discard_done := false
var _wrap_record := PackedByteArray()
var _applying := false
var _sleep_gen := 0


func _init(identity: PKeyIdentity, routes: PKeyIdentityNearbyRoutes, started: PKeyIdentityNearbyRoutes.Started, request: Object, label: String, p_expires_at: float) -> void:
	_identity = identity
	_routes = routes
	_started = started
	_request = request
	expires_in = started.expires_in
	expires_at = p_expires_at
	interval = started.interval
	device_name = label
	_link("approvers_changed", func(list: Array) -> void: approvers_changed.emit(_clean(list)))
	_link("result", func(status: String) -> void: result.emit(status))
	# The engine hands records over only after `confirm_account()`.
	_link("record", _on_record)


func _to_string() -> String:
	return "PKeyNearbySignIn(channel=nearby, chosen=%s, expires_in=%d)" % [code != "", expires_in]


func _link(signal_name: String, fn: Callable) -> void:
	if _request.has_signal(signal_name):
		_request.connect(signal_name, fn)
		_links.append([signal_name, fn])


# -- the approvers and the code -------------------------------------------------------------------


## The approvers that answered, at most 8, labels cleaned: [{id, label (String or null), platform}].
func approvers() -> Array:
	return _clean(_request.approvers())


static func _clean(list: Array) -> Array:
	var out: Array = []
	for a: Dictionary in list:
		var label := PKeyPeerPayload.clean_label(String(a["label"])) if a.get("label") is String else ""
		out.append({"id": a["id"], "label": label if label != "" else null, "platform": PKeyPeerPayload.clean_platform(String(a.get("platform", "")))})
	return out


## What `VOUCH_RESULT` said, for display only: the poll is the authority.
func get_result() -> String:
	return String(_request.get_result())


## The person tapped this approver. ok with {code}: the code to show; the request goes out once it is shown.
## A coroutine.
func choose(approver_id: String) -> PKeyResult:
	if _final != null or _cancelled or _ended:
		return PKeyResult.failure(PKeyErrors.SIGN_IN_FAILED, "The sign-in is over.")
	var r: PKeyResult = await _request.choose(approver_id)
	if r.ok and r.detail is Dictionary:
		code = String(r.detail.get("code", ""))
	return r


# -- the end --------------------------------------------------------------------------------------


## True once the sign-in ended unconfirmed (a decline, a cancel, the deadline).
func is_ended() -> bool:
	return _ended


## True once the person confirmed the account.
func is_confirmed() -> bool:
	return _confirmed


## Stop. A running `wait()` answers `cancelled`; the request simply lapses on the Worker. After `signed_in` and
## before the confirmation it also signs the device out.
func cancel() -> void:
	var step := _halt()
	_close_lan()
	if step["discard"]:
		_discard()


## The end of this sign-in: no further poll is honoured, the deadline stops and listeners hear of it (once, and
## only while unconfirmed). `acted` is false when `only_unconfirmed` and the sign-in was already confirmed or
## over; `discard` is true when a signed-in, unconfirmed session must now be discarded.
func _halt(only_unconfirmed := false) -> Dictionary:
	if only_unconfirmed and (_confirmed or _ended):
		return {"acted": false, "discard": false}
	_cancelled = true
	_cancel_deadline()
	woke.emit()
	if _ended or _confirmed:
		return {"acted": true, "discard": false}
	_ended = true
	ended.emit()
	return {"acted": true, "discard": _signed_in}


## The confirm screen's deadline: `expires_in` seconds from the moment the poll answered, on the monotonic timer
## (never a wall clock the host could move).
func _arm_deadline() -> void:
	if _cancelled or _confirmed:
		return
	_deadline = _identity._nearby_timer(float(expires_in), Callable(self, "_deadline_fired"))


func _cancel_deadline() -> void:
	if _deadline.is_valid():
		_deadline.call()
	_deadline = Callable()


func _deadline_fired() -> void:
	# Decided in the step `confirm_account` takes: whichever got here first wins.
	_deadline = Callable()
	var step := _halt(true)
	if not step["acted"]:
		return
	_close_lan()
	if step["discard"]:
		_discard()


## The one end path for an unconfirmed sign-in; idempotent and serialized (a second caller waits for the
## first). The LAN request declines and closes, the Worker is asked to sign out as a best effort, and whatever
## it answered the credential, its mark and its documents go. Only this session's own token is touched.
## A coroutine.
func _discard() -> void:
	if _discarding:
		if not _discard_done:
			await discard_finished
		return
	_discarding = true
	if not _lan_declined:
		_lan_declined = true
		_request.decline_account()
	# Whatever was held for the key ring goes with the sign-in.
	_zero_wrap()
	_close_lan()
	var token := _token
	_token = ""
	if token != "":
		await _identity._nearby_discard_token(token)
	_signed_in = false
	_discard_done = true
	discard_finished.emit()


func _close_lan() -> void:
	if not _lan_open:
		return
	_lan_open = false
	for l: Array in _links:
		if is_instance_valid(_request) and _request.is_connected(l[0], l[1]):
			_request.disconnect(l[0], l[1])
	_links = []
	_request.close()


func _zero_wrap() -> void:
	if not _wrap_record.is_empty():
		_wrap_record.fill(0)
	_wrap_record = PackedByteArray()


func _on_record(record_type: int, body: PackedByteArray) -> void:
	if record_type != KEYRING_WRAP_RECORD or _ended:
		return
	_zero_wrap()
	_wrap_record = body.duplicate()
	# A wrap that arrives after the confirmation is taken as it comes.
	if _confirmed:
		_apply_wrap()


## The KEYRING_WRAP record M sent, once the person confirmed the account; "" bytes before that. Taking it empties
## the hold.
func take_wrap_record() -> PackedByteArray:
	if not _confirmed:
		return PackedByteArray()
	var out := _wrap_record
	_wrap_record = PackedByteArray()
	return out


## Adopt the held wrap once, after a sign-in the person confirmed. A ring that is missing, locked out or refuses it
## is not an error here: the device stays locked and the server's copy is the fallback.
func _apply_wrap() -> void:
	if _applying:
		await wrap_idle
		return
	if not _confirmed or _ended or _wrap_record.is_empty():
		return
	var ring := _identity._nearby_keyring()
	if ring == null:
		_zero_wrap()
		return
	_applying = true
	# A wrap that lands while one is being adopted is taken after it.
	while _confirmed and not _ended and not _wrap_record.is_empty():
		var record := take_wrap_record()
		var r: PKeyResult = await ring.adopt_wrap(record)
		record.fill(0)
		wrap = WRAP_APPLIED if r.ok and r.detail is Dictionary and (r.detail as Dictionary).get("kind") == "unlocked" else WRAP_REFUSED
		wrap_changed.emit(wrap)
	_applying = false
	wrap_idle.emit()


# -- the wait -------------------------------------------------------------------------------------


## Poll until the sign-in settles. The first terminal answer is kept: a later call gets the same one (the token
## is handed over once). A cancelled sign-in answers `cancelled`; M's refusal is `denied`. A coroutine.
func wait() -> PKeySignInOutcome:
	if _final != null:
		return _final
	if _running:
		return await outcome
	var core := _identity._core()
	if core == null or not core.started:
		return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	_running = true
	var r := await _loop()
	_running = false
	if _final == null:
		_final = r
	outcome.emit(_final)
	return _final


func _loop() -> PKeySignInOutcome:
	var core := _identity._core()
	var delay := float(interval)
	while true:
		var over := _over(core)
		if over != null:
			return over
		await _sleep(PKeyIdentity.poll_delay(delay, expires_at - core.clock.system_now()))
		over = _over(core)
		if over != null:
			return over
		var p := await _routes.poll(_started)
		delay = float(interval)
		if p["kind"] == "ready":
			return await _on_ready(p)
		if _cancelled:
			return _cancelled_outcome()
		var done := _answered(p)
		if done != null:
			return done
		if p["kind"] == "transient":
			# Ride out a transient failure at the current interval, or the Worker's Retry-After.
			delay = maxf(float(interval), float(p["retry_after"]))
		elif p["kind"] == "slow-down":
			interval = maxi(interval, int(p["interval"]))
			delay = float(interval)
	return _terminal(_expired())


## The outcome that ends the session before a poll (cancelled, lapsed), else null.
func _over(core: PKeyCore) -> PKeySignInOutcome:
	if _cancelled:
		return _cancelled_outcome()
	if core.clock.system_now() >= expires_at:
		return _terminal(_expired())
	return null


## What a poll answer ends the wait with, or null to poll again (pending, slow-down, transient).
func _answered(p: Dictionary) -> PKeySignInOutcome:
	match String(p["kind"]):
		"timeout":
			return _terminal(_expired())
		"denied":
			return _terminal(PKeySignInOutcome.ended(PKeySignInOutcome.KIND_DENIED, PKeyErrors.SIGN_IN_DENIED, "Nearby sign-in was refused.", 200))
		"unavailable":
			var off := PKeySignInOutcome.ended(PKeySignInOutcome.KIND_SERVICE_UNAVAILABLE, PKeyErrors.SERVICE_UNAVAILABLE, "This product no longer serves nearby sign-in.")
			off.detail = PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_NEARBY, "identity")
			return _terminal(off)
		"superseded":
			return _terminal(PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.SIGN_IN_FAILED, "Another sign-in landed first."))
		"error":
			var e := PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, p.get("code", PKeyErrors.SIGN_IN_FAILED), String(p.get("message", "")), int(p.get("status", 0)))
			e.detail = p.get("detail")
			return _terminal(e)
	return null


## The poll stored the token (unconfirmed). A decline or cancel that got in before this answer discards it at
## once; nothing is handed to the caller.
func _on_ready(p: Dictionary) -> PKeySignInOutcome:
	_signed_in = true
	_token = String(p["token"])
	_subject = String(p["subject"])
	if _cancelled:
		await _discard()
		return _cancelled_outcome()
	_arm_deadline()
	var out := PKeySignInOutcome.signed_in(p["identity"], "", true, null, _subject)
	out.scope = String(p["scope"])
	out.license_id = String(p["license_id"])
	return out


## Keep a terminal outcome; everything but a sign-in closes the LAN half now.
func _terminal(o: PKeySignInOutcome) -> PKeySignInOutcome:
	_final = o
	_close_lan()
	return o


func _expired() -> PKeySignInOutcome:
	return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_EXPIRED, PKeyErrors.SIGN_IN_EXPIRED, "The sign-in request lapsed; start again.")


func _cancelled_outcome() -> PKeySignInOutcome:
	return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_CANCELLED, PKeyErrors.CANCELLED, "The sign-in was cancelled.")


func _sleep(seconds: float) -> void:
	if _identity.sleeper.is_valid():
		# Tests: the injected sleeper advances a fake clock.
		await _identity.sleeper.call(seconds)
		return
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return
	_sleep_gen += 1
	var gen := _sleep_gen
	var t := tree.create_timer(maxf(seconds, 0.05), true, false, true)
	t.timeout.connect(func() -> void:
		if gen == _sleep_gen:
			woke.emit())
	await woke


# -- the person's decision ------------------------------------------------------------------------


## The person has seen the signed-in account (`wait()` answered `signed_in` with the identity) and says it is
## theirs (rule 12). Only now does the engine hand over the records M sent, and the account becomes the
## device's: the stored subject, the `signedIn` event, the end of the signed-out state. Fails with
## `sign-in-failed` when the sign-in ended first, or when the device is not signed in. A coroutine.
func confirm_account() -> PKeyResult:
	# Decided in one step with the deadline: nothing awaits between these checks and the write.
	if _ended:
		return PKeyResult.failure(PKeyErrors.SIGN_IN_FAILED, "The sign-in ended before it was confirmed.")
	if not _signed_in or _subject == "" or _token == "":
		return PKeyResult.failure(PKeyErrors.SIGN_IN_FAILED, "Nothing to confirm: the device is not signed in.")
	if _confirmed:
		return PKeyResult.success()
	_confirmed = true
	_cancel_deadline()
	var verdict := _identity._nearby_confirm(_subject, _token)
	if verdict == &"failed":
		_confirmed = false
		return PKeyResult.failure(PKeyErrors.SIGN_IN_FAILED, "The sign-in could not be confirmed.")
	if verdict != &"ok":
		# A later sign-in replaced this one's token: nothing of it is written, nothing signed out.
		_confirmed = false
		_halt()
		_close_lan()
		_token = ""
		_discard()
		return PKeyResult.failure(PKeyErrors.SIGN_IN_FAILED, "The sign-in ended before it was confirmed.")
	# The chosen session is gone: no records, the server copy is the fallback.
	_request.confirm_account()
	await _apply_wrap()
	# The account is the device's now: its licence is fetched (the sync an unconfirmed token never ran).
	await _identity._nearby_acquired()
	return PKeyResult.success()


## The account is not the person's: every held record is dropped, the LAN half closes and the device signs out
## (rule 12). Safe to call more than once; a late decline after the confirmation leaves the sign-in alone.
## A coroutine.
func decline_account() -> void:
	if _confirmed:
		return
	_halt()
	await _discard()
