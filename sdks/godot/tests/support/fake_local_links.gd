extends RefCounted
## A scripted stand-in for `PolarisKey.cloud_connect.local_links` (the calls the Pair with a Code models
## make) and a virtual clock, so the models' tests run with no network, no wall clock and no timer
## of the engine's. A test drives the other device through `last_pair` (the options `pair` was given:
## `on_code`, `on_confirm`, `on_linked`, `on_interrupted`, `on_end`) and `last_join`.

## Whether the gate is on, and what `list()` holds ({id, label, last_seen, reachable, ...}).
var gate := true
var links: Array = []
var list_failure := false
## Answers (PKeyResult) the next calls give, or null for the default.
var pair_result: PKeyResult = null
var join_result: PKeyResult = null
var rename_result: PKeyResult = null
var remove_result: PKeyResult = null
## The join waits for `finish_join` while this is true.
var hold_join := false

var window: Shower = Shower.new()
var last_pair: Dictionary = {}
var last_join: Dictionary = {}
var pairs := 0
var joins := 0
var cancels := 0
var renamed: Array = []
var removed: Array = []
var reachable_calls: Array = []
## Dials left by the first two digits, by prefix; a prefix not named has 2.
var dials: Dictionary = {}

## Virtual time.
var now_seconds := 1700000000.0
var timers: Array = []

var _listeners: Array = []
var _held: Array = []


func now() -> float:
	return now_seconds


## A timer the test advances: Callable(seconds, fn) -> a Callable that cancels it.
func timer(seconds: float, fn: Callable) -> Callable:
	var entry := {"at": now_seconds + seconds, "fn": fn, "live": true}
	timers.append(entry)
	return Callable(self, "_cancel").bind(entry)


func _cancel(entry: Dictionary) -> void:
	entry["live"] = false


## Move the clock on by `seconds`, running each timer that comes due, in order.
func advance(seconds: float) -> void:
	var to := now_seconds + seconds
	while true:
		var next: Dictionary = {}
		for e in timers:
			if e["live"] and e["at"] <= to and (next.is_empty() or e["at"] < next["at"]):
				next = e
		if next.is_empty():
			break
		next["live"] = false
		now_seconds = maxf(now_seconds, next["at"])
		next["fn"].call()
	now_seconds = to


func pending_timers() -> int:
	var n := 0
	for e in timers:
		if e["live"]:
			n += 1
	return n


# ── The calls ────────────────────────────────────────────────────────────────────────────────


func local_pairing() -> bool:
	return gate


func list() -> PKeyResult:
	if list_failure:
		return PKeyResult.failure(&"storage-failed", "unreadable")
	return PKeyResult.success(links.duplicate(true))


func rename(id: String, label: String) -> PKeyResult:
	renamed.append([id, label])
	if rename_result != null:
		return rename_result
	for l in links:
		if l["id"] == id:
			l["label"] = label
	return PKeyResult.success()


func remove(id: String) -> PKeyResult:
	removed.append(id)
	if remove_result != null:
		return remove_result
	links = links.filter(func(l: Dictionary) -> bool: return l["id"] != id)
	return PKeyResult.success()


func set_reachable(id: String, on: bool) -> PKeyResult:
	reachable_calls.append([id, on])
	var on_count := 0
	for l in links:
		if l["reachable"]:
			on_count += 1
	if on and on_count >= 8:
		return PKeyResult.failure(&"local-links-full", "full", {"cap": "reachable"})
	for l in links:
		if l["id"] == id:
			l["reachable"] = on
	return PKeyResult.success()


func on_change(fn: Callable) -> Callable:
	_listeners.append(fn)
	return Callable(self, "_off").bind(fn)


func _off(fn: Callable) -> void:
	_listeners.erase(fn)


func listeners() -> int:
	return _listeners.size()


## The other side changed the links.
func notify() -> void:
	for fn in _listeners.duplicate():
		fn.call()


func dials_left(text: String) -> Variant:
	if text.length() < 2:
		return null
	return dials.get(text.substr(0, 2), 2)


func pair(options: Dictionary) -> PKeyResult:
	pairs += 1
	last_pair = options
	await Engine.get_main_loop().process_frame
	if pair_result != null:
		return pair_result
	window = Shower.new()
	return PKeyResult.success(window)


func join(options: Dictionary) -> PKeyResult:
	joins += 1
	last_join = options
	if hold_join:
		var slot := {"result": null}
		_held.append(slot)
		while slot["result"] == null:
			await Engine.get_main_loop().process_frame
		return slot["result"]
	await Engine.get_main_loop().process_frame
	if join_result != null:
		return join_result
	return PKeyResult.success(
		{"id": "L9", "label": "Studio PC", "categories": options["categories"]}
	)


## Answer the joins that wait.
func finish_join(result: PKeyResult) -> void:
	for slot in _held:
		slot["result"] = result
	_held = []


func cancel_join() -> void:
	cancels += 1
	finish_join(PKeyResult.failure(&"peer-closed", "cancelled", {"reason": "cancelled"}))


# ── Results ──────────────────────────────────────────────────────────────────────────────────


static func fail(code: String, detail: Variant = null) -> PKeyResult:
	return PKeyResult.failure(StringName(code), code, detail)


static func row(
	id: String, label: Variant, last_seen: Variant = 1700000000, reachable := true
) -> Dictionary:
	return {
		"id": id,
		"label": label,
		"categories": [],
		"created_at": 1,
		"last_seen": last_seen,
		"reachable": reachable,
		"platform": null
	}


static func code(digits: String, reason: String, expires_at: float) -> Dictionary:
	return {
		"code": digits,
		"qr": "PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y",
		"nameplate": "x",
		"reason": reason,
		"expires_at": expires_at,
		"failures": 0
	}


# -- Doubles ---------------------------------------------------------------------------------


## One offer at a consent prompt.
class Offer:
	extends RefCounted
	var label := ""
	var categories: Array = []
	var confirms := 0
	var declines := 0

	func _init(p_label := "", p_categories := []) -> void:
		label = p_label
		categories = p_categories

	func confirm() -> void:
		confirms += 1

	func decline() -> void:
		declines += 1


## The window `pair` answers.
class Shower:
	extends RefCounted
	var stops := 0
	var renews: Array = []
	var renew_calls := 0

	func stop() -> void:
		stops += 1

	## The next scripted answer (a PKeyResult).
	func renew() -> PKeyResult:
		renew_calls += 1
		await Engine.get_main_loop().process_frame
		return (
			renews.pop_front()
			if not renews.is_empty()
			else PKeyResult.failure(&"peer-closed", "closed", {"reason": "closed"})
		)
