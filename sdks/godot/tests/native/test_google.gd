extends RefCounted
# @pkey-feature identity.autosignin identity.exchange
# Google sign-in on Android (I-48.5b), headless: the PKeyAndroid gid_* calls and PKeyGoogleProvider over
# PKeyFakeAndroidNative (the Commands shapes), the export's Credential Manager pins and their gate on
# the engine version, and the drift test that holds PLAY_DEPENDENCIES to sdks/kotlin's
# gradle/libs.versions.toml.

const E := preload("res://addons/polaris_key/native/android_export.gd")
const TOML := "../kotlin/gradle/libs.versions.toml"


static func _android(p_platform: String, p_native: Object = null) -> PKeyAndroid:
	var a := PKeyAndroid.new()
	a.platform = p_platform
	a.native = p_native
	a.timeout_s = 2.0
	return a


func run(t: PKeyTestContext) -> void:
	await _facade(t)
	await _provider(t)
	_export(t)
	_drift(t)


func _facade(t: PKeyTestContext) -> void:
	var fake := PKeyFakeAndroidNative.new()
	var a := _android("android", fake)
	t.check("google: the capability is reported with the libraries", a.google_id_available() and a.google_id_unavailable_reason() == "")
	var r: PKeyResult = await a.gid_silent("bm9uY2U", "web.apps")
	var sent := fake.last_call("gid_silent")
	t.check("google: silent answers the token", r.ok and r.detail.get("token") == "eyJ.google.token")
	t.check("google: silent sends the nonce and the server client id", sent.get("nonce") == "bm9uY2U" and sent.get("serverClientId") == "web.apps")
	r = await a.gid_sheet("n", "id")
	var row: PKeyResult = await a.gid_provider("n", "id")
	t.check("google: sheet and provider use their own ops", r.ok and row.ok and fake.ops_called("gid_sheet") == 1 and fake.ops_called("gid_provider") == 1)
	fake.google_result = {"ok": false, "error": "cancelled"}
	r = await a.gid_sheet("n", "id")
	t.check("google: a dismissed sheet is platform-error cancelled", not r.ok and r.code == PKeyErrors.PLATFORM_ERROR and r.detail.get("error") == "cancelled")
	r = await a.gid_sign_out()
	t.check("google: sign-out reaches the plugin", r.ok and fake.google_signed_out == 1)
	a.free()

	var stripped := PKeyFakeAndroidNative.new()
	stripped.google_libraries = false
	a = _android("android", stripped)
	t.check("google: an export without the libraries is dependency", not a.google_id_available() and a.google_id_unavailable_reason() == "dependency")
	a.free()
	var direct := PKeyFakeAndroidNative.new()
	direct.flavor = "direct"
	a = _android("android", direct)
	t.check("google: the direct flavour is outlet", a.google_id_unavailable_reason() == "outlet")
	a.free()
	var off := _android("windows")
	var r2: PKeyResult = await off.gid_silent("n", "id")
	t.check("google: off Android the facade is Unsupported (runtime)", not off.google_id_available() and r2.code == &"unsupported" and r2.detail.get("reason") == "runtime")
	off.free()


func _provider(t: PKeyTestContext) -> void:
	var fake := PKeyFakeAndroidNative.new()
	var a := _android("android", fake)
	var p := PKeyGoogleProvider.new(a)
	t.check("google: kind google, silent and sheet both on", p.kind == "google" and p.has_silent() and p.has_sheet())
	var got: Dictionary = await p.silent("bm9uY2U", "web.apps")
	t.check("google: silent answers the token", got == {"token": "eyJ.google.token"})
	var sheet: Dictionary = await p.sheet("n", "id")
	var row: Dictionary = await p.provider_row("n", "id")
	t.check("google: sheet and the form's row answer the token", sheet.has("token") and row.has("token") and fake.ops_called("gid_provider") == 1)
	got = await p.silent("n", "")
	t.check("google: no server client id is unavailable and asks nobody", got.has("unavailable") and fake.ops_called("gid_silent") == 1)
	fake.google_result = {"ok": false, "error": "cancelled"}
	t.check("google: a dismissed sheet is cancelled", (await p.sheet("n", "id")).get("cancelled") == true)
	fake.google_result = {"ok": false, "error": "unavailable", "reason": "no-credential"}
	got = await p.silent("n", "id")
	t.check("google: no credential is unavailable with the reason", got.has("unavailable") and str(got["unavailable"]).contains("no-credential"))
	fake.google_result = {"ok": true}
	t.check("google: an answer without a token is unavailable", (await p.silent("n", "id")).has("unavailable"))
	await p.sign_out_cleanup()
	t.check("google: sign-out clears the credential state", fake.google_signed_out == 1)
	t.check("google: nothing is revoked by Google (no launch check)", not p.credential_revoked())
	# Capabilities are read once per facade: a fresh one for the stripped export.
	var stripped := PKeyFakeAndroidNative.new()
	stripped.google_libraries = false
	var a2 := _android("android", stripped)
	p = PKeyGoogleProvider.new(a2)
	var calls_before := stripped.ops_called("gid_silent")
	got = await p.silent("n", "id")
	t.check("google: without the libraries the answer is unavailable (dependency)", got.has("unavailable") and str(got["unavailable"]).contains("dependency"))
	t.check("google: …and no op runs", stripped.ops_called("gid_silent") == calls_before)
	a.free()
	a2.free()


