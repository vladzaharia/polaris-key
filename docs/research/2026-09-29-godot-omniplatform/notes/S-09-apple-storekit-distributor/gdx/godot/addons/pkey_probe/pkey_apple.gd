class_name PKeyApple
extends Node
## S-09 probe of P5-05's facade: typed GDScript over the PolarisKeyApple GDExtension.
## The native side exposes one static cmd(json) -> String. Asynchronous results and events are
## queued natively (from any thread) and drained here, on the main thread, once per frame; the
## signals are declared and emitted in GDScript, so Swift never calls into the engine.
## Without the class (desktop, or an iOS export without the plugin) every call returns
## {"ok": false, "unsupported": true, "reason": "runtime" | "dependency"}.

signal transaction_updated(jws: String, info: Dictionary)
signal pack_progress(id: String, bytes: int, total: int)
signal pack_ready(id: String, path: String)
signal pack_failed(id: String, err: String)

const NATIVE := "PolarisKeyApple"

var _results := {}
var polls := 0
var events_seen := 0


static func unsupported_reason() -> String:
	if OS.get_name() != "iOS":
		return "runtime"
	if not ClassDB.class_exists(NATIVE):
		return "dependency"
	return ""


func call_sync(q: Dictionary) -> Dictionary:
	var why := unsupported_reason()
	if why != "":
		return {"ok": false, "unsupported": true, "reason": why}
	var s: String = ClassDB.class_call_static(NATIVE, "cmd", JSON.stringify(q))
	var r = JSON.parse_string(s)
	return r if r is Dictionary else {"ok": false, "error": "bad reply", "raw": s}


func call_async(q: Dictionary, timeout_s := 30.0) -> Dictionary:
	var r := call_sync(q)
	if not r.has("req"):
		return r
	var req := int(r.req)
	var t0 := Time.get_ticks_msec()
	while not _results.has(req):
		if Time.get_ticks_msec() - t0 > int(timeout_s * 1000):
			return {"ok": false, "error": "timeout", "req": req}
		await get_tree().process_frame
	var out: Dictionary = _results[req]
	_results.erase(req)
	out["godot_wait_ms"] = Time.get_ticks_msec() - t0
	return out


func _process(_delta: float) -> void:
	if unsupported_reason() != "":
		return
	polls += 1
	var r := call_sync({"op": "poll"})
	for ev in r.get("events", []):
		events_seen += 1
		if ev.has("req"):
			_results[int(ev.req)] = ev
		match str(ev.get("ev", "")):
			"transaction_updated":
				transaction_updated.emit(str(ev.get("jws", "")), ev)
			"pack_progress":
				pack_progress.emit(str(ev.id), int(ev.bytes), int(ev.total))
			"pack_ready":
				pack_ready.emit(str(ev.id), str(ev.path))
			"pack_failed":
				pack_failed.emit(str(ev.id), str(ev.err))
