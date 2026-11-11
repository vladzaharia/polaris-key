extends RefCounted
# @pkey-feature outlet.detect core.store packs.transport.apple commerce.receipt devices.attest identity.autosignin identity.gamecenter
# The Apple platform plugin's GDScript side (P5-05), headless on every OS:
#
#   stubs     PKeyApple without the native class: every call answers Unsupported, reason
#             `runtime` off iOS and `dependency` on iOS without the GDExtension; no call reaches
#             a native object; poll() is a no-op
#   facade    PKeyApple over PKeyFakeAppleNative (the PolarisKeyPlatform router's shapes): a
#             request is answered by the event carrying its `req`, delivered by a later poll;
#             unsolicited events become transaction_updated / pack_* signals; unsupported,
#             error, bad-reply and timeout mapping; the launch distributor read
#   keychain  PKeyKeychainStore over the fake Keychain: token and device id round trips, the
#             migration from the file store, a failing Keychain surfaced (no silent downgrade),
#             and the file store everywhere off iOS
#   binary    the D-13 binary entry (CC-14b.2): PKeyApple.cmd_bin / poll_bin over a fake, and, when the
#             macOS dylib is built and installed (native/macos/build_apple.sh --install, run with
#             PKEY_APPLE_SELFTEST=1), over the real glue: bounds, empty answers, byte round trips
#   auth      PKeyAppleAuth (I-48.17) over a fake binary entry: auth_open / auth_cancel and the
#             auth_done / auth_fail events routed to the caller's callbacks
#   export    PKeyAppleExport: auto/on/off per outlet kind, the Info.plist mark, the warnings

const FOES := "gg.vlad.diceroll.pack.foes"
const TOKEN := "6F2C3B1A-0000-4000-8000-00000000C0DE"


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_stubs(t)
	await _facade(t)
	await _sign_in_with_apple(t)
	await _game_center(t)
	_keychain(t)
	await _backup(t)
	_binary(t)
	_auth(t)
	_export(t)
	_export_entitlements(t)
	return true


## A native object with the binary entry: it echoes for "echo", reverses for "rev", queues events.
class FakeBin:
	extends RefCounted
	var events: Array = []
	var seen_ops: Array[String] = []

	func cmd_bin(op: String, data: PackedByteArray) -> Variant:
		seen_ops.append(op)
		if op == "echo":
			return data
		if op == "huge":
			var big := PackedByteArray()
			big.resize(PKeyApple.BIN_MAX + 1)
			return big
		if op == "wrong":
			return "not bytes"
		return PackedByteArray()

	func poll_bin() -> Variant:
		var out := events
		events = []
		return out


class FakeNoBin:
	extends RefCounted

	func cmd(_json: String) -> String:
		return "{}"


## A native object that models WebAuthHost's ops: one sheet at a time, events queued by the test.
class FakeAuth:
	extends RefCounted
	var ops: Array = []
	var inputs: Array = []
	var events: Array = []
	var is_open := false
	var status := 1

	func cmd_bin(op: String, data: PackedByteArray) -> Variant:
		ops.append(op)
		inputs.append(data.get_string_from_utf8())
		if op == "auth_open":
			if is_open:
				return PackedByteArray([7])
			if status == 1:
				is_open = true
			return PackedByteArray([status])
		if op == "auth_cancel":
			var was := is_open
			is_open = false
			return PackedByteArray([1 if was else 0])
		return PackedByteArray()

	func poll_bin() -> Variant:
		var out := events
		events = []
		return out

	## The native side closes its slot when it reports an end.
	func event(kind: String, body: Dictionary) -> void:
		is_open = false
		events.append([kind, JSON.stringify(body).to_utf8_buffer()])


func _auth(t: PKeyTestContext) -> void:
	var fake := FakeAuth.new()
	var a := _apple("ios", fake)
	var auth := PKeyAppleAuth.create(a, null)
	t.check("auth: a native with the binary entry gives an opener", auth != null and str(auth) == "PKeyAppleAuth(open=false)")
	var no_bin := _apple("ios", FakeNoBin.new())
	t.check("auth: no binary entry, no opener", PKeyAppleAuth.create(no_bin, null) == null)
	no_bin.free()
	var got := []
	var failed := []
	var on_done := func(u: String) -> void: got.append(u)
	var on_fail := func(r: String) -> void: failed.append(r)
	var opened: bool = auth.open("https://key.plrs.im/a", "demoapp", "key.plrs.im", on_done, on_fail, true)
	var sent = JSON.parse_string(fake.inputs[0]) if not fake.inputs.is_empty() else null
	var want := {"url": "https://key.plrs.im/a", "callback_scheme": "demoapp", "issuer_host": "key.plrs.im", "prefers_ephemeral": true}
	t.check("auth: open sends the url, scheme, issuer host and ephemeral flag", opened and fake.ops == ["auth_open"] and sent == want)
	t.check("auth: the sheet id advances", auth.sheet_id == 1)
	fake.event("auth_done", {"url": "demoapp:/pkey/callback?code=x"})
	auth.poll()
	t.check("auth: auth_done goes to on_done once", got == ["demoapp:/pkey/callback?code=x"] and failed.is_empty())
	fake.event("auth_done", {"url": "demoapp:/pkey/callback?code=y"})
	auth.poll()
	t.check("auth: an event with no sheet open is dropped", got.size() == 1)
	auth.open("https://key.plrs.im/a", "demoapp", "key.plrs.im", on_done, on_fail)
	fake.event("auth_fail", {"reason": "cancelled"})
	auth.poll()
	t.check("auth: auth_fail goes to on_fail with its reason", failed == ["cancelled"])
	auth.open("https://key.plrs.im/a", "demoapp", "key.plrs.im", on_done, on_fail)
	fake.events = [["auth_done", PackedByteArray([0xff, 0x7b])], ["auth_done", "{}".to_utf8_buffer()]]
	auth.poll()
	t.check("auth: an unreadable or url-less event is ignored", got.size() == 1 and failed.size() == 1)
	var before := fake.ops.size()
	auth.cancel_sheet(auth.sheet_id + 5)
	t.check("auth: cancel_sheet of another id does nothing", fake.ops.size() == before)
	auth.cancel_sheet(auth.sheet_id)
	t.check("auth: cancel_sheet of the showing sheet sends auth_cancel", fake.ops[-1] == "auth_cancel" and not fake.is_open)
	fake.event("auth_done", {"url": "demoapp:/pkey/callback?code=z"})
	auth.poll()
	t.check("auth: nothing is delivered after a cancel", got.size() == 1)
	fake.status = 3
	t.check("auth: a refusal from the native side is false", not auth.open("http://evil.example/", "demoapp", "key.plrs.im", on_done, on_fail))
	fake.status = 1
	auth.open("https://key.plrs.im/a", "demoapp", "key.plrs.im", on_done, on_fail)
	auth.open("https://key.plrs.im/b", "demoapp", "key.plrs.im", on_done, on_fail)
	t.check("auth: opening again closes the sheet showing first", fake.ops.slice(-3) == ["auth_open", "auth_cancel", "auth_open"], str(fake.ops))
	a.free()


