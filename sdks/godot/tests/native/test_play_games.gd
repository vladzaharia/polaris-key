extends RefCounted
# @pkey-feature identity.pgs identity.exchange
# Play Games on Android (I-48.7a export half, headless): the opt-in's Maven dependency and the app id
# meta-data in a play export only, the warnings, and the drift test that holds the dependency to
# sdks/kotlin's gradle/libs.versions.toml (`playGames`).

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
	t.check("pgs: the capability is reported with the library", a.play_games_unavailable_reason() == "")
	var r: PKeyResult = await a.pgs_code("123456789012-pgs.apps")
	t.check("pgs: pgs_code answers the server auth code", r.ok and r.detail.get("code") == "4/transcript-server-auth-code")
	t.check("pgs: …and sends the server client id", fake.last_call("pgs_code").get("serverClientId") == "123456789012-pgs.apps")
	r = await a.pgs_sign_in()
	t.check("pgs: the row's sign-in reports authenticated", r.ok and r.detail.get("authenticated") == true)
	fake.pgs_result = {"ok": false, "error": "unavailable", "reason": "not-authenticated"}
	r = await a.pgs_code("id")
	t.check("pgs: a signed-out player is platform-error unavailable with a fixed reason", not r.ok and r.detail.get("reason") == "not-authenticated")
	a.free()
	var stripped := PKeyFakeAndroidNative.new()
	stripped.pgs_libraries = false
	a = _android("android", stripped)
	t.check("pgs: an export without the library is dependency", a.play_games_unavailable_reason() == "dependency")
	a.free()
	var direct := PKeyFakeAndroidNative.new()
	direct.flavor = "direct"
	a = _android("android", direct)
	t.check("pgs: the direct flavour is outlet", a.play_games_unavailable_reason() == "outlet")
	a.free()
	var off := _android("windows")
	var gone: PKeyResult = await off.pgs_code("id")
	t.check("pgs: off Android the facade is Unsupported (runtime)", gone.code == &"unsupported" and gone.detail.get("reason") == "runtime")
	off.free()


func _provider(t: PKeyTestContext) -> void:
	var fake := PKeyFakeAndroidNative.new()
	var a := _android("android", fake)
	var p := PKeyPgsProvider.new(a)
	t.check("pgs: kind pgs, silent and a sheet", p.kind == "pgs" and p.has_silent() and p.has_sheet())
	t.check("pgs: silent answers the code as the token", await p.silent("n", "pgs.apps") == {"token": "4/transcript-server-auth-code"})
	t.check("pgs: the sheet is the same call", await p.sheet("n", "pgs.apps") == {"token": "4/transcript-server-auth-code"})
	var nobody: Dictionary = await p.silent("n", "")
	t.check("pgs: no server client id is unavailable and asks nobody", nobody.has("unavailable") and fake.ops_called("pgs_code") == 2)
	var row: Dictionary = await p.provider_row("n", "pgs.apps")
	t.check("pgs: the row signs in, then asks for the code", row.has("token") and fake.ops_called("pgs_sign_in") == 1 and fake.ops_called("pgs_code") == 3)
	fake.pgs_sign_in_result = {"ok": true, "authenticated": false}
	t.check("pgs: a row the player backed out of is cancelled", (await p.provider_row("n", "pgs.apps")).get("cancelled") == true)
	fake.pgs_result = {"ok": false, "error": "unavailable", "reason": "not-authenticated"}
	var got: Dictionary = await p.silent("n", "pgs.apps")
	t.check("pgs: a signed-out player is unavailable with the reason and no token", got.has("unavailable") and str(got["unavailable"]).contains("not-authenticated") and not got.has("token"))
	fake.pgs_result = {"ok": true}
	t.check("pgs: an answer without a code is unavailable", (await p.silent("n", "pgs.apps")).has("unavailable"))
	t.check("pgs: no launch check and nothing to clear", not await p.credential_revoked())
	var stripped := PKeyFakeAndroidNative.new()
	stripped.pgs_libraries = false
	var a2 := _android("android", stripped)
	var p2 := PKeyPgsProvider.new(a2)
	got = await p2.silent("n", "pgs.apps")
	t.check("pgs: without the library the answer is unavailable (dependency)", got.has("unavailable") and str(got["unavailable"]).contains("dependency"))
	t.check("pgs: …and no op runs", stripped.ops_called("pgs_code") == 0)
	a.free()
	a2.free()


func _export(t: PKeyTestContext) -> void:
	var plain := E.dependencies("play")
	var with_pgs := E.dependencies("play", {}, true)
	t.check("pgs: a play export without the opt-in carries no Play Games library", not Array(plain).has(E.PLAY_GAMES_DEPENDENCY))
	t.check("pgs: …and with it carries exactly one more, the pin", with_pgs.size() == plain.size() + 1 and with_pgs[-1] == E.PLAY_GAMES_DEPENDENCY)
	t.check("pgs: a direct export never carries it", E.dependencies("direct", {}, true).is_empty() and E.dependencies("none", {}, true).is_empty())
	t.check("pgs: the app id is digits only", E.play_games_app_id("123456789012") == "123456789012" and E.play_games_app_id(" 42 ") == "42")
	for bad in ["", "abc", "12a", "-5", "+5", "1.5", "1 2", null]:
		t.check("pgs: app id %s is refused" % str(bad), E.play_games_app_id(bad) == "")
	var meta := E.application_elements("play", true, "123456789012")
	t.check("pgs: the meta-data names APP_ID", meta.contains("android:name=\"com.google.android.gms.games.APP_ID\""), meta)
	t.check("pgs: …with a string value (a backslash and a space first)", meta.contains("android:value=\"\\ 123456789012\""), meta)
	var quiet := E.application_elements("direct", true, "1") + E.application_elements("play", false, "1") + E.application_elements("play", true, "")
	t.check("pgs: …and only for play, opted in, with an id", quiet == "")
	t.check("pgs: on without an id warns", E.play_games_warnings("play", true, "").size() == 1 and E.play_games_warnings("play", true, "abc").size() == 1)
	t.check("pgs: on for a direct export warns", E.play_games_warnings("direct", true, "1").size() == 1)
	t.check("pgs: an id without the opt-in warns", E.play_games_warnings("play", false, "1").size() == 1)
	t.check("pgs: a complete opt-in is quiet", E.play_games_warnings("play", true, "1").is_empty() and E.play_games_warnings("play", false, "").is_empty())


func _drift(t: PKeyTestContext) -> void:
	var path := ProjectSettings.globalize_path("res://").path_join(TOML).simplify_path()
	if not FileAccess.file_exists(path):
		t.info("pgs: libs.versions.toml is not beside the SDK here; the playGames drift check is skipped")
		return
	var text := FileAccess.get_file_as_string(path)
	var re_pin := RegEx.create_from_string("(?m)^playGames = \"([^\"]+)\"\\s*$")
	var m := re_pin.search(text)
	t.check("pgs: libs.versions.toml pins playGames", m != null)
	if m != null:
		var want := "com.google.android.gms:play-services-games-v2:" + m.get_string(1)
		t.check("pgs: PLAY_GAMES_DEPENDENCY is play-services-games-v2 at that pin", E.PLAY_GAMES_DEPENDENCY == want, "toml %s, export %s" % [want, E.PLAY_GAMES_DEPENDENCY])
