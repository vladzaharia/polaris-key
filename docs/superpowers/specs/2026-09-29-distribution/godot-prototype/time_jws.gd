extends SceneTree
const Jws := preload("res://addons/polaris_key/core/jws.gd")
func _init() -> void:
	var corpus: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://cases.json"))
	for id in ["valid-stable", "payload-at-cap"]:
		for c in corpus["jwsCases"]:
			if c["id"] != id:
				continue
			Jws.verify_jws(c["jws"], c["trust"], c["typ"])
			var t := Time.get_ticks_usec()
			var ok := false
			for i in 5:
				ok = not Jws.verify_jws(c["jws"], c["trust"], c["typ"]).is_empty()
			print("%s (%d chars): ok=%s %.1f ms" % [id, String(c["jws"]).length(), ok, (Time.get_ticks_usec() - t) / 5000.0])
	quit()
