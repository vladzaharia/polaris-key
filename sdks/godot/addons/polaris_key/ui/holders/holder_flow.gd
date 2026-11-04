class_name PKeyHolderFlow
extends VBoxContainer
## The holders' steps wired to the SDK (UK-43.14): the Done step after a license key activates, the
## account step it leads to, the manage QR of a screen with no browser, and the same account step
## from Settings. A gate (PKeyGateView) and the account tab (PKeyAccountTab) each own one.
##
##   done  PKeyActivateDone. The key is held in memory (`_key`) from `begin_done()` until Start using
##         (or the flow ends some other way) and is never stored or logged. The recommendation opens
##         AddToAccount; where Identity is off it opens the portal through the SDK's validated opener
##         (`#key=` on a computer or a phone, never on a pad-only screen), and on a pad-only screen
##         (a TV, a console) it shows the manage QR (D5), also without a key.
##   add   PKeyAddToAccount over AddToAccountModel and the SDK driver (licenseHolder.addIn "app" on a
##         computer, a phone and a tablet). The model's `changed` goes to the scene's `apply_snapshot()`.
##   qr    PKeyHolderQr.
##
## The account sign-ins (owned: Sign in to that account; email-bound: Use another account; Done
## waiting: Sign in as ...) start a device-code sign-in and show it on the same wait screen as the
## form's own: the code, the address, a QR code on a wide window, the way back to the page and a
## danger line when the page did not open. Cancel is live through every sign-in and returns to the
## step the person started from. A sign-in that does not finish says so on that step.
##
## Rules (the kit's): Escape or a pad's B never declines and never cancels work in flight (the scenes
## own that); a busy card takes no focus; problems are polite live regions.

## The flow is over: Start using, Done, or an account signed in. The key is already forgotten.
signal finished()

const Model := preload("res://addons/polaris_key/ui/model/add_to_account.gd")
const Driver := preload("res://addons/polaris_key/ui/model/add_to_account_driver.gd")

var done: PKeyActivateDone
var add: PKeyAddToAccount
var qr: PKeyHolderQr

## The PolarisKey node (handed to the three scenes).
var sdk: Node:
	get:
		return done.sdk
	set(value):
		done.sdk = value
		add.sdk = value
		qr.sdk = value

## Opened from Settings: no Done step, and Added closes with Done.
var from_settings := false
## Opens a URL (String) -> Error; replaced by a test. The default is the engine's.
var open_url: Callable = func(url: String) -> int: return OS.shell_open(url)
## Opens a device-code page (PKeySignInSession) -> bool; empty uses the SDK's validated opener.
var open_page: Callable = Callable()

var _stage := ""
var _key := ""
var _model: Model = null
var _driver: Driver = null
## The account sign-in in flight (a device-code session), its generation and the step it started from.
var _wait: PKeySignInSession = null
var _wait_gen := 0
var _wait_from := ""
## A catalog key for the problem line of the step on screen ("" for none).
var _problem := ""
## An account sign-in is starting (its session is not here yet): another press is ignored.
var _starting := false
## The email an account sign-in is for ("" when none is known).
var _signing_as := ""


func _init() -> void:
	name = "PKeyHolderFlow"
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	size_flags_vertical = Control.SIZE_EXPAND_FILL
	visible = false
	done = PKeyActivateDone.new()
	add = PKeyAddToAccount.new()
	qr = PKeyHolderQr.new()
	for v in [done, add, qr]:
		(v as PKeyUiView).auto_sdk = false
		# The flow shows one step at a time; a scene re-rendering (the gate's refresh, a keystroke) must
		# never undo it.
		v.hosted = true
		(v as Control).visible = false
		add_child(v)
	done.start_pressed.connect(_finish)
	done.add_pressed.connect(_on_done_add)
	done.sign_in_pressed.connect(func() -> void: _sign_in_for(_holder_email()))
	qr.done_pressed.connect(_on_qr_done)
	add.submitted.connect(_on_submitted)
	add.edited.connect(_on_edited)
	add.retry_pressed.connect(_on_retry)
	add.cancelled.connect(_on_add_cancelled)
	add.reopen_pressed.connect(_on_reopen)
	add.start_pressed.connect(_finish)
	add.sign_in_pressed.connect(_on_add_sign_in)
	add.verify_pressed.connect(_on_verify)


# ── State ────────────────────────────────────────────────────────────────────────────────

## The flow has a step on screen (a hold: the gate shows the product only when it is not).
func is_open() -> bool:
	return _stage != ""


## "", "done", "add" or "qr".
func stage() -> String:
	return _stage


## A sign-in to an account is running.
func is_waiting() -> bool:
	return _wait != null


