class_name PKeyAndroidExport
extends RefCounted
## What an Android export carries for the Polaris Key Android plugin (P5-06), as pure functions
## the export plugin (android_export_plugin.gd) calls and the headless tests check.
##
## The preset picks the flavour with `polaris_key/android_flavor` (or PKEY_ANDROID_FLAVOR in CI):
##
##   play    polaris-key-platform and polaris-key-godot, play flavour, plus Play Core
##           (app-update, asset-delivery) from Maven. NO install permission: Play forbids
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
## Play Core, the versions polaris-key-platform's play flavour compiles against
## (sdks/kotlin/gradle/libs.versions.toml).
const PLAY_DEPENDENCIES := ["com.google.android.play:app-update:2.1.0", "com.google.android.play:asset-delivery:2.3.0"]
const DIRECT_PERMISSIONS := ["android.permission.REQUEST_INSTALL_PACKAGES", "android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION"]
## The outlet kinds each flavour suits (a mismatch only warns: the stamp is the product's call).
const PLAY_KINDS := ["play", "play-testing"]
const NO_PLAY_CORE_KINDS := ["fdroid-repo"]


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


## The Maven coordinates `flavor` needs: Play Core for play, nothing for direct.
static func dependencies(flavor: String) -> PackedStringArray:
	return PackedStringArray(PLAY_DEPENDENCIES) if flavor == "play" else PackedStringArray()


## The <manifest> children for `flavor`: the two install permissions for direct, nothing else.
static func manifest_elements(flavor: String) -> String:
	if flavor != "direct":
		return ""
	var s := ""
	for p in DIRECT_PERMISSIONS:
		s += "    <uses-permission android:name=\"%s\" />\n" % p
	return s


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
	if flavor == "direct" and PLAY_KINDS.has(outlet_kind):
		out.append("the outlet is %s but the flavour is direct: a Play build must not contain self-update or REQUEST_INSTALL_PACKAGES. Use the play flavour." % outlet_kind)
	if flavor == "play" and NO_PLAY_CORE_KINDS.has(outlet_kind):
		out.append("the outlet is %s but the flavour is play: F-Droid builds must not contain Play Core (proprietary). Use direct or none." % outlet_kind)
	return out


## Whether this export carries the plugin at all.
static func carries_plugin(flavor_raw: Variant, gradle_build: bool, missing: PackedStringArray) -> bool:
	var flavor := canonical(flavor_raw)
	return (flavor == "play" or flavor == "direct") and gradle_build and missing.is_empty()
