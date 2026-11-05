class_name PKeyAndroidExport
extends RefCounted
## What an Android export carries for the Polaris Key Android plugin (P5-06), as pure functions
## the export plugin (android_export_plugin.gd) calls and the headless tests check.
##
## The preset picks the flavour with `polaris_key/android_flavor` (or PKEY_ANDROID_FLAVOR in CI):
##
##   play    polaris-key-platform and polaris-key-godot, play flavour, plus Play Core
##           (app-update, asset-delivery, integrity) from Maven. NO install permission: Play forbids
##           self-update and REQUEST_INSTALL_PACKAGES in Play builds (notes/E2 §A2, §B2)
##   direct  the two AARs, direct flavour (verified PackageInstaller self-update), no Play Core, and
##           the manifest entries REQUEST_INSTALL_PACKAGES and UPDATE_PACKAGES_WITHOUT_USER_ACTION
##           (silent updates need the latter at target SDK 36; ENFORCE_UPDATE_OWNERSHIP is left out:
##           a self-updater never makes the first install, so it can never claim ownership,
##           notes/S-10 §3)
##   none    no plugin: PKeyAndroid answers `dependency`
##
## A Godot v2 Android plugin needs the Gradle build (`gradle_build/use_gradle_build`) on Godot 4.2+;
## without it, or without the AARs (sdks/godot/native/android/build.sh puts them in bin/), the
## export carries nothing and warns.

const OPTION := "polaris_key/android_flavor"
const ENV := "PKEY_ANDROID_FLAVOR"
const FLAVORS := ["play", "direct", "none"]
const DEFAULT_FLAVOR := "play"
## Where build.sh installs the AARs, relative to res://addons/ (what _get_android_libraries wants).
const BIN := "polaris_key/native/android/bin"
## Play Core: exactly the libraries polaris-key-platform-play's POM names (sdks/kotlin/gradle/
## libs.versions.toml), Play Integrity included (P6-02), and the Credential Manager libraries
## (I-48.5b) and Block Store (I-49.14: the restore item, not engine-gated: minSdk 21, no AAR metadata constraint);
## sdks/kotlin/tools/check_publication.sh fails
## when this list and that POM differ (P6-10).
const PLAY_DEPENDENCIES := [
	"com.google.android.play:app-update:2.1.0",
	"com.google.android.play:asset-delivery:2.3.0",
	"com.google.android.play:integrity:1.6.0",
	"androidx.credentials:credentials:1.6.0",
	"androidx.credentials:credentials-play-services-auth:1.6.0",
	"com.google.android.libraries.identity.googleid:googleid:1.2.0",
	"com.google.android.gms:play-services-auth-blockstore:16.4.0",
]
## WorkManager, for background transfers (U-41.6b): exactly the androidx.work library polaris-key-platform's
## POMs name (sdks/kotlin/gradle/libs.versions.toml `androidxWork`). The AARs are local files and carry no
## transitive dependencies, so both flavours add it; sdks/kotlin/tools/check_publication.sh fails when this
## list and the platform POMs differ.
const WORK_DEPENDENCIES := [
	"androidx.work:work-runtime:2.12.0",
]
## Background transfer (D-10): the preset opts in with `polaris_key/cloud_sync_background` (env
## PKEY_CLOUD_SYNC_BACKGROUND). Only then does the export declare the two permissions in TRANSFER_PERMISSIONS (the
## platform AAR declares none), so a game that never syncs files lists neither.
const BACKGROUND_OPTION := "polaris_key/cloud_sync_background"
const BACKGROUND_ENV := "PKEY_CLOUD_SYNC_BACKGROUND"
## Play Games Services v2 (I-48.7a; Q-3): added only by the opt-in `polaris_key/play_games` (env
## PKEY_ANDROID_PLAY_GAMES), with the app id from `polaris_key/play_games_app_id` (PKEY_ANDROID_PLAY_GAMES_APP_ID).
## The pin is libs.versions.toml's `playGames`; a test holds them together.
const PLAY_GAMES_OPTION := "polaris_key/play_games"
const PLAY_GAMES_ENV := "PKEY_ANDROID_PLAY_GAMES"
const PLAY_GAMES_APP_ID_OPTION := "polaris_key/play_games_app_id"
const PLAY_GAMES_APP_ID_ENV := "PKEY_ANDROID_PLAY_GAMES_APP_ID"
const PLAY_GAMES_DEPENDENCY := "com.google.android.gms:play-services-games-v2:22.1.0"
const PLAY_GAMES_APP_ID_META := "com.google.android.gms.games.APP_ID"
## The Credential Manager part of PLAY_DEPENDENCIES (I-48.5b: Google sign-in), by group.
const CREDENTIAL_GROUPS := ["androidx.credentials", "com.google.android.libraries.identity.googleid"]
## credentials 1.6.0 declares minCompileSdk 35: Godot's Android build template compiles against 35
## from 4.4 on, so older engines get no Credential Manager (Google sign-in answers `dependency`).
const CREDENTIALS_MIN_ENGINE := [4, 4]
const DIRECT_PERMISSIONS := ["android.permission.REQUEST_INSTALL_PACKAGES", "android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION"]
## Cloud Connect's LAN discovery (CC-14b.9, D-15): from Android 17, an app that targets it needs this
## runtime permission (the Nearby devices group) to browse, advertise or reach the local network. Both
## flavours declare it, so the lane can ask at first use (L-11); a device below 17 ignores it.
const LOCAL_NETWORK_PERMISSION := "android.permission.ACCESS_LOCAL_NETWORK"
## Background transfers (U-41.4): a transfer the person starts runs at once as a user-initiated job (Android 14+)
## with a notification; without these the platform AAR falls back to a WorkManager job. Declared only when the
## preset opts in to background transfer (D-10).
const TRANSFER_PERMISSIONS := ["android.permission.RUN_USER_INITIATED_JOBS", "android.permission.POST_NOTIFICATIONS"]
## The LAN lane reads the network's subnets and watches the default network; without this normal
## (install-time) permission it finds no subnet and dials nothing.
const NETWORK_STATE_PERMISSION := "android.permission.ACCESS_NETWORK_STATE"
## The native redirect sign-in (I-48.17b): the project registers a custom scheme and/or a verified App Link in the
## project settings, and the export adds the matching intent filter to the redirect activity. Unset (the default)
## adds nothing, and the activity stays unexported.
const REDIRECT_SCHEME_SETTING := "polaris_key/native_redirect/scheme"
const REDIRECT_CLAIMED_SETTING := "polaris_key/native_redirect/claimed_uri"
const REDIRECT_ACTIVITY := "im.plrs.key.godot.PKeyGodotRedirectActivity"
const REDIRECT_PATH := "/pkey/callback"
const REDIRECT_RESERVED_SCHEMES := ["http", "https", "javascript", "data", "file", "content", "intent"]
## The outlet kinds each flavour suits (a mismatch only warns: the stamp is the product's call).
const PLAY_KINDS := ["play", "play-testing"]
const NO_PLAY_CORE_KINDS := ["fdroid-repo"]
## The Maven coordinate a refused export depends on: it cannot resolve, so the Gradle build (and the
## export) fails, and the coordinate names why.
const REFUSAL_DEPENDENCY := "polaris-key.export-refused:direct-flavour-on-a-play-outlet:0"


