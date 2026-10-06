class_name PKeyIdentity
extends RefCounted
## `PolarisKey.identity`: device-code sign-in (RFC 8628), the only way a game finishes an
## identity sign-in natively. The player scans a QR code or types an eight-letter code on another
## device; the game polls until the sign-in completes, stores the licence-bound device token and
## syncs (notes/A2 §6, §9.5; sdk-node `identity/client.ts` is the same flow).
##
##   is_available()                        Identity is on for this product and set up
##   begin_sign_in(device_name, confirm_identity)
##                                         start, emit `sign_in_pending(prompt)`, poll in the
##                                         background, emit `sign_in_finished(result)` at the end
##   cancel()                              stop polling now (the wait ends `cancelled`)
##   accept_sign_in(attach_license)        the player accepted the identity shown on the device
##   open_in_browser(prompt), copy_link(prompt)
##                                         for the dialog's two buttons
##   signed_in_identity()                  who the device is signed in as, for the UI to show
##   current()                             {name, email, activatedAt} of the signed-in person off
##                                         the verified licence, or null (SDK parity §3.12)
##   sign_out()                            cancel any sign-in, forget the identity and release
##                                         this device (license.deactivate()); a PKeyResult
##   sign_in_with_browser(device_name)     begin_sign_in, then open the verification page in the
##                                         system browser (the interim "Sign in with browser"
##                                         until a native redirect route exists, I-15)
##
## The pieces underneath, for a host that paces the flow itself (and for the transcript replays):
## `request_sign_in(device_name)` (the start alone), `poll_sign_in(prompt)` (exactly one poll)
## and `wait_for_sign_in(prompt)` (the paced loop `begin_sign_in` runs).
##
## Polling rules (P1b-08's, the same in every SDK): wait at least `interval` seconds between polls
## (never under one second, never past the code's lifetime); a `slow_down` (HTTP 429) lengthens the
## interval to the one it returns, or adds five seconds to the CURRENT interval when it returns
## none (RFC 8628 §3.5), and never shortens it; a poll that got no answer, or a 5xx, is retried at
## the SAME interval; stop at `expires_at` without asking the server, or on `timeout`, `error`,
## 401, `ready` or `cancel()`. Every poll carries the device id that `X-PKey-Device` carries.
##
## The opt-in attach (P1-07): with `confirm_identity`, the polls ask the Worker to hold the flow
## at the signed-in identity. Once the player has signed in, the SDK emits
## `sign_in_confirm({identity, attachable})` and stops polling until the game calls
## `accept_sign_in(attach_license)` (or `cancel()`). Show the name and e-mail, and only offer
## "attach this device's licence to my account" when `attachable` is true. Nothing is minted or
## merged until the player accepts ON THE DEVICE; a stranger who confirmed the code on their own
## phone can never trigger the attach (they do not hold the device code).
##
## Device-code sign-in sends no fingerprint, so a `strict` tier refuses it. It signs in only:
## unlocking paid content with an externally bought key is a store-policy matter (notes/A2 §6).

## The sign-in started: render `prompt` (code, QR, links).
signal sign_in_pending(prompt: PKeySignInPrompt)
## The player signed in and the flow holds for their acceptance (only with `confirm_identity`):
## {identity: {name?, email?}, attachable: bool}. Answer with `accept_sign_in()` or `cancel()`.
signal sign_in_confirm(confirmation: Dictionary)
## The sign-in ended, every way it can (PKeySignInResult.kind).
signal sign_in_finished(result: PKeySignInResult)

## Wakes the paced wait early (cancel, a decision); internal.
signal _woke

## RFC 8628 §3.5: a `slow_down` without an interval adds this to the CURRENT interval.
const SLOW_DOWN_STEP_SECONDS := 5
## A decision answered `confirm` again (a stale read on the server) is re-sent this many times
## before the player is asked again.
const MAX_DECISION_RESENDS := 3

## `func(seconds: float) -> void`, awaited between polls instead of a real timer (tests drive a
## fake clock with it). Empty: a SceneTreeTimer that ignores pause and time scale.
var sleeper: Callable = Callable()
## `func() -> PKeySyncResult`, awaited after a `ready` stored the token: the autoload's forced
## sync. Empty: no sync.
var on_acquired: Callable = Callable()

