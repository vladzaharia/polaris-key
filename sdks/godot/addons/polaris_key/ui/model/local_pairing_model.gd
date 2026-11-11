class_name PKeyLocalPairingModel
extends RefCounted
## LocalPairingModel (CC-29K): the state machine behind Pair with a Code, the port of ui-core's
## `localPairingModel.ts`, over `PolarisKey.cloud_connect.local_links` (or any object with the same
## calls). It holds what no view may: the stale-code guard, the 30-second wait after Too many tries
## and its second-time warning, the "someone may be guessing" notice and the order of the two roles.
##
##   choose -> show (closed) | enter (joining, waiting) -> confirm -> paired | failed
##
##   - show: the window runs from `expires_at`; a wrong guess changes the code (the changed digits
##     are lit, the new code announced); an end of `too-many-tries` closes it and a new code waits
##     30 s (the SDK enforces the same floor and answers `cooldown`, which this handles by waiting
##     out the rest); a window that ran out waits for nothing;
##   - the second `too-many-tries` in a row, or 5 wrong codes over renewed windows with no pairing,
##     warns that someone nearby may be guessing;
##   - enter: Pair is unavailable with fewer than 8 digits, a prefix with no dial left, or the very
##     code that just failed; pressing it answers its reason under the field. After `wrong` the first
##     two digits stay and the rest clears; after `spent` the field is empty and editable. The failed
##     code is held only while the screen is up and never shown or logged;
##   - Pair is the joiner's consent: the other device's prompt is confirmed at once and the screen
##     waits for the other person; Cancel stops the join at any point.
##
## The clock and the timer are injected (no wall clock in a test): `now` is a Callable() -> seconds
## since the epoch, `timer` a Callable(seconds, fn) -> a Callable that cancels it. `tick()` is
## public so a test drives the seconds itself.
##
## `links` calls, as `PKeyCloudLocalLinks` has them: `local_pairing()`, `list()`, `rename()`,
## `dials_left(text)`, `pair(options)` (a coroutine; ok with a window that has `stop()` and
## `renew()`), `join(options)` (a coroutine), `cancel_join()`. Offers have `label`, `categories`,
## `confirm()` and `decline()`.

## The snapshot changed (`snapshot()`).
signal changed(snapshot: Dictionary)

const Context := preload("res://addons/polaris_key/ui/model/context.gd")
const Local := preload("res://addons/polaris_key/ui/model/local.gd")

const TOO_MANY_WRONG := 5

## The cached state the views read plus what a renderer needs: `changed` (the digit positions, spaces
## counted, that changed in the last rotation), `rotation` (bumps with each new code), `name` (the
## paired screen's field), `id` (the pairing) and `left` (the person left: the host closes the screen).
var base: Dictionary = {}

var _links: Object = null
var _categories: Array = []
var _label := ""
var _pre_prompt := false
var _can_open_settings := false
var _now: Callable
var _timer: Callable
var _s: Dictionary = {}
var _shower: Object = null
var _offer: Object = null
var _joining := false
var _stop_tick: Callable = Callable()
var _expires_at := 0.0
var _cooldown_until := 0.0
var _too_many := 0
var _wrong := 0
var _failed_code: Variant = null
## The label of the last device that reached the prompt, for "Not paired with ...".
var _last_device: Variant = null
## Bumped when a screen's session ends, so a late callback from an old one is dropped.
var _epoch := 0
## What the person typed when Pair was pressed, so Cancel returns to it.
var _typed := ""
## Which view of the open window shows: "code" (the eight digits) or "qr" (the QR). A screen never
## shows both. Switching does not renew the code; a renewal updates whichever is open.
var _view := "code"
## Where the network answer came from, for Try again: {where, entry}.
var _blocked: Variant = null