## A flavour value as given (case and spaces forgiven), or "" when it is not one.
static func canonical(flavor: Variant) -> String:
	var f := str(flavor).strip_edges().to_lower() if flavor != null else ""
	return f if FLAVORS.has(f) else ""


## The AAR paths (relative to res://addons/) for `flavor`: the platform AAR and the Godot binding.
static func libraries(flavor: String) -> PackedStringArray:
	if flavor != "play" and flavor != "direct":
		return PackedStringArray()
	return PackedStringArray([
		"%s/polaris-key-platform-%s-release.aar" % [BIN, flavor],
		"%s/polaris-key-godot-%s-release.aar" % [BIN, flavor],
	])


## The Maven coordinates `flavor` needs: WorkManager for both, plus Play Core and Credential Manager for play.
## `engine` is Engine.get_version_info() of the exporting editor ({} means a current one):
## below Godot 4.4 the Credential Manager libraries are left out.
static func dependencies(flavor: String, engine := {}, play_games := false) -> PackedStringArray:
	if flavor != "play" and flavor != "direct":
		return PackedStringArray()
	var out := PackedStringArray(WORK_DEPENDENCIES)
	if flavor != "play":
		return out
	for d in PLAY_DEPENDENCIES:
		if credentials_supported(engine) or not is_credential_dependency(d):
			out.append(d)
	if play_games:
		out.append(PLAY_GAMES_DEPENDENCY)
	return out


## The Play Games app id from an option or env value: digits only ("" when it is anything else).
static func play_games_app_id(raw: Variant) -> String:
	var id := str(raw).strip_edges() if raw != null else ""
	return id if id != "" and id.is_valid_int() and not id.begins_with("-") and not id.begins_with("+") else ""


