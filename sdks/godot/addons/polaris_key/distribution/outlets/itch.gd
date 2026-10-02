class_name PKeyItchAdapter
extends PKeyPlatformAdapter
## itch: silent; the itch app updates the game (butler). The game's own updater never runs here (README §4.7).


func _init() -> void:
	kind = "itch"
	body_key = "update_platform_itch"
