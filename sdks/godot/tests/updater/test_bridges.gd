extends RefCounted
# @pkey-feature update.driver
# The native hooks (PKeySparkleBridge, PKeyVelopackBridge, PKeyWinSparkleBridge,
# PKeyAppImageBridge): with no plugin every call is the typed unsupported result (`dependency`);
# with a stand-in singleton the call reaches it with the feed URL from discovery (P3-09's
# routes); AppImage installs verify release-record bytes and relaunch $APPIMAGE. Through a real
# PKeyUpdater: `native` is offered to the decision only with a usable bridge, the platform picks
# the bridge, and `binary {native}` with no plugin opens the build's download link instead.

const S := preload("res://tests/updater/support.gd")


class Native extends RefCounted:
	var calls: Array = []
	var ok := true
	var available := true

	func is_available() -> bool:
		return available

	func check_now(feed: String) -> int:
		calls.append(["check_now", feed])
		return OK if ok else FAILED

	func install_and_relaunch(feed: String) -> int:
		calls.append(["install_and_relaunch", feed])
		return OK if ok else FAILED


func run(t: PKeyTestContext) -> void:
	var env := PKeyFakeUpdaterEnv.new()
	# Each on its own OS (P5-07's facades answer `runtime` anywhere else; tests/native covers that).
	for pair in [["macos", PKeySparkleBridge.new(env, "https://x/appcast.xml")], ["windows", PKeyVelopackBridge.new(env, "https://x/velopack/")], ["windows", PKeyWinSparkleBridge.new(env, "https://x/winsparkle.xml")]]:
		var b: PKeyNativeBridge = pair[1]
		env.os = pair[0]
		var r: PKeyApplyResult = await b.install_and_relaunch()
		var c: PKeyApplyResult = await b.check_now()
		t.check("bridges: %s with no plugin is unavailable and answers unsupported (dependency)" % b.id(), not b.is_available() and not r.ok and r.code == PKeyErrors.UNSUPPORTED and r.detail.get("reason") == "dependency" and r.detail.get("feature") == "update.driver" and not c.ok and c.detail.get("reason") == "dependency", str(r))
	env.os = "linux"

	var native := Native.new()
	env.singletons["PolarisKeySparkle"] = native
	var sparkle := PKeySparkleBridge.new(env, "https://x/appcast.xml")
	var r: PKeyApplyResult = await sparkle.install_and_relaunch()
	t.check("bridges: the Sparkle singleton gets install_and_relaunch with the appcast", sparkle.is_available() and r.ok and r.behaviour == "hook" and r.bridge == "sparkle" and native.calls == [["install_and_relaunch", "https://x/appcast.xml"]], str(native.calls))
	native.ok = false
	r = await sparkle.install_and_relaunch()
	t.check("bridges: a failing native call is a typed failure, not a crash", not r.ok and r.code == PKeyErrors.UNSUPPORTED and r.detail.get("reason") == "runtime")
	native.available = false
	t.check("bridges: a plugin that says it is unavailable is unavailable", not sparkle.is_available())

	# AppImage's generic hook cannot install, including through a custom native object.
	var ai := PKeyAppImageBridge.new(env)
	ai.native = Native.new()
	r = await ai.install_and_relaunch()
	t.check("bridges: AppImage rejects the generic hook even with a plugin", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS and ai.native.calls.is_empty() and env.executed.is_empty() and env.relaunched.is_empty())
	await _appimage(t)

	# Through a real updater: the bridge per platform, methods narrowed, feed URLs from discovery.
	var sup := S.new()
	sup.serve()
	var inst := S.install("bridges", S.bytes(64, 1), "macos", "Game")
	var sdk: Node = await sup.launch(inst, "1.4.0", func(o): o.update_outlet = "direct")
	sup.discovered(sdk, {
		"appcast": sup.server.base_url() + "/djdl/update/appcast.xml",
		"winsparkle": sup.server.base_url() + "/djdl/update/{channel}/winsparkle.xml",
		"velopack": sup.server.base_url() + "/djdl/update/{channel}/velopack/releases.{velopackChannel}.json",
	}, S.DL)
	var u: PKeyUpdater = sdk.update.updater
	var e: PKeyFakeUpdaterEnv = inst["env"]
	t.check("bridges: macOS uses Sparkle", u.native_bridge_name() == "sparkle")
	t.check("bridges: native is not offered without the plugin (download stays)", u.methods() == ["download"] or u.methods() == ["download", "sidecar-pck"], str(u.methods()))
	t.check("bridges: the Sparkle feed is this channel's appcast for this arch", u.feed_url("sparkle").begins_with(sup.server.base_url() + "/djdl/update/appcast.xml?arch="), u.feed_url("sparkle"))
	e.os = "windows"
	t.check("bridges: Windows without Velopack uses WinSparkle", u.native_bridge_name() == "winsparkle")
	t.check("bridges: the WinSparkle feed is this channel's", u.feed_url("winsparkle") == sup.server.base_url() + "/djdl/update/stable/winsparkle.xml", u.feed_url("winsparkle"))
	t.check("bridges: the Velopack feed is the channel's directory (UpdateManager adds releases.<channel>.json)", u.feed_url("velopack") == sup.server.base_url() + "/djdl/update/stable/velopack/", u.feed_url("velopack"))
	e.files[inst["exe"].get_base_dir().path_join("sq.version")] = true
	t.check("bridges: a Velopack install uses Velopack", u.native_bridge_name() == "velopack")
	e.files.clear()
	e.os = "linux"
	t.check("bridges: Linux outside an AppImage uses Velopack", u.native_bridge_name() == "velopack")
	e.vars["APPIMAGE"] = "/tmp/Game.AppImage"
	t.check("bridges: Linux in an AppImage uses AppImageUpdate", u.native_bridge_name() == "appimage")
	e.vars.erase("APPIMAGE")
	e.os = "macos"

	# binary {native} with no plugin: the adapter opens the build's download link.
	var check := S.check_of({"action": "binary", "method": "native", "release": {"version": "1.5.0", "seq": 15, "sha256": "ab".repeat(32)}, "build": "macos-dmg", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false})
	var want := S.DL + "/djdl/distribution/builds/1.5.0/macos-dmg"
	r = await sdk.update.apply(check)
	t.check("bridges: binary native with no plugin degrades to the build's download link", r.ok and r.behaviour == "link" and r.url == want and e.opened == [want], "%s %s" % [r, e.opened])
	# With a plugin whose call fails: still the link, and the hook's code is kept.
	var failing := Native.new()
	failing.ok = false
	e.singletons["PolarisKeySparkle"] = failing
	u.bridges = {}
	e.opened.clear()
	r = await sdk.update.apply(check)
	t.check("bridges: a native updater that fails falls back to the download link", r.ok and r.behaviour == "link" and e.opened == [want] and r.detail.get("fallback_from") == "sparkle" and failing.calls.size() == 1, "%s %s" % [r, r.detail])
	var working := Native.new()
	e.singletons["PolarisKeySparkle"] = working
	u.bridges = {}
	e.opened.clear()
	r = await sdk.update.apply(check)
	t.check("bridges: with the Sparkle plugin, binary native hands off (no link opened)", r.ok and r.behaviour == "hook" and working.calls.size() == 1 and e.opened.is_empty() and String(working.calls[0][1]).contains("/update/appcast.xml"), str(working.calls))
	t.check("bridges: with the plugin, native is offered to the decision", u.methods().has("native"))
	sdk.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


