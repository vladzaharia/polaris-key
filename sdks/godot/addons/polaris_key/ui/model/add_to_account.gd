extends RefCounted
## AddToAccountModel: the state machine behind AddToAccount (UK-43.12), the port of ui-core's
## `addToAccountModel.ts`. A license that a key activated is floating; this adds it to an account.
## The person types a name and an email (they live only here, never in the views' input), the
## browser confirms the email, and the license is attached:
##
##   form -> busy -> added | owned | email-bound | other-account | failed   (invalid: a field is wrong)
##
## The model runs over a driver (add_to_account_driver.gd is the SDK's), three coroutine calls:
##
##   sign_in(hints) -> handle | null   hints {login_hint, name_hint, purpose}; null: could not start.
##                                     The handle has wait() -> {outcome, grant?, email?} (outcome
##                                     pending | signedIn | choose | cancelled | expired), reopen(),
##                                     cancel() and, when the sign-in has one, `user_code`
##   complete(grant, choice) -> {outcome}   "signedIn" when the choice completed
##   attach(confirm) -> {kind, code?}       kind ok | refused (code is the wire code) | error;
##                                          confirm false previews, nothing is written
##
## A sign-in that ends `signedIn` with no choice goes straight to attach, after a preview that
## writes nothing. The hints only prefill the page: nothing here sends a code. `attach` carries no
## address; the kit shows the account's email masked itself.
##
## `submit()` and `try_again()` are coroutines (they wait on the browser); `cancel()` may be called
## while one runs, and the late answer of the cancelled attempt is dropped (the epoch).

## The state changed; `snapshot` is `snapshot()`.
signal changed(snapshot: Dictionary)

const Context := preload("res://addons/polaris_key/ui/model/context.gd")
const Holders := preload("res://addons/polaris_key/ui/model/holders.gd")

## Everything else the views read (identity, platform, services, `licenseHolder`).
var base: Dictionary = {}
var _driver: Object = null
var _device_kind := ""
var _step := "form"
## `invalid`: the field to fix, "name", "email" or "both".
var _field := ""
## `other-account`: both emails, masked (never the full address).
var _typed_email := ""
var _signed_email_masked := ""
var _name := ""
var _email := ""
## `busy`: the code the person checks against the one Polaris Locker shows, when the sign-in has one.
var _user_code := ""
var _handle: Object = null
## Bumped when an attempt ends, so a late answer from an old one is dropped.
var _epoch := 0
## The account sign-in finished: Try again then attaches again, with no second sign-in.
var _signed_in := false
## The email of the account that signed in, when the sign-in named it ("" otherwise).
var _signed_email := ""
var _email_pattern: RegEx = null


func _init(driver: Object = null, p_base: Dictionary = {}, device_kind := "") -> void:
	_driver = driver
	base = p_base
	_device_kind = device_kind
	_email_pattern = RegEx.new()
	_email_pattern.compile("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")


# ── State ────────────────────────────────────────────────────────────────────────────────

## {step, field, typed_email, signed_email, name, email, user_code}. "" is none.
func snapshot() -> Dictionary:
	return {
		"step": _step, "field": _field, "typed_email": _typed_email, "signed_email": _signed_email_masked,
		"name": _name, "email": _email, "user_code": _user_code,
	}


func step() -> String:
	return _step


func _update(changes: Dictionary) -> void:
	for key in changes:
		set("_" + String(key), changes[key])
	changed.emit(snapshot())


## The views' input: the base with the step on top. Name and email are not in it.
func input() -> Dictionary:
	var out: Dictionary = base.duplicate(true)
	if _step == "busy" and _user_code != "":
		out["deviceCode"] = {"phase": "waiting", "userCode": _user_code}
	var a := {"step": _step}
	if _field != "":
		a["field"] = _field
	if _step == "other-account" and _typed_email != "":
		a["typedEmail"] = _typed_email
	if _step == "other-account" and _signed_email_masked != "":
		a["signedEmail"] = _signed_email_masked
	if _device_kind != "":
		a["deviceKind"] = _device_kind
	out["addToAccount"] = a
	return out


func view() -> Dictionary:
	return Holders.add_to_account_view(Context.new(input()))


## The person typed in a field ("name" or "email"); an `invalid` step goes back to `form`.
func set_field(field: String, value: String) -> void:
	if field != "name" and field != "email":
		push_error("AddToAccountModel: field is name or email")
		return
	if _step == "busy":
		return
	var changes := {field: value}
	if _step == "invalid":
		changes.merge({"step": "form", "field": ""})
	_update(changes)


## True when Continue (or Try again) would start the browser sign-in right now: the fields are
## valid and no sign-in has finished. A gate arms its tab inside the press only then.
func will_open_browser() -> bool:
	if _step == "busy" or _step == "other-account":
		return false
	return _name.strip_edges() != "" and _email_pattern.search(_email.strip_edges()) != null and not _signed_in


# ── Actions ──────────────────────────────────────────────────────────────────────────────

