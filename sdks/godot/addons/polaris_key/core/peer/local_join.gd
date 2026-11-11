@tool
class_name PKeyPeerLocalJoin
extends RefCounted
## WIRE-CONTRACT-V5 section 15.12, "The joiner": the joiner's choices over one browse, ported from `JoinPlan` in
## `packages/client-core/src/peer/local.ts`. A code or QR that did not parse browses nothing and answers
## `pairing-code-failed`. Matching `m=q` adverts are kept once each in first-seen order, at most `KEPT`, and the
## first `CANDIDATES` are dialled, never redialled. The first session that reaches the transport ends the dial.
##
## The input is {kind = "code", nameplate}, {kind = "qr", instance}, {kind = "invalid"} or {kind = "other-app"}.
## A dial ends as "transport", "before-c2", "after-c2" or "budget" (a dial the budget stopped in the middle of a
## join: nothing was dialled).

const CANDIDATES := 2
## The joiner keeps at most this many matching `m=q` names while it joins.
const KEPT := 8

var _input: Dictionary
var _kept: Array[String] = []
var _dials := 0
var _transport := false
var _after_c2 := false
var _budget_stopped := false
var _spent_at_start := false


func _init(input: Dictionary) -> void:
	_input = input


func _to_string() -> String:
	return "PKeyPeerLocalJoin(%s)" % _input.get("kind", "")


## Whether anything is browsed at all.
func browses() -> bool:
	var kind: String = _input.get("kind", "")
	return kind != "invalid" and kind != "other-app" and not _spent_at_start


## The nameplate's dials were spent before the join began: nothing is browsed or dialled.
func start_spent() -> void:
	_spent_at_start = true


func kept() -> Array[String]:
	return _kept


## One `m=q` advert seen. `tag_matches` is whether its `h` is this product's tag of the current or previous
## epoch; `n` its nameplate. True when it was kept.
func see(instance: String, tag_matches: bool, n: String) -> bool:
	if not browses() or not tag_matches:
		return false
	var matched: bool = n == _input.get("nameplate") if _input.get("kind") == "code" else instance == _input.get("instance")
	if not matched or _kept.has(instance) or _kept.size() >= KEPT:
		return false
	_kept.append(instance)
	return true


## The next advert to dial, or "" when the dial has ended.
func next() -> String:
	if _transport or _dials >= CANDIDATES or _dials >= _kept.size():
		return ""
	return _kept[_dials]


## The dial of `next()` ended this way.
func ended(outcome: String) -> void:
	_dials += 1
	if outcome == "transport":
		_transport = true
	elif outcome == "after-c2":
		_after_c2 = true
	elif outcome == "budget":
		_budget_stopped = true


## The answer once no dial is left (or the browse ran out): "transport", "pairing-code-failed" or
## "pairing-not-found".
func result() -> String:
	if not browses():
		return "pairing-code-failed"
	if _transport:
		return "transport"
	return "pairing-code-failed" if _after_c2 or _budget_stopped else "pairing-not-found"


## Of a `pairing-code-failed` result, why ("invalid", "other-app", "spent" or "wrong"); "" for any other result.
func reason() -> String:
	if result() != "pairing-code-failed":
		return ""
	var kind: String = _input.get("kind", "")
	if kind == "invalid" or kind == "other-app":
		return kind
	if _spent_at_start:
		return "spent"
	return "wrong" if _after_c2 else "spent"


## The joiner's dials per typed nameplate across joins, in memory, per product (section 15.12): at most `BUDGET`
## in any `BUDGET_SECONDS`. A QR names its instance and is never limited. Times are monotonic seconds.
class DialBudget extends RefCounted:
	const BUDGET := 2
	const BUDGET_SECONDS := 300

	var _dialled := {}


	func _to_string() -> String:
		return "PKeyPeerLocalJoin.DialBudget()"


	func _recent(nameplate: String, t: float) -> Array:
		var kept: Array = []
		for d: float in _dialled.get(nameplate, []):
			if t - d < BUDGET_SECONDS:
				kept.append(d)
		if kept.is_empty():
			_dialled.erase(nameplate)
		else:
			_dialled[nameplate] = kept
		return kept


	## Whether a join of this nameplate may browse and dial now, and the dials already spent.
	func check(nameplate: String, t: float) -> Dictionary:
		var used := _recent(nameplate, t).size()
		return {"allowed": used < BUDGET, "used": used}


	## The join made `dials` dials.
	func spend(nameplate: String, t: float, dials: int) -> void:
		if dials <= 0:
			return
		var kept := _recent(nameplate, t)
		for i in dials:
			kept.append(t)
		_dialled[nameplate] = kept


	## The dials a join of this nameplate may still make now: 2 less the dials spent.
	func left(nameplate: String, t: float) -> int:
		return BUDGET - int(check(nameplate, t)["used"])


## The dials left for the nameplate a person has typed so far (`localLinks.dialsLeft`): -1 unless the text, with
## ASCII spaces and hyphens removed, starts with two ASCII digits. It reads those two digits only, keeps nothing
## and spends nothing.
static func dials_left(budget: DialBudget, text: String, t: float) -> int:
	var digits := text.replace(" ", "").replace("-", "")
	if digits.length() < 2:
		return -1
	for i in 2:
		var c := digits.unicode_at(i)
		if c < 48 or c > 57:
			return -1
	return budget.left(digits.substr(0, 2), t)
