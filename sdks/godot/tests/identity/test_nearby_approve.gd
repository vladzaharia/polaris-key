extends RefCounted
# @pkey-feature identity.nearby
# Nearby approval on the approving device M (I-48.16): `identity.nearby.on_request` hands a PKeyNearbyAsk to the host,
# and `pick` runs `nearby/approve` over the LAN approval (a fake here; the engine is the connect suite's). Each group
# below names the rule it proves: only a picked, verified request is approved; D's ids and keys are the request's; a
# 404 is unavailable only after a fresh read lost `nearby`; one answer per ask; the wrap is sealed, sent, then stored.

const B := preload("res://tests/identity/support.gd")

const REQUEST := "nr_pA71hdu4pwET01lPlZ_Pow"
const D_DEVICE := "TRANSCRIPTDEVICE0000000000000001"
const M_TOKEN := "pkeyt_APPROVERAPPROVERAPPROVERAPPROVERAPPROVE0"
const SIGN_KEY := "tr8tkqfXd_Y7w6_mNhNT5szlQxG01mr082eZUHw0rb0"
const AGREE_KEY := "8cnP9-K2HbiD40Pf2p58XzDCxq9xI_9b0kzzedXw7UM"
const CODES := ["482 913", "107 356", "759 204"]


## The LAN approval M holds: three codes, a pick that matches or not, and a log of what the SDK did with it.
class FakeApproval extends PKeyPeerNearbyApprover.Approval:
	var log: Array = []
	var right := "482 913"
	## False: the matched code's request did not verify (the session closed).
	var verifies := true
	## What `finish` answers, in order; the last repeats.
	var finishes: Array = [{"sent": "approved"}]
	var finished: Array = []
	var dead := false

	func _init() -> void:
		label = "Living room" + char(0x202E)
		platform = "macOS"
		codes = ["482 913", "107 356", "759 204"]

	func is_closed() -> bool:
		return dead

	func pick(code: Variant) -> PKeyResult:
		log.append("pick")
		if str(code) != right:
			return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "no", {"reason": "mismatch"})
		if not verifies:
			return PKeyResult.failure(PKeyConstants.ErrorCode.PEER_CLOSED, "no", {"reason": "invalid"})
		return PKeyResult.success({"request": REQUEST, "device_id": D_DEVICE, "sign_key": SIGN_KEY, "agree_key": AGREE_KEY, "label": "x", "platform": "macOS"})

	func decline() -> void:
		log.append("decline")

	func finish(answer: Dictionary) -> PKeyResult:
		log.append("finish")
		finished.append(answer)
		var f: Variant = finishes[0] if finishes.size() == 1 else finishes.pop_front()
		if f is PKeyResult:
			return f
		return PKeyResult.success(f)

	func send_record(type: int, body: PackedByteArray) -> PKeyResult:
		log.append("send:%d:%d" % [type, body.size()])
		return PKeyResult.success()

	func close() -> void:
		log.append("close")


## The running approver `on_request` answers.
class FakeApprover extends RefCounted:
	signal stopped(reason: String)
	var stops := 0

	func stop() -> void:
		stops += 1


## The fake LAN half `on_request` runs over; it keeps the handler the SDK wrapped.
class FakeLan extends RefCounted:
	var handler: Callable
	var options: Dictionary = {}
	var starts := 0
	var approver := FakeApprover.new()
	var failure: PKeyResult = null

	func lane_check(_o := {}) -> PKeyResult:
		return PKeyResult.success()

	func on_request(h: Callable, o := {}) -> PKeyResult:
		handler = h
		options = o
		starts += 1
		return failure if failure != null else PKeyResult.success(approver)


