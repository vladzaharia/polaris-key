extends RefCounted
# @pkey-feature update.driver outlet.detect core.store packs.transport.play devices.attest
# The Android platform plugin's GDScript side (P5-06), headless on every OS:
#
#   stubs     PKeyAndroid without the plugin: every call answers Unsupported, reason `runtime` off
#             Android and `dependency` on Android without the PolarisKeyAndroid singleton; no call
#             reaches a native object; poll() is a no-op
#   outlet    In-App Updates on a direct build or an install Play did not make, Play Asset Delivery
#             on a direct build, and the PackageInstaller self-update on a play build: reason outlet
#   facade    PKeyAndroid over PKeyFakeAndroidNative (the Commands shapes): a request is answered by
#             the result event carrying its `req`, delivered by a later poll; unsolicited events
#             become update_progress / update_result / pack_progress / install_status / resumed
#             (numbers back to int); error, bad-reply and timeout mapping; the launch reads
#   keystore  PKeyKeystoreStore over the fake Keystore: round trips, the migration from the file
#             store, a failing Keystore surfaced (no silent downgrade), a lost key surfaced, and the
#             file store everywhere off Android
#   export    PKeyAndroidExport: the AARs, Play Core and the two direct-only manifest entries per
#             flavour, and the warnings
#   play      PKeyPlayAdapter's In-App Updates path (notes/S-10 §Results 1) and its listing fallback
#   direct    the Android direct path: PKeyApkUpdate over a loopback server (download into private
#             storage, the record's size and SHA-256, then apk_install), the apk bridge, and
#             PKeyDirectAdapter routing `native` to install_apk with the link only on unsupported


const E := preload("res://addons/polaris_key/native/android_export.gd")


class ApkHost:
	extends RefCounted
	var opened: Array[String] = []
	var installs := 0
	var answer: PKeyApplyResult = null
	var available := true

	func open_url(url: String) -> bool:
		opened.append(url)
		return true

	func context(_decision: Dictionary) -> Dictionary:
		return {"platform": "android", "page_url": "", "release_url": "https://example.com/releases", "build_url": "https://dl.example.com/builds/b1", "native_bridge": "apk", "native_available": available}

	func install_apk(_check: PKeyUpdateCheck) -> PKeyApplyResult:
		installs += 1
		return answer


class FakeHost:
	extends RefCounted
	var opened: Array[String] = []

	func open_url(url: String) -> bool:
		opened.append(url)
		return true

	func context(_decision: Dictionary) -> Dictionary:
		return {"platform": "android", "page_url": "https://example.com/diceroll", "release_url": "", "build_url": ""}


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _stubs(t)
	await _outlet(t)
	await _facade(t)
	_launch(t)
	_keystore(t)
	_export(t)
	await _play(t)
	await _direct(t)
	return true


static func _android(p_platform: String, p_native: Object = null) -> PKeyAndroid:
	var a := PKeyAndroid.new()
	a.platform = p_platform
	a.native = p_native
	a.timeout_s = 2.0
	return a


static func _fake(flavor := "play") -> PKeyFakeAndroidNative:
	var f := PKeyFakeAndroidNative.new()
	f.flavor = flavor
	return f


func _stubs(t: PKeyTestContext) -> void:
	t.check("stubs: the PolarisKeyAndroid singleton is absent here", not Engine.has_singleton(PKeyAndroid.SINGLETON) or OS.get_name() == "Android")
	var desktop := _android("linux")
	t.check("stubs: off Android the reason is runtime", desktop.unsupported_reason() == "runtime" and not desktop.is_available())
	var bare := _android("android")
	bare.singleton_name = "PolarisKeyAndroidMissingForTests"
	t.check("stubs: on Android without the plugin the reason is dependency", bare.unsupported_reason() == "dependency")
	for pair in [[desktop, "runtime"], [bare, "dependency"]]:
		var a: PKeyAndroid = pair[0]
		var why: String = pair[1]
		var results := {
			"capabilities": a.capabilities(),
			"install_source": a.install_source(),
			"keystore_get": a.keystore_get("diceroll", "token"),
			"keystore_set": a.keystore_set("diceroll", "token", "pkeyt_x"),
			"keystore_delete": a.keystore_delete("diceroll", "token"),
			"keystore_info": a.keystore_info("diceroll"),
			"update_check": await a.update_check(),
			"update_start": await a.update_start("flexible"),
			"update_complete": await a.update_complete(),
			"pack_status": await a.pack_status("foes"),
			"pack_fetch": await a.pack_fetch("foes"),
			"pack_location": a.pack_location("foes"),
			"pack_remove": await a.pack_remove("foes"),
			"pack_cancel": a.pack_cancel("foes"),
			"pack_confirm": await a.pack_confirm(),
			"apk_can_install": a.apk_can_install(),
			"apk_open_settings": await a.apk_open_settings(),
			"apk_verify": await a.apk_verify("user://u.apk", "0".repeat(64)),
			"apk_install": await a.apk_install("user://u.apk", "0".repeat(64)),
			"apk_last_install": a.apk_last_install(),
			"apk_abandon_stale": a.apk_abandon_stale(),
			"apk_constraints": await a.apk_constraints(),
		}
		var all_unsupported := true
		for k in results:
			var r: PKeyResult = results[k]
			if r.ok or r.code != &"unsupported" or r.detail.get("reason") != why:
				all_unsupported = false
				t.info("stubs: %s answered %s" % [k, r])
		t.check("stubs: every call is Unsupported (%s)" % why, all_unsupported)
		t.check("stubs: call_sync without the plugin is {unsupported, reason: %s}" % why, a.call_sync({"op": "capabilities"}) == {"ok": false, "unsupported": true, "reason": why})
		t.check("stubs: poll() is a no-op (%s)" % why, a.poll() == 0)
	var r: PKeyResult = await desktop.update_check()
	t.check("stubs: update_check names update.driver", r.detail.get("feature") == PKeyConstants.Feature.UPDATE_DRIVER)
	t.check("stubs: pack_location names packs.transport.play", desktop.pack_location("foes").detail.get("feature") == PKeyConstants.Feature.PACKS_TRANSPORT_PLAY)
	t.check("stubs: keystore_get names core.store", desktop.keystore_get("p", "a").detail.get("feature") == PKeyConstants.Feature.CORE_STORE)


