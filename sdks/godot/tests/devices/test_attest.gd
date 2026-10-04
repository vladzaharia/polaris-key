extends RefCounted
# @pkey-feature devices.attest
# PolarisKey.devices.attest() (P6-02) against a loopback server that answers like the Worker's
# attestation routes, with PKeyApple over PKeyFakeAppleNative and PKeyAndroid over
# PKeyFakeAndroidNative:
#
#   unsupported  `runtime` on linux, macos, windows and web (and where App Attest does not run);
#                `outlet` on an iOS install that is not App Store/TestFlight, an Android install
#                Play did not make, the direct plugin build, and a mobile build without the plugin.
#                None of them touches the network.
#   ios          challenge, App Attest over SHA-256(requestHash) with the key id kept in the
#                Keychain, the attest body, a key lost to a reinstall re-attested with a fresh key
#                in the same call, server_unavailable keeping the generated key
#   android      the play.cloudProjectNumber from the challenge (or PKeyOptions'), the token for the
#                requestHash verbatim, the attest body, a missing project number
#   errors       the server's codes verbatim (rate_limited, attestation_unavailable,
#                attestation_rejected), no token, a malformed challenge

const TOKEN := "pkeyt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const CHALLENGE := "c2luZ2xlLXVzZS1jaGFsbGVuZ2UtZm9yLXRoaXMtZGV2"
const REQUEST_HASH := "q8Jm3rJ0b1x2Vd4n6Q9sT0uW1yZ2aB3cD4eF5gH6iJ7"
const PROJECT := "123456789012"

var F: Dictionary
var plan := {}
var server: PKeyFakeServer
var _nodes: Array[Node] = []


func run(t: PKeyTestContext) -> void:
	F = PKeyTestFixtures.sync_docs()
	if not t.check("attest: fixtures present", not F.is_empty()):
		return
	server = PKeyTestFixtures.new_server(_answer)
	PKeyApple.reset_launch()
	await _unsupported(t)
	await _ios(t)
	await _android(t)
	await _errors(t)
	for n in _nodes:
		if is_instance_valid(n):
			n.free()
	PKeyApple.reset_launch()
	server.queue_free()


func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	for suffix in plan:
		if path.ends_with(suffix):
			var q: Array = plan[suffix]
			var a = q[0] if q.size() == 1 else q.pop_front()
			return a.call(req) if a is Callable else a
	return {"status": 404, "body": "{\"error\":{\"code\":\"not_found\"}}"}


func _json(status: int, body: Variant) -> Dictionary:
	return {"status": status, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify(body)}


func _challenge(play := true) -> Dictionary:
	var b := {"challenge": CHALLENGE, "requestHash": REQUEST_HASH, "expiresAt": int(F["now"]) + 300}
	if play:
		b["play"] = {"cloudProjectNumber": PROJECT}
	return _json(200, b)


func _attested(kind: String) -> Dictionary:
	return _json(200, {"trustLevel": "attested", "kind": kind, "attestedAt": int(F["now"])})


func _sdk(token := TOKEN, tweak := Callable()) -> Node:
	var sdk := PKeyTestFixtures.new_sdk()
	var store := PKeyMemoryStore.new(F["device_id"], token)
	var opts := PKeyTestFixtures.options(server.base_url(), store, [F["now"]], F["product"], F["trust"], F["version"])
	opts.expected_services = PackedStringArray()
	if tweak.is_valid():
		tweak.call(opts)
	sdk.configure(opts)
	await sdk.start()
	return sdk


func _apple(fake: Object, missing := false) -> PKeyApple:
	var a := PKeyApple.new()
	a.platform = "ios"
	a.native = fake
	a.timeout_s = 2.0
	if missing:
		a.native_class = "PolarisKeyAppleMissingForTests"
	_nodes.append(a)
	return a


func _android_facade(fake: Object, missing := false) -> PKeyAndroid:
	var a := PKeyAndroid.new()
	a.platform = "android"
	a.native = fake
	a.timeout_s = 2.0
	if missing:
		a.singleton_name = "PolarisKeyAndroidMissingForTests"
	_nodes.append(a)
	return a


func _requests(suffix: String) -> Array:
	return server.requests.filter(func(r): return r["method"] == "POST" and String(r["path"]).ends_with(suffix))


static func _body(req: Dictionary) -> Variant:
	var parsed := PKeyJson.parse((req["body"] as PackedByteArray).get_string_from_utf8())
	return parsed["value"] if parsed["ok"] else null


static func _unsupported_with(r: PKeyResult, reason: String) -> bool:
	return not r.ok and r.code == &"unsupported" and r.detail is Dictionary and r.detail.get("reason") == reason and r.detail.get("feature") == PKeyConstants.Feature.DEVICES_ATTEST


