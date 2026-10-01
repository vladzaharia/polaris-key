class_name PKeyFakeServer
extends Node
## A loopback HTTP/1.1 server for the SDK's tests: a `TCPServer` on 127.0.0.1, polled every
## frame from `_process`, so it runs on the same main loop as the `HTTPRequest`s it answers.
## Writes are non-blocking (`put_partial_data`, spread across frames), so a large response
## cannot deadlock the single thread the client and the server share.
##
## `handler` is `func(req: Dictionary) -> Dictionary`. The request is {method, path, headers
## (lower-case names), body: PackedByteArray}; the answer is {status, headers?: Dictionary,
## body?: String | PackedByteArray, hang?: bool}. `hang` never answers (for timeouts). Every
## request is appended to `requests`. The transcript replayer (transcript_replay.gd) installs a
## handler that serves P1b-03's conformance/transcripts format.

var handler: Callable
var requests: Array = []
var port := 0

var _server := TCPServer.new()
var _conns: Array = []


## Listen on a kernel-assigned loopback port. False when none could be bound.
func listen() -> bool:
	if _server.listen(0, "127.0.0.1") != OK:
		return false
	port = _server.get_local_port()
	return port > 0


func base_url() -> String:
	return "http://127.0.0.1:%d" % port


func stop() -> void:
	for c in _conns:
		c["peer"].disconnect_from_host()
	_conns.clear()
	_server.stop()


func _exit_tree() -> void:
	stop()


func _process(_delta: float) -> void:
	while _server.is_connection_available():
		var peer := _server.take_connection()
		_conns.append({"peer": peer, "in": PackedByteArray(), "out": PackedByteArray(), "state": "read"})
	var keep: Array = []
	for c in _conns:
		if _pump(c):
			keep.append(c)
	_conns = keep


## Returns false once the connection is finished.
func _pump(c: Dictionary) -> bool:
	var peer: StreamPeerTCP = c["peer"]
	peer.poll()
	var st := peer.get_status()
	if st == StreamPeerTCP.STATUS_ERROR or st == StreamPeerTCP.STATUS_NONE:
		return false
	if st != StreamPeerTCP.STATUS_CONNECTED:
		return true
	match c["state"]:
		"read":
			var n := peer.get_available_bytes()
			if n > 0:
				var got: Array = peer.get_partial_data(n)
				if got[0] == OK:
					c["in"].append_array(got[1])
			var req = _parse(c["in"])
			if req != null:
				requests.append(req)
				var res: Dictionary = handler.call(req) if handler.is_valid() else {"status": 404}
				if res.get("hang", false):
					c["state"] = "hang"
				else:
					c["out"] = _render(res)
					c["state"] = "write"
		"write":
			var out: PackedByteArray = c["out"]
			if out.is_empty():
				peer.disconnect_from_host()
				return false
			var sent: Array = peer.put_partial_data(out)
			if sent[0] != OK:
				return false
			c["out"] = out.slice(sent[1])
	return true


## A complete request (head plus Content-Length body), or null when more bytes are needed.
static func _parse(buf: PackedByteArray) -> Variant:
	var head_end := -1
	for i in range(maxi(0, buf.size() - 3)):
		if buf[i] == 13 and buf[i + 1] == 10 and buf[i + 2] == 13 and buf[i + 3] == 10:
			head_end = i
			break
	if head_end < 0:
		return null
	var head := buf.slice(0, head_end).get_string_from_utf8()
	var lines := head.split("\r\n")
	var first := lines[0].split(" ")
	if first.size() < 2:
		return null
	var headers := {}
	for k in range(1, lines.size()):
		var i := lines[k].find(":")
		if i > 0:
			headers[lines[k].substr(0, i).strip_edges().to_lower()] = lines[k].substr(i + 1).strip_edges()
	var length := int(headers.get("content-length", "0"))
	var body_start := head_end + 4
	if buf.size() < body_start + length:
		return null
	return {
		"method": first[0],
		"path": first[1],
		"headers": headers,
		"body": buf.slice(body_start, body_start + length),
	}


static func _render(res: Dictionary) -> PackedByteArray:
	var status: int = res.get("status", 200)
	var b = res.get("body", "")
	var body: PackedByteArray = b if b is PackedByteArray else str(b).to_utf8_buffer()
	if status == 304 or status == 204:
		body = PackedByteArray()
	var head := "HTTP/1.1 %d %s\r\n" % [status, _reason(status)]
	var headers: Dictionary = res.get("headers", {})
	for k in headers:
		if String(k).to_lower() != "content-length":
			head += "%s: %s\r\n" % [k, headers[k]]
	head += "Content-Length: %d\r\nConnection: close\r\n\r\n" % body.size()
	var out := head.to_utf8_buffer()
	out.append_array(body)
	return out


static func _reason(status: int) -> String:
	match status:
		200: return "OK"
		301: return "Moved Permanently"
		302: return "Found"
		303: return "See Other"
		304: return "Not Modified"
		307: return "Temporary Redirect"
		401: return "Unauthorized"
		403: return "Forbidden"
		404: return "Not Found"
		429: return "Too Many Requests"
		500: return "Internal Server Error"
	return "Status"
