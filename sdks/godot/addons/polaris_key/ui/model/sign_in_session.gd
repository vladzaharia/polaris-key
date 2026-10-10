extends RefCounted
## The state machine of the one sign-in form: the port of ui-core's `signInModel.ts`
## (`SignInModel`; SIGN-IN.md §3.17, plans/I-04.md §G, UI-KITS.md §1.3 "Sign-in and activation in
## three layers"). Its body morphs in place:
##
##   methods → handoff | code → finishing → choose ↔ replace | key → done
##                                    plus error, expired, cancelled (back to methods)
##
## It drives the SDK primitives of plans/I-04.md §G.9 (`signIn.start`, `session.wait()`,
## `session.reopen()`, `session.cancel()`, `choice.licenses / devices / complete / cancel`,
## `activate`); this file only names their shape. The form's steps are views of the pure models
## in `sign_in.gd` (SignIn, SignInHandoff, LicenseChoice), so a game that draws its own form on
## the snapshot gets the same steps, states and copy keys as the drop-in.
##
## `presentation` and `replace` are inputs: `inline` and `sheet` choose the license in the app
## (`licenseChoice: "app"`), `browser` leaves it to the card (`"card"`); a device-code sign-in
## always chooses on the card and never issues a grant (D4). `replace: "browser"` opens the card's
## Replace instead of the device list.
##
##   const SignInSession := preload("res://addons/polaris_key/ui/model/sign_in_session.gd")
##   var form = SignInSession.new({"primitives": primitives, "base": input})
##   form.changed.connect(func(_snapshot): redraw(form.views()))
##   await form.start()
##
## GDScript spellings of the TS shapes:
##
## - The store (`store.ts`) is folded in: `snapshot`, `subscribe(listener)` (returns the
##   unsubscribe Callable) and the `changed` signal. `deliver` is `func(fn: Callable) -> void`, the
##   UI-thread hook; `schedule` is `func(fn: Callable, ms: int) -> Callable` (returns the cancel),
##   the timer seam in place of `setTimeout`.
## - The primitives are a Dictionary of Callables, each awaited (a coroutine or a plain function):
##     start: func(options: Dictionary) -> handle
##     choice: {licenses: func(grant) -> Dictionary, devices: func(grant, license_id) -> Dictionary,
##              complete: func(grant, choice) -> Dictionary, cancel: func(grant) -> void}
##     activate: func(key) -> Dictionary (an ActivationInput)
##   A handle is `{browserOpened?, deviceCode?, wait: Callable, reopen: Callable, cancel: Callable}`.
##   GDScript has no exceptions: an answer that is not a Dictionary (null) is the TS rejection.
## - TS's `undefined` is an absent key: a null in a patch removes the member.
## - TS's `continue()` is `continue_choice()` (`continue` is a GDScript keyword).

const Context := preload("res://addons/polaris_key/ui/model/context.gd")
const SignIn := preload("res://addons/polaris_key/ui/model/sign_in.gd")
const View := preload("res://addons/polaris_key/ui/model/view.gd")

## Each new snapshot, through `deliver` (the store's listeners in signal form).
signal changed(snapshot: Dictionary)

## Seconds until a license-choice grant lapses when `wait()` names none.
const GRANT_SECONDS := 300

## The snapshot members besides `session` (`SignInSnapshot`): the inputs of the three step views.
const SNAPSHOT_KEYS := ["deviceCode", "choices", "replaceView", "selected", "loading", "activation", "keyField", "error"]

## The current snapshot: `{session, deviceCode?, choices?, replaceView?, selected?, loading?,
## activation?, keyField?, error?}`. A new Dictionary whenever anything changed; never mutate it.
var snapshot: Dictionary:
	get:
		return _state

var _state: Dictionary
var _listeners: Array = []
var _deliver: Callable
var _base: Dictionary
var _primitives: Variant
var _schedule: Callable
var _handle: Variant = null
var _grant: Variant = null
var _cancel_grant_timer := Callable()
## Bumped whenever a session ends, so a late answer from an old one is dropped.
var _epoch := 0
## False for a model restored from an input with no sign-in session (Identity off).
var _live := true