var _core_ref: WeakRef = null
var _host: Node = null
## The sign-in `begin_sign_in` is running, or null.
var _active: PKeySignInPrompt = null
## Bumped by every cancel(); a wait whose generation is stale ends `cancelled`.
var _generation := 0
var _awaiting_decision := false
var _decision: Variant = null
var _sleep_gen := 0
var _last_identity: Dictionary = {}


## Bind to Core (PolarisKey.configure). A sign-in in progress is cancelled.
func attach(core: PKeyCore, host: Node) -> void:
	cancel()
	_core_ref = weakref(core)
	_host = host


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


# ── Availability ─────────────────────────────────────────────────────────────────────────

## True when Identity is enabled for this product (D-21: discovery this session, else
## `expected_services`) and, when discovery was loaded, the product has an IdP configured
## (`services.identity.configured`). No request.
func is_available() -> bool:
	var core := _core()
	if core == null or not core.enabled("identity"):
		return false
	var m = core.discovery_manifest
	if m is Dictionary and m.get("services") is Dictionary and m["services"].get("identity") is Dictionary:
		var fragment: Dictionary = m["services"]["identity"]
		if fragment.has("configured") and not PKeyClaims.is_true(fragment["configured"]):
			return false
	return true


## True while `begin_sign_in`'s background wait is running.
func is_signing_in() -> bool:
	return _active != null


# ── The high-level flow ──────────────────────────────────────────────────────────────────

## Start a sign-in and poll in the background. Returns the prompt (also emitted as
## `sign_in_pending`); the ending arrives as `sign_in_finished(result)`. A sign-in already
## running is cancelled first. `device_name` is what the confirmation page shows the human (the
## anti-phishing cue); empty: `PKeyOptions.device_name`, else `default_device_name()`, unless
## `PKeyOptions.send_device_name` is off (WIRE-CONTRACT-V4 §12.7.1). `confirm_identity`: hold at the signed-in
## identity for the player's acceptance, and offer the licence attach (see the class doc). When
## the start fails, the prompt is not ok and `sign_in_finished` reports it too. A coroutine.
func begin_sign_in(device_name := "", confirm_identity := false) -> PKeySignInPrompt:
	cancel()
	var gen := _generation
	var prompt := await request_sign_in(device_name)
	if not prompt.ok:
		sign_in_finished.emit(_start_failure(prompt))
		return prompt
	prompt.confirm_identity = confirm_identity
	if gen != _generation:
		# cancel() (or another begin) landed while the start was in flight.
		sign_in_finished.emit(_cancelled_result())
		return prompt
	_active = prompt
	sign_in_pending.emit(prompt)
	_run(prompt, gen)
	return prompt


func _run(prompt: PKeySignInPrompt, gen: int) -> void:
	var result := await _wait(prompt, gen)
	if _active == prompt:
		_active = null
	sign_in_finished.emit(result)


## Stop the running sign-in (or a `wait_for_sign_in` in progress): the wait wakes at once, sends
## no further poll and ends `cancelled`. Also declines a pending identity confirmation. Safe to
## call at any time.
func cancel() -> void:
	_generation += 1
	_active = null
	_awaiting_decision = false
	_woke.emit()


## The player accepted the identity `sign_in_confirm` showed, on the device. `attach_license`:
## also attach this device's anonymous licence to the account (only meaningful when the
## confirmation said `attachable`). False when no confirmation is waiting.
func accept_sign_in(attach_license := false) -> bool:
	if not _awaiting_decision:
		return false
	_decision = attach_license
	_awaiting_decision = false
	_woke.emit()
	return true


## Open `verification_uri_complete` in the system browser (on web: `window.open`, which popup
## blockers eat outside an input event, so always render the link and the QR code as well).
## Returns the `OS.shell_open` error code.
func open_in_browser(prompt: PKeySignInPrompt) -> int:
	if prompt == null or prompt.verification_uri_complete == "":
		return ERR_INVALID_PARAMETER
	return OS.shell_open(prompt.verification_uri_complete)