func _outlet(t: PKeyTestContext) -> void:
	var sideloaded := _fake("play")
	sideloaded.installer = "com.android.shell"
	var a := _android("android", sideloaded)
	var r: PKeyResult = await a.update_check()
	t.check("outlet: In-App Updates on an install Play did not make is Unsupported (outlet)", r.code == &"unsupported" and r.detail.get("reason") == "outlet")
	t.check("outlet: …without asking Play", sideloaded.ops_called("iau_check") == 0)
	sideloaded.installer = null
	a = _android("android", sideloaded)
	t.check("outlet: …and with no installer recorded", (await a.update_start("flexible")).detail.get("reason") == "outlet")

	var direct := _fake("direct")
	direct.installer = "com.android.vending"
	a = _android("android", direct)
	t.check("outlet: In-App Updates on a direct build is Unsupported (outlet)", (await a.update_check()).detail.get("reason") == "outlet")
	t.check("outlet: Play Asset Delivery on a direct build is Unsupported (outlet)", (await a.pack_fetch("foes")).detail.get("reason") == "outlet" and a.pack_location("foes").detail.get("reason") == "outlet")
	t.check("outlet: the direct build installs", (await a.apk_verify("user://u.apk", "0".repeat(64))).ok)

	a = _android("android", _fake("play"))
	var pi: PKeyResult = await a.apk_install("user://u.apk", "0".repeat(64), 11)
	t.check("outlet: PackageInstaller on a play build is Unsupported (outlet)", pi.code == &"unsupported" and pi.detail.get("reason") == "outlet")
	t.check("outlet: …every apk_* call", a.apk_can_install().detail.get("reason") == "outlet" and a.apk_last_install().detail.get("reason") == "outlet")
	t.check("outlet: a play build installed by Play checks", (await a.update_check()).ok)
	t.check("outlet: Play Asset Delivery works on a sideloaded play build (bundletool local testing)", _android("android", sideloaded).pack_location("foes").ok)
	# The native reply's own outlet refusal maps the same way.
	var raw := _fake("direct")
	var forced := _android("android", raw)
	var reply := forced._wrap(PKeyConstants.Feature.UPDATE_DRIVER, forced.call_sync({"op": "iau_check"}))
	t.check("outlet: a native outlet refusal becomes Unsupported (outlet)", reply.code == &"unsupported" and reply.detail.get("reason") == "outlet")

	# P6-02: Play Integrity is the play build on a Play install only.
	var side_pi: PKeyResult = await _android("android", sideloaded).integrity_token("1", "h")
	t.check("outlet: Play Integrity on an install Play did not make is Unsupported (outlet), devices.attest", side_pi.code == &"unsupported" and side_pi.detail.get("reason") == "outlet" \
			and side_pi.detail.get("feature") == PKeyConstants.Feature.DEVICES_ATTEST and sideloaded.ops_called("integrity_token") == 0)
	t.check("outlet: Play Integrity on a direct build is Unsupported (outlet)", (await _android("android", direct).integrity_token("1", "h")).detail.get("reason") == "outlet" \
			and _android("android", direct).integrity_availability().detail.get("reason") == "outlet")
	var play := _fake("play")
	var pa := _android("android", play)
	var prep: PKeyResult = await pa.integrity_prepare("123456789012")
	var tok: PKeyResult = await pa.integrity_token("123456789012", "q8Jm3rJ0b1x2Vd4n6Q9sT0uW1yZ2aB3cD4eF5gH6iJ7")
	t.check("play integrity: prepare and token resolve through their req", prep.ok and prep.detail.get("prepared") == true and tok.ok \
			and tok.detail.get("token") == "token:123456789012:q8Jm3rJ0b1x2Vd4n6Q9sT0uW1yZ2aB3cD4eF5gH6iJ7", str(tok))
	play.integrity_error = -19
	var bad_pi: PKeyResult = await pa.integrity_token("123456789012", "h")
	t.check("play integrity: a Play failure is platform-error with its errorCode", not bad_pi.ok and bad_pi.code == PKeyErrors.PLATFORM_ERROR and int(bad_pi.detail.get("errorCode", 0)) == -19)


