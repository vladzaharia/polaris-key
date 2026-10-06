class_name PKeyDownload
extends RefCounted
## A large download straight to a file, resumable with `Range` (P3-10: the sidecar `.pck`). It is
## the transport's sibling and keeps every one of its rules (core/transport.gd, notes/A5 §4):
##
##   - redirects are followed HERE, on `HTTPClient`: the bearer is dropped as soon as the origin
##     changes and never comes back, and a redirect to plain http on a non-loopback host is
##     refused;
##   - one wall-clock deadline for the whole request (every hop and the whole body), never a
##     per-frame timer;
##   - no gzip: `Accept-Encoding: identity`, because gzip breaks `Range`;
##   - local-only refuses before dialling.
##
## Why not HTTPRequest: `download_file` TRUNCATES the target, so it cannot resume, and its body
## limit is the API cap. Bytes go to `<dest>.part`; a `.part` that is already there is resumed
## with `Range: bytes=<size>-` (a 206 appends, a 200 starts over, a 416 for a complete file is
## done). The answer is never trusted: the caller verifies size and SHA-256 against the signed
## record before the file is used (plans/P3-01.md §2.5 step 19). A body longer than
## `expected_size` is refused and the `.part` removed.
##
##   var r := await PKeyDownload.fetch(core.transport, url, "user://…/payload.pck", headers,
##       {"expected_size": 1234, "timeout": 600.0, "progress": func(got, total): …})
##   # r.ok: detail {path: "<dest>.part", size, status, resumed}; else the transport's codes
##
## Each frame reads for at most READ_BUDGET_MSEC, so a fast download does not stall rendering.
## A timeout keeps the `.part` for the next attempt.

const MAX_REDIRECTS := 5
const CHUNK := 256 * 1024
const READ_BUDGET_MSEC := 6
const DEFAULT_TIMEOUT := 600.0
## The most of an error answer's body read for its code.
const ERROR_BODY_LIMIT := 8192


## Download `url` into `dest + ".part"`. Options: expected_size (int >= 0, required), timeout
## (seconds, one budget for the request; default 600), progress (Callable(received, total)). A
## coroutine returning a PKeyResult.
static func fetch(transport: PKeyTransport, url: String, dest: String, headers: Dictionary = {}, opts: Dictionary = {}) -> PKeyResult:
	if transport != null and transport.local_only:
		return PKeyResult.failure(PKeyErrors.LOCAL_ONLY, "This client is local-only; network calls are refused.")
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return PKeyResult.failure(PKeyErrors.NETWORK, "No SceneTree to poll the download on.")
	var expected := int(opts.get("expected_size", -1)) if PKeyClaims.is_number(opts.get("expected_size")) else -1
	if expected < 0:
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "A download needs the record's expected size.")
	var timeout := float(opts.get("timeout", DEFAULT_TIMEOUT)) if PKeyClaims.is_number(opts.get("timeout")) else DEFAULT_TIMEOUT
	var progress: Callable = opts.get("progress", Callable())
	var origin: String = PKeyTransport.parse_url(url).get("origin", "")
	if origin == "":
		return PKeyResult.failure(PKeyErrors.NETWORK, "Not an http(s) URL.")
	var part := dest + ".part"
	DirAccess.make_dir_recursive_absolute(part.get_base_dir())
	var have := _size(part)
	if have > expected:
		DirAccess.remove_absolute(part)
		have = 0
	if have == expected and expected > 0:
		return PKeyResult.success({"path": part, "size": have, "status": 206, "resumed": true})
	var resumed := have > 0
	var h := headers.duplicate()
	var credentials := true
	var current := url
	var restarted := false
	var deadline := Time.get_ticks_msec() + int(timeout * 1000.0)
	var hops := 0
	while hops <= MAX_REDIRECTS:
		hops += 1
		if Time.get_ticks_msec() >= deadline:
			return _timeout(timeout)
		var target := PKeyTransport.parse_url(current)
		if target.is_empty() or not PKeyTransport._secure_target(target):
			return PKeyResult.failure(PKeyErrors.INSECURE_REDIRECT, "Refusing a redirect to %s." % current)
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
			return PKeyResult.failure(PKeyErrors.NETWORK, "The download could not connect to %s." % host)
		var st := await _wait(client, tree, deadline, [HTTPClient.STATUS_RESOLVING, HTTPClient.STATUS_CONNECTING])
		if st == -1:
			client.close()
			return _timeout(timeout)
		if st != HTTPClient.STATUS_CONNECTED:
			client.close()
			return PKeyResult.failure(PKeyErrors.NETWORK, "The download could not connect (HTTPClient status %d)." % st)
		var lines := PackedStringArray()
		var logged := {}
		for k in h:
			if String(k).to_lower() in ["range", "accept-encoding"]:
				continue
			lines.append("%s: %s" % [k, h[k]])
			logged[String(k).to_lower()] = "<redacted>" if String(k).to_lower() == "authorization" else h[k]
		lines.append("Accept-Encoding: identity")
		logged["accept-encoding"] = "identity"
		if have > 0:
			lines.append("Range: bytes=%d-" % have)
			logged["range"] = "bytes=%d-" % have
		if transport != null:
			transport.sent.append({"method": "GET", "url": current, "headers": logged})
			if transport.sent.size() > 64:
				transport.sent.pop_front()
		var path: String = target["path"]
		if client.request(HTTPClient.METHOD_GET, path, lines) != OK:
			client.close()
			return PKeyResult.failure(PKeyErrors.NETWORK, "The download request could not start.")
		st = await _wait(client, tree, deadline, [HTTPClient.STATUS_REQUESTING])
		if st == -1:
			client.close()
			return _timeout(timeout)
		if not client.has_response():
			client.close()
			return PKeyResult.failure(PKeyErrors.NETWORK, "The download got no response (HTTPClient status %d)." % st)
		var status := client.get_response_code()
		var rh := _lower(client.get_response_headers_as_dictionary())
		if PKeyTransport.REDIRECT_STATUSES.has(status) and String(rh.get("location", "")) != "":
			client.close()
			current = PKeyTransport.resolve(current, rh["location"])
			continue
		if status == 416 and have > 0:
			client.close()
			if have == expected:
				return PKeyResult.success({"path": part, "size": have, "status": status, "resumed": true})
			if restarted:
				return PKeyResult.failure(PKeyErrors.HTTP_ERROR, "The download's range was refused twice.", {"status": status})
			restarted = true
			DirAccess.remove_absolute(part)
			have = 0
			resumed = false
			continue
		var append := false
		if status == 206 and have > 0:
			if not String(rh.get("content-range", "")).begins_with("bytes %d-" % have):
				client.close()
				if restarted:
					return PKeyResult.failure(PKeyErrors.HTTP_ERROR, "The download answered a range it was not asked for.", {"status": status})
				restarted = true
				DirAccess.remove_absolute(part)
				have = 0
				resumed = false
				continue
			append = true
		elif status != 200:
			# Read a small error body so the caller sees the server's code (a gated build's
			# `attestation_required`, `download_auth_required`, `not_entitled`, …).
			var err_body := await _small_body(client, tree, deadline, ERROR_BODY_LIMIT)
			client.close()
			var e := PKeyErrors.read_body(err_body)
			var code: String = e["code"] if e["code"] != "" else String(PKeyErrors.HTTP_ERROR)
			return PKeyResult.failure(StringName(code), e["message"] if e["message"] != "" else "The download answered %d." % status, {"status": status, "error": e})
		if not append:
			have = 0
			resumed = false
		var f: FileAccess
		if append:
			f = FileAccess.open(part, FileAccess.READ_WRITE)
			if f != null:
				f.seek_end()
		else:
			f = FileAccess.open(part, FileAccess.WRITE)
		if f == null:
			client.close()
			return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The download target %s could not be opened (%d)." % [part, FileAccess.get_open_error()])
		var r := await _body(client, f, tree, deadline, have, expected, progress)
		f.close()
		client.close()
		if r["error"] == "timeout":
			return _timeout(timeout)
		if r["error"] == "too-large":
			DirAccess.remove_absolute(part)
			return PKeyResult.failure(PKeyErrors.RESPONSE_TOO_LARGE, "The download is larger than the record's %d bytes." % expected)
		have = r["have"]
		if have != expected:
			return PKeyResult.failure(PKeyErrors.NETWORK, "The download stopped at %d of %d bytes; it resumes next time." % [have, expected], {"status": status, "size": have})
		return PKeyResult.success({"path": part, "size": have, "status": status, "resumed": resumed})
	return PKeyResult.failure(PKeyErrors.TOO_MANY_REDIRECTS, "More than %d redirects." % MAX_REDIRECTS)


