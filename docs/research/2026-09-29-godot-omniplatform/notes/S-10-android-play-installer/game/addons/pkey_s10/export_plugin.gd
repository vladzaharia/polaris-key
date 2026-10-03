@tool
extends EditorExportPlugin
## Adds the right flavour's AAR and its Maven dependencies per preset; direct presets also get the
## install permissions. The preset picks the flavour with the "pkey_s10/flavor" option.

const PLAY_DEPS := ["com.google.android.play:app-update:2.1.0", "com.google.android.play:asset-delivery:2.3.0"]


func _get_name() -> String:
	return "PKeyS10"


func _supports_platform(platform: EditorExportPlatform) -> bool:
	return platform is EditorExportPlatformAndroid


func _get_export_options(platform: EditorExportPlatform) -> Array[Dictionary]:
	return [
		{"option": {"name": "pkey_s10/flavor", "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM, "hint_string": "play,direct"}, "default_value": "play"},
		{"option": {"name": "pkey_s10/omit_silent_permission", "type": TYPE_BOOL}, "default_value": false},
	]


func _flavor() -> String:
	return str(get_option("pkey_s10/flavor"))


func _get_android_libraries(platform: EditorExportPlatform, debug: bool) -> PackedStringArray:
	print("PKeyS10 export: flavor=%s preset=%s" % [_flavor(), get_export_preset().get_preset_name() if get_export_preset() else "?"])
	return PackedStringArray(["pkey_s10/bin/pkey-s10-%s-release.aar" % _flavor()])


func _get_android_dependencies(platform: EditorExportPlatform, debug: bool) -> PackedStringArray:
	return PackedStringArray(PLAY_DEPS) if _flavor() == "play" else PackedStringArray()


func _get_android_manifest_element_contents(platform: EditorExportPlatform, debug: bool) -> String:
	if _flavor() != "direct":
		return ""
	var s := "    <uses-permission android:name=\"android.permission.REQUEST_INSTALL_PACKAGES\" />\n"
	s += "    <uses-permission android:name=\"android.permission.ENFORCE_UPDATE_OWNERSHIP\" />\n"
	if not get_option("pkey_s10/omit_silent_permission"):
		s += "    <uses-permission android:name=\"android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION\" />\n"
	return s
