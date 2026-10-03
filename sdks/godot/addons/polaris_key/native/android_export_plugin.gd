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
	return [{
		"option": {"name": A.OPTION, "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM, "hint_string": ",".join(A.FLAVORS)},
		"default_value": A.DEFAULT_FLAVOR,
		"update_visibility": true,
	}]


func _get_export_option_warning(_platform: EditorExportPlatform, option: String) -> String:
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
	return A.dependencies(_flavor())


func _get_android_manifest_element_contents(_platform: EditorExportPlatform, _debug: bool) -> String:
	return A.manifest_elements(_flavor())
