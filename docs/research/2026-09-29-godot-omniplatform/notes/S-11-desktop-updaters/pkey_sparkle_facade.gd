class_name PKeySparkle
extends RefCounted
## S-11 facade sketch: answers Unsupported (runtime | dependency) without the native class.

static func open() -> Dictionary:
	if OS.get_name() != "macOS":
		return {"ok": false, "unsupported": "runtime"}
	if not ClassDB.class_exists(&"PKeySparkleNative"):
		return {"ok": false, "unsupported": "dependency"}
	var info: Dictionary = ClassDB.class_call_static(&"PKeySparkleNative", &"bundle_info")
	if not info.get("sparkle_loaded", false):
		return {"ok": false, "unsupported": "dependency"}
	return {"ok": true, "native": ClassDB.instantiate(&"PKeySparkleNative"), "info": info}