# ── unsupported ──────────────────────────────────────────────────────────────────────────

func _unsupported(t: PKeyTestContext) -> void:
	server.requests.clear()
	plan = {"/devices/attest/challenge": [_challenge()], "/devices/attest": [_attested("app-attest")]}
	var sdk = await _sdk()
	var devices: PKeyDevices = sdk.devices

	for p in ["linux", "macos", "windows", "web"]:
		devices.attest_platform = p
		var r: PKeyResult = await devices.attest()
		t.check("unsupported: %s is runtime" % p, _unsupported_with(r, "runtime"), str(r))

	# iOS.
	devices.attest_platform = "ios"
	PKeyApple.reset_launch()
	devices.apple = _apple(null, true)
	var r: PKeyResult = await devices.attest()
	t.check("unsupported: iOS without the plugin is outlet", _unsupported_with(r, "outlet"), str(r))
	var cases := [
		[{"signal": "marketplace:com.example.store", "provisioned": false}, "an alternative marketplace"],
		[{"signal": "web", "provisioned": false}, "web distribution"],
		[{"signal": "other", "provisioned": true}, "a development or ad hoc build"],
		[{"signal": "unavailable", "reason": "timeout", "provisioned": true}, "a sideload (AltStore, SideStore) with no AppDistributor answer"],
	]
	for c in cases:
		var fake := PKeyFakeAppleNative.new()
		fake.distributor = {"ok": true, "ms": 3, "altBundleIdentifier": null, "bundleIdentifier": "gg.vlad.diceroll"}.merged(c[0])
		devices.apple = _apple(fake)
		r = await devices.attest()
		t.check("unsupported: iOS %s is outlet" % c[1], _unsupported_with(r, "outlet"), str(r))
		t.check("unsupported: iOS %s never generates a key" % c[1], not fake.calls.any(func(q): return String(q.get("op", "")).begins_with("app_attest_attest")))
	var sim := PKeyFakeAppleNative.new()
	sim.app_attest_supported = false
	devices.apple = _apple(sim)
	r = await devices.attest()
	t.check("unsupported: iOS where App Attest does not run (the simulator) is runtime", _unsupported_with(r, "runtime"), str(r))

	# Android.
	devices.attest_platform = "android"
	devices.android = _android_facade(null, true)
	r = await devices.attest()
	t.check("unsupported: Android without the plugin is outlet", _unsupported_with(r, "outlet"), str(r))
	var direct := PKeyFakeAndroidNative.new()
	direct.flavor = "direct"
	devices.android = _android_facade(direct)
	r = await devices.attest()
	t.check("unsupported: the direct plugin build is outlet", _unsupported_with(r, "outlet"), str(r))
	for installer in ["com.android.packageinstaller", "org.fdroid.fdroid", null]:
		var side := PKeyFakeAndroidNative.new()
		side.installer = installer
		devices.android = _android_facade(side)
		r = await devices.attest()
		t.check("unsupported: an install by %s is outlet" % str(installer), _unsupported_with(r, "outlet"), str(r))
		t.check("unsupported: no Play Integrity request for %s" % str(installer), side.ops_called("integrity_token") == 0)

	t.check("unsupported: no Unsupported answer touched the network", server.requests.is_empty(), str(server.requests.map(func(q): return q["path"])))

	# PolarisKey.supports() agrees: runtime on the desktop runtimes, and the outlet N/A on iOS and
	# Android has its detector (no "no detector decides it" problem at start-up on a device).
	var engine: PKeyCaps = sdk.core.capability_engine()
	for p in ["linux", "macos", "windows", "web"]:
		t.check("supports: devices.attest on %s is runtime" % p, _unsupported_with(engine.supports_on(PKeyConstants.Feature.DEVICES_ATTEST, p), "runtime"))
	for p in ["ios", "android"]:
		var mobile := PKeyCaps.new(Callable(), "0.0.0", p)
		mobile.detectors = engine.detectors
		var problems := Array(mobile.validate()).filter(func(x): return String(x).contains("devices.attest"))
		t.check("supports: the devices.attest outlet N/A on %s has a detector" % p, problems.is_empty(), str(problems))
	t.check("supports: the outlet detector says nothing off mobile", PKeyDevices.attest_outlet_detail() == "")
	sdk.queue_free()


# ── iOS ──────────────────────────────────────────────────────────────────────────────────