## `options`: `links`, `categories` (ids, at most 8), `label`, `pre_prompt` (the system has not asked
## about the local network yet), `can_open_settings`, `now`, `timer`, `base` (the views' other input).
func _init(options: Dictionary) -> void:
	_links = options["links"]
	_categories = (options.get("categories", []) as Array).duplicate()
	_label = String(options.get("label", ""))
	_pre_prompt = options.get("pre_prompt") == true
	_can_open_settings = options.get("can_open_settings") == true
	base = options.get("base", {})
	_now = options.get("now", Callable(self, "_system_now"))
	_timer = options.get("timer", Callable(PKeyLocalPairingModel, "_system_timer"))
	_s = {
		"step": "choose",
		"categories": _categories.duplicate(),
		"changed": [],
		"rotation": 0,
		"name": "",
		"left": false,
		"max": Local.MAX_CONNECTABLE,
	}
	if _pre_prompt:
		_s["prePrompt"] = true


static func _system_now() -> float:
	return Time.get_unix_time_from_system()


## The default timer: a SceneTree timer, cancelled by the Callable it answers.
static func _system_timer(seconds: float, fn: Callable) -> Callable:
	var tree := Engine.get_main_loop() as SceneTree
	var t := tree.create_timer(seconds)
	t.timeout.connect(fn)
	return Callable(PKeyLocalPairingModel, "_cancel_timer").bind(t, fn)


static func _cancel_timer(t: SceneTreeTimer, fn: Callable) -> void:
	if t.timeout.is_connected(fn):
		t.timeout.disconnect(fn)


# ── State ────────────────────────────────────────────────────────────────────────────────────


func snapshot() -> Dictionary:
	return _s


func step() -> String:
	return String(_s.get("step", ""))


## The views' input: the base with the step on top.
func input() -> Dictionary:
	var out := base.duplicate(true)
	var pairing := _s.duplicate(true)
	for k in ["changed", "rotation", "name", "id", "left"]:
		pairing.erase(k)
	out["localPairing"] = pairing
	return out


func view() -> Dictionary:
	return Local.local_pairing_view(Context.new(input()))


## Read the gate and the cap: the entry screen says so before either button.
func start() -> void:
	_close()
	if not _links.local_pairing():
		_go({"step": "off"})
		return
	var full := false
	var r: PKeyResult = _links.list()
	if r.ok and (r.detail as Array).size() >= Local.MAX_PAIRED:
		full = true
	var entry := _entry()
	if full:
		entry["full"] = true
	_go(entry)


## Drop everything this model started: the window, a join and the timer. Call it when the screen goes.
func dispose() -> void:
	_close()


# ── Show ─────────────────────────────────────────────────────────────────────────────────────


## This device shows the code (and again for Show a code instead, from the field). A coroutine.
func show() -> void:
	if _s.get("full") == true:
		return
	await _open_window()


## Switch the open window between its two views, "code" and "qr". The window is not renewed.
func set_view(view: String) -> void:
	if step() != "show" or (view != "code" and view != "qr") or view == _view:
		return
	_view = view
	_merge({"view": view})


## Show a new code: closes the window and opens one with new first two digits. Waits out the 30
## seconds after Too many tries. A coroutine.
func show_new() -> void:
	if _cooldown_left() > 0:
		return
	await _open_window(true)


func _open_window(renew := false) -> void:
	var renewing := renew and _shower != null
	if not renewing:
		_epoch += 1
		_view = "code"
	var epoch := _epoch
	if renewing:
		# A second press while the first is answered does nothing.
		if _s.get("busy") != null:
			return
		_merge({"busy": "new-code"})
		var next: PKeyResult = await _shower.renew()
		if epoch != _epoch:
			return
		if next.ok:
			_rotate(next.detail)
		else:
			_fail(next, "show")
		return
	# The code tile is there at once, as a placeholder, while the window opens.
	_go({"step": "opening"})
	_close(false)
	_epoch = epoch
	var options := {
		"categories": _categories,
		"on_code": Callable(self, "_on_code").bind(epoch),
		"on_confirm": Callable(self, "_on_confirm").bind(epoch),
		"on_linked": Callable(self, "_on_linked").bind(epoch),
		"on_interrupted": Callable(self, "_on_interrupted").bind(epoch),
		"on_end": Callable(self, "_on_end").bind(epoch),
	}
	if _label != "":
		options["label"] = _label
	var r: PKeyResult = await _links.pair(options)
	if epoch != _epoch:
		if r.ok:
			r.detail.stop()
		return
	if r.ok:
		_shower = r.detail
	else:
		_fail(r, "show")


