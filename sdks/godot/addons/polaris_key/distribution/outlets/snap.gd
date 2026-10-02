class_name PKeySnapAdapter
extends PKeyPlatformAdapter
## Snap: silent; snapd refreshes the game.


func _init() -> void:
	kind = "snap"
	body_key = "update_platform_store"