func _facade(t: PKeyTestContext) -> void:
	var f := _fake("play")
	f.update["priority"] = 5
	var a := _android("android", f)
	var c: PKeyResult = await a.update_check()
	t.check("facade: update_check answers Play's status", c.ok and int(c.detail.get("availability")) == 2 and int(c.detail.get("priority")) == 5)
	t.check("facade: the result is matched by req", c.detail.has("req") and c.detail.get("ev") == "result")
	var st: PKeyResult = await a.update_start("flexible")
	t.check("facade: update_start answers started", st.ok and st.detail.get("started") == true)

	var progress: Array = []
	var results: Array = []
	var packs: Array = []
	var statuses: Array = []
	var resumes := [0]
	a.update_progress.connect(func(s: Dictionary) -> void: progress.append(s))
	a.update_result.connect(func(result: String, code: int) -> void: results.append([result, code]))
	a.pack_progress.connect(func(n: String, s: Dictionary) -> void: packs.append([n, s]))
	a.install_status.connect(func(s: Dictionary) -> void: statuses.append(s))
	a.resumed.connect(func() -> void: resumes[0] += 1)
	f.push_event({"ev": "update_state", "installStatus": 2.0, "errorCode": 0.0, "bytesDownloaded": 10.0, "totalBytes": 20.0})
	f.push_event({"ev": "update_result", "resultCode": 0.0, "result": "canceled"})
	f.push_event({"ev": "install_status", "status": -1.0, "name": "pending_user_action", "session": 3.0, "legacyStatus": 0.0})
	f.push_event({"ev": "resumed"})
	t.check("facade: poll drains four events", a.poll() == 4)
	t.check("facade: update_progress carries ints", progress.size() == 1 and progress[0]["installStatus"] is int and progress[0]["installStatus"] == 2 and not progress[0].has("ev"))
	t.check("facade: update_result carries the result and code", results == [["canceled", 0]])
	t.check("facade: install_status carries ints", statuses.size() == 1 and statuses[0]["status"] is int and statuses[0]["status"] == -1 and statuses[0]["session"] == 3)
	t.check("facade: resumed is emitted", resumes[0] == 1)

	t.check("facade: an unfetched pack has no location", a.pack_location("foes").ok and a.pack_location("foes").detail.get("location") == null)
	var fetch: PKeyResult = await a.pack_fetch("foes")
	t.check("facade: pack_fetch is only accepted (PENDING)", fetch.ok and int(fetch.detail["state"]["status"]) == 1)
	a.poll()
	t.check("facade: pack_progress follows to COMPLETED with ints", packs.size() == 2 and packs[1][0] == "foes" and packs[1][1]["status"] == PKeyAndroid.PACK_COMPLETED and packs[1][1]["status"] is int)
	var loc := a.pack_location("foes")
	t.check("facade: a completed pack's location is an absolute .pck path", loc.ok and str(loc.detail["location"]["pck"]) == "/data/data/gg.vlad.diceroll/files/assetpacks/foes/11/11/assets/foes.pck")
	var install_time := a.pack_location("assetPackInstallTime")
	t.check("facade: the install-time pack has no file (res://)", install_time.detail["location"]["installTime"] == true and install_time.detail["location"]["pck"] == null)
	var unknown: PKeyResult = await a.pack_status("nosuchpack")
	t.check("facade: an unknown pack is a platform-error", not unknown.ok and unknown.code == PKeyErrors.PLATFORM_ERROR and unknown.detail.get("exception") == "LocalTestingException")
	var confirm: PKeyResult = await a.pack_confirm()
	t.check("facade: the confirmation dialog off Play answers -14", not confirm.ok and int(confirm.detail.get("errorCode")) == -14)

	f.check_fails = true
	var failed: PKeyResult = await a.update_check()
	t.check("facade: a failed check is platform-error with detail.error unavailable", not failed.ok and failed.code == PKeyErrors.PLATFORM_ERROR and failed.detail.get("error") == "unavailable")
	f.garbage_for = "pad_location"
	var bad := a.pack_location("foes")
	t.check("facade: a reply that is not JSON is platform-error bad_reply", not bad.ok and bad.code == PKeyErrors.PLATFORM_ERROR and bad.detail.get("error") == "bad_reply")
	f.garbage_for = ""
	f.never = PackedStringArray(["iau_complete"])
	a.timeout_s = 0.2
	var late: PKeyResult = await a.update_complete()
	t.check("facade: a result that never arrives is a timeout", not late.ok and late.code == PKeyErrors.TIMEOUT)

	var d := _fake("direct")
	d.refuse = ["hash_mismatch"]
	var da := _android("android", d)
	var v: PKeyResult = await da.apk_verify("user://pkey/u.apk", "0".repeat(64), 11)
	t.check("facade: apk_verify carries the refusals", v.ok and v.detail["verify"]["ok"] == false and v.detail["verify"]["refused"] == ["hash_mismatch"])
	t.check("facade: apk_verify sends the versionCode only when given", d.last_call("pi_verify").get("versionCode") == 11.0)
	await da.apk_verify("user://pkey/u.apk", "0".repeat(64))
	t.check("facade: …and omits it otherwise", not d.last_call("pi_verify").has("versionCode"))
	var refused: PKeyResult = await da.apk_install("user://pkey/u.apk", "0".repeat(64), 11)
	t.check("facade: a refused install commits nothing", refused.ok and refused.detail.get("committed") == false)
	d.refuse = []
	var installed: PKeyResult = await da.apk_install("user://pkey/u.apk", "a".repeat(64), 11, {"when_backgrounded": true, "silent": false})
	t.check("facade: a verified install is committed", installed.ok and installed.detail.get("committed") == true)
	var q: Dictionary = d.last_call("pi_install")
	t.check("facade: install options reach the plugin", q.get("whenBackgrounded") == true and q.get("silent") == false and q.get("prompt") == true)

	var src := a.install_source()
	t.check("facade: install_source is raw", src.ok and src.detail.get("installer") == "com.android.vending")
	var n := f.ops_called("install_source")
	a.install_source()
	t.check("facade: install_source is read once per launch", f.ops_called("install_source") == n)
	f.push_event({"ev": "resumed"})
	a.poll()
	a.install_source()
	t.check("facade: …and again after a resume", f.ops_called("install_source") == n + 1)