## Put `verification_uri_complete` on the clipboard.
func copy_link(prompt: PKeySignInPrompt) -> void:
	if prompt != null and prompt.verification_uri_complete != "":
		DisplayServer.clipboard_set(prompt.verification_uri_complete)


## Who the device is signed in as, for the UI to show after a sign-in: the verified licence
## document's profile when it names someone, else what the last `ready` in this session reported.
## {name?, email?}; empty when neither knows.
func signed_in_identity() -> Dictionary:
	var core := _core()
	if core != null and core.cache != null and core.cache.license != null:
		var doc = core.cache.license.get("doc")
		if doc is Dictionary and doc.get("profile") is Dictionary:
			var shown := _shown(doc["profile"])
			if not shown.is_empty():
				return shown
	return _last_identity.duplicate()


## The signed-in person, SDK parity §3.12's `identity.current()`: {name, email, activatedAt} off
## the verified licence document's profile (a value the profile lacks is null), or null when the
## device holds no profile naming someone.
func current() -> Variant:
	var core := _core()
	if core == null or core.cache == null or core.cache.license == null:
		return null
	var doc = core.cache.license.get("doc")
	if not (doc is Dictionary) or not (doc.get("profile") is Dictionary):
		return null
	var p: Dictionary = doc["profile"]
	var name = p.get("name") if p.get("name") is String and p["name"] != "" else null
	var email = p.get("email") if p.get("email") is String and p["email"] != "" else null
	if name == null and email == null:
		return null
	var at = p.get("activatedAt")
	return {"name": name, "email": email, "activatedAt": int(at) if PKeyClaims.is_number(at) else null}


## Sign this device out (SDK parity §3.12's `identity.signOut()`): cancel a sign-in in progress,
## forget the identity this session saw, and release the seat with license.deactivate() (its
## best-effort server call, then the mandatory local wipe). The PKeyResult is deactivate()'s;
## `state_changed` fires as for a deactivation. A coroutine.
func sign_out() -> PKeyResult:
	cancel()
	_last_identity = {}
	var license = _host.get("license") if _host != null and is_instance_valid(_host) else null
	if license == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	return await license.deactivate()


## "Sign in with browser" (SDK parity §3.12): begin_sign_in, then open the verification page in
## the system browser at once; the QR code and the code stay on screen for another device. The
## prompt as begin_sign_in returns it. A coroutine.
func sign_in_with_browser(device_name := "", confirm_identity := false) -> PKeySignInPrompt:
	var prompt := await begin_sign_in(device_name, confirm_identity)
	if prompt.ok:
		open_in_browser(prompt)
	return prompt


## The name a sign-in shows the human when the game gives none: the device model where the OS
## reports a real one, else the OS name ("macOS", "Linux", …).
static func default_device_name() -> String:
	return PKeyDeviceLabel.platform_default()


# ── The pieces underneath ────────────────────────────────────────────────────────────────

## `POST /identity/auth/device/start` alone: no polling, no signal. The label is
## `PKeyDeviceLabel.resolve(device_name, options)`: normalised, omitted when empty. A coroutine.
func request_sign_in(device_name := "") -> PKeySignInPrompt:
	var core := _core()
	if core == null or not core.started:
		return _prompt_failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() before begin_sign_in().")
	if not core.enabled("identity"):
		var off := _prompt_failure(PKeyErrors.SERVICE_UNAVAILABLE, "The identity service is not enabled (or not set up) for %s." % core.product)
		off.detail = PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_DEVICECODE, "identity")
		return off
	if not is_available():
		return _prompt_failure(PKeyErrors.SERVICE_UNAVAILABLE, "The identity service is not enabled (or not set up) for %s." % core.product)
	var body := {"deviceId": core.device_id}
	var label := PKeyDeviceLabel.resolve(device_name, core.options)
	if label != "":
		body["deviceName"] = label
	var r := await core.request("POST", "identity/auth/device/start", body)
	if not r.ok:
		var p := _prompt_failure(r.code, r.message)
		p.detail = {"status": _status(r)}
		return p
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var b = parsed["value"] if parsed["ok"] else null
	if not (b is Dictionary) or not _str(b.get("deviceCode")) or not _str(b.get("userCode")) \
			or not _str(b.get("verificationUri")) or not _str(b.get("verificationUriComplete")) \
			or not _seconds(b.get("expiresIn")) or not _seconds(b.get("interval")):
		return _prompt_failure(PKeyErrors.INVALID_RESPONSE, "The device sign-in start answered without a complete prompt.")
	var prompt := PKeySignInPrompt.new(true)
	prompt.device_code = b["deviceCode"]
	prompt.user_code = b["userCode"]
	prompt.verification_uri = b["verificationUri"]
	prompt.verification_uri_complete = b["verificationUriComplete"]
	prompt.expires_in = _whole(b["expiresIn"])
	prompt.interval = _whole(b["interval"])
	prompt.expires_at = core.clock.system_now() + prompt.expires_in
	# The echo is what the page shows; an older Worker sends none, so show what was sent.
	if b.has("deviceName"):
		prompt.device_name = b["deviceName"] if b["deviceName"] is String else ""
	else:
		prompt.device_name = label
	return prompt