func _core() -> PKeyCore:
	var s := sdk
	return s.core if s != null and s.get("core") != null else null


func _enabled(slug: String) -> bool:
	var c := _core()
	return c != null and c.enabled(slug)


## True where Add opens the portal instead of the form: Identity is off.
func _identity_on() -> bool:
	return _core() == null or _enabled("identity")


func _pad() -> bool:
	return PKeyUiView.pad_only()


func _kind() -> String:
	if PKeyUiView.is_mobile():
		return "phone"
	return "TV" if _pad() else "computer"


func _show(which: String) -> void:
	_stage = which
	visible = which != ""
	done.visible = which == "done"
	add.visible = which == "add"
	qr.visible = which == "qr"
	_push_problem()
	if which != "":
		(_scene() as PKeyUiView).refresh_view()


func _scene() -> Control:
	match _stage:
		"done":
			return done
		"add":
			return add
		"qr":
			return qr
	return null


## What the active scene's problem line shows now.
func _push_problem() -> void:
	var on_done := _stage == "done"
	var on_add := _stage == "add"
	var for_done := _problem if on_done else ""
	var for_add := _problem if on_add else ""
	if done.problem_key != for_done:
		done.problem_key = for_done
	if add.problem_key != for_add:
		add.problem_key = for_add


# ── Starting ─────────────────────────────────────────────────────────────────────────────

## The Done step after a key activated. The key stays in memory until the flow ends.
func begin_done(key: String) -> void:
	_reset()
	_key = key
	from_settings = false
	add.from_settings = false
	_facts()
	_show("done")
	_load_seat()


## The account step from Settings (no Done step): the form, or the manage QR on a pad-only screen.
func begin_add() -> void:
	_reset()
	from_settings = true
	add.from_settings = true
	_facts()
	if _pad() or not _identity_on():
		_show_qr()
		return
	_open_add()


## Leave the flow now (the host went away): any sign-in is let go, the key forgotten.
func close() -> void:
	_reset()
	_show("")


func _reset() -> void:
	_drop_wait()
	_key = ""
	_problem = ""
	_model = null
	_driver = null
	_stage = ""
	add.clear_values()
	add.step = "form"
	_clear_page()
	_push_problem()


## The facts the scenes read off the SDK.
func _facts() -> void:
	var facts: Dictionary = PKeyAccountController.facts(sdk)
	done.tier = String(facts["tier"])
	done.limit = int(facts["devices_limit"]) if facts["devices_limit"] != null else 0
	done.device_kind = _kind()
	done.seat = 0
	done.add_in = "portal" if _pad() else "app"
	done.identity_on = _identity_on()
	done.sync_on = _core() == null or _enabled("sync")
	done.license_on = _core() == null or _enabled("license")
	var email := _holder_email()
	done.holder_email = email
	add.holder_email = email
	add.identity_on = done.identity_on
	add.sync_on = done.sync_on
	add.device_kind = done.device_kind
	# No portal link: the offer is dropped quietly (a danger line is for a press that failed).
	done.no_add_action = _portal_path() and _portal_link() == ""
	_problem = ""
	_push_problem()


func _holder_email() -> String:
	if sdk == null or sdk.get("license") == null:
		return ""
	var p = sdk.license.get_profile()
	if p is Dictionary and p.get("email") is String:
		return String(p["email"]).strip_edges()
	return ""


## This device's seat among the license's devices, from the roster, when it answers (the step is drawn
## without it until then).
func _load_seat() -> void:
	if sdk == null or sdk.get("devices") == null:
		return
	var r: PKeyResult = await sdk.devices.list()
	if not is_instance_valid(self) or _stage != "done" or not r.ok:
		return
	if r.detail is Dictionary and r.detail.get("roster") == true and r.detail.get("devices") is Array:
		var n := (r.detail["devices"] as Array).size()
		if n > 0:
			done.seat = n


# ── The portal ───────────────────────────────────────────────────────────────────────────

## Add goes to the portal here: Identity is off, or a pad-only screen has no in-app channel.
func _portal_path() -> bool:
	return not _identity_on() or _pad()


## `_portal_path()`, for a host that draws its own Add (Settings).
func portal_path() -> bool:
	return _portal_path()


## The product page in the portal, or "": no link means Add has nothing to open.
func portal_link() -> String:
	return _portal_link()


## The product page in the portal, or "" (the Worker's own link, never a guess once it has answered).
func _portal_link() -> String:
	var c := _core()
	if c == null or sdk == null:
		return ""
	var link = PKeyPortal.portal_link(null, sdk.portal(), c.base_url, c.product)
	# Only a link the opener will take (https) is a link.
	return link if link is String and PKeyOutletAdapter.is_https(link) else ""


