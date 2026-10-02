class_name PKeySteamAdapter
extends PKeyPlatformAdapter
## Steam: silent; Steam updates the game. Never a download, a swap or a native updater, even when the game ships its own (README §4.7).


func _init() -> void:
	kind = "steam"
	body_key = "update_platform_steam"
