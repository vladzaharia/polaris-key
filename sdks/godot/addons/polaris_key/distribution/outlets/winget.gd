class_name PKeyWingetAdapter
extends PKeyPlatformAdapter
## winget: silent; the player runs `winget upgrade`.


func _init() -> void:
	kind = "winget"
	body_key = "update_platform_winget"