## The key ring M holds, in the order its calls arrive.
class FakeRing extends RefCounted:
	var log: Array = []
	var held := true
	var put_result: PKeyResult = PKeyResult.success()

	func unlocked() -> bool:
		return held

	func seal_wrap_to(device_id: String, agree_key: Variant) -> PKeyResult:
		log.append("seal:%s:%s" % [device_id, agree_key])
		return PKeyResult.success({"ring_id": "rg_AAAAAAAAAAAAAAAAAAAAAA", "epoch": 1, "kid": "00112233445566778899aabbccddeeff", "kem": 32, "enc": "A".repeat(43), "ct": "B".repeat(64)})

	func put_wrap(device_id: String, _w: Dictionary) -> PKeyResult:
		log.append("put:%s" % device_id)
		return put_result


class Bed extends PKeyIdentityTestBed:
	var approves: Array = []
	var key_puts: Array = []
	var requests: Array = []
	var nearby_on := true
	var approve_n: Array = []
	var keys_answers: Array = []

	func _answer(req: Dictionary) -> Dictionary:
		var path := String(req["path"])
		if path.ends_with("/.well-known/polaris.json"):
			return json(200, discovery_doc())
		if path.ends_with("/identity/nearby/approve"):
			var parsed := PKeyJson.parse_bytes(req["body"])
			requests.append("approve")
			approves.append({"body": parsed["value"] if parsed["ok"] else null, "headers": req["headers"]})
			if approve_n.is_empty():
				return {"status": 500}
			var a = approve_n[0] if approve_n.size() == 1 else approve_n.pop_front()
			return a.call(req) if a is Callable else a
		if path.ends_with("/devices/keys"):
			requests.append("keys")
			key_puts.append({"body": PKeyJson.parse_bytes(req["body"])["value"], "headers": req["headers"]})
			var k = keys_answers[0] if keys_answers.size() == 1 else keys_answers.pop_front()
			return k
		return super._answer(req)

	func discovery_doc() -> Dictionary:
		var root := "%s/%s/identity" % [server.base_url(), F["product"]]
		var fragment := {"enabled": true, "configured": true, "endpoints": {}}
		if nearby_on:
			fragment["nearby"] = true
			fragment["endpoints"]["nearbyStart"] = root + "/nearby/start"
			fragment["endpoints"]["nearbyPoll"] = root + "/nearby/poll"
			fragment["endpoints"]["nearbyApprove"] = root + "/nearby/approve"
		return {"product": F["product"], "services": {"license": {"enabled": true}, "config": {"enabled": true}, "identity": fragment}}


static func approved() -> Dictionary:
	return B.json(200, {"status": "approved", "deviceLabel": "Living-room console"})


static func refused(status: int, code: String) -> Dictionary:
	return B.json(status, {"error": {"code": code}})


static func choose_answer() -> Dictionary:
	return B.json(200, {"status": "choose", "choices": {"state": "choose", "choices": [
		{"id": "lic_0", "tierName": "djdl", "name": null, "state": "free"},
		{"id": "lic_1", "tierName": "djdl", "name": "Second", "state": "free"},
	], "keep": false, "preselected": "lic_0", "create": null, "getLicense": null}})


## M: a started SDK holding a confirmed token, with a fake LAN approver and key ring.
class Rig extends RefCounted:
	var bed: Bed
	var sdk: Node
	var lan := FakeLan.new()
	var ring := FakeRing.new()
	var keys := PKeyFixtureDeviceKeys.new("transcript-nearby-m-1")

	func up(token := M_TOKEN) -> void:
		bed = Bed.new()
		bed.device_keys = keys
		sdk = await bed.make_sdk(token)
		sdk.identity.nearby_lan = lan
		sdk.identity.nearby_keyring = ring
		sdk.core.discovery_manifest = bed.discovery_doc()

	## The ask the SDK built for a fake approval.
	func ask(approval: FakeApproval) -> PKeyNearbyAsk:
		var got: Array = []
		var made: PKeyResult = await sdk.identity.nearby.on_request(func(a: PKeyNearbyAsk) -> void: got.append(a))
		if not made.ok:
			return null
		lan.handler.call(approval)
		return got[0]

	func free_all() -> void:
		bed.free_all()


func run(t: PKeyTestContext) -> void:
	await _start(t)
	await _pick(t)
	await _deny_and_mismatch(t)
	await _choice(t)
	await _refusals(t)
	await _wrap(t)