## Exactly one `POST /identity/auth/device/poll`; the caller paces. Returns {status, …}:
##   pending                     not finished yet
##   slow-down    {interval}     polled too fast: wait `interval` seconds before the next poll
##   confirm      {identity, attachable}
##                               signed in, held for the player's acceptance (confirm_identity)
##   ready        {identity, attached, stored, sync}
##                               the token is stored and the forced sync has run
##   timeout                     the server no longer knows the code
##   denied                      the server answered `error`
##   device-mismatch             401
##   transient    {code}         no answer, or a 5xx: says nothing about the sign-in
##   error        {code, message, status}
## A coroutine.
func poll_sign_in(prompt: PKeySignInPrompt) -> Dictionary:
	return await _poll(prompt, prompt.interval if prompt != null else 0, null)


func _poll(prompt: PKeySignInPrompt, current: int, decision: Variant) -> Dictionary:
	var core := _core()
	if core == null or not core.started:
		return {"status": "error", "code": PKeyErrors.NOT_CONFIGURED, "message": "Call configure() and start() first.", "status_code": 0}
	if prompt == null or not prompt.ok:
		return {"status": "error", "code": PKeyErrors.INVALID_OPTIONS, "message": "No usable sign-in prompt.", "status_code": 0}
	var body := {"deviceCode": prompt.device_code, "deviceId": core.device_id}
	var extra := {}
	if prompt.confirm_identity:
		body["confirmIdentity"] = true
		if decision != null:
			body["attachLicense"] = bool(decision)
		# The device's own token names the anonymous licence an attach would take. Sent only on
		# the opt-in: an ordinary poll asks for the identity's credential and carries no bearer.
		if core.tokens.has_token():
			extra["Authorization"] = "Bearer %s" % core.tokens.current()
	var r := await core.request("POST", "identity/auth/device/poll", body, false, extra)
	var status := _status(r)
	if status == 0:
		if r.code == PKeyErrors.LOCAL_ONLY or r.code == PKeyErrors.NOT_CONFIGURED:
			return {"status": "error", "code": r.code, "message": r.message, "status_code": 0}
		return {"status": "transient", "code": r.code, "message": r.message}
	if status >= 500:
		return {"status": "transient", "code": PKeyErrors.SERVER_ERROR, "message": "The poll answered %d." % status}
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var b: Dictionary = parsed["value"] if parsed["ok"] and parsed["value"] is Dictionary else {}
	if status == 429:
		# The Worker's own `slow_down` carries the interval; a rate limiter in front of it (or its
		# flat `rate_limited`) answers 429 without one, which RFC 8628 §3.5 treats the same way.
		return {"status": "slow-down", "interval": _whole(b["interval"]) if _seconds(b.get("interval")) else current + SLOW_DOWN_STEP_SECONDS}
	if status == 401:
		return {"status": "device-mismatch", "code": PKeyErrors.UNAUTHORIZED, "message": "The poll's device id is not the one the sign-in was started for.", "status_code": 401}
	if not r.ok:
		return {"status": "error", "code": r.code, "message": r.message, "status_code": status}
	match b.get("status"):
		"pending":
			return {"status": "pending"}
		"timeout":
			return {"status": "timeout"}
		"error":
			return {"status": "denied"}
		"confirm":
			return {"status": "confirm", "identity": _shown(b.get("identity")), "attachable": PKeyClaims.is_true(b.get("attachable"))}
		"ready":
			if not _str(b.get("token")):
				return {"status": "error", "code": PKeyErrors.INVALID_RESPONSE, "message": "The poll answered ready without a token.", "status_code": status}
			var shown := _shown(b.get("identity"))
			_last_identity = shown
			var stored := core.tokens.set_token(b["token"], PKeyTokenManager.SOURCE_SIGNIN)
			var synced: PKeySyncResult = null
			if on_acquired.is_valid():
				synced = await on_acquired.call()
			var attached: String = b["attached"] if b.get("attached") in ["claimed", "migrated"] else ""
			return {"status": "ready", "identity": shown, "attached": attached, "stored": stored, "sync": synced}
	return {"status": "error", "code": PKeyErrors.INVALID_RESPONSE, "message": "The poll answered an unknown state.", "status_code": status}


