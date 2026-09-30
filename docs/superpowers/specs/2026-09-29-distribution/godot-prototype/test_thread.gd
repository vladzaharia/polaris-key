extends SceneTree
const Ed := preload("res://addons/polaris_key/crypto/ed25519.gd")
var results := []
var mutex := Mutex.new()
func _job(i: int, t: Dictionary) -> void:
	var ok := Ed.verify(String(t["pub"]).hex_decode(), String(t["msg"]).hex_decode(), String(t["sig"]).hex_decode())
	mutex.lock()
	results.append([i, ok == bool(t["ok"])])
	mutex.unlock()
func _init() -> void:
	var v: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://vectors.json"))
	Ed.sha512(PackedByteArray())  # static setup on main thread first
	var ids := []
	var t0 := Time.get_ticks_msec()
	for i in v["ed"].size():
		ids.append(WorkerThreadPool.add_task(_job.bind(i, v["ed"][i])))
	for id in ids:
		WorkerThreadPool.wait_for_task_completion(id)
	var bad := results.filter(func(r): return not r[1]).size()
	print("threaded: %d tasks, %d wrong, %d ms wall" % [results.size(), bad, Time.get_ticks_msec() - t0])
	quit()