# -- start ------------------------------------------------------------------------------------------


func _start(t: PKeyTestContext) -> void:
	var r := Rig.new()
	await r.up()
	var got: Array = []
	var made: PKeyResult = await r.sdk.identity.nearby.on_request(func(a): got.append(a))
	t.check("on_request: starts the approver with the device label and no handler argument it was not given", made.ok and r.lan.starts == 1 and r.lan.options.get("label") == "Test Device", str(made))
	var ap := FakeApproval.new()
	r.lan.handler.call(ap)
	t.check("on_request: the handler gets a PKeyNearbyAsk with cleaned device, platform and three codes",
		got.size() == 1 and got[0] is PKeyNearbyAsk and got[0].device == "Living room" and got[0].platform == "macOS" and got[0].codes.size() == 3, str(got))
	t.check("on_request: the ask prints as nothing", str(got[0]) == "PKeyNearbyAsk()")
	var bad: PKeyResult = await r.sdk.identity.nearby.on_request(Callable())
	t.check("on_request: needs a handler", not bad.ok and bad.code == PKeyConstants.ErrorCode.INVALID_OPTIONS)
	r.sdk.identity.nearby_lan = RefCounted.new()
	var web: PKeyResult = await r.sdk.identity.nearby.on_request(func(_a): pass)
	t.check("on_request: no LAN half is nearby-unsupported, with no request made", not web.ok and web.code == PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED and r.bed.requests.is_empty())
	r.sdk.identity.nearby_lan = r.lan
	t.check("nearby_available('approver'): the lane and the last discovery are there", r.sdk.identity.nearby_available("approver"))
	r.bed.nearby_on = false
	r.sdk.core.discovery_manifest = r.bed.discovery_doc()
	t.check("nearby_available('approver'): false when discovery names no nearby", not r.sdk.identity.nearby_available("approver"))
	r.free_all()


# -- the pick ---------------------------------------------------------------------------------------


func _pick(t: PKeyTestContext) -> void:
	var r := Rig.new()
	await r.up()
	r.bed.approve_n = [approved()]
	var ap := FakeApproval.new()
	r.ring.held = false
	var ask: PKeyNearbyAsk = await r.ask(ap)
	var step: PKeyNearbyStep = await ask.pick("482 913")
	t.check("pick: the matched code asks the Worker once and the approval is the step", step.kind == PKeyNearbyStep.KIND_APPROVED and r.bed.approves.size() == 1, str(step))
	var body: Dictionary = r.bed.approves[0]["body"]
	t.check("pick: the request carries exactly the verified request's ids and keys",
		body.get("request") == REQUEST and body.get("deviceId") == D_DEVICE and body.get("signKey") == SIGN_KEY and body.get("agreeKey") == AGREE_KEY
		and body.get("decision") == "approve" and not body.has("choice") and String(body.get("proof", "")).length() > 40, str(body.keys()))
	t.check("pick: M's confirmed bearer is sent", r.bed.approves[0]["headers"].get("authorization") == "Bearer " + M_TOKEN)
	t.check("pick: the answer is given to the LAN approval (the Worker's body, discovery still names nearby)",
		ap.finished.size() == 1 and ap.finished[0]["http"] == 200 and ap.finished[0]["discovery_nearby"] == true and str(ap.finished[0]["body"]).contains("approved"))
	var again: PKeyNearbyStep = await ask.pick("482 913")
	t.check("pick: asking twice gives the first answer and never a second approve", again == step and r.bed.approves.size() == 1 and ap.log.count("pick") == 1)
	t.check("pick: with no root held, no wrap is sealed or sent", r.ring.log.is_empty() and not ap.log.any(func(l: String) -> bool: return l.begins_with("send")))
	# Concurrent picks share one run.
	var r2 := Rig.new()
	await r2.up()
	r2.bed.approve_n = [approved()]
	var ap2 := FakeApproval.new()
	var ask2: PKeyNearbyAsk = await r2.ask(ap2)
	var results: Array = []
	var first := func() -> void: results.append(await ask2.pick("482 913"))
	first.call()
	first.call()
	for i in 600:
		if results.size() == 2:
			break
		await (Engine.get_main_loop() as SceneTree).process_frame
	t.check("pick: two taps at once make one approve", results.size() == 2 and results[0] == results[1] and r2.bed.approves.size() == 1)
	# The vouch prints as nothing.
	var vouch := PKeyNearbyVouch.from_pick({"request": REQUEST, "device_id": D_DEVICE, "sign_key": SIGN_KEY, "agree_key": AGREE_KEY})
	t.check("vouch: prints as nothing", str(vouch) == "PKeyNearbyVouch()" and not str(vouch).contains(REQUEST))
	r.free_all()
	r2.free_all()