## Poll until the sign-in settles: the loop `begin_sign_in` runs (see the class doc for the
## rules). Ends `expired` once `prompt.expires_at` has passed without asking the server, and
## `cancelled` after `cancel()`. With `prompt.confirm_identity`, a `confirm` answer emits
## `sign_in_confirm` and the wait holds for `accept_sign_in()` (or cancel, or expiry). A coroutine.
func wait_for_sign_in(prompt: PKeySignInPrompt) -> PKeySignInResult:
	return await _wait(prompt, _generation)


func _wait(prompt: PKeySignInPrompt, gen: int) -> PKeySignInResult:
	var core := _core()
	if core == null or not core.started:
		return PKeySignInResult.ended(PKeySignInResult.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	if prompt == null or not prompt.ok:
		return PKeySignInResult.ended(PKeySignInResult.KIND_ERROR, PKeyErrors.INVALID_OPTIONS, "No usable sign-in prompt.")
	if not core.enabled("identity"):
		var off := PKeySignInResult.ended(PKeySignInResult.KIND_SERVICE_UNAVAILABLE, PKeyErrors.SERVICE_UNAVAILABLE, "The identity service is not enabled for %s." % core.product)
		off.detail = PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_DEVICECODE, "identity")
		return off
	var interval := prompt.interval
	var decision: Variant = null
	var resends := 0
	while true:
		if gen != _generation:
			return _cancelled_result()
		if core.clock.system_now() >= prompt.expires_at:
			return _expired()
		await _sleep(poll_delay(interval, prompt.expires_at - core.clock.system_now()))
		if gen != _generation:
			return _cancelled_result()
		if core.clock.system_now() >= prompt.expires_at:
			return _expired()
		var p := await _poll(prompt, interval, decision)
		if gen != _generation and p["status"] != "ready":
			return _cancelled_result()
		match p["status"]:
			"pending", "transient":
				continue
			"slow-down":
				interval = maxi(interval, int(p["interval"]))
				continue
			"confirm":
				# A decision answered `confirm` again: either the server read a stale record (re-send
				# the same decision) or the licence stopped being attachable (ask the player again).
				if decision != null and resends < MAX_DECISION_RESENDS and not (bool(decision) and not p["attachable"]):
					resends += 1
					continue
				decision = null
				resends = 0
				_decision = null
				_awaiting_decision = true
				# A handler may decide right here, synchronously, during the emit.
				sign_in_confirm.emit({"identity": p["identity"], "attachable": p["attachable"]})
				# Hold until the player decides, cancels, or the code's lifetime runs out.
				# One-second slices, so expiry is noticed promptly whatever the clock does.
				while _awaiting_decision and gen == _generation and core.clock.system_now() < prompt.expires_at:
					await _hold(minf(1.0, prompt.expires_at - core.clock.system_now()))
				_awaiting_decision = false
				if gen != _generation:
					return _cancelled_result()
				if _decision == null:
					return _expired()
				decision = _decision
				# The decision is a poll like any other: it waits out the interval first.
				continue
			"ready":
				return PKeySignInResult.signed_in(p["identity"], p["attached"], p["stored"], p["sync"])
			"timeout":
				return PKeySignInResult.ended(PKeySignInResult.KIND_TIMEOUT, PKeyErrors.SIGN_IN_EXPIRED, "The sign-in code is no longer known to the server; begin again.", 200)
			"denied":
				return PKeySignInResult.ended(PKeySignInResult.KIND_DENIED, PKeyErrors.SIGN_IN_DENIED, "The sign-in failed or was refused; begin again.", 200)
			"device-mismatch":
				return PKeySignInResult.ended(PKeySignInResult.KIND_DEVICE_MISMATCH, p["code"], p["message"], 401)
			_:
				return PKeySignInResult.ended(PKeySignInResult.KIND_ERROR, p.get("code", PKeyErrors.HTTP_ERROR), p.get("message", ""), p.get("status_code", 0))
	return _expired()


