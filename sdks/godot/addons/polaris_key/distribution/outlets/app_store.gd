class_name PKeyAppStoreAdapter
extends PKeyStoreAdapter
## The App Store and the Mac App Store. Its listing prefixes are `https://apps.apple.com/` and `itms-apps://apps.apple.com/`; only the https one is opened. P5-05 adds the in-app store sheet (`SKStoreProductViewController`).


func _init() -> void:
	kind = "app-store"
	action_key = "update_store"