func _deny_and_mismatch(t: PKeyTestContext) -> void:
	var r := Rig.new()
	await r.up()
	r.bed.approve_n = [approved()]
	var wrong := FakeApproval.new()
	var ask: PKeyNearbyAsk = await r.ask(wrong)
	var step: PKeyNearbyStep = await ask.pick("107 356")
	t.check("mismatch: a wrong code is a mismatch and calls no route", step.kind == PKeyNearbyStep.KIND_MISMATCH and r.bed.requests.is_empty() and wrong.finished.is_empty())
	var ap := FakeApproval.new()
	var ask2: PKeyNearbyAsk = await r.ask(ap)
	ask2.deny()
	ask2.deny()
	t.check("deny: none of these match closes the session once and calls no route", ap.log == ["decline"] and r.bed.requests.is_empty())
	var late: PKeyNearbyStep = await ask2.pick("482 913")
	t.check("deny: a pick after a deny approves nothing", late.kind == PKeyNearbyStep.KIND_EXPIRED and r.bed.requests.is_empty() and not ap.log.has("pick"))
	# A request that did not verify.
	var unverified := FakeApproval.new()
	unverified.verifies = false
	var ask3: PKeyNearbyAsk = await r.ask(unverified)
	t.check("pick: a closed session is expired, not an approval", (await ask3.pick("482 913")).kind == PKeyNearbyStep.KIND_EXPIRED and r.bed.requests.is_empty())
	# No token, or an unconfirmed one: no request.
	var s2 := Rig.new()
	await s2.up("")
	s2.bed.approve_n = [approved()]
	var ask4: PKeyNearbyAsk = await s2.ask(FakeApproval.new())
	var none: PKeyNearbyStep = await ask4.pick("482 913")
	t.check("pick: signed out is account-required and sends nothing", none.kind == PKeyNearbyStep.KIND_ACCOUNT_REQUIRED and s2.bed.approves.is_empty())
	r.free_all()
	s2.free_all()


# -- the licence choice -----------------------------------------------------------------------------