func _launch(t: PKeyTestContext) -> void:
	PKeyAndroid.reset_launch()
	var d := _fake("direct")
	d.last_install = {"event": "status", "status": 0, "name": "success", "session": 7}
	d.abandoned = 2
	PKeyAndroid.start_launch_reads(_android("android", d))
	var last = PKeyAndroid.launch_install_outcome()
	t.check("launch: a direct build reads the previous install's outcome", last is Dictionary and last.get("name") == "success")
	t.check("launch: …and clears it", d.last_install == null)
	t.check("launch: stale sessions are abandoned", PKeyAndroid.launch_abandoned_sessions() == 2)
	PKeyAndroid.start_launch_reads(_android("android", _fake("direct")))
	t.check("launch: runs once per process", PKeyAndroid.launch_install_outcome() is Dictionary)
	PKeyAndroid.reset_launch()
	var p := _fake("play")
	PKeyAndroid.start_launch_reads(_android("android", p))
	t.check("launch: a play build reads nothing", PKeyAndroid.launch_install_outcome() == null and p.ops_called("pi_last") == 0)
	PKeyAndroid.reset_launch()
	PKeyAndroid.start_launch_reads(_android("linux"))
	t.check("launch: off Android nothing happens", PKeyAndroid.launch_install_outcome() == null)
	PKeyAndroid.reset_launch()