## Loopback downloads through the real updater/adapter, with the current image on disk.
func _appimage(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var inst := S.install("appimage", S.bytes(64, 1), "linux", "Game.AppImage")
	var image: String = ProjectSettings.globalize_path(inst["exe"])
	var old := S.read(image)
	var good := S.bytes(128, 2)
	var bad := S.bytes(128, 3)
	var sdk: Node = await sup.launch(inst, "1.4.0", func(o): o.update_outlet = "direct")
	sup.discovered(sdk)
	var u: PKeyUpdater = sdk.update.updater
	var e: PKeyFakeUpdaterEnv = inst["env"]
	e.vars["APPIMAGE"] = image
	var ai := u.bridge("appimage") as PKeyAppImageBridge
	t.check("appimage: the verified updater needs no external tool", ai.is_available() and u.methods().has("native") and e.programs.is_empty())
	var check := S.sidecar_check("1.5.0", good)
	check.decision["method"] = "native"
	check.record_doc["builds"][0]["format"] = "appimage"
	var prefix := "/djdl/distribution/builds/1.5.0/linux-pck"
	var a := PKeyOutletAdapters.for_kind("direct")
	var r: PKeyApplyResult = await a.apply(check.decision, u)
	t.check("appimage: adapter without a verified check refuses before downloading", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS and sup.requests(prefix).is_empty() and S.read(image) == old)
	r = await ai.install_verified(null, {})
	t.check("appimage: verified hook cannot run without a check", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS)
	var no_record := S.check_of(check.decision)
	r = await sdk.update.apply(no_record)
	t.check("appimage: a decision without its record cannot install", not r.ok and r.code == PKeyErrors.RECORD_MISMATCH and sup.requests(prefix).is_empty())
	var missing := S.check_of(check.decision.duplicate(true))
	missing.record_doc = check.record_doc.duplicate(true)
	missing.decision["build"] = "absent"
	r = await sdk.update.apply(missing)
	t.check("appimage: the selected build must be in the verified record", not r.ok and r.code == PKeyErrors.RECORD_MISMATCH and sup.requests(prefix).is_empty())
	missing.decision["build"] = check.decision["build"]
	missing.record_doc["version"] = "1.6.0"
	r = await sdk.update.apply(missing)
	t.check("appimage: the record must match the decision's release", not r.ok and r.code == PKeyErrors.RECORD_MISMATCH and sup.requests(prefix).is_empty())
	missing.record_doc = check.record_doc.duplicate(true)
	missing.record_doc["builds"][0]["artifacts"].append(missing.record_doc["builds"][0]["artifacts"][0].duplicate())
	r = await sdk.update.apply(missing)
	t.check("appimage: ambiguous payloads cannot install", not r.ok and r.code == PKeyErrors.RECORD_MISMATCH and sup.requests(prefix).is_empty())
	# A transport-consistent replacement with the exact expected length but a different digest.
	sup.plan[prefix] = [S.ranged(bad)]
	r = await sdk.update.apply(check)
	t.check("appimage: host-controlled bytes absent from the signed record are refused without changing the image", not r.ok and r.code == PKeyErrors.PAYLOAD_MISMATCH and S.read(image) == old and e.relaunched.is_empty() and e.opened.is_empty() and _no_staging(image))
	sup.plan[prefix] = [S.ranged(S.bytes(129, 4))]
	r = await sdk.update.apply(check)
	t.check("appimage: an oversized payload changes nothing", not r.ok and r.code == PKeyErrors.RESPONSE_TOO_LARGE and S.read(image) == old and e.relaunched.is_empty() and _no_staging(image))
	sup.plan[prefix] = [S.ranged(S.bytes(127, 4))]
	r = await sdk.update.apply(check)
	t.check("appimage: a truncated payload changes nothing", not r.ok and S.read(image) == old and e.relaunched.is_empty() and _no_staging(image))
	sup.plan[prefix] = [S.ranged(good)]
	u.rename_hook = func(fresh: String, target: String) -> int:
		t.check("appimage: commit receives verified bytes in a private sibling directory", S.read(fresh) == good and target == image and fresh.get_base_dir().get_base_dir() == image.get_base_dir() and FileAccess.get_unix_permissions(fresh.get_base_dir()) == PKeyAppImageBridge.PRIVATE_MODE and FileAccess.get_unix_permissions(fresh) == PKeyAppImageBridge.PRIVATE_MODE)
		return ERR_FILE_CANT_WRITE
	r = await sdk.update.apply(check)
	t.check("appimage: a failed atomic replacement preserves the original and does not relaunch", not r.ok and r.code == PKeyErrors.SWAP_FAILED and S.read(image) == old and e.relaunched.is_empty() and _no_staging(image))
	u.rename_hook = Callable()
	r = await sdk.update.apply(check)
	t.check("appimage: verified bytes replace and relaunch the image without invoking the zsync updater", r.ok and r.bridge == "appimage" and S.read(image) == good and e.relaunched == [image] and e.executed.is_empty() and e.opened.is_empty() and _no_staging(image), str(r))
	# The external tool can still provide an informational check, never an install.
	e.programs["appimageupdatetool"] = "/usr/bin/appimageupdatetool"
	e.exec_code = 1
	r = await ai.check_now()
	t.check("appimage: -j exit 1 is informational only", r.ok and r.detail.get("available") == true and Array(e.executed[0][1]) == ["-j", image] and e.relaunched.size() == 1)
	sdk.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _no_staging(image: String) -> bool:
	var dir := DirAccess.open(image.get_base_dir())
	for name in dir.get_directories():
		if name.begins_with(".pkey-appimage-"):
			return false
	return true
