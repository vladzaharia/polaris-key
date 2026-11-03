class_name PKeyLoopbackListener
extends RefCounted
## The loopback listener of a native redirect sign-in (WIRE-CONTRACT-V5 §12.12 item 6, RFC 8252 §7.3).
## It binds 127.0.0.1 (never a wildcard or `localhost`) on an OS-assigned port when it is built, so
## the redirect URI is known before the request is pushed and the socket is held until the callback.
## `start(accept)` begins serving; `poll()` is driven every frame by a PKeyLoopbackTicker (and by the
## session's wait loop), so nothing here blocks or needs a thread.
##
## Rules:
##   * One request: `GET /pkey/callback` whose `Host` is exactly `127.0.0.1:<port>`; anything else
##     (another method, path, Host, a second Host, a malformed head) is answered `404` with no body
##     and the listener keeps listening. Nothing is served but status lines and the headers below.
##   * `accept(callback_url) -> [location, final]` decides (the session checks the redirect URI,
##     `state` in constant time, `iss`, the code and the handle). A non-empty `location` is answered
##     with ONE `303` carrying `Location`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`
##     and `Content-Length: 0`: no body, no CORS headers, no cookies. `final` ends the listener.
##   * A head holding a bare LF, a CR not followed by LF or a NUL is answered `404` unparsed.
##   * At most MAX_CONNECTIONS open connections (a newcomer takes the place of the oldest one still
##     waiting for its request; if every one has been answered it is dropped at once), each held for at most
##     `head_deadline` seconds while the request head arrives, at most MAX_HEAD bytes of it.
##   * The listener closes after the first accepted callback, after `lifetime` seconds (600, the
##     pushed request's own), or on `close()`. A closed listener has released its port.
## The request line carries the code, so it is never logged or kept: the only copy is the string
## handed to `accept`.

const MAX_CONNECTIONS := 8
const MAX_HEAD := 8192
const LISTEN_LIFETIME_SECONDS := 600.0
const HEAD_DEADLINE_SECONDS := 5.0
## A connection that has been answered is kept this long so the answer is flushed before the close.
const DRAIN_MS := 1000

## The OS-assigned port; 0 when the bind failed.
var port := 0
## OK, or the error the bind returned.
var bind_error := OK

var _server := TCPServer.new()
var _accept: Callable = Callable()
var _conns: Array = []
var _started := false
var _done := false
var _closed := false
var _lifetime_ms := 0
var _head_deadline_ms := 0
var _deadline := 0


func _init(lifetime := LISTEN_LIFETIME_SECONDS, head_deadline := HEAD_DEADLINE_SECONDS) -> void:
	_lifetime_ms = int(lifetime * 1000.0)
	_head_deadline_ms = int(head_deadline * 1000.0)
	bind_error = _server.listen(0, "127.0.0.1")
	if bind_error != OK:
		_closed = true
		return
	port = _server.get_local_port()


## True when the socket is bound (the redirect URI can be built).
func is_bound() -> bool:
	return bind_error == OK and port > 0


func is_closed() -> bool:
	return _closed


## Serve until the first accepted callback, the lifetime or `close()`.
func start(accept: Callable) -> void:
	if _closed or _started:
		return
	_accept = accept
	_started = true
	_deadline = Time.get_ticks_msec() + _lifetime_ms


func close() -> void:
	if _closed:
		return
	_closed = true
	_accept = Callable()
	_server.stop()
	for c in _conns:
		(c["peer"] as StreamPeerTCP).disconnect_from_host()
	_conns.clear()


## One step: take new connections, read request heads, answer, enforce the deadlines.
func poll() -> void:
	if _closed or not _started:
		return
	var now := Time.get_ticks_msec()
	if now >= _deadline:
		close()
		return
	while not _done and _server.is_listening() and _server.is_connection_available():
		var peer := _server.take_connection()
		if peer == null:
			break
		if _conns.size() >= MAX_CONNECTIONS and not _evict_oldest():
			peer.disconnect_from_host()
			continue
		_conns.append({"peer": peer, "buf": PackedByteArray(), "at": now, "answered": false})
	for c in _conns.duplicate():
		_serve(c, now)
	if _done and _conns.is_empty():
		close()


## Makes room for a newcomer by dropping the oldest connection still waiting for its request (an
## answered one is flushing its reply and stays). False when every connection has been answered.
func _evict_oldest() -> bool:
	var oldest: Variant = null
	for c: Dictionary in _conns:
		if c["answered"]:
			continue
		if oldest == null or int(c["at"]) < int((oldest as Dictionary)["at"]):
			oldest = c
	if oldest == null:
		return false
	_drop(oldest)
	return true


