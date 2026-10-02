extends RefCounted
# @pkey-feature outlet.detect
# PKeyOutletSignals over faked installs (PKeyFakeOutletEnv), for every outlet a Godot build can
# see, through PKeyOutlet.detect_outlet: Linux (Flatpak, snap, AppImage), Steam (library manifest
# and environment), itch (receipt; ITCHIO_APP diagnostic), macOS (receipt, ProductionSandbox, the
# Mach-O leaf, the product's Caskroom link), Windows (path conventions; the package hook), Android
# (getInstallSourceInfo: Play declared, Obtainium, F-Droid, a browser download, the shell's
# forged installer), iOS (the AppDistributor hook, unavailable by default) and web (display
# mode, the synthesised stamp). The mapping itself runs row for row in the conformance suite.

const IDS := {
	"steamAppId": "3166810", "itchGameId": "1001", "flatpakId": "gg.vlad.Diceroll", "snapName": "diceroll",
	"caskToken": "diceroll", "homebrewFormula": "diceroll", "msixFamilyName": "Diceroll_abc123", "bundleId": "gg.vlad.diceroll",
}
const MAC_EXE := "/Applications/Diceroll.app/Contents/MacOS/Diceroll"
const RECEIPT := "/Applications/Diceroll.app/Contents/_MASReceipt/receipt"


func run(t: PKeyTestContext) -> void:
	_linux(t)
	_steam_itch(t)
	_macos(t)
	_windows(t)
	_android(t)
	_ios_web(t)
	_stamps(t)


static func _env(platform: String) -> PKeyFakeOutletEnv:
	var e := PKeyFakeOutletEnv.new()
	e.platform_name = platform
	return e


static func _stamp(kind := "direct", subkind: Variant = null) -> Dictionary:
	return {"outletKind": kind, "subkind": subkind, "outletIds": IDS.duplicate()}


static func _detect(e: PKeyOutletEnv, stamp: Variant = _stamp()) -> Dictionary:
	var ids: Dictionary = stamp["outletIds"] if stamp is Dictionary else {}
	return PKeyOutlet.detect_outlet(stamp, PKeyOutletSignals.read_outlet_signals(e, ids))


static func _same(a: Variant, b: Variant) -> bool:
	return JSON.stringify(a, "", true) == JSON.stringify(b, "", true)


func _linux(t: PKeyTestContext) -> void:
	var e := _env("linux")
	e.exe = "/app/bin/diceroll"
	e.files["/.flatpak-info"] = "[Application]\nname=gg.vlad.Diceroll\nruntime=runtime/x\n[Instance]\nbranch=master\n"
	t.check("outlet: /.flatpak-info's name with this id names flathub (attested)", _same(PKeyOutletSignals.read_outlet_signals(e, IDS), {"linux.flatpakInfo": "gg.vlad.Diceroll"}) \
			and _same(_detect(e), {"kind": "flathub", "confidence": "attested", "source": "linux.flatpakInfo", "subkind": null}))
	t.check("outlet: the same file keeps a direct + flatpak stamp", _same(_detect(e, _stamp("direct", "flatpak")), {"kind": "direct", "confidence": "attested", "source": "linux.flatpakInfo", "subkind": "flatpak"}))
	e = _env("linux")
	e.env_vars = {"FLATPAK_ID": "gg.vlad.Diceroll"}
	t.check("outlet: FLATPAK_ID alone (inherited) is not evidence", PKeyOutletSignals.read_outlet_signals(e, IDS).is_empty())
	e.env_vars = {"SNAP_NAME": "diceroll", "SNAP_REVISION": "42"}
	t.check("outlet: SNAP_NAME restricts to snap (declared)", _same(_detect(e), {"kind": "snap", "confidence": "declared", "source": "linux.snapEnv", "subkind": null}))
	e.env_vars = {"SNAP_NAME": "diceroll", "SNAP_REVISION": "x1"}
	t.check("outlet: a local snap revision vetoes a snap stamp", _detect(e, _stamp("snap"))["kind"] == "unknown")
	e = _env("linux")
	e.exe = "/tmp/.mount_DicerX1/usr/bin/diceroll"
	e.env_vars = {"APPIMAGE": "/home/a/Diceroll.AppImage", "APPDIR": "/tmp/.mount_DicerX1"}
	t.check("outlet: APPDIR around the executable restricts to direct + appimage", _same(_detect(e), {"kind": "direct", "confidence": "declared", "source": "linux.appImageEnv", "subkind": "appimage"}))
	t.check("outlet: AppImage never widens a steam stamp", _detect(e, _stamp("steam"))["kind"] == "steam")