## Cancel a session the form no longer follows; its failure is nobody's to show. Deferred, like
## the TS's `Promise.resolve().then(…)`.
static func _release(handle: Variant) -> void:
	if not (handle is Dictionary):
		return
	var cancel_fn = handle.get("cancel")
	if cancel_fn is Callable and (cancel_fn as Callable).is_valid():
		(cancel_fn as Callable).call_deferred()


## Options: `primitives`, `presentation`, `replace`, `channel`, `base` (everything else the views
## read: identity, platform, capabilities, services), `deliver`, `schedule`.
func _init(options: Dictionary = {}) -> void:
	_primitives = options.get("primitives") if options.get("primitives") is Dictionary else null
	_base = options.get("base") if options.get("base") is Dictionary else {}
	_schedule = options.get("schedule") if options.get("schedule") is Callable else _default_schedule
	_deliver = options.get("deliver") if options.get("deliver") is Callable else Callable()
	_state = {
		"session": {
			"presentation": View.first([options.get("presentation"), "inline"]),
			"replace": View.first([options.get("replace"), "inline"]),
			"channel": View.first([options.get("channel"), "browser"]),
		},
	}


## A model holding `input`'s sign-in state as it stands, with no primitives behind it: how a runner
## (or a test) asks what the form shows for one snapshot.
static func restore(input: Dictionary, options: Dictionary = {}) -> RefCounted:
	var with_base := options.duplicate()
	with_base["base"] = input
	var m = new(with_base)
	m._live = input.has("signIn")
	var sign_in = input.get("signIn")
	if sign_in is Dictionary:
		var snap := {"session": sign_in.duplicate()}
		for k in ["deviceCode", "choices", "replaceView", "activation", "keyField", "error"]:
			if View.truthy(input.get(k)):
				snap[k] = input[k]
		for k in ["selected", "loading"]:
			if input.has(k):
				snap[k] = input[k]
		m._store_set(snap)
	return m


## Called with each new snapshot (through the UI-thread hook); returns the unsubscribe Callable.
func subscribe(listener: Callable) -> Callable:
	_listeners.append(listener)
	return func() -> void: _listeners.erase(listener)


## Change what the views read besides the form's own state (identity, platform, …).
func set_base(base: Dictionary) -> void:
	_base = base
	_store_set(_state.duplicate())


## The views' input: the base with the form's state on top. Drops the sign-in members when
## Identity is off, the way the SDK reports it (no session can exist).
func input() -> Dictionary:
	var s := _state
	var out := _base.duplicate()
	out["signIn"] = s["session"]
	for k in SNAPSHOT_KEYS:
		if s.has(k):
			out[k] = s[k]
	var services = _base.get("services")
	if not _live or (services is Array and not services.has("identity")):
		out.erase("signIn")
		out.erase("deviceCode")
	return out


## The form's three step views for the current snapshot: `{signIn, handoff, licenseChoice}`.
func views() -> Dictionary:
	var ctx := Context.new(input())
	return {
		"signIn": SignIn.sign_in_view(ctx),
		"handoff": SignIn.sign_in_handoff_view(ctx),
		"licenseChoice": SignIn.license_choice_view(ctx),
	}


## One step's view, by component name (`SignIn`, `SignInHandoff` or `LicenseChoice`).
func view(component: String) -> Dictionary:
	var v := views()
	if component == "SignIn":
		return v["signIn"]
	if component == "SignInHandoff":
		return v["handoff"]
	return v["licenseChoice"]


# ── Actions ─────────────────────────────────────────────────────────────────────────────────

func _patch(p: Dictionary, session: Dictionary = {}) -> void:
	var next := _assign(_state, p)
	next["session"] = _assign(_state["session"], session)
	_store_set(next)


func _require_primitives() -> Variant:
	if _primitives == null:
		push_error("ui-core SignInModel: no SDK primitives to drive")
	return _primitives


