extends RefCounted
# @pkey-feature outlet.detect core.store packs.transport.apple commerce.receipt
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
#   export    PKeyAppleExport: auto/on/off per outlet kind, the Info.plist mark, the warnings

const FOES := "gg.vlad.diceroll.pack.foes"
const TOKEN := "6F2C3B1A-0000-4000-8000-00000000C0DE"


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_stubs(t)
	await _facade(t)
	_keychain(t)
	_export(t)
	return true


static func _apple(p_platform: String, p_native: Object = null) -> PKeyApple:
	var a := PKeyApple.new()
	a.platform = p_platform
	a.native = p_native
	a.timeout_s = 2.0
	return a


func _stubs(t: PKeyTestContext) -> void:
	var desktop := _apple("macos")
	t.check("stubs: the native class is not registered here", not ClassDB.class_exists(PKeyApple.NATIVE_CLASS) or OS.get_name() == "iOS")
	t.check("stubs: off iOS the reason is runtime", desktop.unsupported_reason() == "runtime" and not desktop.is_available())
	var ios := _apple("ios")
	ios.native_class = "PolarisKeyAppleMissingForTests"
	t.check("stubs: on iOS without the GDExtension the reason is dependency", ios.unsupported_reason() == "dependency")
	for pair in [[desktop, "runtime"], [ios, "dependency"]]:
		var a: PKeyApple = pair[0]
		var why: String = pair[1]
		var results := {
			"capabilities": a.capabilities(),
			"listen": a.listen(),
			"keychain_get": a.keychain_get("diceroll", "token"),
			"keychain_set": a.keychain_set("diceroll", "token", "pkeyt_x"),
			"keychain_delete": a.keychain_delete("diceroll", "token"),
			"watch_pack": a.watch_pack("foes-c3"),
			"unwatch_pack": a.unwatch_pack("foes-c3"),
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
	# The coroutine calls without the plugin (awaited, so in this function).
	var desktop := _apple("windows")
	var stub_calls: Array[PKeyResult] = [
		await desktop.distributor(), await desktop.app_transaction(), await desktop.products(PackedStringArray([FOES])),
		await desktop.purchase(FOES, TOKEN), await desktop.entitlements(), await desktop.finish("1"),
		await desktop.pack_status("foes-c3"), await desktop.ensure_packs([{"id": "foes-c3", "path": "p"}]),
		await desktop.check_pack_updates(), await desktop.remove_pack("foes-c3"), await desktop.pack_path("p"),
	]
	t.check("stubs: every awaited call is Unsupported (runtime) with its feature", stub_calls.all(func(r: PKeyResult): return not r.ok and r.code == &"unsupported" and r.detail.get("reason") == "runtime") \
			and stub_calls[0].detail["feature"] == PKeyConstants.Feature.OUTLET_DETECT and stub_calls[3].detail["feature"] == PKeyConstants.Feature.COMMERCE_RECEIPT \
			and stub_calls[7].detail["feature"] == PKeyConstants.Feature.PACKS_TRANSPORT_APPLE)
	desktop.free()

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

	# The launch read feeds outlet detection, and is per process only.
	PKeyApple.reset_launch()
	t.check("facade: no launch read before it is started", PKeyApple.launch_distributor() == null)
	a.free()
	fake = null


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
	t.check("keychain: off iOS the preferred store is the file store", PKeyHeaders.platform() == "ios" or PKeyKeychainStore.preferred("diceroll", root) is PKeyFileStore)
	for a in made:
		a.free()


func _export(t: PKeyTestContext) -> void:
	var E := PKeyAppleExport
	t.check("export: auto is on for app-store and testflight", E.enabled("auto", "app-store") and E.enabled("auto", "testflight"))
	t.check("export: auto is off for the sideload outlets", not E.enabled("auto", "altstore") and not E.enabled("auto", "altstore-pal") and not E.enabled("auto", "direct"))
	t.check("export: on and off override the outlet", E.enabled("on", "altstore") and not E.enabled("off", "app-store") and E.enabled("ON", "altstore"))
	t.check("export: the mark names the App Group from the bundle id", E.plist_content(true, "gg.vlad.diceroll") == "<key>PKeyAppleBackgroundAssets</key>\n<true/>\n<key>PKeyAppleAppGroup</key>\n<string>group.gg.vlad.diceroll</string>\n")
	t.check("export: a sideload mark is false with no group", E.plist_content(false, "gg.vlad.diceroll") == "<key>PKeyAppleBackgroundAssets</key>\n<false/>\n")
	t.check("export: on for a sideload outlet warns", E.mode_warning("on", "altstore") != "" and E.mode_warning("auto", "altstore") == "" and E.mode_warning("sometimes", "app-store") != "")
	t.check("export: a preset below iOS 17.0 warns", E.min_ios_warning("15.0") != "" and E.min_ios_warning("17.0") == "" and E.min_ios_warning("26.4") == "" and E.min_ios_warning("") == "")
