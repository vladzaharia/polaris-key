@tool
extends EditorPlugin
# Editor shell for the Polaris Key addon: enabling the plugin registers the `PolarisKey`
# autoload, disabling it removes it. P1-11 adds the export plugin.

const AUTOLOAD_NAME := "PolarisKey"
const AUTOLOAD_PATH := "res://addons/polaris_key/polaris_key.gd"


func _enable_plugin() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)


func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