## Step 1 → 2: start a sign-in on `channel` (Continue in browser, a provider, Use a code).
## Options: `channel`, `provider`.
func start(options: Dictionary = {}) -> void:
	var p = _require_primitives()
	if p == null:
		return
	var channel: String = View.first([options.get("channel"), _state["session"]["channel"]])
	var presentation = _state["session"].get("presentation")
	# A second start (Retry, another provider, a double click) ends the first request too.
	var previous = _handle
	_end_session()
	_release(previous)
	_live = true
	var epoch := _epoch
	var session := {
		"presentation": _state["session"].get("presentation"),
		"replace": _state["session"].get("replace"),
		"channel": channel,
	}
	if channel == "browser":
		session["outcome"] = "pending"
	var fresh := {"session": session}
	if channel == "device-code":
		fresh["deviceCode"] = {"phase": "starting"}
	_store_set(fresh)
	var start_options := {
		"channel": channel,
		# Device code always chooses on the card (§G.2); browser presentation leaves it there.
		"licenseChoice": "card" if channel == "device-code" or presentation == "browser" else "app",
	}
	if View.truthy(options.get("provider")):
		start_options["provider"] = options["provider"]
	var handle = await p["start"].call(start_options)
	if not (handle is Dictionary):
		if epoch == _epoch:
			_patch({"error": {"code": "sign-in-failed"}}, {"outcome": null})
		return
	if epoch != _epoch:
		# The form moved on while the request started: nobody follows it now.
		_release(handle)
		return
	_handle = handle
	if channel == "device-code":
		_patch({"deviceCode": View.first([handle.get("deviceCode"), {"phase": "waiting"}])})
	elif handle.get("browserOpened") is bool and not handle["browserOpened"]:
		_patch({}, {"browserOpened": false})
	_pump(epoch)


## Wait on the session until it settles, applying each answer.
func _pump(epoch: int) -> void:
	while true:
		var h = _handle
		if h == null or epoch != _epoch:
			return
		var r = await h["wait"].call()
		if not (r is Dictionary):
			if epoch == _epoch:
				_patch({"error": {"code": "sign-in-failed"}})
			return
		if epoch != _epoch:
			return
		var outcome = r.get("outcome")
		if outcome == "pending":
			# The poll's phase and countdown change; the code and the address stay.
			if View.truthy(r.get("deviceCode")):
				_patch({"deviceCode": _spread(_state.get("deviceCode"), r["deviceCode"])})
			continue
		if outcome == "choose":
			_grant = r.get("grant")
			_arm_grant_timer(float(View.first([r.get("expiresIn"), GRANT_SECONDS])), epoch)
			_patch(
				{"choices": r.get("choices"), "loading": false},
				{"outcome": "choose", "event": null, "raced": false, "grantExpired": false},
			)
			return
		if outcome == "signedIn":
			_finish(r.get("issuedNow") is bool and r["issuedNow"])
			return
		if outcome == "expired":
			var device_code_channel: bool = _state["session"].get("channel") == "device-code"
			_patch(
				{"deviceCode": _spread(_state.get("deviceCode"), r["deviceCode"])} if View.truthy(r.get("deviceCode")) else {},
				{} if device_code_channel else {"outcome": "expired"},
			)
			if r.get("deviceCode") == null and _state["session"].get("channel") == "device-code":
				_patch({"deviceCode": {"phase": "expired"}})
			return
		if outcome == "cancelled":
			_cancelled()
			return


func _arm_grant_timer(seconds: float, epoch: int) -> void:
	if _cancel_grant_timer.is_valid():
		_cancel_grant_timer.call()
	# Weak, so a pending timer never keeps a disposed form alive.
	var me := weakref(self)
	var lapse := func() -> void:
		var m = me.get_ref()
		if m != null and epoch == m._epoch:
			m._patch({}, {"grantExpired": true})
	_cancel_grant_timer = _schedule.call(lapse, int(seconds * 1000))