func _steam_itch(t: PKeyTestContext) -> void:
	var lib := "/home/a/.steam/steam"
	var acf := "\"AppState\"\n{\n\t\"appid\"\t\t\"3166810\"\n\t\"installdir\"\t\t\"Diceroll\"\n\t\"buildid\"\t\t\"22883144\"\n}\n"
	var e := _env("linux")
	e.exe = lib + "/steamapps/common/Diceroll/diceroll.x86_64"
	e.files[lib + "/steamapps/appmanifest_3166810.acf"] = acf
	t.check("outlet: the product's appmanifest naming this install moves direct to steam (declared)", _same(PKeyOutletSignals.read_outlet_signals(e, IDS), {"steam.libraryManifest": "3166810"}) \
			and _detect(e)["confidence"] == "declared" and _detect(e)["kind"] == "steam")
	e.files[lib + "/steamapps/appmanifest_3166810.acf"] = acf.replace("\"Diceroll\"", "\"Other\"")
	t.check("outlet: a manifest for another install dir does not count", PKeyOutletSignals.read_outlet_signals(e, IDS).is_empty())
	t.check("outlet: no steamAppId in the stamp: no manifest is read", PKeyOutletSignals.read_outlet_signals(e, {}).is_empty())
	e = _env("macos")
	e.env_vars = {"SteamAppId": "3166810", "SteamClientLaunch": "1"}
	t.check("outlet: SteamAppId with this app id restricts to steam (heuristic)", _same(PKeyOutletSignals.read_outlet_signals(e, IDS), {"steam.appIdEnv": {"appId": "3166810", "clientLaunch": true}}) \
			and _detect(e)["kind"] == "steam" and _detect(e)["confidence"] == "heuristic")
	e.env_vars = {"SteamAppId": "480"}
	t.check("outlet: another app id leaves the stamp", _detect(e)["kind"] == "direct")
	t.check("outlet: no stamp: a heuristic never selects", _detect(e, null)["kind"] == "unknown")
	e = _env("windows")
	e.exe = "C:/Users/a/AppData/Roaming/itch/apps/diceroll/bin/diceroll.exe"
	e.files["C:/Users/a/AppData/Roaming/itch/apps/diceroll/.itch/receipt.json.gz"] = JSON.stringify({"game": {"id": 1001}, "upload": {"id": 2002}}).to_utf8_buffer().compress(FileAccess.COMPRESSION_GZIP)
	e.env_vars = {"ITCHIO_APP": "1"}
	t.check("outlet: the nearest itch receipt's game.id (a float) is compared as a decimal string", _same(PKeyOutletSignals.read_outlet_signals(e, IDS), {"itch.receipt": "1001", "itch.appEnv": true}) \
			and _same(_detect(e), {"kind": "itch", "confidence": "declared", "source": "itch.receipt", "subkind": null}))
	e = _env("linux")
	e.env_vars = {"ITCHIO_APP": "1"}
	t.check("outlet: ITCHIO_APP alone is diagnostic", _detect(e)["kind"] == "direct")


