extends RefCounted
# @pkey-feature identity.devicecode
# The opt-in confirm-identity step and the licence attach (P1-07): with `confirm_identity` the
# polls ask the Worker to hold at the signed-in identity and carry the device's own token; a
# `confirm` answer emits `sign_in_confirm` and polling stops until the player accepts on the
# device (`accept_sign_in(attach)`) or cancels; the decision is a paced poll of its own; a stale
# `confirm` re-sends the decision, a lost attachability asks the player again.

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
	var results := B.record(sdk.identity)
	var shown := []
	sdk.identity.sign_in_confirm.connect(func(c: Dictionary) -> void:
		shown.append(c)
		# Nothing was minted yet: the held anonymous token is still the device's credential.
		shown.append(sdk.core.tokens.current() == HELD)
		sdk.identity.accept_sign_in(true))
	t.check("attach: accept_sign_in() is false with nothing to accept", not sdk.identity.accept_sign_in(true))
	var prompt: PKeySignInPrompt = await sdk.identity.begin_sign_in("x", true)
	t.check("attach: the prompt records the opt-in", prompt.confirm_identity)
	await B.until(func(): return not results.is_empty())
	t.check("attach: sign_in_confirm carried the identity and attachable", shown.size() == 2 and shown[0] == {"identity": WHO, "attachable": true} and shown[1] == true, str(shown))
	var r: PKeySignInResult = results[0] if not results.is_empty() else null
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
	var results := B.record(sdk.identity)
	sdk.identity.sign_in_confirm.connect(func(_c: Dictionary) -> void: sdk.identity.accept_sign_in(false))
	await sdk.identity.begin_sign_in("x", true)
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
	var results := B.record(sdk.identity)
	var asked := [0]
	sdk.identity.sign_in_confirm.connect(func(_c: Dictionary) -> void:
		asked[0] += 1
		sdk.identity.accept_sign_in(true))
	await sdk.identity.begin_sign_in("x", true)
	await B.until(func(): return not results.is_empty())
	var decisions := bed.polls_sent().filter(func(p): return p["body"].has("attachLicense"))
	t.check("stale: the decision is re-sent, the player asked once", asked[0] == 1 and decisions.size() == 2 and results.size() == 1 and results[0].attached == "migrated", "asked %d, %d decisions, %s" % [asked[0], decisions.size(), str(results)])

	# An attach answered with `attachable: false` (the licence stopped being attachable) asks again.
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(true), _confirm(false), _ready_body()]
	sdk = await bed.make_sdk(HELD)
	results = B.record(sdk.identity)
	var seen := []
	sdk.identity.sign_in_confirm.connect(func(c: Dictionary) -> void:
		seen.append(c["attachable"])
		sdk.identity.accept_sign_in(c["attachable"]))
	await sdk.identity.begin_sign_in("x", true)
	await B.until(func(): return not results.is_empty())
	var last: Dictionary = bed.polls_sent()[-1]
	t.check("lost: the player is asked again when nothing is attachable any more", seen == [true, false] and last["body"].get("attachLicense") == false and results.size() == 1 and results[0].ok, "%s %s" % [str(seen), str(results)])


func _no_token(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(false), _ready_body()]
	var sdk = await bed.make_sdk("")
	var results := B.record(sdk.identity)
	var shown := []
	sdk.identity.sign_in_confirm.connect(func(c: Dictionary) -> void:
		shown.append(c)
		sdk.identity.accept_sign_in(false))
	await sdk.identity.begin_sign_in("x", true)
	await B.until(func(): return not results.is_empty())
	var polls := bed.polls_sent()
	t.check("no token: polls ask to confirm but carry no bearer", polls.size() == 2 and polls[0]["body"].get("confirmIdentity") == true and not polls[0]["headers"].has("authorization"))
	t.check("no token: the identity is still shown first, nothing attachable", shown.size() == 1 and shown[0]["attachable"] == false and results.size() == 1 and results[0].ok, str(shown))


func _cancel_while_confirming(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(true)]
	var sdk = await bed.make_sdk(HELD)
	var results := B.record(sdk.identity)
	var shown := []
	sdk.identity.sign_in_confirm.connect(func(c: Dictionary) -> void: shown.append(c))
	await sdk.identity.begin_sign_in("x", true)
	await B.until(func(): return not shown.is_empty())
	await PKeyTestFixtures.frames(5)
	var sent := bed.polls_sent().size()
	t.check("cancel: polling stopped while the player decides", sent == 1 and results.is_empty(), "%d polls" % sent)
	sdk.identity.cancel()
	await B.until(func(): return not results.is_empty(), 60)
	t.check("cancel: declining the identity ends cancelled at once", results.size() == 1 and results[0].kind == PKeySignInResult.KIND_CANCELLED, str(results))
	t.check("cancel: no further poll, the anonymous token kept", bed.polls_sent().size() == 1 and sdk.core.tokens.current() == HELD)
	t.check("cancel: accept_sign_in() after the cancel does nothing", not sdk.identity.accept_sign_in(true))


func _expire_while_confirming(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [_confirm(true)]
	var sdk = await bed.make_sdk(HELD)
	var results := B.record(sdk.identity)
	var shown := []
	sdk.identity.sign_in_confirm.connect(func(c: Dictionary) -> void: shown.append(c))
	var prompt: PKeySignInPrompt = await sdk.identity.begin_sign_in("x", true)
	await B.until(func(): return not shown.is_empty())
	bed.clock[0] = prompt.expires_at
	await B.until(func(): return not results.is_empty(), 240)
	t.check("expiry: an unanswered confirmation ends expired, no further poll", results.size() == 1 and results[0].kind == PKeySignInResult.KIND_EXPIRED and bed.polls_sent().size() == 1, str(results))