func _choice(t: PKeyTestContext) -> void:
	var r := Rig.new()
	await r.up()
	r.bed.approve_n = [choose_answer(), approved()]
	var ap := FakeApproval.new()
	ap.finishes = [{"wait": "choice"}, {"sent": "approved"}]
	var ask: PKeyNearbyAsk = await r.ask(ap)
	var step: PKeyNearbyStep = await ask.pick("482 913")
	t.check("choose: a choose answer is the step, with the Worker's view", step.kind == PKeyNearbyStep.KIND_CHOOSE and step.choose != null and step.choose.choices["choices"].size() == 2, str(step))
	t.check("choose: nothing was sent to the new device yet", ap.finished.size() == 1 and ap.finished[0]["http"] == 200)
	var done: PKeyNearbyStep = await step.choose.choose({"kind": "license", "license_id": "lic_1"})
	t.check("choose: one tap on a licence approves it", done.kind == PKeyNearbyStep.KIND_APPROVED and r.bed.approves.size() == 2, str(done))
	t.check("choose: the second call carries the choice and the same request", r.bed.approves[1]["body"].get("choice") == {"kind": "license", "licenseId": "lic_1"}
		and r.bed.approves[1]["body"].get("request") == REQUEST)
	var twice: PKeyNearbyStep = await step.choose.choose({"kind": "create"})
	t.check("choose: a choice answers once", twice.kind == PKeyNearbyStep.KIND_EXPIRED and r.bed.approves.size() == 2)
	# Cancel at the choice: the Worker is told "deny".
	var c := Rig.new()
	await c.up()
	c.bed.approve_n = [choose_answer(), B.json(204, {})]
	var cap := FakeApproval.new()
	cap.finishes = [{"wait": "choice"}, {"sent": "denied"}]
	var cask: PKeyNearbyAsk = await c.ask(cap)
	var cstep: PKeyNearbyStep = await cask.pick("482 913")
	var denied: PKeyNearbyStep = await cstep.choose.cancel()
	t.check("choose: cancel is a deny at the Worker, matched code or not", denied.kind == PKeyNearbyStep.KIND_DENIED and c.bed.approves[1]["body"].get("decision") == "deny", str(denied))
	# A lost mint asks again at most three times, then ends it.
	var l := Rig.new()
	await l.up()
	l.bed.approve_n = [refused(409, "license_choice_required")]
	var lap := FakeApproval.new()
	lap.finishes = [{"wait": "choice"}]
	var lask: PKeyNearbyAsk = await l.ask(lap)
	var lost: PKeyNearbyStep = await lask.pick("482 913")
	t.check("choose: a choice nobody can show ends it after three asks", lost.kind == PKeyNearbyStep.KIND_EXPIRED
		and l.bed.approves.size() == 3
		and lap.log.has("close"), "%d approves" % l.bed.approves.size())
	r.free_all()
	c.free_all()
	l.free_all()


# -- refusals ---------------------------------------------------------------------------------------


func _refusals(t: PKeyTestContext) -> void:
	var table := [
		[403, "not_nearby", PKeyNearbyStep.KIND_NOT_NEARBY], [403, "device_limit", PKeyNearbyStep.KIND_DEVICE_LIMIT],
		[401, "unauthorized", PKeyNearbyStep.KIND_ACCOUNT_REQUIRED], [429, "rate_limited", PKeyNearbyStep.KIND_RATE_LIMITED],
		[400, "invalid_grant", PKeyNearbyStep.KIND_EXPIRED],
	]
	for row: Array in table:
		var r := Rig.new()
		await r.up()
		r.bed.approve_n = [refused(row[0], row[1])]
		var ap := FakeApproval.new()
		ap.finishes = [{"sent": "denied"}]
		var step: PKeyNearbyStep = await (await r.ask(ap)).pick("482 913")
		t.check("refusal: %s -> %s" % [row[1], row[2]], step.kind == row[2], str(step))
		r.free_all()
	# N11: a 404 is "expired" while a fresh read still names nearby, and the routes gone otherwise.
	var n := Rig.new()
	await n.up()
	n.bed.approve_n = [refused(404, "not_found")]
	var nap := FakeApproval.new()
	nap.finishes = [{"sent": "expired"}]
	await (await n.ask(nap)).pick("482 913")
	t.check("404: discovery still names nearby, so it is the request that is gone", nap.finished[0]["discovery_nearby"] == true and nap.finished[0]["http"] == 404)
	var g := Rig.new()
	await g.up()
	g.bed.approve_n = [refused(404, "not_found")]
	g.bed.nearby_on = false
	var gap := FakeApproval.new()
	gap.finishes = [{"closed": true}]
	await (await g.ask(gap)).pick("482 913")
	t.check("404: a fresh read that lost nearby is the routes gone (the advert stops)", gap.finished[0]["discovery_nearby"] == false)
	# A keys 409 registers the keys and retries once; a second one closes.
	var k := Rig.new()
	await k.up()
	k.bed.approve_n = [refused(409, "device_keys_required"), approved()]
	k.bed.keys_answers = [B.json(200, {"keySeq": 1})]
	var kap := FakeApproval.new()
	var kstep: PKeyNearbyStep = await (await k.ask(kap)).pick("482 913")
	t.check("keys: device_keys_required registers this device's keys and retries once", kstep.kind == PKeyNearbyStep.KIND_APPROVED
		and k.bed.requests == ["approve", "keys", "approve"], str(k.bed.requests))
	t.check("keys: the registration is signed and carries M's bearer", k.bed.key_puts[0]["headers"].get("authorization") == "Bearer " + M_TOKEN and k.bed.key_puts[0]["body"].has("sig"))
	var k2 := Rig.new()
	await k2.up()
	k2.bed.approve_n = [refused(409, "device_keys_required")]
	k2.bed.keys_answers = [B.json(200, {"keySeq": 1})]
	var k2ap := FakeApproval.new()
	k2ap.finishes = [{"closed": true}]
	await (await k2.ask(k2ap)).pick("482 913")
	t.check("keys: a second 409 is reported so the table closes, never a second retry", k2.bed.requests == ["approve", "keys", "approve"]
		and str(k2ap.finished[0]["body"]).contains("device_keys_retried"), str(k2.bed.requests))
	n.free_all()
	g.free_all()
	k.free_all()
	k2.free_all()


