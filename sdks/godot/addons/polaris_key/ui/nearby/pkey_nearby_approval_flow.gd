class_name PKeyNearbyApprovalFlow
extends RefCounted
## What the approver screen (PKeyNearbyApproval) does with the SDK, headless (WIRE-CONTRACT-V5 section 15.6.1; UXR
## rules): "Approve a nearby device" starts the advert (`identity.nearby.on_request`), one new device's three codes
## are shown, the tapped one is the pick, and the licence choice, when the Worker asks for it, is one tap per
## licence. Ported from the Python Qt kit's `NearbyApproval` (reference: Swift `NearbyApprovalModel`).
##
## Rules:
##  - the SDK approves only a code that matched; a wrong one is `mismatch` and nothing is approved;
##  - one answer per ask: a second tap while the Worker is asked does nothing (the screen is `working`);
##  - leaving the codes or the licence choice by any route (Deny, Escape, the screen closing) answers Deny: before
##    a code was picked it is local (no route is called), at the licence choice it is the choice's own cancel;
##  - an outcome stops the advert's prompt: nothing is left listening that the person did not ask for;
##  - the licences are the free ones, at most 9, each one tap; the digits 1 to n are the n that are there.
##
## `exited` is emitted when the person is done (Done, Cancel, or an outcome that ends it); `devices_requested` when
## Manage devices is chosen after a device limit, and `sign_in_requested` when Sign in is chosen after
## `account-required`.

signal exited()
signal devices_requested()
signal sign_in_requested()

const OUTCOMES := ["approved", "not-nearby", "mismatch", "denied", "expired", "device-limit", "account-required", "rate-limited", "failed"]

var view: PKeyNearbyApproval
var sdk: Node

var _approver: Object = null
var _ask: PKeyNearbyAsk = null
var _choose: PKeyNearbyChoose = null
var _free: Array = []
var _open := false
var _closed := false
var _start_gen := 0


func _init(p_view: PKeyNearbyApproval, p_sdk: Node) -> void:
	view = p_view
	sdk = p_sdk
	view.entry_pressed.connect(open)
	view.code_chosen.connect(pick)
	view.choice_chosen.connect(choose)
	view.create_chosen.connect(create)
	view.denied.connect(deny)
	view.primary_pressed.connect(_primary)


func _to_string() -> String:
	return "PKeyNearbyApprovalFlow(%s)" % view.step


## "Approve a nearby device": show the waiting screen and start listening (the prompt is open).
func open() -> void:
	if _closed or _open:
		return
	_open = true
	_start_gen += 1
	var gen := _start_gen
	_ask = null
	_choose = null
	view.device = ""
	view.codes = PackedStringArray()
	view.step = "waiting"
	var r: PKeyResult = await sdk.identity.nearby.on_request(Callable(self, "_on_ask"), {"prompt": true})
	if _closed or gen != _start_gen or not _open:
		if r.ok:
			r.detail.stop()
		return
	if not r.ok:
		# Signed out reads as such; a service or network failure is not an expired code.
		_ended("account-required" if r.code == PKeyConstants.ErrorCode.ACCOUNT_REQUIRED else "failed")
		return
	_approver = r.detail
	_approver.stopped.connect(_on_stopped)


## The advert stopped on its own. Two declined requests (`budget`) say so and offer Start again; a sign-out and a
## discovery failure are their own endings.
func _on_stopped(reason: String) -> void:
	if not _open or _closed:
		return
	match reason:
		"budget":
			_ask = null
			_choose = null
			view.step = "stopped"
		"signed-out":
			_ended("account-required")
		_:
			_ended("failed")


## Start again after the advert paused: the failure budget counts from zero and the waiting screen returns.
func _start_again() -> void:
	if _closed or _approver == null or view.step != "stopped":
		return
	view.step = "waiting"
	await _approver.reopen()