func _binary(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	var a := _apple("ios", fake)
	t.check("binary: a native object with cmd_bin and poll_bin has the entry", a.binary_available())
	var all := PackedByteArray()
	for i in 256:
		all.append(i)
	t.check("binary: all 256 byte values round trip", a.cmd_bin("echo", all) == all)
	t.check("binary: an unknown op is empty", a.cmd_bin("nope", all).is_empty())
	t.check("binary: an empty op never reaches the native side", a.cmd_bin("", all).is_empty() and not fake.seen_ops.has(""))
	t.check("binary: an over-long op never reaches the native side", a.cmd_bin("x".repeat(PKeyApple.BIN_OP_MAX + 1), all).is_empty() and fake.seen_ops.size() == 2)
	t.check("binary: an oversized result is empty", a.cmd_bin("huge", all).is_empty())
	t.check("binary: a result of the wrong type is empty", a.cmd_bin("wrong", all).is_empty())
	var big := PackedByteArray()
	big.resize(PKeyApple.BIN_MAX + 1)
	var before := fake.seen_ops.size()
	t.check("binary: an oversized input never reaches the native side", a.cmd_bin("echo", big).is_empty() and fake.seen_ops.size() == before)
	fake.events = [["bj_data", PackedByteArray([1, 2])], ["x"], "junk", [1, PackedByteArray()], ["bj_closed", PackedByteArray()]]
	var evs := a.poll_bin()
	t.check("binary: poll_bin keeps well-formed events in order and drops the rest", evs.size() == 2 and evs[0][0] == "bj_data" and evs[0][1] == PackedByteArray([1, 2]) and evs[1][0] == "bj_closed")
	t.check("binary: poll_bin drains", a.poll_bin().is_empty())
	# The bulk channel's events (U-41.5c) are taken by prefix: the others wait for their consumer.
	fake.events = [["bj_data", PackedByteArray([7])], ["sb_done", PackedByteArray([1])], ["sb_fail", PackedByteArray([2])], ["sb_reconciled", PackedByteArray([3])]]
	var sb := a.poll_bin("sb_")
	t.check("binary: poll_bin(\"sb_\") takes the bulk events in order and leaves the rest", sb.size() == 3 and sb[0][0] == "sb_done" and sb[1][0] == "sb_fail" and sb[2][0] == "sb_reconciled")
	var rest := a.poll_bin("bj_")
	t.check("binary: another consumer's event waited for it", rest.size() == 1 and rest[0][0] == "bj_data" and a.poll_bin().is_empty())
	a.free()
	var old := _apple("ios", FakeNoBin.new())
	t.check("binary: a native build without it is unavailable and answers empty", not old.binary_available() and old.cmd_bin("echo", all).is_empty() and old.poll_bin().is_empty())
	old.free()
	var off := _apple("windows")
	t.check("binary: off Apple platforms there is none", not off.binary_available())
	off.free()
	var gone := _apple("macos")
	gone.native_class = "PolarisKeyAppleMissingForTests"
	t.check("binary: without the GDExtension there is none", not gone.binary_available() and gone.cmd_bin("echo", all).is_empty())
	gone.free()

	if not (OS.get_name() == "macOS" and ClassDB.class_exists(PKeyApple.NATIVE_CLASS) and ClassDB.class_has_method(PKeyApple.NATIVE_CLASS, "cmd_bin")):
		t.info("binary: the real glue is not built here (native/macos/build_apple.sh --install); skipped")
		return
	_binary_real(t, all)


## The real libpkey_apple.dylib. The echo and event ops exist only under PKEY_APPLE_SELFTEST=1.
func _binary_real(t: PKeyTestContext, all: PackedByteArray) -> void:
	var m := _apple("macos")
	t.check("real: the entry is available", m.binary_available() and ClassDB.class_has_method(PKeyApple.NATIVE_CLASS, "poll_bin"))
	t.check("real: an unknown op is empty", m.cmd_bin("no_such_op", all).is_empty())
	t.check("real: an empty op is empty", m.cmd_bin("", all).is_empty())
	t.check("real: an over-long op is empty", m.cmd_bin("x".repeat(65), all).is_empty())
	t.check("real: a JSON op is not a binary op", m.cmd_bin("ping", all).is_empty())
	t.check("real: empty data with an unknown op is empty", m.cmd_bin("no_such_op", PackedByteArray()).is_empty())
	# Earlier suites of the same process may have driven the shared binding and left events: drain them first.
	m.poll_bin()
	t.check("real: poll_bin is an empty Array at rest", m.poll_bin().is_empty())
	var raw = ClassDB.class_call_static(PKeyApple.NATIVE_CLASS, "poll_bin")
	t.check("real: poll_bin through ClassDB is an Array", raw is Array and raw.is_empty())
	if OS.get_environment("PKEY_APPLE_SELFTEST") != "1":
		t.info("real: PKEY_APPLE_SELFTEST=1 is not set; the round trips are skipped")
		m.free()
		return
	t.check("real: all 256 byte values round trip", m.cmd_bin("selftest_echo", all) == all)
	t.check("real: empty data round trips as empty", m.cmd_bin("selftest_echo", PackedByteArray()).is_empty())
	var mib := PackedByteArray()
	mib.resize(1 << 20)
	for i in mib.size():
		mib[i] = (i * 7 + 3) & 0xFF
	var echoed := m.cmd_bin("selftest_echo", mib)
	t.check("real: 1 MiB round trips", echoed.size() == mib.size() and echoed == mib)
	var edge := PackedByteArray()
	edge.resize(PKeyApple.BIN_MAX)
	t.check("real: the 16 MiB bound round trips", m.cmd_bin("selftest_echo", edge).size() == PKeyApple.BIN_MAX)
	# The GDScript side refuses an oversized input; call the native one directly to prove its own bound.
	edge.resize(PKeyApple.BIN_MAX + 1)
	var direct = ClassDB.class_call_static(PKeyApple.NATIVE_CLASS, "cmd_bin", "selftest_echo", edge)
	t.check("real: the native side refuses an input over 16 MiB", direct is PackedByteArray and direct.is_empty())
	# A typed call (the engine may take the ptrcall path) and the dynamic one agree.
	var typed := GDScript.new()
	typed.source_code = "\n".join([
		"extends RefCounted",
		"func go(d: PackedByteArray) -> PackedByteArray:",
		"\tvar r: PackedByteArray = PolarisKeyApple.cmd_bin(\"selftest_echo\", d)",
		"\treturn r",
		"func ev() -> Array:",
		"\tvar a: Array = PolarisKeyApple.poll_bin()",
		"\treturn a",
		"",
	])
	if t.check("real: the typed caller compiles", typed.reload() == OK):
		var o = typed.new()
		t.check("real: a typed call (ptrcall) round trips", o.go(all) == all)
		t.check("real: a typed poll_bin is an Array", o.ev() is Array)
	m.cmd_bin("selftest_event", PackedByteArray([7, 8, 9]))
	m.cmd_bin("selftest_event", PackedByteArray())
	var evs := m.poll_bin()
	t.check("real: binary events arrive in order as [kind, bytes]", evs.size() == 2 and evs[0][0] == "selftest" and evs[0][1] == PackedByteArray([7, 8, 9]) and evs[1][1].is_empty())
	t.check("real: poll_bin drains", m.poll_bin().is_empty())
	for i in 1100:
		m.cmd_bin("selftest_event", PackedByteArray([i & 0xFF]))
	t.check("real: the event queue is bounded at 1024, oldest dropped", m.poll_bin().size() == 1024)
	m.free()


static func _apple(p_platform: String, p_native: Object = null) -> PKeyApple:
	var a := PKeyApple.new()
	a.platform = p_platform
	a.native = p_native
	a.timeout_s = 2.0
	return a


## `_apple`, kept in `made` so the test can free the node.
static func _made(made: Array[PKeyApple], p_platform: String, p_native: Object = null) -> PKeyApple:
	var a := _apple(p_platform, p_native)
	made.append(a)
	return a


func _stubs(t: PKeyTestContext) -> void:
	var desktop := _apple("linux")
	var has_plugin_os := OS.get_name() == "iOS" or OS.get_name() == "macOS"
	t.check("stubs: the native class is not registered here", not ClassDB.class_exists(PKeyApple.NATIVE_CLASS) or has_plugin_os)
	t.check("stubs: off iOS the reason is runtime", desktop.unsupported_reason() == "runtime" and not desktop.is_available())
	# SP-27: on macOS the Keychain calls (core.store) run through the desktop build, so without it
	# they answer `dependency`; everything else stays iOS-only (`runtime`).
	var mac := _apple("macos")
	mac.native_class = "PolarisKeyAppleMissingForTests"
	var mac_kc := mac.keychain_get("diceroll", "device-token", PKeyApple.LOGIN_KEYCHAIN)
	t.check("stubs: on macOS without the dylib the Keychain calls answer dependency", not mac_kc.ok and mac_kc.detail.get("reason") == "dependency" \
			and str(mac_kc.message).contains("libpkey_apple.dylib") and not mac.keychain_available())
	t.check("stubs: on macOS every other call is still runtime", mac.unsupported_reason() == "runtime" and mac.capabilities().detail.get("reason") == "runtime")
	mac.free()
	var ios := _apple("ios")
	ios.native_class = "PolarisKeyAppleMissingForTests"
	t.check("stubs: on iOS without the GDExtension the reason is dependency", ios.unsupported_reason() == "dependency")
	for pair in [[desktop, "runtime"], [ios, "dependency"]]:
		var a: PKeyApple = pair[0]
		var why: String = pair[1]
		var results := {
			"capabilities": a.capabilities(),
			"keychain_get": a.keychain_get("diceroll", "token"),
			"keychain_set": a.keychain_set("diceroll", "token", "pkeyt_x"),
			"keychain_delete": a.keychain_delete("diceroll", "token"),
		}
		var all_unsupported := true
		for k in results:
			var r: PKeyResult = results[k]
			if r.ok or r.code != &"unsupported" or r.detail.get("reason") != why:
				all_unsupported = false
				t.info("stubs: %s answered %s" % [k, r])
		t.check("stubs: every synchronous call is Unsupported (%s)" % why, all_unsupported)
		t.check("stubs: call_sync without the plugin is {unsupported, reason: %s}" % why, a.call_sync({"op": "ping"}) == {"ok": false, "unsupported": true, "reason": why})
		t.check("stubs: poll() drains nothing (%s)" % why, a.poll() == 0)
		a.free()


func _facade(t: PKeyTestContext) -> void:
	# The coroutine calls without the plugin (awaited, so in this function): off iOS (runtime) and
	# on iOS without the GDExtension (dependency).
	var desktop := _apple("windows")
	var missing := _apple("ios")
	missing.native_class = "PolarisKeyAppleMissingForTests"
	for pair in [[desktop, "runtime"], [missing, "dependency"]]:
		var a: PKeyApple = pair[0]
		var why: String = pair[1]
		var stub_calls: Array[PKeyResult] = [
			await a.distributor(), await a.app_transaction(), await a.products(PackedStringArray([FOES])),
			await a.purchase(FOES, TOKEN), await a.entitlements(), await a.finish("1"),
			await a.pack_status("foes-c3"), await a.ensure_packs([{"id": "foes-c3", "path": "p"}]),
			await a.check_pack_updates(), await a.remove_pack("foes-c3"), await a.pack_path("p"),
			await a.listen(), await a.watch_pack("foes-c3"), await a.unwatch_pack("foes-c3"),
			await a.app_attest("h"), await a.app_attest_assert("k", "x"),
		]
		t.check("stubs: every awaited call (%d) is Unsupported (%s) with its feature" % [stub_calls.size(), why], stub_calls.all(func(r: PKeyResult): return not r.ok \
				and r.code == &"unsupported" and r.detail.get("reason") == why) \
				and stub_calls[0].detail["feature"] == PKeyConstants.Feature.OUTLET_DETECT and stub_calls[3].detail["feature"] == PKeyConstants.Feature.COMMERCE_RECEIPT \
				and stub_calls[7].detail["feature"] == PKeyConstants.Feature.PACKS_TRANSPORT_APPLE and stub_calls[14].detail["feature"] == PKeyConstants.Feature.DEVICES_ATTEST)
		a.free()

	var fake := PKeyFakeAppleNative.new()
	var a := _apple("ios", fake)
	t.check("facade: a native object makes the plugin available", a.is_available())
	var caps := a.capabilities()
	t.check("facade: capabilities is synchronous", caps.ok and caps.detail.get("protocol") == 1)

	var d := await a.distributor()
	t.check("facade: distributor resolves through its req", d.ok and d.detail.get("signal") == "appStore" and d.detail.get("ev") == "distributor")
	var sent := fake.calls.filter(func(c): return c["op"] == "distributor")
	t.check("facade: the distributor deadline is 2 s by default", sent.size() == 1 and is_equal_approx(float(sent[0]["deadline"]), 2.0))

	var products := await a.products(PackedStringArray([FOES, "missing"]))
	t.check("facade: products carries the store's list", products.ok and (products.detail["products"] as Array).size() == 1)
	var bought := await a.purchase(FOES, TOKEN)
	t.check("facade: purchase carries the transaction and its JWS, with a string id", bought.ok and bought.detail["result"] == "success" \
			and bought.detail["transaction"]["jws"] == "h.p.s" and bought.detail["transaction"]["id"] is String)
	t.check("facade: the appAccountToken is sent as given", fake.calls.any(func(c): return c["op"] == "purchase" and c.get("appAccountToken") == TOKEN))
	t.check("facade: nothing is finished before the host asks", fake.finished.is_empty())
	var fin := await a.finish(bought.detail["transaction"]["id"])
	t.check("facade: finish sends the id it was given", fin.ok and fake.finished == ["1000000000000000042"])
	var unknown := await a.purchase("nope")
	t.check("facade: a native error is platform-error with the reply as detail", not unknown.ok and unknown.code == PKeyErrors.PLATFORM_ERROR and unknown.detail.get("error") == "product_not_loaded")

	# Unsolicited events become signals, emitted on the thread that polls.
	var seen := {"tx": [], "progress": [], "ready": [], "failed": []}
	a.transaction_updated.connect(func(jws: String, tx: Dictionary): seen["tx"].append([jws, tx.get("revoked")]))
	a.pack_progress.connect(func(id: String, bytes: int, total: int): seen["progress"].append([id, bytes, total]))
	a.pack_ready.connect(func(id: String, path: String): seen["ready"].append([id, path]))
	a.pack_failed.connect(func(id: String, err: String): seen["failed"].append([id, err]))
	fake.push_event({"ev": "transaction_updated", "id": "7", "jws": "r.e.v", "revoked": true})
	fake.push_event({"ev": "pack_failed", "id": "bosses-c3", "err": "BAManagedErrorDomain 0: No asset pack"})
	t.check("facade: poll drains the queued events", a.poll() == 2)
	t.check("facade: transaction_updated carries the JWS and the transaction", seen["tx"] == [["r.e.v", true]])
	t.check("facade: pack_failed carries the error string", seen["failed"] == [["bosses-c3", "BAManagedErrorDomain 0: No asset pack"]])
	var ensured := await a.ensure_packs([{"id": "foes-c3", "path": "foes/content.pck"}], true)
	t.check("facade: ensure_packs resolves and emits pack_progress then pack_ready", ensured.ok and seen["progress"] == [["foes-c3", 512, 1024]] \
			and seen["ready"] == [["foes-c3", "/staging/foes/content.pck"]])
	t.check("facade: ensure_packs sends latest", fake.calls.any(func(c): return c["op"] == "packs_ensure" and c.get("latest") == true))

	fake.packs_supported = false
	fake.packs_reason = "outlet"
	var sideload := await a.pack_status("foes-c3")
	t.check("facade: a build without the extension answers Unsupported (outlet)", not sideload.ok and sideload.code == &"unsupported" and sideload.detail["reason"] == "outlet" \
			and sideload.detail["feature"] == PKeyConstants.Feature.PACKS_TRANSPORT_APPLE)
	# P6-02: App Attest.
	t.check("facade: capabilities reports appAttest", a.capabilities().detail.get("appAttest") == true and a.app_attest_supported().ok)
	var att := await a.app_attest("q8Jm3rJ0b1x2Vd4n6Q9sT0uW1yZ2aB3cD4eF5gH6iJ7")
	t.check("facade: app_attest generates a key and answers the attestation", att.ok and att.detail.get("generated") == true and att.detail.get("keyId") is String \
			and fake.calls.any(func(c): return c["op"] == "app_attest_attest" and c.get("requestHash") == "q8Jm3rJ0b1x2Vd4n6Q9sT0uW1yZ2aB3cD4eF5gH6iJ7" and not c.has("keyId")))
	var again := await a.app_attest("h", att.detail.get("keyId", ""))
	t.check("facade: app_attest with a key id sends it", again.ok and again.detail.get("generated") == false \
			and fake.calls.filter(func(c): return c["op"] == "app_attest_attest").back().get("keyId") == att.detail.get("keyId"))
	var asserted := await a.app_attest_assert(att.detail.get("keyId", ""), "{}")
	t.check("facade: app_attest_assert answers the assertion", asserted.ok and asserted.detail.get("assertion") is String)
	fake.attest_keys.clear()
	var lost := await a.app_attest("h", att.detail.get("keyId", ""))
	t.check("facade: a lost key is platform-error invalid_key with its id", not lost.ok and lost.code == PKeyErrors.PLATFORM_ERROR and lost.detail.get("error") == "invalid_key" \
			and lost.detail.get("keyId") == att.detail.get("keyId"))
	fake.app_attest_supported = false
	var sim := await a.app_attest("h")
	t.check("facade: where App Attest does not run it is Unsupported (runtime)", sim.code == &"unsupported" and sim.detail.get("reason") == "runtime" \
			and a.app_attest_supported().detail.get("reason") == "runtime")
	fake.app_attest_supported = true

	fake.packs_reason = "version"
	var old := await a.ensure_packs([{"id": "foes-c3", "path": "p"}])
	t.check("facade: below iOS 26.4 Background Assets answers Unsupported (version)", old.code == &"unsupported" and old.detail["reason"] == "version")

	fake.garbage_for = "capabilities"
	var bad := a.capabilities()
	t.check("facade: a reply that is not JSON is platform-error", not bad.ok and bad.code == PKeyErrors.PLATFORM_ERROR and bad.detail.get("error") == "bad_reply")
	fake.garbage_for = ""
	fake.never = PackedStringArray(["entitlements"])
	a.timeout_s = 0.2
	var late := await a.entitlements()
	t.check("facade: a result that never arrives is timeout", not late.ok and late.code == PKeyErrors.TIMEOUT)
	# The result turns up after the caller gave up: it is dropped, not kept forever.
	fake.push_event({"ev": "entitlements", "req": int(late.detail["req"]), "ok": true, "entitlements": []})
	a.poll()
	t.check("facade: a result that arrives after its timeout is dropped", not PKeyApple._results.has(a._key(int(late.detail["req"]))) \
			and not PKeyApple._abandoned.has(a._key(int(late.detail["req"]))))
	# A result that never arrives cannot grow the set without bound (SR-4 L3): capped, and expired by age.
	PKeyApple._abandoned.clear()
	for i in PKeyApple.ABANDONED_MAX + 20:
		PKeyApple._abandon("cap-%d" % i)
	t.check("facade: the abandoned set is capped, the oldest first",
		PKeyApple._abandoned.size() == PKeyApple.ABANDONED_MAX and not PKeyApple._abandoned.has("cap-0") and PKeyApple._abandoned.has("cap-%d" % (PKeyApple.ABANDONED_MAX + 19)))
	PKeyApple._abandoned["old"] = Time.get_ticks_msec() - PKeyApple.ABANDONED_TTL_MSEC - 1000
	PKeyApple._abandon("fresh")
	t.check("facade: an abandoned request older than its ttl is forgotten", not PKeyApple._abandoned.has("old") and PKeyApple._abandoned.has("fresh"))
	PKeyApple._abandoned.clear()
	a.timeout_s = 2.0
	fake.never = PackedStringArray()
	fake.packs_supported = true
	var watch := await a.watch_pack("foes-c3")
	var unwatch := await a.unwatch_pack("foes-c3")
	t.check("facade: watch_pack and unwatch_pack answer through the event queue (no main-thread wait)", watch.ok and watch.detail.get("ev") == "packs_watch" \
			and unwatch.ok and unwatch.detail.get("ev") == "packs_unwatch")

	# The launch work: the Transaction.updates listener (when StoreKit is there) and the
	# distributor read that feeds outlet detection; once per process.
	PKeyApple.reset_launch()
	t.check("facade: no launch read before it is started", PKeyApple.launch_distributor() == null and not PKeyApple.launch_listening())
	a.free()
	var lf := PKeyFakeAppleNative.new()
	var la := _apple("ios", lf)
	await PKeyApple.start_launch_reads(la)
	t.check("launch: the Transaction.updates listener starts at launch when StoreKit is there", PKeyApple.launch_listening() \
			and lf.calls.any(func(c): return c["op"] == "listen"))
	t.check("launch: the distributor read is stored for outlet detection", PKeyApple.launch_distributor() is Dictionary \
			and PKeyApple.launch_distributor()["signal"] == "appStore")
	var calls_before := lf.calls.size()
	await PKeyApple.start_launch_reads(la)
	t.check("launch: it runs once per process", lf.calls.size() == calls_before)
	PKeyApple.reset_launch()
	var nf := PKeyFakeAppleNative.new()
	nf.store_kit = false
	var na := _apple("ios", nf)
	await PKeyApple.start_launch_reads(na)
	t.check("launch: no listener without StoreKit", not PKeyApple.launch_listening() and not nf.calls.any(func(c): return c["op"] == "listen") \
			and PKeyApple.launch_distributor() is Dictionary)
	PKeyApple.reset_launch()
	la.free()
	na.free()


func _backup(t: PKeyTestContext) -> void:
	var made: Array[PKeyApple] = []
	var fake := PKeyFakeAppleNative.new()
	var b := PKeyPlatformBackup.new(_made(made, "ios", fake))
	t.check("backup: available on iOS with the plugin", b.is_available())
	var absent := await b.read_restore("diceroll")
	t.check("backup: an absent restore item reads as null", absent.ok and absent.detail["value"] == null)
	var w := await b.write_restore("diceroll", "rk_abcdefghijklmnopqrstuv", "rs_secret")
	t.check("backup: a write succeeds and carries no value back", w.ok and w.detail == null)
	var sent: Dictionary = fake.calls.filter(func(c): return c["op"] == "bk_set")[0]
	t.check("backup: the write names the item and product, no group by default", sent["item"] == "restore" and sent["product"] == "diceroll" and not sent.has("accessGroup") \
			and not sent.has("subject"))
	var got := await b.read_restore("diceroll")
	var v: PKeyPlatformBackup.RestoreValue = got.detail["value"]
	t.check("backup: the restore item round trips", got.ok and v != null and v.restore_id == "rk_abcdefghijklmnopqrstuv" and v.secret_bytes().get_string_from_utf8() == "rs_secret")
	t.check("backup: the value never prints its secret", not str(v).contains("rs_secret") and str(v).contains("<redacted>"))
	fake.backup["restore:diceroll"] = "{\"v\":2,\"restoreId\":\"a\",\"secret\":\"b\"}"
	t.check("backup: a value of another version reads as null", (await b.read_restore("diceroll")).detail["value"] == null)
	fake.backup["restore:diceroll"] = "not json"
	t.check("backup: a corrupt value reads as null", (await b.read_restore("diceroll")).detail["value"] == null)
	t.check("backup: delete removes the restore item only", (await b.write_sync_root("diceroll", "sub1", "ring1", {"v": 1, "k": "x"})).ok \
			and (await b.delete_restore("diceroll")).ok and not fake.backup.has("restore:diceroll") and fake.backup.has("sync:diceroll:sub1:ring1"))
	var root := await b.read_sync_root("diceroll", "sub1", "ring1")
	t.check("backup: the sync root round trips as a Dictionary", root.ok and root.detail["value"] is Dictionary and int(root.detail["value"]["v"]) == 1 and root.detail["value"]["k"] == "x")
	t.check("backup: an oversized sync root is refused before the plugin", not (await b.write_sync_root("diceroll", "sub1", "ring1", {"v": 1, "x": "a".repeat(PKeyPlatformBackup.MAX_VALUE_BYTES)})).ok)
	var grouped := PKeyPlatformBackup.new(_made(made, "ios", fake), "TEAM.group.x")
	await grouped.read_restore("diceroll")
	t.check("backup: the access group is sent when set", fake.calls[-1].get("accessGroup") == "TEAM.group.x")
	fake.backup_status = -34018
	var gone := await b.read_restore("diceroll")
	t.check("backup: no entitlement is Unsupported, not a failure", not gone.ok and gone.code == &"unsupported" and gone.detail["feature"] == PKeyConstants.Feature.IDENTITY_RESTORE \
			and not str(gone.message).contains("rs_"))
	var mac := PKeyPlatformBackup.new(_made(made, "macos", PKeyFakeAppleNative.new()))
	t.check("backup: macOS with the dylib answers", (await mac.read_restore("diceroll")).ok)
	var linux := PKeyPlatformBackup.new(_made(made, "linux"))
	var lr := await linux.read_restore("diceroll")
	t.check("backup: Linux is Unsupported (runtime)", not lr.ok and lr.code == &"unsupported" and lr.detail["reason"] == "runtime")
	var missing := _made(made, "ios")
	missing.native_class = "PolarisKeyAppleMissingForTests"
	var nr := await PKeyPlatformBackup.new(missing).write_restore("diceroll", "rk_x", "rs_y")
	t.check("backup: iOS without the extension is Unsupported (dependency)", not nr.ok and nr.detail["reason"] == "dependency")
	for a in made:
		a.free()


func _keychain(t: PKeyTestContext) -> void:
	var made: Array[PKeyApple] = []
	var root := "user://pkey_test_keychain_%d" % Time.get_ticks_usec()
	var fake := PKeyFakeAppleNative.new()
	var apple := _apple("ios", fake)
	made.append(apple)
	var store := PKeyKeychainStore.new("diceroll", apple, root)
	t.check("keychain: an empty Keychain has no token", store.get_token() == "" and store.status() == {"backend": "keychain"})
	t.check("keychain: set and read the token", store.set_token("pkeyt_abc") and store.get_token() == "pkeyt_abc" and fake.keychain.get("diceroll/token") == "pkeyt_abc")
	t.check("keychain: the token is never written to a file", not FileAccess.file_exists(root.path_join("diceroll/token")))
	var id := store.get_device_id()
	t.check("keychain: the device id is minted once and kept in the Keychain", PKeyDeviceId.is_well_formed(id) and fake.keychain.get("diceroll/device") == id \
			and PKeyKeychainStore.new("diceroll", apple, root).get_device_id() == id)
	t.check("keychain: clear_token removes it", store.clear_token() and store.get_token() == "" and not fake.keychain.has("diceroll/token"))

	# Migration: a file store's token and device id move into an empty Keychain.
	var root2 := "user://pkey_test_keychain_m_%d" % Time.get_ticks_usec()
	var files := PKeyFileStore.new("diceroll", root2)
	files.set_token("pkeyt_legacy")
	var legacy_id := files.get_device_id()
	var fake2 := PKeyFakeAppleNative.new()
	made.append(_apple("ios", fake2))
	var migrated := PKeyKeychainStore.new("diceroll", made[-1], root2)
	t.check("keychain: a file store's token moves into the Keychain", migrated.get_token() == "pkeyt_legacy" and fake2.keychain.get("diceroll/token") == "pkeyt_legacy" \
			and not FileAccess.file_exists(root2.path_join("diceroll/token")))
	t.check("keychain: a file store's device id moves into the Keychain", migrated.get_device_id() == legacy_id and fake2.keychain.get("diceroll/device") == legacy_id)

	# A failing Keychain is surfaced, and the token is not written anywhere else.
	var fake3 := PKeyFakeAppleNative.new()
	fake3.keychain["__fail__"] = true
	made.append(_apple("ios", fake3))
	var broken := PKeyKeychainStore.new("diceroll", made[-1], "user://pkey_test_keychain_f_%d" % Time.get_ticks_usec())
	var errors := []
	broken.failed.connect(func(e: Dictionary): errors.append(e))
	t.check("keychain: a failed write is surfaced (failed signal, false)", not broken.set_token("pkeyt_x") and errors.size() == 1 and str(errors[0]["message"]).contains("-34018"))
	t.check("keychain: status reports keyring-error after a failure", broken.status().get("degraded", {}).get("reason") == "keyring-error")
	var fallback_id := broken.get_device_id()
	t.check("keychain: a device id that cannot reach the Keychain is still stable (device file)", PKeyDeviceId.is_well_formed(fallback_id) and broken.get_device_id() == fallback_id)
	var fresh := PKeyKeychainStore.new("diceroll", made[-1], "user://pkey_test_keychain_h_%d" % Time.get_ticks_usec())
	var fresh_errors := []
	fresh.failed.connect(func(e: Dictionary): fresh_errors.append(e))
	t.check("keychain: has_device_id surfaces a Keychain failure", not fresh.has_device_id() and fresh_errors.size() == 1 \
			and fresh.status().get("degraded", {}).get("reason") == "keyring-error")

	# A migration whose token-file delete fails is surfaced and retried on the next read.
	var root4 := "user://pkey_test_keychain_r_%d" % Time.get_ticks_usec()
	var legacy_files := PKeyFileStore.new("diceroll", root4)
	legacy_files.set_token("pkeyt_orphan")
	var fake4 := PKeyFakeAppleNative.new()
	made.append(_apple("ios", fake4))
	var stuck := PKeyKeychainStore.new("diceroll", made[-1], root4)
	var stuck_files := _StuckFiles.new("diceroll", root4)
	stuck.files = stuck_files
	var stuck_errors := []
	stuck.failed.connect(func(e: Dictionary): stuck_errors.append(e))
	var token_path := root4.path_join("diceroll/token")
	t.check("keychain: a failed delete after migration is surfaced and the file is still there", stuck.get_token() == "pkeyt_orphan" \
			and fake4.keychain.get("diceroll/token") == "pkeyt_orphan" and FileAccess.file_exists(token_path) \
			and stuck_errors.any(func(e): return str(e.get("message", "")).contains("retried on the next read")))
	t.check("keychain: the next read retries the delete and removes the plaintext token", stuck.get_token() == "pkeyt_orphan" and not FileAccess.file_exists(token_path))
	t.check("keychain: off iOS the preferred store is not the Keychain store", PKeyHeaders.platform() == "ios" or not (PKeyKeychainStore.preferred("diceroll", root) is PKeyKeychainStore))
	for a in made:
		a.free()


## Sign in with Apple (I-48.4b): the facade's apple_* calls and the provider over the fake plugin.
func _sign_in_with_apple(t: PKeyTestContext) -> void:
	var none := _apple("windows")
	var r: PKeyResult = await none.apple_sign_in("n")
	t.check("siwa: off iOS and macOS the facade is Unsupported (runtime)", not r.ok and r.code == &"unsupported" and r.detail.get("reason") == "runtime")
	var mac := _apple("macos")
	mac.native_class = "PolarisKeyAppleMissingForTests"
	r = await mac.apple_sign_in("n")
	t.check("siwa: macOS without the dylib is Unsupported (dependency), not runtime", r.code == &"unsupported" and r.detail.get("reason") == "dependency")

	var fake := PKeyFakeAppleNative.new()
	var a := _apple("ios", fake)
	var provider := PKeyAppleProvider.new(a)
	t.check("siwa: kind apple, no silent mode, a sheet", provider.kind == "apple" and not provider.has_silent() and provider.has_sheet())
	var silent: Dictionary = await provider.silent("n", "")
	t.check("siwa: silent is unavailable and never reaches the plugin", silent.has("unavailable") and fake.calls.filter(func(c): return str(c["op"]).begins_with("apple_")).is_empty())

	var got: Dictionary = await provider.sheet("bm9uY2U", "")
	var sent := fake.calls.filter(func(c): return c["op"] == "apple_sign_in")
	t.check("siwa: the sheet answers the token and the user id", got.get("token") == "eyJ.apple.token" and got.get("user_id") == "001234.abcd", str(got.keys()))
	t.check("siwa: the sheet sends the server nonce as it is, immediate", sent.size() == 1 and sent[0]["nonce"] == "bm9uY2U" and sent[0]["immediate"] == true)
	await provider.provider_row("n2", "")
	sent = fake.calls.filter(func(c): return c["op"] == "apple_sign_in")
	t.check("siwa: the form's row is the plain account sheet (immediate false)", sent.size() == 2 and sent[1]["immediate"] == false)

	fake.apple_result = {"ok": false, "error": "cancelled"}
	got = await provider.sheet("n", "")
	t.check("siwa: a dismissed sheet is cancelled", got.get("cancelled") == true and not got.has("token"))
	fake.apple_result = {"ok": false, "error": "unavailable"}
	got = await provider.sheet("n", "")
	t.check("siwa: a system failure is unavailable", got.has("unavailable") and not got.has("token"))
	fake.apple_result = {"ok": true, "userID": "u"}
	got = await provider.sheet("n", "")
	t.check("siwa: an answer without a token is unavailable", got.has("unavailable"))
	fake.apple_supported = false
	got = await provider.sheet("n", "")
	t.check("siwa: an unsupported plugin is unavailable", got.has("unavailable"))
	fake.apple_supported = true

	t.check("siwa: nothing is revoked before a user id is kept", not await provider.credential_revoked())
	await provider.session_started({"user_id": "001234.abcd"})
	t.check("siwa: session_started keeps the user id", fake.apple_user_id == "001234.abcd")
	await provider.session_started({})
	t.check("siwa: session_started without an id changes nothing", fake.apple_user_id == "001234.abcd")
	t.check("siwa: an authorized credential is not revoked", not await provider.credential_revoked())
	fake.apple_state = "notFound"
	t.check("siwa: not found is not revoked", not await provider.credential_revoked())
	fake.apple_state = "transferred"
	t.check("siwa: transferred is not revoked", not await provider.credential_revoked())
	fake.apple_state = "revoked"
	t.check("siwa: revoked is revoked", await provider.credential_revoked())
	provider.sign_out_cleanup()
	t.check("siwa: sign-out forgets the user id", fake.apple_user_id == "")
	fake.apple_supported = false
	t.check("siwa: an unsupported plugin is never revoked", not await provider.credential_revoked())
	a.free()
	none.free()
	mac.free()


## Game Center (I-48.6b): the opt-in extension's facade and the provider over the fake plugin.
func _game_center(t: PKeyTestContext) -> void:
	var off := _apple("windows")
	var r: PKeyResult = await off.gc_identity()
	t.check("gc: off iOS and macOS the facade is Unsupported (runtime)", r.code == &"unsupported" and r.detail.get("reason") == "runtime")
	var missing := _apple("ios")
	missing.native_class = "PolarisKeyGameCenterMissingForTests"
	r = await missing.gc_identity()
	t.check("gc: without the extension it is Unsupported (dependency) and names the build switch", r.code == &"unsupported" and r.detail.get("reason") == "dependency")
	missing.native_class = PKeyApple.GAME_CENTER_CLASS
	r = await missing.gc_identity()
	t.check("gc: the missing-extension message names EXTENSION=gamecenter", String(r.message).contains("EXTENSION=gamecenter") and String(r.message).contains("pkey_gamecenter"), r.message)
	var mac := _apple("macos")
	mac.native_class = PKeyApple.GAME_CENTER_CLASS
	r = await mac.gc_identity()
	t.check("gc: macOS without the dylib is dependency, not runtime", r.detail.get("reason") == "dependency" and String(r.message).contains("libpkey_gamecenter.dylib"), r.message)

	var fake := PKeyFakeAppleNative.new()
	var a := _apple("ios", fake)
	a.native_class = PKeyApple.GAME_CENTER_CLASS
	var p := PKeyGameCenterProvider.new(a)
	t.check("gc: kind gamecenter, silent only", p.kind == "gamecenter" and p.has_silent() and not p.has_sheet())
	var got: Dictionary = await p.silent("bm9uY2U", "")
	t.check("gc: silent answers the gc1. token built from the raw fields", got.get("token") == PKeyGameCenterToken.encode(fake.gc_result) and str(got.get("token")).begins_with("gc1."))
	var asked := fake.calls.filter(func(c): return c["op"] == "gc_identity")
	t.check("gc: the request is just gc_identity (no nonce, nothing to present)", asked.size() == 1 and asked[0].keys() == ["op"])
	t.check("gc: the sheet is unavailable and asks nobody", (await p.sheet("n", "")).has("unavailable") and fake.calls.filter(func(c): return c["op"] == "gc_identity").size() == 1)
	for error in ["not_authenticated", "ids_not_persistent", "unsupported", "verification_failed", "malformed"]:
		fake.gc_result = {"ok": false, "error": error}
		got = await p.silent("n", "")
		t.check("gc: %s is unavailable with no token" % error, got.has("unavailable") and not got.has("token") and str(got["unavailable"]).contains(error))
	fake.gc_result = {"ok": true, "publicKeyUrl": "u", "signature": "AQID=", "salt": "UEtleQECAwQ", "timestamp": "1", "teamPlayerId": "t", "bundleId": "b"}
	t.check("gc: malformed fields are unavailable", (await p.silent("n", "")).has("unavailable"))
	t.check("gc: no revocation check, no sign-out state", not await p.credential_revoked())
	a.free()
	off.free()
	missing.free()
	mac.free()


func _export_entitlements(t: PKeyTestContext) -> void:
	var ex := PKeyAppleExport
	var frag := ex.entitlement_fragments(true)
	var key := "<key>com.apple.developer.applesignin</key>"
	t.check("export: sign-in off adds no entitlement", ex.entitlement_fragments(false).is_empty())
	t.check("export: sign-in on adds applesignin", frag.size() == 1 and frag[0].contains(key) and frag[0].contains("<string>Default</string>"))
	var merged := ex.merge_entitlements("", frag)
	t.check("export: the entitlement is appended to an empty preset text", merged == frag[0] + "\n", merged)
	var own := "<key>aps-environment</key><string>production</string>"
	merged = ex.merge_entitlements(own, frag)
	t.check("export: the preset's own text is kept first, the entitlement follows", merged.begins_with(own) and merged.count("applesignin") == 1, merged)
	t.check("export: merging twice adds nothing", ex.merge_entitlements(merged, frag) == merged)
	t.check("export: the preset's own applesignin is not doubled", ex.merge_entitlements(key + "<array/>", frag) == key + "<array/>")
	var both := ex.entitlement_fragments(true, true)
	t.check("export: game center adds its entitlement as <true/>", both.size() == 2 and both[1] == "<key>com.apple.developer.game-center</key>\n<true/>")
	t.check("export: game center alone adds just that one", ex.entitlement_fragments(false, true).size() == 1)
	var present := func(_p: String): return true
	var absent := func(_p: String): return false
	t.check("export: the extension is installed where its .gdextension is", ex.extension_installed("ios", present) and not ex.extension_installed("ios", absent))
	t.check("export: …and only on iOS and macOS", ex.extension_installed("macos", present) and not ex.extension_installed("linux", present))
	t.check("export: option and extension agree is quiet", ex.game_center_warning(true, true) == "" and ex.game_center_warning(false, false) == "")
	t.check("export: option on without the extension warns", ex.game_center_warning(true, false).contains("EXTENSION=gamecenter"))
	t.check("export: the extension without the option warns that GameKit is linked", ex.game_center_warning(false, true).contains("GameKit is linked"))
	t.check("export: macOS warns, iOS and off do not", ex.sign_in_warning(true, "macos") != "" and ex.sign_in_warning(true, "ios") == "" and ex.sign_in_warning(false, "macos") == "")


func _export(t: PKeyTestContext) -> void:
	var E := PKeyAppleExport
	t.check("export: auto is on for app-store and testflight", E.enabled("auto", "app-store") and E.enabled("auto", "testflight"))
	t.check("export: auto is off for the sideload outlets", not E.enabled("auto", "altstore") and not E.enabled("auto", "altstore-pal") and not E.enabled("auto", "direct"))
	t.check("export: on and off override the outlet", E.enabled("on", "altstore") and not E.enabled("off", "app-store") and E.enabled("ON", "altstore"))
	t.check("export: the mark names the App Group from the bundle id", E.plist_content(true, \
			"gg.vlad.diceroll") == "<key>PKeyAppleBackgroundAssets</key>\n<true/>\n<key>PKeyAppleAppGroup</key>\n<string>group.gg.vlad.diceroll</string>\n")
	t.check("export: a sideload mark is false with no group", E.plist_content(false, "gg.vlad.diceroll") == "<key>PKeyAppleBackgroundAssets</key>\n<false/>\n")
	t.check("export: on for a sideload outlet warns", E.mode_warning("on", "altstore") != "" and E.mode_warning("auto", "altstore") == "" and E.mode_warning("sometimes", "app-store") != "")
	t.check("export: a preset below iOS 18.0 warns", E.min_ios_warning("17.0") != "" and E.min_ios_warning("18.0") == "" and E.min_ios_warning("26.4") == "" and E.min_ios_warning("") == "")


## A file store whose first clear_token() fails (a locked or read-only file).
class _StuckFiles extends PKeyFileStore:
	var failures := 1

	func clear_token() -> bool:
		if failures > 0:
			failures -= 1
			_fail("remove", path_of(TOKEN_FILE), ERR_FILE_CANT_WRITE, "stuck (test)")
			return false
		return super.clear_token()