## Open the portal through the validated opener: `key` rides as `#key=` on a computer or a phone, never
## on a pad-only screen. False when there is no link or it did not open.
func open_portal(key := "") -> bool:
	var link := _portal_link()
	if link == "" or not PKeyOutletAdapter.is_https(link):
		return false
	var target := PKeyManage.with_key(link, key) if key != "" and not _pad() else link
	if not PKeyOutletAdapter.is_https(target):
		return false
	return int(open_url.call(target)) == OK


func _show_qr() -> void:
	qr.link = _portal_link()
	_show("qr")


func _on_qr_done() -> void:
	if _key != "":
		_show("done")
		return
	_finish()


func _on_done_add() -> void:
	if _problem == "signin.approve.failed":
		_problem = ""
	if done.model.get("copy", []).has("signin.key.addInLocker"):
		if _pad():
			_show_qr()
			return
		_problem = "" if open_portal(_key) else ("signin.handoff.noBrowser" if _portal_link() != "" else "common.linkUnavailable")
		_push_problem()
		return
	_open_add()


# ── The form ─────────────────────────────────────────────────────────────────────────────

## The model over the SDK driver (kept when it exists).
func _ensure_model() -> void:
	if _model != null:
		return
	_driver = Driver.new(sdk.identity, _on_page)
	_driver.open_page = _open_device_page
	_model = Model.new(_driver, {"services": ["license", "identity"]}, _kind())
	_model.changed.connect(_on_model_changed)


## Open a device-code page: a pad-only screen has no browser, so nothing opens and nothing is said.
func _open_device_page(session: PKeySignInSession) -> bool:
	if _pad():
		return true
	if open_page.is_valid():
		return bool(open_page.call(session))
	return int(sdk.identity.open_in_browser(session)) == OK


func _open_add() -> void:
	_model = null
	_ensure_model()
	_problem = ""
	_clear_page()
	add.clear_values()
	add.holder_email = _holder_email()
	_push_problem()
	_show("add")
	add.apply_snapshot(_model.snapshot())


func _on_model_changed(snap: Dictionary) -> void:
	# A sign-in to an account holds the screen: the model's own steps wait behind it.
	if _wait != null:
		return
	if snap.get("step") != "busy":
		_clear_page()
		if _problem != "signin.approve.failed":
			_problem = ""
		_push_problem()
	add.apply_snapshot(snap)


## The device-code fallback's page: where to type the code, and whether it opened.
func _on_page(info: Dictionary) -> void:
	add.address = String(info.get("address", ""))
	add.link = String(info.get("link", ""))
	var opened := bool(info.get("opened", false)) or _pad()
	add.opened = opened
	_problem = "" if opened else "signin.handoff.noBrowser"
	_push_problem()


func _clear_page() -> void:
	if add.address != "":
		add.address = ""
	if add.link != "":
		add.link = ""
	if not add.opened:
		add.opened = true


func _on_edited(field: String, value: String) -> void:
	if _model != null:
		_model.set_field(field, value)


func _on_submitted(person_name: String, email: String) -> void:
	if _model == null:
		return
	_problem = ""
	_push_problem()
	_model.set_field("name", person_name)
	_model.set_field("email", email)
	await _model.submit()


func _on_retry() -> void:
	if _model == null:
		_open_add()
		return
	_problem = ""
	_push_problem()
	# Other account, reached from an account sign-in: the model is on its own step, so go back to the form.
	if add.step == "other-account" and _model.step() != "other-account":
		_model.cancel()
		return
	await _model.try_again()


## Cancel (or Escape on a step with nothing in flight). A sign-in to an account is let go and the
## person is where they started; a running form sign-in is let go and the form kept; anywhere else the
## step is left.
func _on_add_cancelled() -> void:
	if _wait != null:
		_cancel_wait()
		return
	if _model != null and _model.step() == "busy":
		_model.cancel()
		return
	_leave()


## Back to the step before the account step (Done after a key, else the flow's end).
func _leave() -> void:
	_drop_wait()
	_model = null
	_problem = ""
	_clear_page()
	_push_problem()
	if _key != "":
		_show("done")
	else:
		_finish()


func _on_reopen() -> void:
	var ok := true
	if _wait != null:
		ok = _open_device_page(_wait)
	elif _model != null:
		ok = _model.reopen()
	if ok:
		add.opened = true
		if _problem == "signin.handoff.noBrowser":
			_problem = ""
	else:
		_problem = "signin.handoff.noBrowser"
	_push_problem()


## Sign in to that account (owned: the email typed) or Use another account (email-bound: the email the
## license waits for).
func _on_add_sign_in() -> void:
	_sign_in_for(add.typed_email_address().strip_edges() if add.step == "owned" else _holder_email())