## Poll until the status leaves `waiting`; the final status, or -1 once the deadline passed.
static func _wait(client: HTTPClient, tree: SceneTree, deadline: int, waiting: Array) -> int:
	while true:
		client.poll()
		var st := client.get_status()
		if not waiting.has(st):
			return st
		if Time.get_ticks_msec() >= deadline:
			return -1
		await tree.process_frame
	return -1


## Read the body into `f`: {have, error: "" | "timeout" | "too-large"}.
static func _body(client: HTTPClient, f: FileAccess, tree: SceneTree, deadline: int, have: int, expected: int, progress: Callable) -> Dictionary:
	while client.get_status() == HTTPClient.STATUS_BODY:
		var frame_start := Time.get_ticks_msec()
		var got_any := false
		while client.get_status() == HTTPClient.STATUS_BODY and Time.get_ticks_msec() - frame_start < READ_BUDGET_MSEC:
			client.poll()
			var chunk := client.read_response_body_chunk()
			if chunk.is_empty():
				break
			got_any = true
			if have + chunk.size() > expected:
				return {"have": have, "error": "too-large"}
			f.store_buffer(chunk)
			have += chunk.size()
		if got_any and progress.is_valid():
			progress.call(have, expected)
		if Time.get_ticks_msec() >= deadline:
			return {"have": have, "error": "timeout"}
		if client.get_status() == HTTPClient.STATUS_BODY:
			await tree.process_frame
	return {"have": have, "error": ""}


## Up to `limit` bytes of a (non-2xx) body, in memory.
static func _small_body(client: HTTPClient, tree: SceneTree, deadline: int, limit: int) -> PackedByteArray:
	var out := PackedByteArray()
	while client.get_status() == HTTPClient.STATUS_BODY and out.size() < limit:
		client.poll()
		var chunk := client.read_response_body_chunk()
		if chunk.is_empty():
			if Time.get_ticks_msec() >= deadline:
				break
			await tree.process_frame
			continue
		out.append_array(chunk)
	return out.slice(0, limit) if out.size() > limit else out


static func _lower(d: Dictionary) -> Dictionary:
	var out := {}
	for k in d:
		out[String(k).to_lower()] = str(d[k])
	return out


static func _size(path: String) -> int:
	if not FileAccess.file_exists(path):
		return 0
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return 0
	var n := int(f.get_length())
	f.close()
	return n


static func _timeout(timeout: float) -> PKeyResult:
	return PKeyResult.failure(PKeyErrors.TIMEOUT, "The download did not finish within %.0f s; it resumes next time." % timeout, {"result": HTTPRequest.RESULT_TIMEOUT})
