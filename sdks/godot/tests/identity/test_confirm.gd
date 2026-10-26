extends RefCounted
# @pkey-feature identity.devicecode
# The opt-in confirm-identity step and the licence attach (P1-07): with `confirm_identity` the
# polls ask the Worker to hold at the signed-in identity and carry the device's own token; a
# `confirm` answer makes `wait()` return `choose` and polling stops until the player accepts on the
# device (`session.accept(attach)`, then `wait()` again) or cancels; the decision is a paced poll of its own; a stale
# `confirm` re-sends the decision, a lost attachability is answered "no" without asking again; with nothing to attach the player is
# never asked (D-10).

const B := preload("res://tests/identity/support.gd")
const HELD := "pkeyt_ANONYMOUSENROLLEDANONYMOUSENROLLEDANONYM"
const WHO := {"name": "Ada", "email": "ada@example.com"}


func run(t: PKeyTestContext) -> void:
	var bed := B.new()
	if not t.check("confirm: sync fixtures present", not bed.F.is_empty()):
		bed.free_all()
		return
	await _attach(t, bed)
	await _decline(t, bed)
	await _stale_and_lost(t, bed)
	await _no_token(t, bed)
	await _cancel_while_confirming(t, bed)
	await _expire_while_confirming(t, bed)
	bed.free_all()


func _reset(bed: B) -> void:
	bed.flow_requests.clear()
	bed.server.requests.clear()
	bed.sleeps.clear()
	bed.clock[0] = bed.F["now"]


func _confirm(attachable: bool) -> Dictionary:
	return B.state("confirm", {"identity": WHO, "attachable": attachable})


func _ready_body(attached := "") -> Dictionary:
	var b := {"token": B.TOKEN, "schemaVersion": 1, "identity": WHO}
	if attached != "":
		b["attached"] = attached
	return B.state("ready", b)


func _attach(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [B.state("pending"), _confirm(true), _ready_body("claimed")]
	var sdk = await bed.make_sdk(HELD)
	var shown := []
	var run := await B.begin(sdk.identity, "x", true, func(o: PKeySignInOutcome, s: PKeySignInSession) -> void:
		shown.append({"identity": o.identity, "attachable": o.attachable})
		# Nothing was minted yet: the held anonymous token is still the device's credential.
		shown.append(sdk.core.tokens.current() == HELD)
		s.accept(true))
	var prompt: PKeySignInSession = run[0]
	var results: Array = run[1]
	t.check("attach: accept() is false with nothing to accept", not prompt.accept(true))
	t.check("attach: the session records the opt-in", prompt.confirm_identity)
	await B.until(func(): return not results.is_empty())
	t.check("attach: choose carried the identity and attachable", shown.size() == 2 and shown[0] == {"identity": WHO, "attachable": true} and shown[1] == true, str(shown))
	var r: PKeySignInOutcome = results[0] if not results.is_empty() else null
	t.check("attach: ok, attached claimed, identity shown", r != null and r.ok and r.attached == "claimed" and r.identity == WHO, str(r))
	t.check("attach: the signed-in token replaced the anonymous one", sdk.core.tokens.current() == B.TOKEN)
	var polls := bed.polls_sent()
	if not t.check("attach: three polls", polls.size() == 3, str(polls.size())):
		return
	var ok_bodies := true
	for p in polls:
		ok_bodies = ok_bodies and p["body"].get("confirmIdentity") == true and p["headers"].get("authorization") == "Bearer %s" % HELD \
				and p["body"]["deviceId"] == p["headers"].get("x-pkey-device")
	t.check("attach: every poll asks to confirm and carries the device's own token and id", ok_bodies, str(polls.map(func(p): return p["body"])))
	t.check("attach: only the poll after the acceptance carries the decision", not polls[0]["body"].has("attachLicense") and not polls[1]["body"].has("attachLicense") and polls[2]["body"].get("attachLicense") == true)
	t.check("attach: the decision waits out the interval like any poll", bed.sleeps == [2.0, 2.0, 2.0], str(bed.sleeps))


func _decline(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(true), _ready_body()]
	var sdk = await bed.make_sdk(HELD)
	var results: Array = (await B.begin(sdk.identity, "x", true, func(_o, s: PKeySignInSession) -> void: s.accept(false)))[1]
	await B.until(func(): return not results.is_empty())
	var polls := bed.polls_sent()
	t.check("decline: attachLicense false is sent", polls.size() == 2 and polls[1]["body"].get("attachLicense") == false, str(polls.map(func(p): return p["body"])))
	t.check("decline: ok, nothing attached", results.size() == 1 and results[0].ok and results[0].attached == "", str(results))


func _stale_and_lost(t: PKeyTestContext, bed: B) -> void:
	# A decision answered `confirm` again with the same attachability is a stale read: re-sent,
	# without asking the player twice.
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(true), _confirm(true), _ready_body("migrated")]
	var sdk = await bed.make_sdk(HELD)
	var asked := [0]
	var results: Array = (await B.begin(sdk.identity, "x", true, func(_o, s: PKeySignInSession) -> void:
		asked[0] += 1
		s.accept(true)))[1]
	await B.until(func(): return not results.is_empty())
	var decisions := bed.polls_sent().filter(func(p): return p["body"].has("attachLicense"))
	t.check("stale: the decision is re-sent, the player asked once", asked[0] == 1 and decisions.size() == 2 and results.size() == 1 and results[0].attached == "migrated", "asked %d, %d decisions, %s" % [asked[0], decisions.size(), str(results)])

	# An attach answered with `attachable: false` (the licence stopped being attachable) asks again.
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(true), _confirm(false), _ready_body()]
	sdk = await bed.make_sdk(HELD)
	var seen := []
	results = (await B.begin(sdk.identity, "x", true, func(o: PKeySignInOutcome, s: PKeySignInSession) -> void:
		seen.append(o.attachable)
		s.accept(o.attachable)))[1]
	await B.until(func(): return not results.is_empty())
	var last: Dictionary = bed.polls_sent()[-1]
	t.check("lost: nothing attachable any more is answered no, the player is not asked again", seen == [true] and last["body"].get("attachLicense") == false and results.size() == 1 and results[0].ok, "%s %s" % [str(seen), str(results)])