func _on_code(c: Dictionary, epoch: int) -> void:
	if epoch == _epoch:
		_rotate(c)


func _on_confirm(offer: Object, epoch: int) -> void:
	if epoch == _epoch:
		_confirm_prompt(offer)
	else:
		offer.decline()


func _on_linked(link: Dictionary, epoch: int) -> void:
	if epoch == _epoch:
		_linked(link)


func _on_interrupted(n: int, epoch: int) -> void:
	if epoch == _epoch and n >= 3 and step() == "show":
		_merge({"notice": "blocked"})


func _on_end(e: Dictionary, epoch: int) -> void:
	if epoch == _epoch:
		_ended(String(e.get("reason", "")))


## A new code on show: an opened one starts the window, any other is a rotation.
func _rotate(c: Dictionary) -> void:
	var prev := _s
	_expires_at = float(c.get("expires_at", 0.0))
	var reason := String(c.get("reason", ""))
	var opened := reason == PKeyConstants.LocalCodeReason.OPENED
	var wrong_code := reason == PKeyConstants.LocalCodeReason.WRONG_CODE
	# A changed code ends the session that was at the prompt: whatever the reason, its offer is over,
	# or the next device would be refused as "one at a time" by a prompt that is gone.
	if prev.get("step") == "confirm" or (not opened and not wrong_code):
		_offer = null
	if wrong_code:
		_wrong += 1
	var code := String(c.get("code", ""))
	var lit: Array = []
	var before := String(prev.get("code", ""))
	if not opened and before != "":
		for i in code.length():
			if i >= before.length() or code[i] != before[i]:
				lit.append(i)
	var notice := ""
	if not opened:
		notice = (
			("guessing" if _wrong >= TOO_MANY_WRONG else "rotated") if wrong_code else "declined"
		)
	var next := {
		"step": "show",
		"view": _view,
		"code": code,
		"qr": String(c.get("qr", "")),
		"secondsLeft": maxi(0, ceili(_expires_at - float(_now.call()))),
	}
	if notice != "":
		next["notice"] = notice
	if notice == "declined" and _last_device != null:
		next["device"] = _last_device
	_go(next, {"changed": lit, "rotation": int(prev.get("rotation", 0)) + 1})
	tick()


## The window ended: Too many tries closes it for 30 s; time running out, for nothing.
func _ended(reason: String) -> void:
	_offer = null
	_shower = null
	_cancel_tick()
	match reason:
		PKeyConstants.LocalWindowEnd.TOO_MANY_TRIES:
			_too_many += 1
			_cooldown_until = float(_now.call()) + Local.COOLDOWN_SECONDS
			var next := {
				"step": "closed",
				"closedBy": "too-many-tries",
				"cooldownLeft": Local.COOLDOWN_SECONDS
			}
			if _too_many >= 2:
				next["warn"] = true
			_go(next)
			tick()
		PKeyConstants.LocalWindowEnd.EXPIRED:
			var next := {"step": "closed", "closedBy": "expired"}
			if _too_many >= 2:
				next["warn"] = true
			_go(next)
		PKeyConstants.LocalWindowEnd.OFF:
			_go({"step": "off"})
		PKeyConstants.LocalWindowEnd.STORED:
			pass  # `on_linked` took the screen to paired
		_:
			# The person's own stop: back to the entry, nothing kept.
			_go(_entry())


# ── Confirm ──────────────────────────────────────────────────────────────────────────────────


func _confirm_prompt(offer: Object) -> void:
	if _offer != null:
		# One device at a time: the next one is declined, not left waiting.
		offer.decline()
		return
	_offer = offer
	var label := String(offer.label) if offer.label != null else ""
	_last_device = label if label != "" else null
	var next := {"step": "confirm", "categories": (offer.categories as Array).duplicate()}
	if label != "":
		next["device"] = label
	_go(next)