func _keystore(t: PKeyTestContext) -> void:
	var root := "user://pkey_test_keystore_%d" % Time.get_ticks_usec()
	var f := _fake("play")
	var a := _android("android", f)
	var s := PKeyKeystoreStore.new("diceroll", a, root)
	t.check("keystore: no token at first", s.get_token() == "")
	t.check("keystore: set_token stores in the Keystore", s.set_token("pkeyt_one") and f.keystore.get("diceroll/token") == "pkeyt_one")
	t.check("keystore: get_token reads it back", s.get_token() == "pkeyt_one")
	t.check("keystore: no token file is written", not FileAccess.file_exists(s.files.path_of(PKeyFileStore.TOKEN_FILE)))
	var id := s.get_device_id()
	t.check("keystore: a device id is minted and stored in the Keystore", PKeyDeviceId.is_well_formed(id) and f.keystore.get("diceroll/device") == id)
	t.check("keystore: …and kept in the device file", s.files.has_device_id())
	t.check("keystore: status is keystore, not degraded", s.status() == {"backend": "keystore"})
	t.check("keystore: clear_token removes it", s.clear_token() and not f.keystore.has("diceroll/token"))

	# Migration: a token and a device id only in the file store.
	var root2 := root + "_mig"
	var legacy := PKeyFileStore.new("diceroll", root2)
	legacy.set_token("pkeyt_legacy")
	var legacy_id := legacy.get_device_id()
	var f2 := _fake("play")
	var s2 := PKeyKeystoreStore.new("diceroll", _android("android", f2), root2)
	t.check("keystore: a file-store token migrates on first read", s2.get_token() == "pkeyt_legacy" and f2.keystore.get("diceroll/token") == "pkeyt_legacy")
	t.check("keystore: …and its file is removed", not FileAccess.file_exists(legacy.path_of(PKeyFileStore.TOKEN_FILE)))
	t.check("keystore: the file-store device id migrates", s2.get_device_id() == legacy_id and f2.keystore.get("diceroll/device") == legacy_id)

	# A failing Keystore is surfaced, never downgraded to a file.
	var f3 := _fake("play")
	f3.ks_fail = true
	var s3 := PKeyKeystoreStore.new("diceroll", _android("android", f3), root + "_fail")
	var errors: Array = []
	s3.failed.connect(func(e: Dictionary) -> void: errors.append(e))
	t.check("keystore: a failed write answers false", not s3.set_token("pkeyt_x"))
	t.check("keystore: …emits failed", errors.size() == 1 and str(errors[0].get("path")) == "keystore:pkey:diceroll/token")
	t.check("keystore: …and never writes the token to a file", not FileAccess.file_exists(s3.files.path_of(PKeyFileStore.TOKEN_FILE)))
	t.check("keystore: status is degraded keyring-error", s3.status().get("degraded", {}).get("reason") == "keyring-error")
	var id3 := s3.get_device_id()
	t.check("keystore: the device id still comes from the device file", PKeyDeviceId.is_well_formed(id3) and s3.files.has_device_id())

	# A lost key: the values are dropped, the store says so, the device id comes back from the file.
	var f4 := _fake("play")
	var s4 := PKeyKeystoreStore.new("diceroll", _android("android", f4), root + "_reset")
	s4.set_token("pkeyt_gone")
	var id4 := s4.get_device_id()
	var errors4: Array = []
	s4.failed.connect(func(e: Dictionary) -> void: errors4.append(e))
	f4.ks_reset = "key-invalidated"
	t.check("keystore: a lost key loses the token", s4.get_token() == "")
	t.check("keystore: …and is surfaced", errors4.size() == 1 and str(errors4[0].get("message")).contains("key-invalidated"))
	var s4b := PKeyKeystoreStore.new("diceroll", _android("android", f4), root + "_reset")
	t.check("keystore: the device id survives a lost key through the device file", s4b.get_device_id() == id4)

	t.check("keystore: off Android the preferred store is the file store", PKeyKeystoreStore.preferred("diceroll", root) is PKeyFileStore)
	for r in [root, root2, root + "_fail", root + "_reset"]:
		_rmrf(r)


