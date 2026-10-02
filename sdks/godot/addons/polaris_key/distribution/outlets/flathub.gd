class_name PKeyFlathubAdapter
extends PKeyPlatformAdapter
## Flathub: silent; Flatpak updates the game (`flatpak update` or the software centre).


func _init() -> void:
	kind = "flathub"
	body_key = "update_platform_store"
