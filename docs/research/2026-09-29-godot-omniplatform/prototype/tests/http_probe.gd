extends SceneTree
# godot --headless --path . --script res://tests/http_probe.gd
# Godot does not read HTTPS_PROXY itself; when it is set (e.g. http://127.0.0.1:3128), the probe
# applies it explicitly. The proxy's CA must be in the OS trust store, which Godot's Linux build loads.
# Needs network access to httpbin.org and postman-echo.com.

var proxy_host := ""
var proxy_port := -1

func _init() -> void:
	var p := OS.get_environment("HTTPS_PROXY")
	if p == "":
		p = OS.get_environment("https_proxy")
	if p != "":
		var hostport := p.split("://")[-1].trim_suffix("/").split("@")[-1]
		var i := hostport.rfind(":")
		if i > 0:
			proxy_host = hostport.substr(0, i)
			proxy_port = int(hostport.substr(i + 1))

func _mk(gzip := true) -> HTTPRequest:
	var r := HTTPRequest.new()
	if proxy_port > 0:
		r.set_https_proxy(proxy_host, proxy_port)
	r.accept_gzip = gzip
	r.timeout = 30
	root.add_child(r)
	return r

func _req(url: String, headers: PackedStringArray, gzip := true, file := "", max_redirects := 8) -> Array:
	var r := _mk(gzip)
	r.max_redirects = max_redirects
	if file != "":
		r.download_file = file
	var err := r.request(url, headers)
	if err != OK:
		return [err, 0, PackedStringArray(), PackedByteArray()]
	var res: Array = await r.request_completed
	r.queue_free()
	return res

func _hdr(headers: PackedStringArray, name: String) -> String:
	for h in headers:
		var i := h.find(":")
		if i > 0 and h.substr(0, i).strip_edges().to_lower() == name.to_lower():
			return h.substr(i + 1).strip_edges()
	return ""

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	print("system CA bundle length (OS.get_system_ca_certificates): ", OS.get_system_ca_certificates().length())
	# 1. custom headers incl. Authorization echoed back
	var res = await _req("https://httpbin.org/headers", ["Authorization: Bearer pkeyt_TESTTOKEN", "X-PKey-SDK: godot", "X-PKey-Device: dev_123"])
	print("[1] custom headers: result=%d code=%d echoed=%s" % [res[0], res[1], JSON.parse_string(res[3].get_string_from_utf8()).headers if res[1] == 200 else "-"])
	# 2. ETag / If-None-Match -> 304
	res = await _req("https://httpbin.org/etag/abc123", [])
	var etag := _hdr(res[2], "ETag")
	print("[2a] first GET: code=%d ETag=%s body=%dB" % [res[1], etag, res[3].size()])
	res = await _req("https://httpbin.org/etag/abc123", ["If-None-Match: " + etag])
	print("[2b] conditional GET: code=%d body=%dB (304 expected, surfaced to caller, not auto-handled)" % [res[1], res[3].size()])
	# 3. Range -> 206 (gzip off so the range applies to identity bytes)
	res = await _req("https://httpbin.org/range/1000", ["Range: bytes=100-199"], false)
	print("[3] Range bytes=100-199: code=%d Content-Range=%s body=%dB" % [res[1], _hdr(res[2], "Content-Range"), res[3].size()])
	# 4. download_file + Range: does it append or truncate?
	var path := "user://resume_test.bin"
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_buffer("PREFIX-0123456789".to_utf8_buffer())
	f.close()
	res = await _req("https://httpbin.org/range/1000", ["Range: bytes=500-599"], false, path)
	var size_after := FileAccess.get_file_as_bytes(path).size()
	print("[4] download_file with Range into pre-existing 17-byte file: code=%d file size after=%d (117 = append, 100 = TRUNCATED)" % [res[1], size_after])
	# 5. redirect to another host: is Authorization forwarded?
	res = await _req("https://httpbin.org/redirect-to?url=https%3A%2F%2Fpostman-echo.com%2Fheaders", ["Authorization: Bearer pkeyt_SECRET_SHOULD_NOT_LEAK"])
	var echoed = JSON.parse_string(res[3].get_string_from_utf8()) if res[1] == 200 else null
	print("[5] cross-host redirect: final code=%d; Authorization seen by redirect target: %s" % [res[1], echoed.headers.get("authorization", "<absent>") if echoed else "-"])
	res = await _req("https://httpbin.org/redirect-to?url=https%3A%2F%2Fpostman-echo.com%2Fheaders", ["Authorization: Bearer x"], true, "", 0)
	print("[5b] same with max_redirects=0: result=%d code=%d Location=%s" % [res[0], res[1], _hdr(res[2], "Location")])
	# 6. TLS: common-name mismatch must fail
	var r := _mk()
	r.set_tls_options(TLSOptions.client(null, "not-the-right-name.example"))
	r.request("https://httpbin.org/get")
	res = await r.request_completed
	print("[6] TLS with wrong common-name override: result=%d (RESULT_TLS_HANDSHAKE_ERROR=%d) code=%d" % [res[0], HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR, res[1]])
	# 7. resumable download with low-level HTTPClient streaming + append
	await _resume_demo()
	quit()

func _resume_demo() -> void:
	var path := "user://resume_demo.bin"
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.close()
	var total := 0
	for part in [[0, 399], [400, 999]]:
		var c := HTTPClient.new()
		if proxy_port > 0:
			c.set_https_proxy(proxy_host, proxy_port)
		c.connect_to_host("httpbin.org", 443, TLSOptions.client())
		while c.get_status() in [HTTPClient.STATUS_CONNECTING, HTTPClient.STATUS_RESOLVING]:
			c.poll()
			await process_frame
		var have := FileAccess.get_file_as_bytes(path).size()
		c.request(HTTPClient.METHOD_GET, "/range/1000", ["Range: bytes=%d-%d" % [have, part[1]], "Accept-Encoding: identity"])
		while c.get_status() == HTTPClient.STATUS_REQUESTING:
			c.poll()
			await process_frame
		var code := c.get_response_code()
		var fa := FileAccess.open(path, FileAccess.READ_WRITE)
		fa.seek_end()
		while c.get_status() == HTTPClient.STATUS_BODY:
			c.poll()
			var chunk := c.read_response_body_chunk()
			if chunk.size() > 0:
				fa.store_buffer(chunk)
			else:
				await process_frame
		fa.close()
		print("[7] HTTPClient Range %d-%d: code=%d file now %d B" % [have, part[1], code, FileAccess.get_file_as_bytes(path).size()])
	var data := FileAccess.get_file_as_bytes(path)
	print("[7] resumed file size=%d, first bytes=%s last=%s" % [data.size(), data.slice(0, 8).get_string_from_ascii(), data.slice(992, 1000).get_string_from_ascii()])