## The offer at the prompt when a press may act on it: not answered yet, not already pressed.
func _idle_offer() -> Object:
	if _offer != null and step() == "confirm" and _s.get("busy") == null:
		return _offer
	return null


## Pair: the person's yes. The link exists once the other person agrees too.
func confirm() -> void:
	var offer := _idle_offer()
	if offer == null:
		return
	# The press is answered at once: Pair keeps its label with a ring until the window answers.
	_merge({"busy": "pair"})
	offer.confirm()


## Not now: nothing is stored; the shower stays on its changed code.
func not_now() -> void:
	var offer := _idle_offer()
	if offer == null:
		return
	_merge({"busy": "not-now"})
	offer.decline()


func _linked(link: Dictionary) -> void:
	_shower = null
	_cancel_tick()
	_stored(link)


## A pairing was stored, from either role: the paired screen, and a clean slate for the next.
func _stored(link: Dictionary) -> void:
	_offer = null
	_joining = false
	_too_many = 0
	_wrong = 0
	_failed_code = null
	_last_device = null
	var label: Variant = link.get("label")
	var device := String(label) if label is String and label != "" else ""
	var next := {"step": "paired"}
	if device != "":
		next["device"] = device
	_go(next, {"name": device, "id": String(link.get("id", ""))})
	_check_reachable(String(link.get("id", "")))


## A pairing kept with Can connect off because 8 already are says so.
func _check_reachable(id: String) -> void:
	var epoch := _epoch
	var r: PKeyResult = _links.list()
	if not r.ok:
		return
	for l in r.detail:
		if l.get("id") == id:
			if l.get("reachable") != true and epoch == _epoch:
				_merge({"cantConnect": true})
			return


## The name field of the paired screen.
func set_name(text: String) -> void:
	if step() == "paired":
		_s["name"] = text
		_s.erase("nameError")
		changed.emit(_s)


## Done: a changed name is saved on this device, then the screen is left.
func done() -> void:
	var name := String(_s.get("name", ""))
	if (
		step() == "paired"
		and _s.get("id", "") != ""
		and name.strip_edges() != ""
		and name != _s.get("device")
	):
		var r: PKeyResult = _links.rename(_s["id"], name.strip_edges())
		if not r.ok:
			# The name was not kept: the screen stays and says so, so nothing is lost silently.
			_merge({"nameError": "failed"})
			return
	_leave()


# ── Enter ────────────────────────────────────────────────────────────────────────────────────


## This device types the code (and Enter a code instead, from a shown code: the window is withdrawn at
## once).
func enter() -> void:
	if _s.get("full") == true:
		return
	_close()
	_failed_code = null
	_go({"step": "enter", "entry": ""})
	_refresh_entry()


## The field changed. Spaces and hyphens in a paste are dropped; at most 8 digits are kept.
func set_entry(text: String) -> void:
	if step() != "enter":
		return
	var d := _digits_of(text)
	var prev := _digits_of(String(_s.get("entry", "")))
	# The old answer goes with the change; a wrong code's line stays until the person types past the
	# two digits the shower proved.
	var keep_wrong: bool = _s.get("error") == "wrong" and d.length() <= 2
	_s["entry"] = _grouped(d)
	if keep_wrong:
		_s["error"] = "wrong"
	else:
		_s.erase("error")
	if d != prev:
		_refresh_entry()
	else:
		changed.emit(_s)


static func _digits_of(text: String) -> String:
	var out := ""
	for ch in text:
		if ch >= "0" and ch <= "9":
			out += ch
	return out.substr(0, 8)


static func _grouped(d: String) -> String:
	return d.substr(0, 4) + " " + d.substr(4) if d.length() > 4 else d


## `triesLeft` and `pairDisabled` follow the field and the failed code.
func _refresh_entry() -> void:
	if step() != "enter":
		return
	var d := _digits_of(String(_s.get("entry", "")))
	var left: Variant = _links.dials_left(d)
	var stale: bool = _failed_code != null and d == _failed_code
	_s["triesLeft"] = left
	_s["pairDisabled"] = d.length() < 8 or (left != null and int(left) == 0) or stale
	changed.emit(_s)


