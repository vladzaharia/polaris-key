class_name PKeyPlayAdapter
extends PKeyStoreAdapter
## Google Play: the listing (`https://play.google.com/store/apps/details?id=`; `market://` is never opened). P5-06 adds Play In-App Updates.


func _init() -> void:
	kind = "play"
	action_key = "update_store"