func _drop(c: Dictionary) -> void:
	(c["peer"] as StreamPeerTCP).disconnect_from_host()
	_conns.erase(c)


func _serve(c: Dictionary, now: int) -> void:
	var peer: StreamPeerTCP = c["peer"]
	peer.poll()
	var status := peer.get_status()
	if status != StreamPeerTCP.STATUS_CONNECTED:
		_conns.erase(c)
		return
	if c["answered"]:
		# Nothing more is read for a reason: let the answer flush, then close.
		if now - int(c["at"]) > DRAIN_MS:
			_drop(c)
		return
	if now - int(c["at"]) > _head_deadline_ms:
		_drop(c)
		return
	var avail := peer.get_available_bytes()
	if avail <= 0:
		return
	var buf: PackedByteArray = c["buf"]
	var got := peer.get_partial_data(mini(avail, MAX_HEAD + 1 - buf.size()))
	if got[0] != OK:
		_drop(c)
		return
	buf.append_array(got[1])
	c["buf"] = buf
	var end := _head_end(buf)
	if end < 0:
		if buf.size() > MAX_HEAD:
			_drop(c)
		return
	if end > MAX_HEAD:
		_drop(c)
		return
	c["buf"] = PackedByteArray()
	c["answered"] = true
	c["at"] = now
	var head := buf.slice(0, end)
	_answer(c, "" if _malformed(head) else head.get_string_from_utf8())


## The index of the first byte after the blank line ending the head, or -1.
static func _head_end(buf: PackedByteArray) -> int:
	for i in range(0, buf.size() - 3):
		if buf[i] == 13 and buf[i + 1] == 10 and buf[i + 2] == 13 and buf[i + 3] == 10:
			return i + 4
	return -1


## True when the head holds a NUL, a CR not followed by LF, or an LF not preceded by CR.
static func _malformed(head: PackedByteArray) -> bool:
	for i in head.size():
		var b := head[i]
		if b == 0:
			return true
		if b == 13 and (i + 1 >= head.size() or head[i + 1] != 10):
			return true
		if b == 10 and (i == 0 or head[i - 1] != 13):
			return true
	return false


func _answer(c: Dictionary, head: String) -> void:
	var target := _target_of(head)
	if target == "":
		_respond(c, "")
		return
	var location := ""
	if not _done and _accept.is_valid():
		var result = _accept.call("http://127.0.0.1:%d%s" % [port, target])
		if result is Array and result.size() == 2:
			location = String(result[0])
			if result[1] == true:
				# The first accepted callback wins; the port is released now and the rest dropped.
				_done = true
				_server.stop()
	_respond(c, location)


## The request target when `head` is `GET /pkey/callback…` for this listener's own Host, else "".
func _target_of(head: String) -> String:
	var lines := head.split("\r\n")
	var parts := lines[0].split(" ")
	if parts.size() != 3 or parts[0] != "GET" or not parts[2].begins_with("HTTP/1."):
		return ""
	var target := parts[1]
	if not target.begins_with("/") or target.contains("#"):
		return ""
	var q := target.find("?")
	if (target if q == -1 else target.substr(0, q)) != PKeyNativeRedirect.NATIVE_REDIRECT_PATH:
		return ""
	var hosts: Array = []
	for i in range(1, lines.size()):
		if lines[i] == "":
			break
		var colon: int = lines[i].find(":")
		if colon > 0 and lines[i].substr(0, colon).strip_edges().to_lower() == "host":
			hosts.append(lines[i].substr(colon + 1).strip_edges())
	if hosts.size() != 1 or String(hosts[0]).to_lower() != "127.0.0.1:%d" % port:
		return ""
	return target


## `303 location` or, with no location, `404`; no body either way.
func _respond(c: Dictionary, location: String) -> void:
	var lines: PackedStringArray = []
	if location != "" and not location.contains("\r") and not location.contains("\n"):
		lines.append("HTTP/1.1 303 See Other")
		lines.append("Location: " + location)
	else:
		lines.append("HTTP/1.1 404 Not Found")
	lines.append("Cache-Control: no-store")
	lines.append("Referrer-Policy: no-referrer")
	lines.append("Content-Length: 0")
	lines.append("Connection: close")
	(c["peer"] as StreamPeerTCP).put_data(("\r\n".join(lines) + "\r\n\r\n").to_utf8_buffer())
