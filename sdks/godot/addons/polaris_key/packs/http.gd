class_name PKeyPackHttp
extends RefCounted
## One pack object GET, streamed chunk by chunk to the engine, on HTTPClient (P4-08; notes/A5 §4,
## prototype README's HTTP findings). It keeps every rule of PKeyTransport and PKeyDownload:
##
##   - redirects are followed HERE (`max_redirects` is never left to the engine): the bearer is
##     dropped as soon as the origin changes and never comes back, and a redirect to plain http on
##     a non-loopback host is refused;
##   - `Accept-Encoding: identity`: gzip breaks `Range`;
##   - `Range: bytes=<offset>-` with `If-Range: "<sha256>"` (the strong ETag) on a resume, so a
##     resume never splices two versions; the ENGINE checks the answer (206 from the offset, or a
##     200 that starts over);
##   - `open_range`: one bounded `Range: bytes=<o>-<e>` (never a multi-range) with the If-Range the
##     chunk adapter derives from the signed index; the head comes back with the body unread and
##     the caller pulls it (PKeyPackChunks.chunk_range_fetch reads only an exact 206);
##   - one wall-clock deadline for the whole request (every hop and the whole body), never a
##     per-frame timer; each frame reads for at most READ_BUDGET_MSEC;
##   - local-only refuses before dialling.
##
## Why not HTTPRequest: `download_file` truncates its target and cannot resume, and on web it
## deletes the file after a "successful" download (S-05 §4.3).
##
##   var r := await PKeyPackHttp.fetch(transport, url, headers, offset, if_range, on_response,
##       on_chunk, 600.0)
##   # r: {status, content_range, error: "" | "timeout" | "aborted" | code, message}
##   var o := await PKeyPackHttp.open_range(transport, url, headers, offset, length, if_range, 600.0)
##   # o: the same plus etag and body (pulled with `await o.body.take(n)`, then `o.body.close()`)

const MAX_REDIRECTS := 5
const CHUNK := 256 * 1024
const READ_BUDGET_MSEC := 6


static func _done(status: int, content_range: String, error: String, message := "") -> Dictionary:
	return {"status": status, "content_range": content_range, "error": error, "message": message}


## GET `url` from `offset`: `on_response(status, content_range) -> bool` sees the head first
## (false aborts before the body), then each body chunk goes to `on_chunk(bytes) -> bool` (false
## aborts: `error` "aborted"). `headers` may carry `Authorization`; it is dropped once the origin changes.
## A coroutine.
static func fetch(transport: PKeyTransport, url: String, headers: Dictionary, offset: int, if_range: String, on_response: Callable, on_chunk: Callable, timeout: float) -> Dictionary:
	var extra := []
	if offset > 0:
		extra.append(["Range", "bytes=%d-" % offset])
		if if_range != "":
			extra.append(["If-Range", if_range])
	var deadline := Time.get_ticks_msec() + int(timeout * 1000.0)
	var head: Dictionary = await _request(transport, url, headers, extra, deadline)
	if head.has("done"):
		return head["done"]
	var client: HTTPClient = head["client"]
	var tree: SceneTree = head["tree"]
	var status: int = head["status"]
	var content_range := String(head["headers"].get("content-range", ""))
	if on_response.is_valid() and not on_response.call(status, content_range):
		client.close()
		return _done(status, content_range, "aborted")
	if status != 200 and status != 206:
		client.close()
		return _done(status, content_range, "")
	var err := ""
	while client.get_status() == HTTPClient.STATUS_BODY:
		var frame_start := Time.get_ticks_msec()
		while client.get_status() == HTTPClient.STATUS_BODY and Time.get_ticks_msec() - frame_start < READ_BUDGET_MSEC:
			client.poll()
			var chunk := client.read_response_body_chunk()
			if chunk.is_empty():
				break
			if not on_chunk.call(chunk):
				err = "aborted"
				break
		if err != "":
			break
		if Time.get_ticks_msec() >= deadline:
			err = "timeout"
			break
		if client.get_status() == HTTPClient.STATUS_BODY:
			await tree.process_frame
	if err == "" and client.get_status() != HTTPClient.STATUS_CONNECTED and client.get_status() != HTTPClient.STATUS_DISCONNECTED:
		err = String(PKeyErrors.NETWORK)
	client.close()
	return _done(status, content_range, err)


