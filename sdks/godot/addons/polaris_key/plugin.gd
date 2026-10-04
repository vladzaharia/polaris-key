@tool
extends EditorPlugin
# Editor shell for the Polaris Key addon: enabling the plugin registers the `PolarisKey`
# autoload, disabling it removes it. While the plugin is on it also registers the export plugin
# (export/export_plugin.gd: the build stamp and the pkey_* feature tags), the Android export plugin
# (native/android_export_plugin.gd: the Polaris Key Android plugin's AARs per flavour) and the setup dock
# (editor/setup_dock.tscn: res://polaris_key.tres and the pin check). The dock goes through
# `add_dock` where the editor has it (4.6+), otherwise `add_control_to_dock` (the 4.4 floor). On
# 4.6+ the dock tab carries the Pinned K editor glyph from brand/ (the kit's bit-less 16 px cut,
# copied by `pnpm gen:brand`), rasterised here because that folder is never imported.

const AUTOLOAD_NAME := "PolarisKey"
const AUTOLOAD_PATH := "res://addons/polaris_key/polaris_key.gd"
const ExportPlugin := preload("res://addons/polaris_key/export/export_plugin.gd")
const AndroidExportPlugin := preload("res://addons/polaris_key/native/android_export_plugin.gd")
const DOCK_SCENE := "res://addons/polaris_key/editor/setup_dock.tscn"
const DOCK_TITLE := "Polaris Key"
const DOCK_ICON := "res://addons/polaris_key/brand/polaris_key-dark.svg"

var _export_plugin: EditorExportPlugin = null
var _android_export_plugin: EditorExportPlugin = null
var _dock: Control = null
## The EditorDock wrapping `_dock` on 4.6+ (typed Object: the class does not exist on 4.4).
var _editor_dock: Object = null


func _enable_plugin() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)


func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)


func _enter_tree() -> void:
	_export_plugin = ExportPlugin.new()
	add_export_plugin(_export_plugin)
	_android_export_plugin = AndroidExportPlugin.new()
	add_export_plugin(_android_export_plugin)
	var scene: PackedScene = load(DOCK_SCENE)
	if scene == null:
		push_error("Polaris Key: could not load %s" % DOCK_SCENE)
		return
	_dock = scene.instantiate()
	_dock.name = "PolarisKeySetup"
	if has_method("add_dock") and ClassDB.class_exists("EditorDock"):
		_editor_dock = ClassDB.instantiate("EditorDock")
		_editor_dock.set("name", "PolarisKey")
		_editor_dock.set("title", DOCK_TITLE)
		_editor_dock.set("layout_key", "polaris_key_setup")
		_editor_dock.set("default_slot", DOCK_SLOT_RIGHT_UL)
		var icon := _brand_icon()
		if icon != null:
			_editor_dock.set("dock_icon", icon)
		_editor_dock.add_child(_dock)
		call("add_dock", _editor_dock)
	else:
		add_control_to_dock(DOCK_SLOT_RIGHT_UL, _dock)


func _exit_tree() -> void:
	if _export_plugin != null:
		remove_export_plugin(_export_plugin)
		_export_plugin = null
	if _android_export_plugin != null:
		remove_export_plugin(_android_export_plugin)
		_android_export_plugin = null
	if _editor_dock != null:
		call("remove_dock", _editor_dock)
		_editor_dock.queue_free()
		_editor_dock = null
		_dock = null
	elif _dock != null:
		remove_control_from_docks(_dock)
		_dock.queue_free()
		_dock = null


## The editor glyph as a texture at the editor's scale, or null (an unreadable file only loses the
## icon). brand/ is `.gdignore`d: an imported SVG's `.import` file differs between engine versions.
func _brand_icon() -> Texture2D:
	var svg := FileAccess.get_file_as_string(DOCK_ICON)
	if svg.is_empty():
		return null
	var image := Image.new()
	if image.load_svg_from_string(svg, EditorInterface.get_editor_scale()) != OK:
		return null
	return ImageTexture.create_from_image(image)
