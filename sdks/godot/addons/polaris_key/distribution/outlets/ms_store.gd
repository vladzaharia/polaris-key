class_name PKeyMsStoreAdapter
extends PKeyStoreAdapter
## The Microsoft Store: the listing under `https://apps.microsoft.com/detail/` (`ms-windows-store://` is never opened). A `StoreContext` hook is P5-07's.


func _init() -> void:
	kind = "ms-store"
	action_key = "update_store"