## The seconds the wait actually sleeps: `interval`, never under one second (a zero, negative or
## non-finite interval would spin) and never past the code's remaining lifetime.
static func poll_delay(interval: float, remaining: float) -> float:
	var ceiling := remaining if remaining >= 1.0 and not is_inf(remaining) else 1.0
	if is_nan(interval) or interval < 1.0:
		return 1.0
	return minf(interval, ceiling)


func _sleep(seconds: float) -> void:
	if sleeper.is_valid():
		# Tests: the injected sleeper advances a fake clock. A cancel that lands meanwhile is seen
		# by the caller's generation check after it returns.
		await sleeper.call(seconds)
		return
	await _hold(seconds)


## A real wait of `seconds` (a SceneTreeTimer that ignores pause and time scale) that cancel()
## and accept_sign_in() cut short. Re-checked by the caller, so a stale timer firing later can
## only cause one extra check, never a poll.
func _hold(seconds: float) -> void:
	if _host == null or not _host.is_inside_tree():
		return
	_sleep_gen += 1
	var gen := _sleep_gen
	var t := _host.get_tree().create_timer(maxf(seconds, 0.05), true, false, true)
	t.timeout.connect(func() -> void:
		if gen == _sleep_gen:
			_woke.emit())
	await _woke


func _expired() -> PKeySignInResult:
	return PKeySignInResult.ended(PKeySignInResult.KIND_EXPIRED, PKeyErrors.SIGN_IN_EXPIRED, "The sign-in code expired before the player finished.")


func _cancelled_result() -> PKeySignInResult:
	return PKeySignInResult.ended(PKeySignInResult.KIND_CANCELLED, PKeyErrors.CANCELLED, "The sign-in was cancelled.")


static func _start_failure(prompt: PKeySignInPrompt) -> PKeySignInResult:
	var status: int = prompt.detail.get("status", 0) if prompt.detail is Dictionary else 0
	var kind := PKeySignInResult.KIND_ERROR
	if prompt.code == PKeyErrors.SERVICE_UNAVAILABLE:
		kind = PKeySignInResult.KIND_SERVICE_UNAVAILABLE
	elif status == 429:
		kind = PKeySignInResult.KIND_RATE_LIMITED
	return PKeySignInResult.ended(kind, prompt.code, prompt.message, status)


static func _prompt_failure(code: StringName, message: String) -> PKeySignInPrompt:
	return PKeySignInPrompt.new(false, code, message)


## {name?, email?} from a server or document value: non-empty strings only, nothing else.
static func _shown(v: Variant) -> Dictionary:
	var out := {}
	if v is Dictionary:
		for k in ["name", "email"]:
			if _str(v.get(k)):
				out[k] = v[k]
	return out


static func _status(r: PKeyResult) -> int:
	return int(r.detail.get("status", 0)) if r.detail is Dictionary else 0


static func _str(v: Variant) -> bool:
	return v is String and v != ""


static func _seconds(v: Variant) -> bool:
	return PKeyClaims.is_number(v) and not is_nan(float(v)) and not is_inf(float(v)) and float(v) > 0.0


## A server's seconds rounded UP, so a 0.5 is one second rather than a sub-second spin (the same
## as the Node, Python and Swift SDKs).
static func _whole(v: Variant) -> int:
	return int(ceil(float(v)))
