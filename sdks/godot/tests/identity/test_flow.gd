extends RefCounted
# @pkey-feature identity.devicecode
# PolarisKey.identity's device-code flow against a fake Worker: the start, the paced polling
# (interval, slow_down from the returned interval and from the CURRENT one, transient retries,
# expiry), every ending mapped to its kind, the token stored and exactly one forced sync on
# `ready`, cancellation within one interval, the D-21 refusal before any request, and the
# device id every poll carries.

const B := preload("res://tests/identity/support.gd")
## cancel(): the frames the cancelled result may take to land (measured 0: it lands inside
## cancel(), which wakes the wait; sleeping out the interval would take at least one frame
## and, at any frame rate faster than the interval, more).
const CANCEL_FRAMES := 1


func run(t: PKeyTestContext) -> void:
	var bed := B.new()
	if not t.check("flow: sync fixtures present", not bed.F.is_empty()):
		bed.free_all()
		return
	await _happy(t, bed)
	await _slow_down_without_interval(t, bed)
	await _endings(t, bed)
	await _expiry(t, bed)
	await _transient(t, bed)
	await _refused(t, bed)
	await _cancel(t, bed)
	_units(t)
	bed.free_all()


func _reset(bed: B) -> void:
	bed.flow_requests.clear()
	bed.server.requests.clear()
	bed.sleeps.clear()
	bed.clock[0] = bed.F["now"]