func _finish(issued_now: bool) -> void:
	if _cancel_grant_timer.is_valid():
		_cancel_grant_timer.call()
	var channel = _state["session"].get("channel")
	_patch(
		{"deviceCode": {"phase": "ok"}} if channel == "device-code" else {},
		{"outcome": "signedIn", "issuedNow": issued_now, "event": null},
	)


func _cancelled() -> void:
	# Cancelling is not an error: the form goes back to step 1 with nothing else lost (DL7).
	_end_session()
	var s: Dictionary = _state["session"]
	_store_set({
		"session": {
			"presentation": s.get("presentation"),
			"replace": s.get("replace"),
			"channel": "browser" if s.get("channel") == "device-code" else s.get("channel"),
			"outcome": "cancelled",
		},
	})


func _end_session() -> void:
	_epoch += 1
	if _cancel_grant_timer.is_valid():
		_cancel_grant_timer.call()
	_cancel_grant_timer = Callable()
	_handle = null
	_grant = null


## Open browser again: the same request, never a second one.
func reopen() -> void:
	var h = _handle
	if h == null:
		return
	var opened = await h["reopen"].call()
	_patch({}, {"event": "reopen", "browserOpened": opened})


## The opener failed and the person copied the link instead.
func copy_link() -> void:
	_patch({}, {"event": "copy-link"})


## Use a code instead: the device-code channel, in the same form.
func use_code() -> void:
	# The epoch moves first, so the browser session's late "cancelled" never shows.
	var previous = _handle
	_end_session()
	_release(previous)
	await start({"channel": "device-code"})


## Cancel: back to step 1.
func cancel() -> void:
	var h = _handle
	var grant = _grant
	_cancelled()
	if h != null:
		await h["cancel"].call()
	var choice = _choice()
	if View.truthy(grant) and choice != null and choice.get("cancel") is Callable:
		await choice["cancel"].call(grant)


## Start again after an expired code, link or grant.
func retry() -> void:
	await start()


## Pick a row of the license choice (a license id, `keep` or `create`).
func select(id: String) -> void:
	_patch({"selected": id})


## Use a license key instead: the key step, keeping the account (Must not).
func have_key() -> void:
	_patch({"keyField": {"text": ""}}, {"event": "have-key"})


## Back from the key or Replace step to the license choice.
func back() -> void:
	_patch(
		{"replaceView": null, "activation": null, "keyField": null},
		{"event": null, "raced": false},
	)


## Submit the key step.
func submit_key(key: String) -> void:
	var p = _require_primitives()
	if p == null:
		return
	if not (p.get("activate") is Callable):
		push_error("ui-core SignInModel: no activate primitive")
		return
	_patch({"keyField": {"text": key, "submitted": true}, "activation": null})
	var epoch := _epoch
	var result = await p["activate"].call(key)
	if not (result is Dictionary):
		# A failed call is an error under the key field (DL7), never a silent stop.
		result = {"result": "error"}
	if epoch != _epoch:
		return
	if result.get("result") == "ok":
		_finish(true)
	else:
		_patch({"activation": result})


## Replace a device on a full license: the device list in place, or the card's Replace.
func open_replace(license_id: String) -> void:
	var choice = _choice()
	if _state["session"].get("replace") == "browser" or not View.truthy(_grant) or choice == null:
		# The card's Replace: the kit opens the row's freeDeviceUrl (replace-in-browser).
		_patch({}, {"event": "open-replace"})
		return
	var epoch := _epoch
	var replace_view = await choice["devices"].call(_grant, license_id)
	if not (replace_view is Dictionary):
		if epoch == _epoch:
			_patch({}, {"raced": true})
		return
	if epoch == _epoch:
		_patch({"replaceView": replace_view}, {"event": "open-replace"})


## Replace and continue.
func confirm_replace(device_id: String) -> void:
	var rv = _state.get("replaceView")
	var license_id = rv.get("licenseId") if rv is Dictionary else null
	if not View.truthy(license_id):
		return
	_patch({}, {"event": "confirm-replace"})
	await _complete({"kind": "license", "licenseId": license_id, "replaceDeviceId": device_id})