func _ios(t: PKeyTestContext) -> void:
	server.requests.clear()
	plan = {"/devices/attest/challenge": [_challenge(false)], "/devices/attest": [_attested("app-attest")]}
	var sdk = await _sdk()
	var devices: PKeyDevices = sdk.devices
	devices.attest_platform = "ios"
	PKeyApple.reset_launch()
	var fake := PKeyFakeAppleNative.new()
	devices.apple = _apple(fake)
	var account := "%s/%s" % [F["product"], PKeyDevices.APP_ATTEST_ACCOUNT]

	var r: PKeyResult = await devices.attest()
	t.check("ios: attested", r.ok and r.detail == {"trust_level": "attested", "kind": "app-attest", "attested_at": int(F["now"])}, str(r))
	var ch := _requests("/devices/attest/challenge")
	t.check("ios: one challenge, with the bearer and no body", ch.size() == 1 and ch[0]["headers"].get("authorization") == "Bearer %s" % TOKEN and (ch[0]["body"] as PackedByteArray).is_empty())
	var posts := _requests("/devices/attest")
	var key := str(fake.attest_keys[0]) if fake.attest_keys.size() > 0 else ""
	var body = _body(posts[0]) if posts.size() == 1 else null
	t.check("ios: the attest body", body == {"kind": "app-attest", "keyId": key, "attestation": Marshalls.utf8_to_base64("attestation:%s:%s" % [key, REQUEST_HASH]), "challenge": CHALLENGE}, str(body))
	t.check("ios: the native call carried the requestHash and generated a key", fake.calls.filter(func(q): return q.get("op") == "app_attest_attest").map(func(q): return q.get("keyId")) == [null] \
			and fake.calls.any(func(q): return q.get("op") == "app_attest_attest" and q.get("requestHash") == REQUEST_HASH))
	t.check("ios: the key id is kept in the Keychain", fake.keychain.get(account) == key, str(fake.keychain))

	# Again: the stored key is reused.
	server.requests.clear()
	fake.calls.clear()
	r = await devices.attest()
	var attests := fake.calls.filter(func(q): return q.get("op") == "app_attest_attest")
	t.check("ios: a second attestation reuses the stored key", r.ok and attests.size() == 1 and attests[0].get("keyId") == key, str(attests))

	# A reinstall (or restore, or migration) kills the key: re-attested with a fresh one, in one call.
	fake.attest_keys.clear()
	server.requests.clear()
	fake.calls.clear()
	r = await devices.attest()
	attests = fake.calls.filter(func(q): return q.get("op") == "app_attest_attest")
	var fresh := str(fake.attest_keys[0]) if fake.attest_keys.size() > 0 else ""
	t.check("ios: a lost key is re-attested with a fresh key, not reported as fraud", r.ok and attests.size() == 2 and attests[0].get("keyId") == key and attests[1].get("keyId") == null, str(attests))
	t.check("ios: the fresh key replaces the stored one", fresh != "" and fresh != key and fake.keychain.get(account) == fresh)
	posts = _requests("/devices/attest")
	t.check("ios: the fresh key is the one posted", posts.size() == 1 and _body(posts[0]).get("keyId") == fresh)

	# Apple's attestation service is down: the generated key is kept for the retry.
	fake.keychain.erase(account)
	fake.attest_fail = "server_unavailable"
	server.requests.clear()
	r = await devices.attest()
	t.check("ios: server_unavailable is a platform error, nothing posted", not r.ok and r.code == PKeyErrors.PLATFORM_ERROR and r.detail.get("error") == "server_unavailable" and _requests("/devices/attest").is_empty(), str(r))
	t.check("ios: ... and the generated key is kept for the retry", fake.keychain.get(account) is String and fake.keychain.get(account) == r.detail.get("keyId"))

	# The launch's distributor read is used when it has arrived (TestFlight here).
	fake.distributor = {"ok": true, "signal": "testFlight", "ms": 2, "provisioned": false, "altBundleIdentifier": null, "bundleIdentifier": "gg.vlad.diceroll"}
	await PKeyApple.start_launch_reads(devices.apple)
	fake.calls.clear()
	r = await devices.attest()
	t.check("ios: TestFlight attests, from the launch's distributor read", r.ok and not fake.calls.any(func(q): return q.get("op") == "distributor"), str(r))
	PKeyApple.reset_launch()
	sdk.queue_free()


# ── Android ──────────────────────────────────────────────────────────────────────────────