## start -> pending -> slow_down (interval 7 returned) -> pending -> ready.
func _happy(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [
		B.state("pending"),
		B.json(429, {"status": "slow_down", "interval": 7}),
		B.state("pending"),
		B.state("ready", {"token": B.TOKEN, "schemaVersion": 1, "identity": {"name": "Ada", "email": "ada@example.com"}}),
	]
	var sdk = await bed.make_sdk()
	var pending := []
	sdk.identity.sign_in_pending.connect(func(p: PKeySignInPrompt) -> void: pending.append(p))
	var results := B.record(sdk.identity)
	var syncs := []
	sdk.sync_finished.connect(func(r: PKeySyncResult) -> void: syncs.append(r))
	var prompt: PKeySignInPrompt = await sdk.identity.begin_sign_in("Living-room PC")
	t.check("happy: the prompt", prompt.ok and prompt.user_code == "WDJB-MJHT" and prompt.interval == 2 and prompt.expires_in == 600 \
			and prompt.expires_at == bed.F["now"] + 600 and prompt.verification_uri_complete.ends_with("?user_code=WDJB-MJHT"), str(prompt))
	t.check("happy: sign_in_pending carried the prompt", pending.size() == 1 and pending[0] == prompt)
	t.check("happy: is_signing_in while polling", sdk.identity.is_signing_in())
	await B.until(func(): return not results.is_empty())
	if not t.check("happy: sign_in_finished fired once", results.size() == 1, str(results)):
		return
	var r: PKeySignInResult = results[0]
	t.check("happy: ok", r.ok and r.kind == PKeySignInResult.KIND_OK, str(r))
	t.check("happy: the signed-in identity is reported", r.identity == {"name": "Ada", "email": "ada@example.com"}, str(r.identity))
	t.check("happy: nothing attached without the opt-in", r.attached == "")
	t.check("happy: the token is stored with source signin", r.stored and sdk.core.tokens.current() == B.TOKEN and sdk.core.tokens.source() == PKeyTokenManager.SOURCE_SIGNIN)
	t.check("happy: exactly one forced sync ran", syncs.size() == 1 and r.sync != null and bed.count("GET", "/license/document") == 1 and bed.count("GET", "/config/document") == 1,
			"%d syncs, %d licence fetches" % [syncs.size(), bed.count("GET", "/license/document")])
	t.check("happy: the licence gate is ok after the sync", sdk.is_licensed() and sdk.status()["status"] == "ok", str(sdk.status()))
	t.check("happy: no longer signing in", not sdk.identity.is_signing_in())
	t.check("happy: signed_in_identity() names someone", not sdk.identity.signed_in_identity().is_empty(), str(sdk.identity.signed_in_identity()))
	# Pacing: the first poll waits one interval; after the slow_down the RETURNED interval is used.
	t.check("happy: sleeps 2, 2, 7, 7", bed.sleeps == [2.0, 2.0, 7.0, 7.0], str(bed.sleeps))
	var polls := bed.polls_sent()
	var times: Array = polls.map(func(p): return p["at"] - bed.F["now"])
	t.check("happy: four polls at +2, +4, +11, +18", times == [2.0, 4.0, 11.0, 18.0], str(times))
	var start: Dictionary = bed.flow_requests[0]
	t.check("happy: the start sends the device id and name, no bearer", start["body"] == {"deviceId": bed.F["device_id"], "deviceName": "Living-room PC"} and not start["headers"].has("authorization"), str(start["body"]))
	var same := true
	for p in polls:
		same = same and p["body"]["deviceId"] == p["headers"].get("x-pkey-device") and p["body"]["deviceId"] == bed.F["device_id"] \
				and p["body"]["deviceCode"] == "SECRETDEVICECODE0000001" and not p["headers"].has("authorization") and not p["body"].has("confirmIdentity")
	t.check("happy: every poll carries the X-PKey-Device id, the device code, and no bearer", same, str(polls.map(func(p): return p["body"])))


## RFC 8628 §3.5: an interval-less slow_down adds five seconds to the CURRENT interval, again
## and again; never faster.
func _slow_down_without_interval(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [
		B.json(429, {"status": "slow_down"}),
		B.json(429, {"error": "rate_limited", "message": "too many requests"}),
		B.json(429, {"status": "slow_down", "interval": 3}),
		B.state("timeout"),
	]
	var sdk = await bed.make_sdk()
	var results := B.record(sdk.identity)
	await sdk.identity.begin_sign_in("x")
	await B.until(func(): return not results.is_empty())
	t.check("slow_down: 2, then +5 => 7, then +5 from the current => 12, never shortened by a smaller one", bed.sleeps == [2.0, 7.0, 12.0, 12.0], str(bed.sleeps))
	t.check("slow_down: timeout maps to timeout", results.size() == 1 and results[0].kind == PKeySignInResult.KIND_TIMEOUT and results[0].code == PKeyErrors.SIGN_IN_EXPIRED, str(results))


## timeout, error, a 401 and a malformed ready map to their kinds; nothing is stored.
func _endings(t: PKeyTestContext, bed: B) -> void:
	var cases := [
		[B.state("timeout"), PKeySignInResult.KIND_TIMEOUT, PKeyErrors.SIGN_IN_EXPIRED],
		[B.state("error"), PKeySignInResult.KIND_DENIED, PKeyErrors.SIGN_IN_DENIED],
		[B.json(401, {"error": "unauthorized", "message": "device mismatch"}), PKeySignInResult.KIND_DEVICE_MISMATCH, PKeyErrors.UNAUTHORIZED],
		[B.state("ready"), PKeySignInResult.KIND_ERROR, PKeyErrors.INVALID_RESPONSE],
		[B.state("weird"), PKeySignInResult.KIND_ERROR, PKeyErrors.INVALID_RESPONSE],
		[B.json(400, {"error": "bad_request", "message": "missing deviceCode/deviceId"}), PKeySignInResult.KIND_ERROR, PKeyErrors.BAD_REQUEST],
	]
	for c in cases:
		_reset(bed)
		bed.starts = [B.started(2)]
		bed.polls = [c[0]]
		var sdk = await bed.make_sdk()
		var results := B.record(sdk.identity)
		await sdk.identity.begin_sign_in("x")
		await B.until(func(): return not results.is_empty())
		var r: PKeySignInResult = results[0] if not results.is_empty() else null
		t.check("ending %s: kind %s, code %s" % [c[0]["body"], c[1], c[2]], r != null and not r.ok and r.kind == c[1] and r.code == c[2], str(r))
		t.check("ending %s: one poll, nothing stored" % c[1], bed.polls_sent().size() == 1 and sdk.core.tokens.current() == "")


## No poll is sent at or after expires_at; the waits are clamped to the code's remaining life.
func _expiry(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2, 5)]
	bed.polls = [B.state("pending")]
	var sdk = await bed.make_sdk()
	var results := B.record(sdk.identity)
	var prompt: PKeySignInPrompt = await sdk.identity.begin_sign_in("x")
	await B.until(func(): return not results.is_empty())
	var times: Array = bed.polls_sent().map(func(p): return p["at"])
	var after := times.filter(func(at): return at >= prompt.expires_at)
	t.check("expiry: ends expired", results.size() == 1 and results[0].kind == PKeySignInResult.KIND_EXPIRED and results[0].code == PKeyErrors.SIGN_IN_EXPIRED, str(results))
	t.check("expiry: no poll at or after expires_at", after.is_empty() and times.size() == 2, "polls at %s, expires_at %s" % [str(times), prompt.expires_at])
	t.check("expiry: the last wait is clamped to the remaining second", bed.sleeps == [2.0, 2.0, 1.0], str(bed.sleeps))

	# wait_for_sign_in on a prompt already past its expiry sends nothing.
	bed.flow_requests.clear()
	bed.clock[0] = prompt.expires_at + 1
	var r: PKeySignInResult = await sdk.identity.wait_for_sign_in(prompt)
	t.check("expiry: a wait past expiry ends at once without a request", r.kind == PKeySignInResult.KIND_EXPIRED and bed.flow_requests.is_empty(), str(r))


## A poll that got no answer (5xx here) is retried at the SAME interval, never faster.
func _transient(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(3)]
	bed.polls = [{"status": 503}, B.state("pending"), B.state("error")]
	var sdk = await bed.make_sdk()
	var results := B.record(sdk.identity)
	await sdk.identity.begin_sign_in("x")
	await B.until(func(): return not results.is_empty())
	t.check("transient: a 5xx is retried at the same interval", bed.sleeps == [3.0, 3.0, 3.0] and bed.polls_sent().size() == 3, str(bed.sleeps))
	t.check("transient: then error ends denied", results.size() == 1 and results[0].kind == PKeySignInResult.KIND_DENIED, str(results))


## D-21: Identity off, or on but not set up, refuses before any request; a 429 start is
## rate-limited; a start without a complete prompt is refused.
func _refused(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(2)]
	var sdk = await bed.make_sdk("", PackedStringArray(["license", "config"]))
	var results := B.record(sdk.identity)
	t.check("refused: is_available() is false with identity off", not sdk.identity.is_available())
	var p: PKeySignInPrompt = await sdk.identity.begin_sign_in("x")
	t.check("refused: identity off -> service-unavailable", not p.ok and p.code == PKeyErrors.SERVICE_UNAVAILABLE, str(p))
	t.check("refused: and no request was sent", bed.server.requests.is_empty(), str(bed.server.requests.size()))
	t.check("refused: sign_in_finished reports service-unavailable", results.size() == 1 and results[0].kind == PKeySignInResult.KIND_SERVICE_UNAVAILABLE)

	# Discovery says enabled but not configured (no IdP yet).
	sdk = await bed.make_sdk()
	sdk.core.discovery_manifest = {"services": {"identity": {"enabled": true, "configured": false}}}
	t.check("refused: is_available() is false when discovery says not configured", not sdk.identity.is_available())
	p = await sdk.identity.request_sign_in("x")
	t.check("refused: not configured -> service-unavailable, no request", not p.ok and p.code == PKeyErrors.SERVICE_UNAVAILABLE and bed.flow_requests.is_empty())
	sdk.core.discovery_manifest = {"services": {"identity": {"enabled": true, "configured": true}}}
	t.check("refused: is_available() once configured", sdk.identity.is_available())

	# Before configure(): the sub-object exists and refuses.
	var bare := PKeyTestFixtures.new_sdk()
	t.check("refused: identity exists before configure() and is unavailable", bare.identity != null and not bare.identity.is_available())
	var np: PKeySignInPrompt = await bare.identity.request_sign_in("x")
	t.check("refused: before configure() -> not-configured", not np.ok and np.code == PKeyErrors.NOT_CONFIGURED)
	bare.queue_free()

	_reset(bed)
	bed.starts = [B.json(429, {"error": "rate_limited", "message": "too many requests"})]
	sdk = await bed.make_sdk()
	results = B.record(sdk.identity)
	p = await sdk.identity.begin_sign_in("x")
	t.check("refused: a 429 start -> rate-limited", not p.ok and results.size() == 1 and results[0].kind == PKeySignInResult.KIND_RATE_LIMITED and results[0].status == 429, str(results))
	t.check("refused: and nothing polls", bed.polls_sent().is_empty() and not sdk.identity.is_signing_in())

	_reset(bed)
	bed.starts = [B.json(200, {"status": "pending", "deviceCode": "x", "userCode": "y"})]
	sdk = await bed.make_sdk()
	p = await sdk.identity.request_sign_in("x")
	t.check("refused: an incomplete start -> invalid-response", not p.ok and p.code == PKeyErrors.INVALID_RESPONSE, str(p))

	# The default device name is sent when the game gives none.
	_reset(bed)
	bed.starts = [B.started(2)]
	bed.polls = [B.state("timeout")]
	sdk = await bed.make_sdk()
	results = B.record(sdk.identity)
	await sdk.identity.begin_sign_in()
	await B.until(func(): return not results.is_empty())
	var sent_name = bed.flow_requests[0]["body"].get("deviceName")
	t.check("refused: begin_sign_in() names the device by default", sent_name is String and sent_name == PKeyIdentity.default_device_name() and sent_name != "", str(sent_name))


## cancel() with a REAL timer: the wait wakes at once, ends cancelled, and sends nothing more.
func _cancel(t: PKeyTestContext, bed: B) -> void:
	_reset(bed)
	bed.starts = [B.started(1)]
	bed.polls = [B.state("pending")]
	var sdk = await bed.make_sdk("", PackedStringArray(["license", "config", "identity"]), false)
	var results := B.record(sdk.identity)
	await sdk.identity.begin_sign_in("x")
	# Let the first real poll go out (one interval = 1 s), then cancel partway into the next.
	await B.until(func(): return bed.polls_sent().size() >= 1, 600)
	await (Engine.get_main_loop() as SceneTree).create_timer(0.3).timeout
	var sent := bed.polls_sent().size()
	# Counted in frames, not milliseconds, so a loaded machine cannot fail it: cancel() wakes the
	# wait itself, so the result lands at once; sleeping out the rest of the 1 s interval instead
	# takes as many frames as that time holds (dozens and more headless).
	var frames := 0
	var tree := Engine.get_main_loop() as SceneTree
	var at := Time.get_ticks_msec()
	sdk.identity.cancel()
	while results.is_empty() and frames < CANCEL_FRAMES:
		await tree.process_frame
		frames += 1
	var took := Time.get_ticks_msec() - at
	t.info("cancel: the cancelled result landed after %d frames (%d ms)" % [frames, took])
	t.check("cancel: sign_in_finished(cancelled) at once (within %d frame)" % CANCEL_FRAMES, results.size() == 1 and results[0].kind == PKeySignInResult.KIND_CANCELLED and results[0].code == PKeyErrors.CANCELLED, "%s after %d frames, %d ms" % [str(results), frames, took])
	await (Engine.get_main_loop() as SceneTree).create_timer(1.5).timeout
	t.check("cancel: no poll after cancel()", bed.polls_sent().size() == sent, "%d -> %d" % [sent, bed.polls_sent().size()])
	t.check("cancel: not signing in", not sdk.identity.is_signing_in())


func _units(t: PKeyTestContext) -> void:
	t.check("poll_delay: never under one second", PKeyIdentity.poll_delay(0, 600) == 1.0 and PKeyIdentity.poll_delay(-3, 600) == 1.0 and PKeyIdentity.poll_delay(NAN, 600) == 1.0)
	t.check("poll_delay: never past the remaining lifetime", PKeyIdentity.poll_delay(10, 3.5) == 3.5 and PKeyIdentity.poll_delay(10, 0.2) == 1.0)
	t.check("poll_delay: the interval otherwise", PKeyIdentity.poll_delay(5, 600) == 5.0)
	var p := PKeySignInPrompt.new(true)
	p.device_code = "SECRETDEVICECODE0000001"
	p.user_code = "WDJB-MJHT"
	t.check("prompt: str() redacts the device code", not str(p).contains("SECRETDEVICECODE") and str(p).contains("[redacted]") and str(p).contains("WDJB-MJHT"), str(p))
	var r := PKeySignInResult.signed_in({"name": "Ada"}, "", true, null)
	t.check("result: str() shows the identity", str(r).contains("Ada"), str(r))
