@tool
extends EditorExportPlugin
## The Android half of the Polaris Key export (P5-06): per preset, the right flavour's AARs and
## Maven dependencies, and for direct presets only the install permissions (PKeyAndroidExport has
## the rules). Registered by plugin.gd beside the build-stamp export plugin.

const A := preload("res://addons/polaris_key/native/android_export.gd")
const S := preload("res://addons/polaris_key/core/build_stamp.gd")


func _get_name() -> String:
	return "PolarisKeyAndroid"


func _supports_platform(platform: EditorExportPlatform) -> bool:
	return platform is EditorExportPlatformAndroid


func _get_export_options(platform: EditorExportPlatform) -> Array[Dictionary]:
	if not (platform is EditorExportPlatformAndroid):
		return []
	return [
		{
			"option": {"name": A.OPTION, "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM, "hint_string": ",".join(A.FLAVORS)},
			"default_value": A.DEFAULT_FLAVOR,
			"update_visibility": true,
		},
		{
			"option": {"name": A.BACKGROUND_OPTION, "type": TYPE_BOOL},
			"default_value": false,
		},
		{
			"option": {"name": A.PLAY_GAMES_OPTION, "type": TYPE_BOOL},
			"default_value": false,
			"update_visibility": true,
		},
		{
			"option": {"name": A.PLAY_GAMES_APP_ID_OPTION, "type": TYPE_STRING},
			"default_value": "",
			"update_visibility": true,
		},
	]


func _get_export_option_warning(_platform: EditorExportPlatform, option: String) -> String:
	if option == A.PLAY_GAMES_OPTION or option == A.PLAY_GAMES_APP_ID_OPTION:
		return "\n".join(A.play_games_warnings(A.canonical(_flavor_raw()), _play_games(), _option(A.PLAY_GAMES_APP_ID_OPTION, A.PLAY_GAMES_APP_ID_ENV)))
	if option != A.OPTION:
		return ""
	var flavor := _flavor_raw()
	var lines := A.warnings(flavor, _outlet_kind(), _gradle_build(), A.missing_libraries(A.canonical(flavor)))
	var err := A.error(flavor, _outlet_kind())
	if err != "":
		lines.insert(0, "ERROR: " + err)
	return "\n".join(lines)


func _flavor_raw() -> Variant:
	var preset := get_export_preset()
	if preset == null:
		var e := OS.get_environment(A.ENV)
		return e if e != "" else A.DEFAULT_FLAVOR
	var v = preset.get_or_env(A.OPTION, A.ENV)
	return v if v != null else A.DEFAULT_FLAVOR


## The flavour this export uses ("" when it carries no plugin), warning once per hook call site.
func _flavor() -> String:
	var raw = _flavor_raw()
	var flavor := A.canonical(raw)
	var missing := A.missing_libraries(flavor)
	if A.error(raw, _outlet_kind()) != "" or not A.carries_plugin(raw, _gradle_build(), missing):
		return ""
	return flavor


## An option's value, environment first (what PKEY_* in CI sets), else the preset's; null when neither.
func _option(name: String, env: String) -> Variant:
	var preset := get_export_preset()
	if preset == null:
		var e := OS.get_environment(env)
		return e if e != "" else null
	return preset.get_or_env(name, env)


## Whether this export opted in to Play Games (default off).
func _play_games() -> bool:
	var v = _option(A.PLAY_GAMES_OPTION, A.PLAY_GAMES_ENV)
	return v == true or str(v).to_lower() in ["1", "true", "yes", "on"]


## Whether this export opted in to background transfer (default off; D-10).
func _background() -> bool:
	return A.background_enabled(_option(A.BACKGROUND_OPTION, A.BACKGROUND_ENV))


func _gradle_build() -> bool:
	var preset := get_export_preset()
	if preset == null or not preset.has("gradle_build/use_gradle_build"):
		return false
	return bool(preset.get("gradle_build/use_gradle_build"))


func _outlet_kind() -> String:
	var preset := get_export_preset()
	var kind := OS.get_environment(S.ENV_OUTLET_KIND)
	if kind == "" and preset != null and preset.has(S.OPTION_OUTLET_KIND):
		kind = str(preset.get(S.OPTION_OUTLET_KIND))
	if kind != "":
		return kind.strip_edges()
	var outlet := OS.get_environment(S.ENV_OUTLET)
	if outlet == "" and preset != null and preset.has(S.OPTION_OUTLET):
		outlet = str(preset.get(S.OPTION_OUTLET))
	return outlet.strip_edges()


func _export_begin(_features: PackedStringArray, _is_debug: bool, _path: String, _flags: int) -> void:
	if not (get_export_platform() is EditorExportPlatformAndroid):
		return
	var raw = _flavor_raw()
	for w in A.warnings(raw, _outlet_kind(), _gradle_build(), A.missing_libraries(A.canonical(raw))):
		push_warning("Polaris Key Android plugin: %s" % w)
	for pw in A.play_games_warnings(A.canonical(raw), _play_games(), _option(A.PLAY_GAMES_APP_ID_OPTION, A.PLAY_GAMES_APP_ID_ENV)):
		push_warning("Polaris Key Android plugin: %s" % pw)
	var cw := A.credentials_warning(_flavor(), Engine.get_version_info())
	if cw != "":
		push_warning("Polaris Key Android plugin: %s" % cw)
	var err := A.error(raw, _outlet_kind())
	if err != "":
		push_error("Polaris Key Android plugin: %s" % err)
	print("Polaris Key Android plugin: flavour %s" % (_flavor() if _flavor() != "" else "none"))


func _get_android_libraries(_platform: EditorExportPlatform, _debug: bool) -> PackedStringArray:
	return A.libraries(_flavor())


func _get_android_dependencies(_platform: EditorExportPlatform, _debug: bool) -> PackedStringArray:
	if A.error(_flavor_raw(), _outlet_kind()) != "":
		push_error("Polaris Key Android plugin: %s" % A.error(_flavor_raw(), _outlet_kind()))
		return PackedStringArray([A.REFUSAL_DEPENDENCY])
	return A.dependencies(_flavor(), Engine.get_version_info(), _play_games())


func _get_android_manifest_element_contents(_platform: EditorExportPlatform, _debug: bool) -> String:
	return A.manifest_elements(_flavor(), _background())


func _get_android_manifest_application_element_contents(_platform: EditorExportPlatform, _debug: bool) -> String:
	var out := A.application_elements(_flavor(), _play_games(), A.play_games_app_id(_option(A.PLAY_GAMES_APP_ID_OPTION, A.PLAY_GAMES_APP_ID_ENV)))
	# The native redirect sign-in's intent filter: only for what the project settings register (I-48.17b).
	out += A.redirect_elements(_flavor(), A.redirect_scheme(_setting(A.REDIRECT_SCHEME_SETTING)), A.redirect_claimed(_setting(A.REDIRECT_CLAIMED_SETTING)))
	return out


## A project setting's value, or null when unset.
func _setting(name: String) -> Variant:
	return ProjectSettings.get_setting(name) if ProjectSettings.has_setting(name) else null