## Continue: check the fields, then sign in and attach. A coroutine.
func submit() -> void:
	if _step == "busy":
		return
	var name := _name.strip_edges()
	var email := _email.strip_edges()
	var bad_name := name == ""
	var bad_email := _email_pattern.search(email) == null
	if bad_name or bad_email:
		_update({"step": "invalid", "field": "both" if bad_name and bad_email else ("name" if bad_name else "email")})
		return
	await _run(name, email)


## Try again after `failed`: the same attempt, kept fields included. A coroutine.
func try_again() -> void:
	# A different account signed in: back to the form, the fields kept, to sign in again.
	if _step == "other-account":
		cancel()
		return
	if _step != "failed":
		return
	await submit()


## Bring the browser tab back while the sign-in runs. Call it inside the press. False when the page
## did not open.
func reopen() -> bool:
	if _handle == null:
		return true
	return _handle.reopen() != false


## Cancel: back to the form with the fields kept, any sign-in in flight let go.
func cancel() -> void:
	var handle := _handle
	_end()
	_signed_in = false
	_signed_email = ""
	_update({"step": "form", "field": "", "user_code": "", "typed_email": "", "signed_email_masked": ""})
	if handle != null:
		handle.cancel()


# ── The attempt ──────────────────────────────────────────────────────────────────────────

func _end() -> void:
	_epoch += 1
	_handle = null


func _land(step: String, epoch: int) -> void:
	if epoch == _epoch:
		_update({"step": step, "field": "", "user_code": ""})


func _run(name: String, email: String) -> void:
	if _driver == null:
		push_error("AddToAccountModel: no driver")
		return
	# Try again lets the previous sign-in go before it starts another.
	var prev := _handle
	_end()
	var epoch := _epoch
	if prev != null:
		prev.cancel()
	_update({"step": "busy", "field": "", "user_code": ""})
	if not _signed_in and not await _sign_in(name, email, epoch):
		return
	if epoch != _epoch:
		return
	_signed_in = true
	await _attach(email, epoch)


## Preview, check the account is the one typed, then attach.
func _attach(email: String, epoch: int) -> void:
	# Preview first: nothing is written until the account is the one the person typed.
	var preview: Dictionary = await _driver.attach(false)
	if epoch != _epoch:
		return
	if preview.get("kind") != "ok":
		if preview.get("code") == "account_required":
			_signed_in = false
		_land(_step_of(preview), epoch)
		return
	if _signed_email != "" and _signed_email.strip_edges().to_lower() != email.to_lower():
		# A different account signed in than the email typed: the license is added nowhere, and
		# Try again goes back to the form. Both emails are shown masked, never in full.
		_signed_in = false
		_update({
			"step": "other-account", "field": "",
			"typed_email": Holders.mask_email(email), "signed_email_masked": Holders.mask_email(_signed_email),
		})
		return
	var result: Dictionary = await _driver.attach(true)
	if epoch != _epoch:
		return
	# No account session after all: Try again signs in again.
	if result.get("kind") == "refused" and result.get("code") == "account_required":
		_signed_in = false
	_land(_step_of(result), epoch)


## True when the account sign-in ended signed in; otherwise the step is already set.
func _sign_in(name: String, email: String, epoch: int) -> bool:
	var handle: Object = await _driver.sign_in({"login_hint": email, "name_hint": name, "purpose": "attach"})
	if epoch != _epoch:
		if handle != null:
			handle.cancel()
		return false
	if handle == null:
		_land("failed", epoch)
		return false
	_handle = handle
	var user_code = handle.get("user_code")
	if user_code is String and user_code != "":
		_update({"user_code": user_code})
	var verdict := "pending"
	while verdict == "pending":
		verdict = await _settle(await handle.wait(), epoch)
	return verdict == "signed-in"


## One answer of the wait: "pending" (wait again), "signed-in", or "stop" (the step is set, or
## the attempt was let go).
func _settle(r: Dictionary, epoch: int) -> String:
	if epoch != _epoch:
		return "stop"
	var outcome: String = r.get("outcome", "")
	var verdict := "stop"
	match outcome:
		"pending":
			verdict = "pending"
		"signedIn":
			_signed_email = String(r.get("email", ""))
			# Settled: nothing left to cancel on Try again.
			_handle = null
			verdict = "signed-in"
		"choose":
			var done: Dictionary = await _driver.complete(String(r.get("grant", "")), {"kind": "keep"})
			if epoch != _epoch:
				return "stop"
			if done.get("outcome") == "signedIn":
				_signed_email = ""
				verdict = "signed-in"
			else:
				_land("failed", epoch)
		"cancelled":
			_land("form", epoch)
		_:
			# expired, or anything unknown.
			_land("failed", epoch)
	return verdict


## The step an attach answer lands on.
static func _step_of(result: Dictionary) -> String:
	match result.get("kind"):
		"ok":
			return "added"
		"refused":
			match result.get("code"):
				"license_owned":
					return "owned"
				"license_email_bound":
					return "email-bound"
	# `account_required`, an error, and anything else: Try again.
	return "failed"