func _macos(t: PKeyTestContext) -> void:
	var e := _env("macos")
	e.exe = MAC_EXE
	e.files[MAC_EXE] = "....Apple Mac OS Application Signing....".to_utf8_buffer()
	e.files[RECEIPT] = "receipt"
	t.check("outlet: the App Store receipt and leaf name app-store", _same(PKeyOutletSignals.read_outlet_signals(e, IDS), {"macos.masReceipt": true, "macos.receiptSandbox": false, "macos.signingLeaf": "Apple Mac OS Application Signing"}) \
			and _same(_detect(e), {"kind": "app-store", "confidence": "attested", "source": "macos.masReceipt", "subkind": null}))
	e.files[RECEIPT] = "..ProductionSandbox.."
	e.files[MAC_EXE] = "....TestFlight Beta Distribution....".to_utf8_buffer()
	t.check("outlet: ProductionSandbox and the TestFlight leaf name testflight", _detect(e, null)["kind"] == "testflight")
	e = _env("macos")
	e.exe = MAC_EXE
	e.files[MAC_EXE] = "....Developer ID Application: X (T)....".to_utf8_buffer()
	t.check("outlet: a Developer ID leaf vetoes an app-store stamp and leaves a steam one", _detect(e, _stamp("app-store"))["kind"] == "unknown" and _detect(e, _stamp("steam"))["kind"] == "steam")
	e.files[MAC_EXE] = "an ad hoc binary".to_utf8_buffer()
	t.check("outlet: no known leaf is `none`, a veto of testflight", PKeyOutletSignals.read_outlet_signals(e, IDS).get("macos.signingLeaf") == "none" and _detect(e, _stamp("testflight"))["kind"] == "unknown")
	e.links["/opt/homebrew/Caskroom/diceroll/1.4.0/Diceroll.app"] = "/Applications/Diceroll.app"
	t.check("outlet: the product's Caskroom link restricts to direct + homebrew", _same(_detect(e), {"kind": "direct", "confidence": "heuristic", "source": "macos.homebrewCask", "subkind": "homebrew"}))
	var other := IDS.duplicate()
	other["caskToken"] = "other"
	t.check("outlet: another token's Caskroom is never read", not PKeyOutletSignals.read_outlet_signals(e, other).has("macos.homebrewCask"))


func _windows(t: PKeyTestContext) -> void:
	for row in [["C:/Users/a/AppData/Local/Microsoft/WinGet/Packages/D/d.exe", "winget", "winget", null], ["C:\\Users\\a\\scoop\\apps\\diceroll\\current\\d.exe", "scoop", "direct", "scoop"], ["C:/ProgramData/chocolatey/lib/diceroll/tools/d.exe", "chocolatey", "direct", "chocolatey"]]:
		var e := _env("windows")
		e.exe = row[0]
		var got := _detect(e)
		t.check("outlet: %s is the %s path convention" % [row[0], row[1]], _same(PKeyOutletSignals.read_outlet_signals(e, IDS), {"windows.pathConvention": row[1]}) and got["kind"] == row[2] and got["subkind"] == row[3], str(got))
	var w := _env("windows")
	w.exe = "C:/Program Files/WindowsApps/Diceroll/d.exe"
	t.check("outlet: the package hook is unavailable by default (no evidence)", PKeyOutletSignals.read_outlet_signals(w, IDS).is_empty() and PKeyOutletEnv.new().windows_package() == null)
	w.windows = {"packageIdentity": "Diceroll_abc123", "signatureKind": "Store", "appInstallerUri": null, "externalLocation": null}
	t.check("outlet: a plugin's Store signature with this family name names ms-store", _detect(w)["kind"] == "ms-store")