func _export(t: PKeyTestContext) -> void:
	var play := E.dependencies("play")
	t.check("export: play carries WorkManager, Play Core, the three Credential Manager libraries and Block Store", play.size() == 8)
	var cm := "androidx.credentials:credentials"
	t.check("export: …credentials and credentials-play-services-auth", play.has(cm + ":1.6.0") and play.has(cm + "-play-services-auth:1.6.0"))
	t.check("export: …and googleid", play.has("com.google.android.libraries.identity.googleid:googleid:1.2.0"))
	t.check("export: …and Block Store at the platform's pin", play.has("com.google.android.gms:play-services-auth-blockstore:16.4.0") and not E.is_credential_dependency("com.google.android.gms:play-services-auth-blockstore:16.4.0"))
	t.check("export: direct carries no Credential Manager", E.dependencies("direct") == PackedStringArray(E.WORK_DEPENDENCIES))
	var old := {"major": 4, "minor": 3}
	var older := E.dependencies("play", old)
	t.check("export: Godot 4.3 keeps Play Core and leaves Credential Manager out", older.size() == 5 and older.has("com.google.android.gms:play-services-auth-blockstore:16.4.0") and not Array(older).any(func(d): return E.is_credential_dependency(d)))
	var sizes := [4, 7].map(func(minor): return E.dependencies("play", {"major": 4, "minor": minor}).size())
	t.check("export: Godot 4.4 and 4.7 carry all eight", E.dependencies("play", {"major": 4, "minor": 4}).size() == 8 and sizes == [8, 8])
	t.check("export: the old-engine omission is warned about", E.credentials_warning("play", old).contains("Godot 4.3"))
	t.check("export: current engines and direct are not warned", E.credentials_warning("play", {"major": 4, "minor": 7}) == "" and E.credentials_warning("direct", old) == "")


## PLAY_DEPENDENCIES against sdks/kotlin/gradle/libs.versions.toml: every Credential Manager library the
## Kotlin platform's play flavour pins is in the list at the same version, and nothing else of those
## groups is. Skipped (and said so) where the Kotlin tree is not beside the SDK, as in an exported pack.
func _drift(t: PKeyTestContext) -> void:
	var path := ProjectSettings.globalize_path("res://").path_join(TOML).simplify_path()
	if not FileAccess.file_exists(path):
		t.info("google: libs.versions.toml is not beside the SDK here; the PLAY_DEPENDENCIES drift check is skipped")
		return
	var text := FileAccess.get_file_as_string(path)
	var versions := {}
	var modules := {}
	var re_version := RegEx.create_from_string("(?m)^([A-Za-z0-9]+) = \"([^\"]+)\"\\s*$")
	for m in re_version.search_all(text):
		versions[m.get_string(1)] = m.get_string(2)
	var re_lib := RegEx.create_from_string("(?m)^([A-Za-z0-9-]+) = \\{ module = \"([^\"]+)\", version\\.ref = \"([^\"]+)\" \\}")
	for m in re_lib.search_all(text):
		modules[m.get_string(1)] = "%s:%s" % [m.get_string(2), versions.get(m.get_string(3), "?")]
	var want := PackedStringArray()
	for key in ["androidx-credentials", "androidx-credentials-play-services-auth", "googleid"]:
		want.append(modules.get(key, "missing:%s" % key))
	var have := PackedStringArray()
	for d in E.PLAY_DEPENDENCIES:
		if E.is_credential_dependency(d):
			have.append(d)
	want.sort()
	have.sort()
	t.check("google: PLAY_DEPENDENCIES' Credential Manager pins equal libs.versions.toml's", want == have, "toml %s, export %s" % [want, have])
	t.check("google: PLAY_DEPENDENCIES' Block Store pin equals libs.versions.toml's", E.PLAY_DEPENDENCIES.has(str(modules.get("play-blockstore", "missing"))), str(modules.get("play-blockstore", "missing")))
	for key in ["playAppUpdate", "playAssetDelivery", "playIntegrity"]:
		t.check("google: the Play Core pin %s is in PLAY_DEPENDENCIES" % key, E.PLAY_DEPENDENCIES.any(func(d): return d.ends_with(":" + str(versions.get(key, "?")))))