## One single-range GET of `length` bytes of `url` from `offset` (the chunk strategy, P4-11):
## `Range: bytes=<offset>-<offset+length-1>` (never a multi-range), `If-Range: <if_range>` when
## given, `Accept-Encoding: identity`, redirects and the bearer exactly as `fetch`. The head is
## answered before any body byte is read: {status, content_range, etag (String; null when the
## response has no ETag header: Godot's header dictionary keeps an `ETag:` line with an empty value
## as "", so absent and empty stay distinct, and an empty one is refused like any other tag),
## error, message, body: a Body (unread, pulled by the caller; close it) or null}. A coroutine.
static func open_range(transport: PKeyTransport, url: String, headers: Dictionary, offset: int, length: int, if_range: String, timeout: float) -> Dictionary:
	if offset < 0 or length <= 0:
		return {"status": 0, "content_range": "", "etag": null, "error": String(PKeyErrors.INVALID_OPTIONS), "message": "A range needs offset >= 0 and length > 0.", "body": null}
	var extra := [["Range", "bytes=%d-%d" % [offset, offset + length - 1]]]
	if if_range != "":
		extra.append(["If-Range", if_range])
	var deadline := Time.get_ticks_msec() + int(timeout * 1000.0)
	var head: Dictionary = await _request(transport, url, headers, extra, deadline)
	if head.has("done"):
		var d: Dictionary = head["done"]
		d["etag"] = null
		d["body"] = null
		return d
	var h: Dictionary = head["headers"]
	var status: int = head["status"]
	var out := _done(status, String(h.get("content-range", "")), "")
	out["etag"] = String(h["etag"]) if h.has("etag") else null
	out["body"] = Body.new(head["client"], head["tree"], deadline)
	return out


## A response body pulled by its reader (open_range): `take(n)` reads from the connection only
## until it holds `n` bytes (polling once per frame while nothing has arrived), so at most one
## HTTPClient chunk beyond the request is ever buffered.
class Body extends RefCounted:
	var client: HTTPClient
	var tree: SceneTree
	var deadline := 0
	var declared := -1
	var received := 0
	var _pending := PackedByteArray()
	var _ended := false
	var _failed := false

	func _init(p_client: HTTPClient, p_tree: SceneTree, p_deadline: int) -> void:
		client = p_client
		tree = p_tree
		deadline = p_deadline
		declared = client.get_response_body_length() if client.has_response() else -1

	## The next `n` bytes; fewer when the body ended where its length said it would; null when the
	## transfer failed (a drop before the declared length, a timeout). A coroutine.
	func take(n: int) -> Variant:
		while _pending.size() < n and not _ended:
			if client == null or client.get_status() != HTTPClient.STATUS_BODY:
				_ended = true
				var st := client.get_status() if client != null else HTTPClient.STATUS_DISCONNECTED
				if st != HTTPClient.STATUS_CONNECTED and st != HTTPClient.STATUS_DISCONNECTED:
					_failed = true
				if declared >= 0 and received < declared:
					_failed = true
				break
			client.poll()
			if client.get_status() != HTTPClient.STATUS_BODY:
				continue
			var chunk := client.read_response_body_chunk()
			if chunk.is_empty():
				if Time.get_ticks_msec() >= deadline:
					_ended = true
					_failed = true
					break
				if client.get_status() == HTTPClient.STATUS_BODY:
					await tree.process_frame
				continue
			received += chunk.size()
			_pending.append_array(chunk)
		if _failed and _pending.size() < n:
			close()
			return null
		var out := _pending.slice(0, n)
		_pending = _pending.slice(out.size())
		return out

	func close() -> void:
		_ended = true
		if client != null:
			client.close()
			client = null