## Pair. Unavailable, it answers its reason under the field and sends nothing. A coroutine.
func pair() -> void:
	if step() != "enter":
		return
	var d := _digits_of(String(_s.get("entry", "")))
	if _s.get("pairDisabled") == true:
		var reason := "not-a-code"
		if _failed_code != null and d == _failed_code:
			reason = "wrong"
		elif _s.get("triesLeft") != null and int(_s["triesLeft"]) == 0:
			reason = "spent"
		_merge({"error": reason})
		return
	_typed = _grouped(d)
	_epoch += 1
	var epoch := _epoch
	_joining = true
	_s["step"] = "joining"
	_s.erase("error")
	changed.emit(_s)
	var options := {
		"code": d,
		"categories": _categories,
		"on_confirm": Callable(self, "_on_join_confirm").bind(epoch),
	}
	if _label != "":
		options["label"] = _label
	var r: PKeyResult = await _links.join(options)
	if epoch != _epoch:
		return
	if r.ok:
		_stored(r.detail)
	else:
		_join_failed(r, d)


func _on_join_confirm(offer: Object, epoch: int) -> void:
	if epoch != _epoch:
		return
	_offer = offer
	# Pair was the yes: confirm at once and wait for the other person.
	_s["step"] = "waiting"
	_s["categories"] = (offer.categories as Array).duplicate()
	var label := String(offer.label) if offer.label != null else ""
	if label != "":
		_s["device"] = label
	changed.emit(_s)
	offer.confirm()


func _reason_of(r: PKeyResult) -> String:
	return String((r.detail as Dictionary).get("reason", "")) if r.detail is Dictionary else ""


func _join_failed(r: PKeyResult, code: String) -> void:
	_joining = false
	_offer = null
	var c := String(r.code)
	var reason := _reason_of(r)
	if c == PKeyConstants.ErrorCode.PAIRING_CODE_FAILED:
		if reason == PKeyConstants.PairingCodeFailedReason.SPENT:
			# The field is empty and editable; Pair waits for first two digits that differ.
			_failed_code = null
			_back("", "too-many")
			return
		if reason == PKeyConstants.PairingCodeFailedReason.INVALID:
			_back(_grouped(code), "not-a-code")
			return
		# `wrong` and another app's QR read alike. The first two digits stay.
		_failed_code = code
		_back(code.substr(0, 2), "wrong")
		return
	if c == PKeyConstants.ErrorCode.PAIRING_NOT_FOUND:
		_back(_grouped(code), "not-found")
		return
	if c == PKeyConstants.ErrorCode.PEER_CLOSED:
		if reason == PKeyConstants.LocalPairFailure.CANCELLED:
			_back(_grouped(code), "")
			return
		var why := "closed"
		if (
			reason == PKeyConstants.LocalPairFailure.DECLINED
			or reason == PKeyConstants.LocalPairFailure.TIMEOUT
		):
			why = reason
		_go({"step": "failed", "reason": why})
		return
	_fail(r, "enter", _grouped(code))


## Back to the field with the answer; Pair's state follows the field.
func _back(entry: String, error: String) -> void:
	var next := {"step": "enter", "entry": entry}
	if error != "":
		next["error"] = error
	_go(next)
	_refresh_entry()


# ── Leaving ──────────────────────────────────────────────────────────────────────────────────


## Cancel: withdraws the code, stops a join or declines a prompt, and returns one step.
func cancel() -> void:
	match step():
		"joining", "waiting":
			var offer := _offer
			if _joining:
				_links.cancel_join()
			_epoch += 1
			_joining = false
			_offer = null
			if offer != null:
				offer.decline()
			# Cancel stops the join, not the typing: the code is still in the field.
			_failed_code = null
			_go({"step": "enter", "entry": _typed})
			_refresh_entry()
		"opening", "show", "confirm", "enter":
			# Cancel on a window or a prompt, and Back on the field: one step back, to the entry.
			_close()
			_go(_entry())
		_:
			_leave()