func _android(t: PKeyTestContext) -> void:
	server.requests.clear()
	plan = {"/devices/attest/challenge": [_challenge(true)], "/devices/attest": [_attested("play-integrity")]}
	var sdk = await _sdk()
	var devices: PKeyDevices = sdk.devices
	devices.attest_platform = "android"
	var fake := PKeyFakeAndroidNative.new()
	devices.android = _android_facade(fake)

	var r: PKeyResult = await devices.attest()
	t.check("android: attested", r.ok and r.detail == {"trust_level": "attested", "kind": "play-integrity", "attested_at": int(F["now"])}, str(r))
	var q := fake.last_call("integrity_token")
	t.check("android: the token is requested for the challenge's project and the requestHash verbatim", q.get("cloudProjectNumber") == PROJECT and q.get("requestHash") == REQUEST_HASH, str(q))
	var posts := _requests("/devices/attest")
	var body = _body(posts[0]) if posts.size() == 1 else null
	t.check("android: the attest body", body == {"kind": "play-integrity", "token": "token:%s:%s" % [PROJECT, REQUEST_HASH], "challenge": CHALLENGE}, str(body))
	t.check("android: the bearer on both calls", server.requests.size() == 2 and server.requests.all(func(x): return x["headers"].get("authorization") == "Bearer %s" % TOKEN))

	# PKeyOptions.play_cloud_project_number wins over the challenge's.
	var own = await _sdk(TOKEN, func(o: PKeyOptions): o.play_cloud_project_number = "42")
	own.devices.attest_platform = "android"
	own.devices.android = devices.android
	r = await own.devices.attest()
	t.check("android: PKeyOptions.play_cloud_project_number is used when set", r.ok and fake.last_call("integrity_token").get("cloudProjectNumber") == "42", str(r))
	own.queue_free()

	# Neither the Worker nor the options name a project: refused before Play is asked.
	plan["/devices/attest/challenge"] = [_challenge(false)]
	var calls := fake.ops_called("integrity_token")
	r = await devices.attest()
	t.check("android: no cloud project number is invalid-options", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS and fake.ops_called("integrity_token") == calls, str(r))

	# A Play failure is a platform error carrying Play's code; nothing is posted.
	plan["/devices/attest/challenge"] = [_challenge(true)]
	fake.integrity_error = -8
	server.requests.clear()
	r = await devices.attest()
	t.check("android: a Play Integrity failure is platform-error with its errorCode", not r.ok and r.code == PKeyErrors.PLATFORM_ERROR and int(r.detail.get("errorCode", 0)) == -8 and _requests("/devices/attest").is_empty(), str(r))
	sdk.queue_free()


# ── errors ───────────────────────────────────────────────────────────────────────────────

func _errors(t: PKeyTestContext) -> void:
	var fake := PKeyFakeAndroidNative.new()
	var facade := _android_facade(fake)
	var sdk = await _sdk()
	var devices: PKeyDevices = sdk.devices
	devices.attest_platform = "android"
	devices.android = facade

	var cases := [
		["/devices/attest/challenge", _json(429, {"error": {"code": "rate_limited", "message": "slow down"}}), &"rate_limited", "a rate-limited challenge"],
		["/devices/attest/challenge", _json(401, {"error": {"code": "unauthorized", "message": "no"}}), &"unauthorized", "an unknown token"],
		["/devices/attest", _json(409, {"error": {"code": "attestation_unavailable", "message": "not set up"}}), &"attestation_unavailable", "a product not set up for Play Integrity"],
		["/devices/attest", _json(422, {"error": {"code": "attestation_rejected", "message": "verdict"}}), &"attestation_rejected", "a rejected verdict"],
		["/devices/attest", _json(429, {"error": {"code": "rate_limited", "message": "hourly"}}), &"rate_limited", "the per-device budget"],
	]
	for c in cases:
		plan = {"/devices/attest/challenge": [_challenge()], "/devices/attest": [_attested("play-integrity")]}
		plan[c[0]] = [c[1]]
		var r: PKeyResult = await devices.attest()
		t.check("errors: %s surfaces %s verbatim" % [c[3], c[2]], not r.ok and r.code == c[2] and r.detail.get("status") == c[1]["status"], str(r))

	plan = {"/devices/attest/challenge": [_json(200, {"challenge": CHALLENGE})], "/devices/attest": [_attested("play-integrity")]}
	var r: PKeyResult = await devices.attest()
	t.check("errors: a challenge without requestHash is invalid-response", not r.ok and r.code == PKeyErrors.INVALID_RESPONSE, str(r))
	plan = {"/devices/attest/challenge": [_challenge()], "/devices/attest": [_json(200, {"ok": true})]}
	r = await devices.attest()
	t.check("errors: an answer without trustLevel is invalid-response", not r.ok and r.code == PKeyErrors.INVALID_RESPONSE, str(r))
	sdk.queue_free()

	server.requests.clear()
	var bare = await _sdk("")
	bare.devices.attest_platform = "android"
	bare.devices.android = facade
	r = await bare.devices.attest()
	t.check("errors: without a token nothing is sent", not r.ok and r.code == PKeyErrors.DEVICE_MANAGEMENT_UNSUPPORTED and server.requests.is_empty(), str(r))
	bare.queue_free()
