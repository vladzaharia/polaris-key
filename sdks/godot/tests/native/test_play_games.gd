extends RefCounted
# @pkey-feature identity.pgs identity.exchange
# Play Games on Android (I-48.7a export half, headless): the opt-in's Maven dependency and the app id
# meta-data in a play export only, the warnings, and the drift test that holds the dependency to
# sdks/kotlin's gradle/libs.versions.toml (`playGames`).

const E := preload("res://addons/polaris_key/native/android_export.gd")
const TOML := "../kotlin/gradle/libs.versions.toml"


func run(t: PKeyTestContext) -> void:
	_export(t)
	_drift(t)


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