## The <application> children for `flavor`: the Play Games app id meta-data for an export that opted in
## with a valid app id, nothing else. The value is `\u003` plus the digits (the form Google's Unity
## plugin uses: `\u003` and the first digit are that digit's own escape), so that aapt2 keeps the digits
## a string with no leading character (a bare number would be an integer, which Play Games rejects).
static func application_elements(flavor: String, play_games: bool, app_id: String) -> String:
	if flavor != "play" or not play_games or app_id == "":
		return ""
	return "    <meta-data android:name=\"%s\" android:value=\"\\u003%s\" />\n" % [PLAY_GAMES_APP_ID_META, app_id]


## Warnings for the Play Games opt-in ("" entries never appear).
static func play_games_warnings(flavor: String, play_games: bool, app_id_raw: Variant) -> PackedStringArray:
	var out := PackedStringArray()
	var app_id := play_games_app_id(app_id_raw)
	if play_games and flavor != "play":
		out.append("%s is on but the flavour is %s: Play Games is a play-flavour feature, so nothing is added." % [PLAY_GAMES_OPTION, flavor if flavor != "" else "none"])
	elif play_games and app_id == "":
		var why := "%s is on but %s is not a number: Play Games needs the digits of the app id from the Play Console"
		out.append("%s, so no meta-data is added and the sign-in will fail." % (why % [PLAY_GAMES_OPTION, PLAY_GAMES_APP_ID_OPTION]))
	elif not play_games and app_id != "":
		out.append("%s is set but %s is off: nothing is added." % [PLAY_GAMES_APP_ID_OPTION, PLAY_GAMES_OPTION])
	return out


## Whether a coordinate (`group:artifact:version`) is one of the Credential Manager libraries.
static func is_credential_dependency(coordinate: String) -> bool:
	return CREDENTIAL_GROUPS.has(coordinate.get_slice(":", 0))


## Whether the engine's Android build template compiles against API 35 or later ({} is a current one).
static func credentials_supported(engine := {}) -> bool:
	if engine.is_empty():
		return true
	var major := int(engine.get("major", 0))
	var minor := int(engine.get("minor", 0))
	return major > CREDENTIALS_MIN_ENGINE[0] or (major == CREDENTIALS_MIN_ENGINE[0] and minor >= CREDENTIALS_MIN_ENGINE[1])


## A warning when a play export leaves Credential Manager out for an old engine ("" otherwise).
static func credentials_warning(flavor: String, engine := {}) -> String:
	if flavor == "play" and not credentials_supported(engine):
		var why := "Godot %s.%s compiles Android against an API below 35, which androidx.credentials 1.6.0 needs"
		var effect := "this export carries no Credential Manager, so Google sign-in answers dependency. Use Godot 4.4 or later."
		return "%s: %s" % [why % [engine.get("major", "?"), engine.get("minor", "?")], effect]
	return ""


## Whether an option or env value turns background transfer on (default off).
static func background_enabled(raw: Variant) -> bool:
	return (raw is bool and raw) or (not (raw is bool) and str(raw).strip_edges().to_lower() in ["1", "true", "yes", "on"])


## The <manifest> children for `flavor`: the local-network and network-state permissions for play and direct, the
## job and notification permissions only when `background` is on (D-10), and the two install permissions for direct;
## nothing for none.
static func manifest_elements(flavor: String, background := false) -> String:
	if flavor != "play" and flavor != "direct":
		return ""
	var s := "    <uses-permission android:name=\"%s\" />\n" % LOCAL_NETWORK_PERMISSION
	s += "    <uses-permission android:name=\"%s\" />\n" % NETWORK_STATE_PERMISSION
	if background:
		for p in TRANSFER_PERMISSIONS:
			s += "    <uses-permission android:name=\"%s\" />\n" % p
	if flavor != "direct":
		return s
	for p in DIRECT_PERMISSIONS:
		s += "    <uses-permission android:name=\"%s\" />\n" % p
	return s


## A registered scheme name from a project setting (lower case; letters, digits, `+ . -`), or "" when it is none.
static func redirect_scheme(raw: Variant) -> String:
	var name := str(raw).strip_edges() if raw != null else ""
	var re := RegEx.create_from_string("^[a-z][a-z0-9+.-]{0,63}$")
	return name if re.search(name) != null and not REDIRECT_RESERVED_SCHEMES.has(name) else ""


## A claimed App Link from a project setting: an `https://host/path` URI with no port, query, fragment or userinfo and a
## path of its own; "" when it is none.
static func redirect_claimed(raw: Variant) -> String:
	var uri := str(raw).strip_edges() if raw != null else ""
	var re := RegEx.create_from_string("^https://([a-z0-9.-]+)(/[A-Za-z0-9._~/%-]+)$")
	return uri if uri.length() <= 2048 and re.search(uri) != null else ""


