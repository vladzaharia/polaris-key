class_name PKeyTestFlightAdapter
extends PKeyStoreAdapter
## TestFlight: the listing is a public link under `https://testflight.apple.com/join/`, which opens TestFlight.


func _init() -> void:
	kind = "testflight"
	action_key = "update_testflight"