## Verify the license's email: the account page in the browser.
func _on_verify() -> void:
	var r: PKeyResult = await sdk.identity.open_account()
	if not is_instance_valid(self):
		return
	_problem = "" if r.ok and not (r.detail is Dictionary and r.detail.get("opened") == false) else "signin.handoff.noBrowser"
	_push_problem()


# ── The account sign-ins ─────────────────────────────────────────────────────────────────

## Sign in to the account (a hint of the email the license waits for, never the blank form) and wait
## for it on the form's wait screen. A coroutine.
func _sign_in_for(hint: String) -> void:
	if _wait != null or _starting or sdk == null or sdk.get("identity") == null:
		return
	_problem = ""
	_starting = true
	_wait_from = _stage
	_signing_as = hint
	# The request is in flight: the step shows the busy bar, keeps its focus and ignores more presses.
	done.signing_in = true
	add.working = true
	var opts := {"channel": "device-code"}
	if hint != "":
		opts["login_hint"] = hint
	var gen := _wait_gen + 1
	_wait_gen = gen
	var session: PKeySignInSession = await sdk.identity.sign_in.start(opts)
	_starting = false
	if is_instance_valid(self):
		done.signing_in = false
		add.working = false
	if gen != _wait_gen or not is_instance_valid(self):
		if session != null and session.ok:
			session.cancel()
		return
	if not session.ok:
		_problem = "signin.approve.failed"
		_push_problem()
		return
	_wait = session
	_show_wait(session, _open_device_page(session))
	var o: PKeySignInOutcome = null
	while true:
		o = await session.wait()
		if gen != _wait_gen or not is_instance_valid(self):
			return
		if o.kind != PKeySignInOutcome.KIND_PENDING:
			break
	_wait = null
	if o.kind == PKeySignInOutcome.KIND_SIGNED_IN:
		_signed_in(o)
		return
	if o.kind != PKeySignInOutcome.KIND_CANCELLED:
		_problem = "signin.approve.failed"
	_restore_from_wait()


## The account signed in. When it is not the one the sign-in was for (the license's holder, or the email
## typed), nothing was added: the step says so, as the form's own path does.
func _signed_in(o: PKeySignInOutcome) -> void:
	var who = o.identity.get("email") if o.identity is Dictionary else null
	var signed: String = who.strip_edges() if who is String else ""
	if _signing_as != "" and signed != "" and signed.to_lower() != _signing_as.strip_edges().to_lower():
		_ensure_model()
		_clear_page()
		add.user_code = ""
		add.signing_as = ""
		add.typed_email = PKeyAccountController.mask_email(_signing_as)
		add.signed_email = PKeyAccountController.mask_email(signed)
		add.step = "other-account"
		_problem = ""
		_show("add")
		return
	_finish()


## The wait screen of an account sign-in: the form's own `waiting` step on the device-code channel.
func _show_wait(session: PKeySignInSession, opened: bool) -> void:
	add.user_code = session.user_code
	add.address = session.verification_uri
	add.link = session.verification_uri_complete
	add.opened = opened
	add.signing_as = PKeyAccountController.mask_email(_signing_as)
	add.step = "busy"
	_problem = "" if opened else "signin.handoff.noBrowser"
	_push_problem()
	_show("add")


## Cancel (or a failed sign-in): back to the step the person started from.
func _cancel_wait() -> void:
	if _wait == null:
		return
	_drop_wait()
	_problem = ""
	_restore_from_wait()


## Let the account sign-in go, with no step to return to.
func _drop_wait() -> void:
	if _wait == null:
		return
	var session := _wait
	_wait_gen += 1
	_wait = null
	session.cancel()


func _restore_from_wait() -> void:
	_clear_page()
	add.user_code = ""
	add.signing_as = ""
	_push_problem()
	if _wait_from == "add" and _model != null:
		add.apply_snapshot(_model.snapshot())
		_show("add")
	elif _wait_from == "done":
		_show("done")
	else:
		_finish()


# ── The end ──────────────────────────────────────────────────────────────────────────────

func _finish() -> void:
	_reset()
	_show("")
	finished.emit()


# ── Focus ────────────────────────────────────────────────────────────────────────────────

func _focus_chain() -> Array:
	var s := _scene()
	return (s as PKeyUiView)._focus_chain() if s != null else []


func _initial_focus() -> Control:
	var s := _scene()
	return (s as PKeyUiView)._initial_focus() if s != null else null


## Escape (or a pad's B) on the step on screen.
func _cancel() -> bool:
	var s := _scene()
	return s != null and (s as PKeyUiView)._cancel()


func _screen_key() -> String:
	var s := _scene()
	return "%s|%s|%s" % [_stage, (s as PKeyUiView)._screen_key() if s != null else "", _wait != null]