func _export(t: PKeyTestContext) -> void:
	t.check("export: play carries both play AARs", E.libraries("play") == PackedStringArray(["polaris_key/native/android/bin/polaris-key-platform-play-release.aar", "polaris_key/native/android/bin/polaris-key-godot-play-release.aar"]))
	t.check("export: direct carries both direct AARs", E.libraries("direct") == PackedStringArray(["polaris_key/native/android/bin/polaris-key-platform-direct-release.aar", "polaris_key/native/android/bin/polaris-key-godot-direct-release.aar"]))
	t.check("export: none carries nothing", E.libraries("none").is_empty() and E.dependencies("none").is_empty() and E.manifest_elements("none") == "")
	t.check("export: play depends on Play Core", E.dependencies("play") == PackedStringArray(["com.google.android.play:app-update:2.1.0", "com.google.android.play:asset-delivery:2.3.0"]))
	t.check("export: direct depends on no Play Core", E.dependencies("direct").is_empty())
	var direct := E.manifest_elements("direct")
	t.check("export: a direct preset gets REQUEST_INSTALL_PACKAGES", direct.contains("<uses-permission android:name=\"android.permission.REQUEST_INSTALL_PACKAGES\" />"))
	t.check("export: …and UPDATE_PACKAGES_WITHOUT_USER_ACTION", direct.contains("<uses-permission android:name=\"android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION\" />"))
	t.check("export: …and exactly those two entries (no ENFORCE_UPDATE_OWNERSHIP)", direct.count("<uses-permission") == 2 and not direct.contains("ENFORCE_UPDATE_OWNERSHIP"))
	t.check("export: a play preset gets no manifest entry", E.manifest_elements("play") == "")
	t.check("export: flavours are forgiving about case and spaces", E.canonical(" Direct ") == "direct" and E.canonical("beta") == "" and E.canonical(null) == "")
	t.check("export: a missing AAR is listed", E.missing_libraries("play", "res://no_such_addons_dir").size() == 2)
	t.check("export: the plugin rides only with the Gradle build and its AARs", E.carries_plugin("play", true, PackedStringArray()) and not E.carries_plugin("play", false, PackedStringArray()) and not E.carries_plugin("play", true, PackedStringArray(["x.aar"])) and not E.carries_plugin("none", true, PackedStringArray()))
	t.check("export: a Play outlet with the direct flavour is an export error", E.error("direct", "play").contains("refused") and E.error("direct", "play-testing") != "")
	t.check("export: …and only that combination", E.error("play", "play") == "" and E.error("direct", "direct") == "" and E.error("none", "play") == "" and E.error("direct", "obtainium") == "")
	t.check("export: a refused export depends on an unresolvable coordinate that names why", E.REFUSAL_DEPENDENCY.contains("direct-flavour-on-a-play-outlet") and E.REFUSAL_DEPENDENCY.count(":") == 2)
	t.check("export: an F-Droid outlet with the play flavour warns", "\n".join(E.warnings("play", "fdroid-repo", true, PackedStringArray())).contains("Play Core"))
	t.check("export: no Gradle build warns", "\n".join(E.warnings("play", "play", false, PackedStringArray())).contains("Gradle build"))
	t.check("export: an unknown flavour warns", "\n".join(E.warnings("beta", "", true, PackedStringArray())).contains("expected one of"))
	t.check("export: a matching choice has no warning", E.warnings("play", "play", true, PackedStringArray()).is_empty() and E.warnings("direct", "direct", true, PackedStringArray()).is_empty() and E.warnings("none", "play", false, PackedStringArray()).is_empty())


func _play(t: PKeyTestContext) -> void:
	var store := {"action": "store", "release": {"version": "1.1.0", "seq": 2}, "listingUrl": "https://play.google.com/store/apps/details?id=gg.vlad.diceroll", "mandatory": false, "critical": false, "discardStaged": false}
	var urgent := store.duplicate()
	urgent["mandatory"] = true

	var f := _fake("play")
	var adapter := PKeyPlayAdapter.new()
	adapter.android = _android("android", f)
	var host := FakeHost.new()
	var r: PKeyApplyResult = await adapter.apply(store, host)
	t.check("play: an available update starts the flexible flow", r.ok and r.behaviour == PKeyApplyResult.HOOK and r.bridge == "play-in-app-updates" and r.detail.get("type") == "flexible")
	t.check("play: …and opens no link", host.opened.is_empty())
	r = await adapter.apply(urgent, host)
	t.check("play: a mandatory update starts the immediate flow", r.behaviour == PKeyApplyResult.HOOK and r.detail.get("type") == "immediate")
	f.update["immediateAllowed"] = false
	r = await adapter.apply(urgent, host)
	t.check("play: …or flexible when immediate is not allowed", r.detail.get("type") == "flexible")

	f.update = {"availability": 3, "installStatus": 11, "readyToComplete": true, "flexibleAllowed": false, "immediateAllowed": false}
	r = await adapter.apply(store, host)
	t.check("play: a downloaded update is completed", r.behaviour == PKeyApplyResult.HOOK and r.detail.get("step") == "complete" and f.ops_called("iau_complete") == 1)
	f.update = {"availability": 3, "installStatus": 2, "readyToComplete": false, "flexibleAllowed": false, "immediateAllowed": false}
	r = await adapter.apply(store, host)
	t.check("play: an update in progress shows progress", r.detail.get("step") == "progress")
	r = await adapter.apply(urgent, host)
	t.check("play: …and a mandatory one resumes the immediate flow", r.detail.get("step") == "start" and r.detail.get("type") == "immediate")
	f.update = {"availability": 1, "installStatus": 0, "flexibleAllowed": false, "immediateAllowed": false}
	r = await adapter.apply(store, host)
	t.check("play: not offered yet is silent (Play is staging)", r.ok and r.behaviour == PKeyApplyResult.SILENT and r.detail.get("reason") == "play-staging" and host.opened.is_empty())
	r = await adapter.apply(urgent, host)
	t.check("play: …but a mandatory one opens the listing", r.behaviour == PKeyApplyResult.LINK and host.opened.size() == 1 and host.opened[0] == store["listingUrl"])

	host.opened.clear()
	f.update = {"availability": 2, "installStatus": 0, "flexibleAllowed": true, "immediateAllowed": true}
	f.start_ok = false
	r = await adapter.apply(store, host)
	t.check("play: a refused flow falls back to the listing", r.behaviour == PKeyApplyResult.LINK and host.opened.size() == 1)
	host.opened.clear()
	f.check_fails = true
	r = await adapter.apply(store, host)
	t.check("play: a failed check falls back to the listing", r.behaviour == PKeyApplyResult.LINK and host.opened.size() == 1)

	host.opened.clear()
	var side := _fake("play")
	side.installer = "com.android.shell"
	adapter.android = _android("android", side)
	r = await adapter.apply(store, host)
	t.check("play: an install Play did not make opens the listing without asking Play", r.behaviour == PKeyApplyResult.LINK and side.ops_called("iau_check") == 0)
	host.opened.clear()
	adapter.android = _android("linux")
	r = await adapter.apply(store, host)
	t.check("play: off Android the listing as before", r.behaviour == PKeyApplyResult.LINK and host.opened.size() == 1)
	var testing := PKeyPlayTestingAdapter.new()
	t.check("play: the testing tracks use the same adapter", testing is PKeyPlayAdapter and testing.kind == "play-testing")


