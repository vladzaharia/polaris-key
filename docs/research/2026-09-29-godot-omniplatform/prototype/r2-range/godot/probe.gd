# S-02 Godot probe: does Godot's HTTPRequest send Range and If-Range as given, what Accept-Encoding
# does it add, and does it hand a 206 body back intact?
#
#   PROBE_URL=http://127.0.0.1:8787/b/s02/blobs/sha256/<hex> PROBE_SHA=<hex> \
#     godot --headless --script godot/probe.gd
#
# Prints one line per case: case, result, status, body bytes, Content-Range, ETag.
extends SceneTree

var cases := []
var http: HTTPRequest
var url := ""
var sha := ""


func _init() -> void:
	url = OS.get_environment("PROBE_URL")
	sha = OS.get_environment("PROBE_SHA")
	var etag := '"%s"' % sha
	cases = [
		["no-range", PackedStringArray(), true],
		["single-range", PackedStringArray(["Range: bytes=0-99"]), true],
		["single-range-no-gzip", PackedStringArray(["Range: bytes=0-99"]), false],
		["if-range-match", PackedStringArray(["Range: bytes=100-199", "If-Range: " + etag]), true],
		["if-range-stale", PackedStringArray(["Range: bytes=100-199", 'If-Range: "%s"' % "0".repeat(64)]), true],
		["multi-range", PackedStringArray(["Range: bytes=0-9,20-29"]), true],
	]
	http = HTTPRequest.new()
	root.add_child.call_deferred(http)
	http.request_completed.connect(_done)
	_next.call_deferred()


var current := -1


func _next() -> void:
	current += 1
	if current >= cases.size():
		quit(0)
		return
	var c = cases[current]
	http.accept_gzip = c[2]
	var err := http.request(url + "?godot-" + c[0], c[1])
	if err != OK:
		print("%s\terror %d" % [c[0], err])
		_next.call_deferred()


func _done(result: int, code: int, headers: PackedStringArray, body: PackedByteArray) -> void:
	var cr := ""
	var et := ""
	for h in headers:
		var l := h.to_lower()
		if l.begins_with("content-range:"):
			cr = h.substr(14).strip_edges()
		if l.begins_with("etag:"):
			et = h.substr(5).strip_edges()
	print("%s\tresult=%d\tstatus=%d\tbytes=%d\tcontent-range=%s\tetag=%s" % [cases[current][0], result, code, body.size(), cr, et.left(12)])
	_next.call_deferred()