func _no_token(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(false), _ready_body()]
	var sdk = await bed.make_sdk("")
	var shown := []
	var results: Array = (await B.begin(sdk.identity, "x", true, func(o: PKeySignInOutcome, s: PKeySignInSession) -> void:
		shown.append(o)
		s.accept(false)))[1]
	await B.until(func(): return not results.is_empty())
	var polls := bed.polls_sent()
	t.check("no token: polls ask to confirm but carry no bearer", polls.size() == 2 and polls[0]["body"].get("confirmIdentity") == true and not polls[0]["headers"].has("authorization"))
	t.check("no token: nothing attachable, so nothing is shown and the SDK answers no itself", shown.is_empty() and polls[1]["body"].get("attachLicense") == false and results.size() == 1 and results[0].ok and results[0].attached == "", str(shown))


func _cancel_while_confirming(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(true)]
	var sdk = await bed.make_sdk(HELD)
	var shown := []
	var run := await B.begin(sdk.identity, "x", true, func(o: PKeySignInOutcome, _s) -> void: shown.append(o))
	var session: PKeySignInSession = run[0]
	var results: Array = run[1]
	await B.until(func(): return not shown.is_empty())
	await PKeyTestFixtures.frames(5)
	var sent := bed.polls_sent().size()
	t.check("cancel: polling stopped while the player decides", sent == 1 and results.is_empty(), "%d polls" % sent)
	session.cancel()
	results.append(await session.wait())
	t.check("cancel: declining the identity ends cancelled at once", results.size() == 1 and results[0].kind == PKeySignInOutcome.KIND_CANCELLED, str(results))
	t.check("cancel: no further poll, the anonymous token kept", bed.polls_sent().size() == 1 and sdk.core.tokens.current() == HELD)
	t.check("cancel: accept() after the cancel does nothing", not session.accept(true))


func _expire_while_confirming(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(true)]
	var sdk = await bed.make_sdk(HELD)
	var shown := []
	var run := await B.begin(sdk.identity, "x", true, func(o: PKeySignInOutcome, _s) -> void: shown.append(o))
	var prompt: PKeySignInSession = run[0]
	var results: Array = run[1]
	await B.until(func(): return not shown.is_empty())
	bed.clock[0] = prompt.expires_at
	# The choice is left open; the host waits on it again and finds the code lapsed.
	var late: PKeySignInOutcome = await prompt.wait()
	results.append(late)
	t.check("expiry: an unanswered confirmation ends expired, no further poll", results.size() == 1 and results[0].kind == PKeySignInOutcome.KIND_EXPIRED and bed.polls_sent().size() == 1, str(results))