## The <application> child for the redirect activity: exported, with one intent filter per registered redirect;
## "" when neither a scheme nor a claimed link is registered, or when the build carries no plugin. The host of the
## claimed link is verified by Android (autoVerify) against the site's assetlinks.json.
static func redirect_elements(flavor: String, scheme: String, claimed_uri: String) -> String:
	if flavor != "play" and flavor != "direct":
		return ""
	var filters := ""
	if scheme != "":
		filters += "            <intent-filter>\n"
		filters += "                <action android:name=\"android.intent.action.VIEW\" />\n"
		filters += "                <category android:name=\"android.intent.category.DEFAULT\" />\n"
		filters += "                <category android:name=\"android.intent.category.BROWSABLE\" />\n"
		filters += "                <data android:scheme=\"%s\" android:path=\"%s\" />\n" % [scheme, REDIRECT_PATH]
		filters += "            </intent-filter>\n"
	if claimed_uri != "":
		var rest := claimed_uri.trim_prefix("https://")
		var slash := rest.find("/")
		filters += "            <intent-filter android:autoVerify=\"true\">\n"
		filters += "                <action android:name=\"android.intent.action.VIEW\" />\n"
		filters += "                <category android:name=\"android.intent.category.DEFAULT\" />\n"
		filters += "                <category android:name=\"android.intent.category.BROWSABLE\" />\n"
		filters += "                <data android:scheme=\"https\" android:host=\"%s\" android:path=\"%s\" />\n" % [rest.substr(0, slash), rest.substr(slash)]
		filters += "            </intent-filter>\n"
	if filters == "":
		return ""
	return "    <activity android:name=\"%s\" android:exported=\"true\" tools:replace=\"android:exported\">\n%s    </activity>\n" % [REDIRECT_ACTIVITY, filters]


## The AARs of `flavor` missing under `addons_dir` (res://addons by default).
static func missing_libraries(flavor: String, addons_dir := "res://addons") -> PackedStringArray:
	var out := PackedStringArray()
	for rel in libraries(flavor):
		if not FileAccess.file_exists(addons_dir.path_join(rel)):
			out.append(rel)
	return out


## Every problem with this export's choice, in words ("" entries never appear).
static func warnings(flavor_raw: Variant, outlet_kind: String, gradle_build: bool, missing: PackedStringArray) -> PackedStringArray:
	var out := PackedStringArray()
	var flavor := canonical(flavor_raw)
	if flavor == "":
		out.append("%s is \"%s\"; expected one of %s. The export carries no Polaris Key Android plugin." % [OPTION, str(flavor_raw), ", ".join(FLAVORS)])
		return out
	if flavor == "none":
		return out
	if not gradle_build:
		out.append("the Polaris Key Android plugin needs the Gradle build (gradle_build/use_gradle_build); this export carries no plugin, so PKeyAndroid answers dependency.")
	if not missing.is_empty():
		out.append("the %s AARs are missing (%s); run sdks/godot/native/android/build.sh. This export carries no plugin." % [flavor, ", ".join(missing)])
	if flavor == "play" and NO_PLAY_CORE_KINDS.has(outlet_kind):
		out.append("the outlet is %s but the flavour is play: F-Droid builds must not contain Play Core (proprietary). Use direct or none." % outlet_kind)
	return out


## The export ERROR for this choice, or "": the direct flavour on a Play or Play testing outlet. A
## Play build must never contain self-update or REQUEST_INSTALL_PACKAGES (Play policy), so the export
## plugin refuses it: no AAR and no permission are added, and the Gradle build is made to fail
## through REFUSAL_DEPENDENCY (Godot gives an export plugin no other way to stop an export: option
## warnings are only shown).
static func error(flavor_raw: Variant, outlet_kind: String) -> String:
	if canonical(flavor_raw) == "direct" and PLAY_KINDS.has(outlet_kind):
		return "the outlet is %s but %s is direct: a Play build must not contain self-update or REQUEST_INSTALL_PACKAGES. Use the play flavour. The export is refused." % [outlet_kind, OPTION]
	return ""


## Whether this export carries the plugin at all.
static func carries_plugin(flavor_raw: Variant, gradle_build: bool, missing: PackedStringArray) -> bool:
	var flavor := canonical(flavor_raw)
	return (flavor == "play" or flavor == "direct") and gradle_build and missing.is_empty()