func _close(with_leave := false) -> void:
	_epoch += 1
	_cancel_tick()
	var offer := _offer
	var shower := _shower
	var joining := _joining
	_offer = null
	_shower = null
	_joining = false
	if joining:
		_links.cancel_join()
	if offer != null:
		offer.decline()
	if shower != null:
		shower.stop()
	if with_leave:
		_leave()


## Close, Done or Cancel on the entry: the host closes the screen.
func close() -> void:
	_close(true)


## Try again, from a failed pairing, or from the network answer: back to the step it came from, with
## the field kept.
func retry() -> void:
	if step() != "network-blocked":
		enter()
		return
	var from: Variant = _blocked
	_blocked = null
	if from is Dictionary and from["where"] == "enter":
		enter()
		set_entry(String(from["entry"]))
		return
	await _open_window()


func _leave() -> void:
	_close()
	_s["left"] = true
	changed.emit(_s)


# ── Time ─────────────────────────────────────────────────────────────────────────────────────


func _cooldown_left() -> int:
	return maxi(0, ceili(_cooldown_until - float(_now.call())))


## One second passed: the ring and the wait follow the clock. Public so a test drives it.
func tick() -> void:
	_cancel_tick()
	if step() == "show":
		_s["secondsLeft"] = maxi(0, ceili(_expires_at - float(_now.call())))
	elif step() == "closed" and int(_s.get("cooldownLeft", 0)) > 0:
		var left := _cooldown_left()
		_s["cooldownLeft"] = left
		changed.emit(_s)
		if left == 0:
			return
		_stop_tick = _timer.call(1.0, Callable(self, "tick"))
		return
	else:
		return
	changed.emit(_s)
	_stop_tick = _timer.call(1.0, Callable(self, "tick"))


func _cancel_tick() -> void:
	if _stop_tick.is_valid():
		_stop_tick.call()
	_stop_tick = Callable()


# ── Errors ───────────────────────────────────────────────────────────────────────────────────


## A refusal no screen of the flow names: the gate, the cap, the network, or the shower.
func _fail(r: PKeyResult, where: String, entry := "") -> void:
	var code := String(r.code)
	var reason := _reason_of(r)
	var cap := String((r.detail as Dictionary).get("cap", "")) if r.detail is Dictionary else ""
	if code == PKeyConstants.ErrorCode.LOCAL_PAIRING_OFF:
		_go({"step": "off"})
	elif code == PKeyConstants.ErrorCode.NEARBY_PERMISSION_DENIED:
		_blocked = {"where": where, "entry": entry}
		var next := {"step": "network-blocked"}
		if _can_open_settings:
			next["canOpenSettings"] = true
		_go(next)
	elif (
		code == PKeyConstants.ErrorCode.LOCAL_LINKS_FULL
		and cap == PKeyConstants.LocalLinksCap.STORED
	):
		_go({"step": "choose" if where == "show" else "failed", "full": true, "reason": "full"})
	elif (
		code == PKeyConstants.ErrorCode.PEER_CLOSED
		and reason == PKeyConstants.LocalPairFailure.COOLDOWN
	):
		# The SDK's floor is on: wait out the rest of the 30 s on the closed screen.
		_cooldown_until = maxf(_cooldown_until, float(_now.call()) + Local.COOLDOWN_SECONDS)
		_go({"step": "closed", "closedBy": "too-many-tries", "cooldownLeft": _cooldown_left()})
		tick()
	else:
		_go({"step": "failed", "reason": "closed"})


# ── Plumbing ─────────────────────────────────────────────────────────────────────────────────


func _entry() -> Dictionary:
	var out := {"step": "choose"}
	if _pre_prompt:
		out["prePrompt"] = true
	return out


## Replace the screen: only what is named survives, with the form and the flags kept apart.
func _go(next: Dictionary, extra := {}) -> void:
	var out := {
		"categories": _s["categories"],
		"max": _s["max"],
		"changed": [],
		"rotation": _s["rotation"],
		"name": "",
		"left": _s["left"],
	}
	out.merge(next, true)
	out.merge(extra, true)
	_s = out
	changed.emit(_s)


func _merge(over: Dictionary) -> void:
	_s.merge(over, true)
	changed.emit(_s)