# -- the wrap ---------------------------------------------------------------------------------------


func _wrap(t: PKeyTestContext) -> void:
	var r := Rig.new()
	await r.up()
	r.bed.approve_n = [approved()]
	var ap := FakeApproval.new()
	var step: PKeyNearbyStep = await (await r.ask(ap)).pick("482 913")
	t.check("wrap: sealed to D's agreement key from the request, sent as 0x0030, then stored (never reversed)",
		step.kind == PKeyNearbyStep.KIND_APPROVED and r.ring.log.size() == 2 and r.ring.log[0] == "seal:%s:%s" % [D_DEVICE, AGREE_KEY] and r.ring.log[1] == "put:" + D_DEVICE, str(r.ring.log))
	var sends := ap.log.filter(func(l: String) -> bool: return l.begins_with("send"))
	var seal_before_send := ap.log.find(sends[0]) > ap.log.find("finish") if not sends.is_empty() else false
	t.check("wrap: exactly one KEYRING_WRAP goes over the channel", sends.size() == 1 and String(sends[0]).begins_with("send:48:") and seal_before_send, str(ap.log))
	# A refused PUT leaves the approval as it is.
	var f := Rig.new()
	await f.up()
	f.bed.approve_n = [approved()]
	f.ring.put_result = PKeyResult.failure(&"keyring_conflict", "no")
	var fap := FakeApproval.new()
	var fstep: PKeyNearbyStep = await (await f.ask(fap)).pick("482 913")
	t.check("wrap: a failed store leaves the approval and the channel copy as they are", fstep.kind == PKeyNearbyStep.KIND_APPROVED and fap.log.any(func(l: String) -> bool: return l.begins_with("send")))
	# The channel closed meanwhile: the Worker's answer stands and the stored wrap is the fallback.
	var c := Rig.new()
	await c.up()
	c.bed.approve_n = [approved()]
	var cap := FakeApproval.new()
	cap.finishes = [PKeyResult.failure(PKeyConstants.ErrorCode.PEER_CLOSED, "closed")]
	var cstep: PKeyNearbyStep = await (await c.ask(cap)).pick("482 913")
	t.check("wrap: a lost channel still approves, and stores the wrap", cstep.kind == PKeyNearbyStep.KIND_APPROVED and c.ring.log.has("put:" + D_DEVICE))
	# A deny never wraps.
	var d := Rig.new()
	await d.up()
	d.bed.approve_n = [B.json(204, {})]
	var dap := FakeApproval.new()
	dap.finishes = [{"sent": "denied"}]
	await (await d.ask(dap)).pick("482 913")
	t.check("wrap: a denial seals nothing", d.ring.log.is_empty())
	r.free_all()
	f.free_all()
	c.free_all()
	d.free_all()