func _android(t: PKeyTestContext) -> void:
	var cases := [
		["Play, no recorded digest: declared", "com.android.vending", "com.android.vending", "play", "declared"],
		["Obtainium", "dev.imranr.obtainium", "dev.imranr.obtainium", "obtainium", "declared"],
		["the F-Droid client", "org.fdroid.fdroid", "org.fdroid.fdroid", "fdroid-repo", "declared"],
		["a browser download confirms direct", "com.google.android.packageinstaller", "com.google.android.packageinstaller", "direct", "declared"],
		["the shell claiming Play leaves direct", "com.android.vending", "com.android.shell", "direct", "stamp"],
	]
	for c in cases:
		var e := _env("android")
		e.android = {"installer": c[1], "initiator": c[2], "initiatorCertSha256": "09343a27"}
		var sig := PKeyOutletSignals.read_outlet_signals(e, IDS)
		var got := _detect(e)
		t.check("outlet: Android %s" % c[0], sig.get("android.installerMismatch") == (c[1] != c[2]) and got["kind"] == c[3] and got["confidence"] == c[4], str(got))
	var forged := _env("android")
	forged.android = {"installer": "com.android.vending", "initiator": "com.android.shell", "initiatorCertSha256": null}
	t.check("outlet: the shell's forged installer vetoes a play stamp", _detect(forged, _stamp("play"))["kind"] == "unknown")
	t.check("outlet: off Android the install-source reader answers null", _env("linux").android == null and (OS.has_feature("android") or PKeyOutletEnv.new().android_install_source() == null))


func _ios_web(t: PKeyTestContext) -> void:
	var e := _env("ios")
	t.check("outlet: the AppDistributor hook is unavailable until P5-05 (no evidence)", PKeyOutletSignals.read_outlet_signals(e, IDS).is_empty() and PKeyOutletEnv.new().ios_app_distributor() == null)
	e.app_distributor = "appStore"
	t.check("outlet: a plugin's appStore answer overrides a direct stamp", _detect(e)["kind"] == "app-store")
	e.app_distributor = "timeout"
	t.check("outlet: a timeout is no evidence", _detect(e, _stamp("app-store"))["confidence"] == "stamp")
	var w := _env("web")
	w.display = "standalone"
	t.check("outlet: the web stamp plus display mode is web (heuristic)", _same(_detect(w, PKeyOutlet.WEB_STAMP), {"kind": "web", "confidence": "heuristic", "source": "web.displayMode", "subkind": null}))


func _stamps(t: PKeyTestContext) -> void:
	t.check("stamp: detection_stamp reads outletKind, else outlet", _same(PKeyOutlet.detection_stamp({"outlet": "itch-beta", "outletKind": "itch", "outletIds": {"itchGameId": "1001", "x": 5}}), {"outletKind": "itch", "subkind": null, "outletIds": {"itchGameId": "1001"}}) \
			and PKeyOutlet.detection_stamp({"outlet": "steam"})["outletKind"] == "steam")
	t.check("stamp: a kind outside the 17 is no stamp", PKeyOutlet.detection_stamp({"outlet": "itch-beta", "outletKind": ""}) == null and PKeyOutlet.detection_stamp({"outlet": "epic"}) == null and PKeyOutlet.detection_stamp(null) == null)
	t.check("stamp: a valid subkind is kept", PKeyOutlet.detection_stamp({"outlet": "direct", "outletSubkind": "homebrew"})["subkind"] == "homebrew" and PKeyOutlet.detection_stamp({"outlet": "direct", "outletSubkind": "brew"})["subkind"] == null)
	var tags := _env("linux")
	tags.features = PackedStringArray(["pkey_outlet_app_store"])
	t.check("stamp: a pkey_outlet_<kind> feature tag stands in for a missing stamp", _same(PKeyOutletSignals.feature_tag_stamp(tags), {"outlet": "app-store", "outletKind": "app-store"}) and PKeyOutletSignals.feature_tag_stamp(_env("linux")) == null)
	t.check("stamp: malformed signal values are no evidence", PKeyOutlet.detect_outlet(_stamp(), {"linux.snapEnv": "diceroll", "android.installSource": null, "steam.appIdEnv": [3166810.0], "ios.appDistributor": 7})["kind"] == "direct")