func _direct(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var server := PKeyFakeServer.new()
	tree.root.add_child(server)
	if not t.check("direct: the loopback server listens", server.listen()):
		server.queue_free()
		return
	var apk := PackedByteArray()
	apk.resize(70000)
	for i in apk.size():
		apk[i] = (i * 31) % 251
	var sha := PKeyReleaseRecord.sha256_hex(apk)
	server.handler = func(_req: Dictionary) -> Dictionary: return {"status": 200, "headers": {"Content-Type": "application/vnd.android.package-archive"}, "body": apk}
	var dir := "user://pkey_test_apk_%d" % Time.get_ticks_usec()
	var req := func(art: Variant) -> Dictionary: return {"url": server.base_url() + "/builds/b1", "headers": {}, "dir": dir, "artifact": art, "version": "1.1.0", "build": "b1", "timeout": 10.0}

	var d := _fake("direct")
	var a := _android("android", d)
	var r: PKeyApplyResult = await PKeyApkUpdate.run(a, req.call({"sha256": sha, "size": apk.size()}))
	t.check("direct: a verified APK is downloaded and committed", r.ok and r.behaviour == PKeyApplyResult.HOOK and r.bridge == "apk" and r.version == "1.1.0" and int(r.detail.get("session")) == 7)
	var q: Dictionary = d.last_call("pi_install")
	t.check("direct: apk_install gets the record's SHA-256 and a private absolute path", q.get("sha256") == sha and str(q.get("path")).is_absolute_path() and str(q.get("path")).ends_with("/update.apk") and not str(q.get("path")).begins_with("user://"))
	t.check("direct: no versionCode is invented (the record carries none)", not q.has("versionCode"))
	t.check("direct: the player already chose to update: no extra Android prompt is asked for", q.get("silent") == true and q.get("prompt") == true)
	t.check("direct: the downloaded file is removed once the session holds it", not FileAccess.file_exists(dir.path_join("update.apk")))

	var before := d.ops_called("pi_install")
	r = await PKeyApkUpdate.run(a, req.call({"sha256": "0".repeat(64), "size": apk.size()}))
	t.check("direct: bytes that miss the record's SHA-256 are refused before the plugin", not r.ok and r.code == PKeyErrors.PAYLOAD_MISMATCH and d.ops_called("pi_install") == before)
	r = await PKeyApkUpdate.run(a, req.call({"sha256": sha, "size": apk.size() + 1}))
	t.check("direct: a size that is not the record's is refused", not r.ok and d.ops_called("pi_install") == before)
	r = await PKeyApkUpdate.run(a, req.call(null))
	t.check("direct: a record without the build's payload is record-mismatch", not r.ok and r.code == PKeyErrors.RECORD_MISMATCH)
	d.refuse = ["signer_mismatch"]
	r = await PKeyApkUpdate.run(a, req.call({"sha256": sha, "size": apk.size()}))
	t.check("direct: the plugin's refusal is swap-refused with its reasons", not r.ok and r.code == PKeyErrors.SWAP_REFUSED and r.detail.get("refused") == ["signer_mismatch"])
	d.refuse = []

	# The plugin does not answer in time: outcome unknown, the copy kept for the launch cleanup.
	d.never = PackedStringArray(["pi_install"])
	a.install_timeout_s = 0.2
	r = await PKeyApkUpdate.run(a, req.call({"sha256": sha, "size": apk.size()}))
	t.check("direct: an install that does not answer in time is outcome-unknown, not a refusal", not r.ok and r.code == PKeyErrors.TIMEOUT and r.detail.get("reason") == "outcome-unknown")
	t.check("direct: …and its copy is not deleted while the worker may still stream it", FileAccess.file_exists(dir.path_join("update.apk")))
	t.check("direct: the launch cleanup removes a leftover copy", PKeyApkUpdate.cleanup(dir) and not FileAccess.file_exists(dir.path_join("update.apk")))
	t.check("direct: …and is a no-op without one", not PKeyApkUpdate.cleanup(dir))
	var sup := PKeyUpdaterTestSupport.new()
	var inst := PKeyUpdaterTestSupport.install("p506_apk_cleanup", PackedByteArray([1, 2, 3]), "android")
	var stale: String = String(inst["user"]).path_join(PKeyUpdaterTestSupport.PRODUCT).path_join("updates/apk")
	DirAccess.make_dir_recursive_absolute(stale)
	PKeyUpdaterTestSupport.write(stale.path_join("update.apk"), apk)
	PKeyUpdaterTestSupport.write(stale.path_join("update.apk.part"), PackedByteArray([9]))
	var sdk: Node = await sup.launch(inst, "1.0.0")
	t.check("direct: configuring the SDK (PKeyUpdater.attach) removes a leftover update.apk", not FileAccess.file_exists(stale.path_join("update.apk")))
	t.check("direct: …and keeps a .part for resume", FileAccess.file_exists(stale.path_join("update.apk.part")))
	sdk.queue_free()
	d.never = PackedStringArray()

	var hits := server.requests.size()
	r = await PKeyApkUpdate.run(_android("android", _fake("play")), req.call({"sha256": sha, "size": apk.size()}))
	t.check("direct: a play build answers unsupported (outlet) without downloading", not r.ok and r.code == PKeyErrors.UNSUPPORTED and r.detail.get("reason") == "outlet" and server.requests.size() == hits)
	r = await PKeyApkUpdate.run(_android("linux"), req.call({"sha256": sha, "size": apk.size()}))
	t.check("direct: off Android it answers unsupported (runtime)", r.code == PKeyErrors.UNSUPPORTED and r.detail.get("reason") == "runtime")
	server.queue_free()
	_rmrf(dir)

	var bridge := PKeyApkBridge.new()
	bridge.android = _android("android", _fake("direct"))
	t.check("direct: the apk bridge is available on a direct build", bridge.is_available() and bridge.id() == "apk")
	bridge.android = _android("android", _fake("play"))
	t.check("direct: …and not on a play build, so the decision never offers native there", not bridge.is_available())
	var u := PKeyUpdater.new()
	var env := PKeyFakeUpdaterEnv.new()
	env.os = "android"
	u.env = env
	t.check("direct: the updater's native bridge on Android is apk", u.native_bridge_name() == "apk" and u.bridge("apk") is PKeyApkBridge)

	var decision := {"action": "binary", "method": "native", "release": {"version": "1.1.0", "seq": 3, "sha256": "ab".repeat(32)}, "build": "b1", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}
	var adapter := PKeyDirectAdapter.new()
	var check := PKeyUpdateCheck.new(true)
	check.decision = decision
	var host := ApkHost.new()
	host.answer = PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": "apk", "method": "native"})
	var plan := adapter.describe(decision, host.context(decision))
	t.check("direct: the prompt offers the install on a direct build", plan["behaviour"] == PKeyApplyResult.HOOK and plan["bridge"] == "apk" and plan["action"] == "update_install")
	r = await adapter.apply(decision, host, check)
	t.check("direct: native on Android goes to install_apk, no link", r.ok and r.bridge == "apk" and host.installs == 1 and host.opened.is_empty())
	host.answer = PKeyApplyResult.failed(PKeyErrors.UNSUPPORTED, "no plugin", {"reason": "dependency"})
	r = await adapter.apply(decision, host, check)
	t.check("direct: an unsupported answer falls back to the download link", r.behaviour == PKeyApplyResult.LINK and host.opened.size() == 1 and r.detail.get("fallback_from") == "apk")
	host.opened.clear()
	host.answer = PKeyApplyResult.failed(PKeyErrors.PAYLOAD_MISMATCH, "bad bytes")
	r = await adapter.apply(decision, host, check)
	t.check("direct: any other failure is reported, never papered over with a link", not r.ok and r.code == PKeyErrors.PAYLOAD_MISMATCH and host.opened.is_empty())
	r = await adapter.apply(decision, host, null)
	t.check("direct: installing needs the check (its verified record)", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS)
	host.available = false
	host.installs = 0
	r = await adapter.apply(decision, host, check)
	t.check("direct: without the plugin the plan is the download link", r.behaviour == PKeyApplyResult.LINK and host.installs == 0)


static func _rmrf(path: String) -> void:
	var d := DirAccess.open(path)
	if d == null:
		return
	for f in d.get_files():
		d.remove(f)
	for sub in d.get_directories():
		_rmrf(path.path_join(sub))
	DirAccess.remove_absolute(path)