## A device asks: show its three codes. One at a time; the approver queues the rest.
func _on_ask(ask: PKeyNearbyAsk) -> void:
	if _closed or not _open or _ask != null:
		ask.deny()
		return
	_ask = ask
	view.device = ask.device
	view.codes = ask.codes
	view.step = "ask"
	ask.closed.connect(func(_code: StringName, _by_peer: bool) -> void:
		# The device left before the person answered: say so, naming it (the screen keeps its name), with Done.
		if _ask == ask and view.step == "ask" and not _closed:
			_ended("expired"))


## The person tapped this code: the SDK approves only a code that matched.
func pick(code: String) -> void:
	var ask := _ask
	if _closed or view.step != "ask" or ask == null or not view.codes.has(code):
		return
	view.step = "working"
	var gen := _start_gen
	_stepped(await ask.pick(code), gen)


## A licence of the choice (its position, from 0).
func choose(index: int) -> void:
	if index < 0 or index >= _free.size():
		return
	await _answer({"kind": "license", "license_id": String(_free[index]["id"])})


func create() -> void:
	await _answer({"kind": "create"})


func _answer(choice: Dictionary) -> void:
	var step := _choose
	if _closed or step == null or view.step != "choose":
		return
	_choose = null
	view.step = "working"
	var gen := _start_gen
	_stepped(await step.choose(choice), gen)


## Deny: before a code was picked it is "none of these match" (no route is called); at the licence choice it is the
## choice's own cancel.
func deny() -> void:
	if _closed:
		return
	var step := _choose
	if step != null and view.step == "choose":
		_choose = null
		view.step = "working"
		var gen := _start_gen
		_stepped(await step.cancel(), gen)
		return
	var ask := _ask
	if ask != null and view.step == "ask":
		_ask = null
		ask.deny()
		_ended("denied")


func _stepped(step: PKeyNearbyStep, gen: int) -> void:
	if _closed or gen != _start_gen:
		# The screen was left while the Worker was asked: a licence choice that comes back now is answered Deny,
		# never dropped for the request to lapse.
		if step.kind == PKeyNearbyStep.KIND_CHOOSE and step.choose != null:
			step.choose.cancel()
		return
	if step.kind == PKeyNearbyStep.KIND_CHOOSE and step.choose != null:
		var offered: Dictionary = step.choose.choices
		_free = []
		for c: Variant in offered.get("choices", []):
			if c is Dictionary and (c as Dictionary).get("state") == "free" and (c as Dictionary).get("id") is String:
				_free.append(c)
		_free = _free.slice(0, PKeyNearbyApproval.MAX_CHOICES)
		var names := PackedStringArray()
		for c: Dictionary in _free:
			var shown := String(c.get("name") if c.get("name") is String else c.get("tierName", ""))
			names.append(PKeyPeerPayload.clean_label(shown))
		view.choices = names
		view.create_offered = offered.get("create") != null
		_choose = step.choose
		view.step = "choose"
		return
	_ended(String(step.kind) if OUTCOMES.has(String(step.kind)) else "expired")


## An outcome: it stops the advert's prompt and shows where it came to, with Done.
func _ended(step: String) -> void:
	_ask = null
	_choose = null
	_open = false
	_stop_approver()
	view.step = step


func _stop_approver() -> void:
	if _approver != null:
		var a := _approver
		_approver = null
		a.stop()


func _primary(step: String) -> void:
	match step:
		"common.done", "leave":
			leave()
		"signin.nearby.startAgain", "stopped":
			_start_again()
		"devices.manage", "device-limit":
			leave()
			devices_requested.emit()
		"account-required":
			leave()
			sign_in_requested.emit()
		_:
			leave()


## Done or Cancel: the advert's prompt closes and `exited` is emitted. Leaving the codes or the choice answers Deny.
func leave() -> void:
	_start_gen += 1
	_deny_on_leave()
	_open = false
	_stop_approver()
	exited.emit()


func _deny_on_leave() -> void:
	var ask := _ask
	var step := _choose
	_ask = null
	_choose = null
	if step != null:
		step.cancel()
	elif ask != null and view.step == "ask":
		ask.deny()


## The screen is going away: the same as leaving, with nothing more to show.
func close() -> void:
	_start_gen += 1
	_deny_on_leave()
	_closed = true
	_open = false
	_stop_approver()