## Dial, send and follow redirects (the rules in the header): {client, tree, status, headers
## (lower-case names)} with the body unread, or {done: _done(...)} when no answer could be had.
static func _request(transport: PKeyTransport, url: String, headers: Dictionary, extra: Array, deadline: int) -> Dictionary:
	if transport != null and transport.local_only:
		return {"done": _done(0, "", String(PKeyErrors.LOCAL_ONLY), "This client is local-only; network calls are refused.")}
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return {"done": _done(0, "", String(PKeyErrors.NETWORK), "No SceneTree to poll the download on.")}
	var origin: String = PKeyTransport.parse_url(url).get("origin", "")
	if origin == "":
		return {"done": _done(0, "", String(PKeyErrors.NETWORK), "Not an http(s) URL.")}
	var h := headers.duplicate()
	var credentials := true
	var current := url
	var hops := 0
	while hops <= MAX_REDIRECTS:
		hops += 1
		if Time.get_ticks_msec() >= deadline:
			return {"done": _done(0, "", "timeout")}
		var target := PKeyTransport.parse_url(current)
		if target.is_empty() or not PKeyTransport._secure_target(target):
			return {"done": _done(0, "", String(PKeyErrors.INSECURE_REDIRECT), "Refusing a redirect to %s." % current)}
		if credentials and target["origin"] != origin:
			credentials = false
		if not credentials:
			for k in h.keys():
				if String(k).to_lower() == "authorization":
					h.erase(k)
		var client := HTTPClient.new()
		client.read_chunk_size = CHUNK
		var tls: TLSOptions = TLSOptions.client() if target["scheme"] == "https" else null
		var host: String = target["host"]
		if host.begins_with("[") and host.ends_with("]"):
			host = host.substr(1, host.length() - 2)
		if client.connect_to_host(host, int(target["port"]), tls) != OK:
			return {"done": _done(0, "", String(PKeyErrors.NETWORK), "Could not connect to %s." % host)}
		var st := await PKeyDownload._wait(client, tree, deadline, [HTTPClient.STATUS_RESOLVING, HTTPClient.STATUS_CONNECTING])
		if st == -1:
			client.close()
			return {"done": _done(0, "", "timeout")}
		if st != HTTPClient.STATUS_CONNECTED:
			client.close()
			return {"done": _done(0, "", String(PKeyErrors.NETWORK), "Could not connect (HTTPClient status %d)." % st)}
		var lines := PackedStringArray()
		var logged := {}
		for k in h:
			var lk := String(k).to_lower()
			if lk in ["range", "if-range", "accept-encoding"]:
				continue
			lines.append("%s: %s" % [k, h[k]])
			logged[lk] = "<redacted>" if lk == "authorization" else h[k]
		lines.append("Accept-Encoding: identity")
		logged["accept-encoding"] = "identity"
		for e in extra:
			lines.append("%s: %s" % [e[0], e[1]])
			logged[String(e[0]).to_lower()] = e[1]
		if transport != null:
			transport.sent.append({"method": "GET", "url": current, "headers": logged})
			if transport.sent.size() > 64:
				transport.sent.pop_front()
		if client.request(HTTPClient.METHOD_GET, target["path"], lines) != OK:
			client.close()
			return {"done": _done(0, "", String(PKeyErrors.NETWORK), "The request could not start.")}
		st = await PKeyDownload._wait(client, tree, deadline, [HTTPClient.STATUS_REQUESTING])
		if st == -1:
			client.close()
			return {"done": _done(0, "", "timeout")}
		if not client.has_response():
			client.close()
			return {"done": _done(0, "", String(PKeyErrors.NETWORK), "No response (HTTPClient status %d)." % st)}
		var status := client.get_response_code()
		var rh := PKeyDownload._lower(client.get_response_headers_as_dictionary())
		if PKeyTransport.REDIRECT_STATUSES.has(status) and String(rh.get("location", "")) != "":
			client.close()
			current = PKeyTransport.resolve(current, rh["location"])
			continue
		return {"client": client, "tree": tree, "status": status, "headers": rh}
	return {"done": _done(0, "", String(PKeyErrors.TOO_MANY_REDIRECTS), "More than %d redirects." % MAX_REDIRECTS)}
