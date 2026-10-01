class_name PKeyMemoryStore
extends PKeyStore
## Nothing persists (tests, replays, kiosk demos). Reports backend `memory`.

var token := ""
var device_id := ""
var cache: Variant = null
## How many times write_cache ran (tests assert one write per sync pass).
var cache_writes := 0


## An empty `p_device_id` mints a random one for this store's lifetime.
func _init(p_device_id := "", p_token := "") -> void:
	device_id = p_device_id if p_device_id != "" else PKeyDeviceId.from_raw("memory", PKeyDeviceId.random_uuid())
	token = p_token


func get_token() -> String:
	return token


func set_token(p_token: String) -> bool:
	token = p_token
	return true


func clear_token() -> bool:
	token = ""
	return true


func get_device_id() -> String:
	return device_id


func read_cache() -> Variant:
	return cache.duplicate(true) if cache is Dictionary else null


func write_cache(record: Dictionary) -> bool:
	cache_writes += 1
	cache = record.duplicate(true)
	return true


func clear_cache() -> bool:
	cache = null
	return true


func status() -> Dictionary:
	return {"backend": "memory"}