## Continue with the selected row (or the preselected one). TS's `continue()`.
func continue_choice() -> void:
	var choices = _state.get("choices")
	var pick = View.first([_state.get("selected"), choices.get("preselected") if choices is Dictionary else null])
	if not View.truthy(pick):
		return
	if pick == "keep":
		await _complete({"kind": "keep"})
	elif pick == "create":
		await _complete({"kind": "create"})
	else:
		await _complete({"kind": "license", "licenseId": pick})


func _complete(choice: Dictionary) -> void:
	var p = _require_primitives()
	if p == null:
		return
	var grant = _grant
	var c = _choice()
	if not View.truthy(grant) or c == null:
		return
	var epoch := _epoch
	_patch({}, {"redeeming": true})
	var r = await c["complete"].call(grant, choice)
	if not (r is Dictionary):
		if epoch == _epoch:
			_patch({"error": {"code": "sign-in-failed"}}, {"redeeming": false})
		return
	if epoch != _epoch:
		return
	_patch({}, {"redeeming": false})
	if r.get("outcome") == "signedIn":
		_finish(View.truthy(r.get("issuedNow")) or choice["kind"] == "create")
		return
	if r.get("outcome") == "expired":
		_patch({}, {"grantExpired": true})
		return
	# Raced: the seat was taken since the view loaded. Re-read the view and say so.
	_patch({}, {"raced": true})
	var fresh = await c["licenses"].call(grant)
	# A failed re-read keeps the race message over the last list; Continue tries again.
	if fresh is Dictionary and epoch == _epoch:
		_patch({"choices": fresh})


## Stop following the session: no answer is applied after this, and that is all. The request and
## any license-choice grant stay open on the server, so a screen that re-enters the tree can follow
## the same sign-in again with a new model. Call it when a view leaves the tree. To end the sign-in
## itself (the person cancelled, or the host closes the form for good), call `cancel()`, which
## cancels the request and the grant.
func dispose() -> void:
	_end_session()


# ── The store (store.ts, folded in) ───────────────────────────────────────────────────────────

## Replace the snapshot. The same Dictionary notifies no one (`Object.is`).
func _store_set(next: Dictionary) -> void:
	if is_same(_state, next):
		return
	_state = next
	var snap := _state
	var notify := func() -> void:
		for l in _listeners.duplicate():
			(l as Callable).call(snap)
		changed.emit(snap)
	if _deliver.is_valid():
		_deliver.call(notify)
	else:
		notify.call()


# ── Helpers (GDScript only) ──────────────────────────────────────────────────────────────────

## The `choice` primitives, or null (TS's `primitives?.choice`).
func _choice() -> Variant:
	if _primitives == null:
		return null
	var c = _primitives.get("choice")
	return c if c is Dictionary else null



## `{...base, ...over}` where a null in `over` removes the member (TS's `member: undefined`).
static func _assign(base: Dictionary, over: Dictionary) -> Dictionary:
	var out := base.duplicate()
	for k in over:
		if over[k] == null:
			out.erase(k)
		else:
			out[k] = over[k]
	return out


## `{...a, ...b}` for two values that may be absent.
static func _spread(a: Variant, b: Variant) -> Dictionary:
	var out: Dictionary = a.duplicate() if a is Dictionary else {}
	if b is Dictionary:
		for k in b:
			out[k] = b[k]
	return out


## `setTimeout` on the main loop's SceneTree: `fn` runs after `ms` (real time, through pause), and
## the returned Callable cancels it.
static func _default_schedule(fn: Callable, ms: int) -> Callable:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		push_error("ui-core SignInModel: no SceneTree to time the grant on")
		return func() -> void: pass
	var timer := tree.create_timer(ms / 1000.0, true, false, true)
	var state := {"live": true}
	var fire := func() -> void:
		if state["live"]:
			fn.call()
	timer.timeout.connect(fire)
	return func() -> void: state["live"] = false
