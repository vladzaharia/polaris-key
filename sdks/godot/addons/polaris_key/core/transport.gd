@tool
class_name PKeyTransport
extends RefCounted
## HTTP for the SDK, on `HTTPRequest` nodes that live under the host (the autoload). The rules
## (notes/A5 §4, report §5.3) are not optional:
##
##   - `max_redirects = 0`, and redirects are followed HERE: `HTTPRequest` forwards
##     `Authorization` to a redirect target on another host (measured on 4.7.2). The bearer is
##     dropped as soon as the origin changes and never comes back; a redirect to plain http on
##     a non-loopback host is refused. 303 (and 301/302 after a POST) become a GET without body.
##   - `timeout` 15 s per request (PKeyOptions.request_timeout_seconds), on the WALL clock from
##     the moment the request starts; every redirect hop spends the same budget. `HTTPRequest.timeout` is a Timer that counts process delta,
##     so a request started at the end of a long frame (a scene load, a bundle verify) loses that
##     whole frame on its first tick and times out before a byte moves; it is left at 0 here.
##   - `body_size_limit` 512 KiB for API responses (also a zip-bomb guard).
##   - `accept_gzip = false` for any `Range` request (gzip breaks ranges).
##   - https only, except http://localhost, 127.0.0.1 and [::1] (`check_base_url`).
##   - local-only refuses at the dial, before a URL is used.
##
## On web the browser's fetch follows redirects itself and strips credentials across origins;
## cross-origin calls need the Worker's CORS allowlist (P0-05).
##
## `request` is a coroutine returning a PKeyResult: ok with detail {status, headers (lower-case
## names), body: PackedByteArray, url} when a response arrived (any status), or a failure:
## `timeout`, `response-too-large`, `too-many-redirects`, `insecure-redirect`, `local-only`,
## `network-error`.

const MAX_REDIRECTS := 5
const BODY_LIMIT := 512 * 1024
const LOOPBACK_HOSTS := ["localhost", "127.0.0.1", "[::1]"]
const REDIRECT_STATUSES := [301, 302, 303, 307, 308]

const _METHODS := {
	"GET": HTTPClient.METHOD_GET,
	"HEAD": HTTPClient.METHOD_HEAD,
	"POST": HTTPClient.METHOD_POST,
	"PUT": HTTPClient.METHOD_PUT,
	"PATCH": HTTPClient.METHOD_PATCH,
	"DELETE": HTTPClient.METHOD_DELETE,
}

static var _url_re: RegEx
static var _scheme_re: RegEx

var host: Node
var timeout := 15.0
var body_limit := BODY_LIMIT
var local_only := false
## Every request this transport sent, newest last: {method, url, headers} (headers without any
## credential value). Tests read it; capped at 64 entries.
var sent: Array = []


static func _static_init() -> void:
	_url_re = RegEx.create_from_string("\\A([A-Za-z][A-Za-z0-9+.-]*)://(\\[[0-9A-Fa-f:.]+\\]|[^/?#:@\\[\\]]+)(?::([0-9]{1,5}))?([/?#].*)?\\z")
	_scheme_re = RegEx.create_from_string("\\A[A-Za-z][A-Za-z0-9+.-]*:")


func _init(p_host: Node = null) -> void:
	host = p_host


## {scheme, host, port, path, origin} (scheme and host lower-cased, default ports filled in), or
## {} when `url` is not an absolute http(s) URL.
static func parse_url(url: String) -> Dictionary:
	var m := _url_re.search(url)
	if m == null:
		return {}
	var scheme := m.get_string(1).to_lower()
	if scheme != "http" and scheme != "https":
		return {}
	var h := m.get_string(2).to_lower()
	var port := int(m.get_string(3)) if m.get_string(3) != "" else (443 if scheme == "https" else 80)
	var path := m.get_string(4)
	return {
		"scheme": scheme,
		"host": h,
		"port": port,
		"path": path if path != "" else "/",
		"origin": "%s://%s:%d" % [scheme, h, port],
	}


## The https rule. ok with detail = the URL without trailing slashes, or `insecure-base-url`.
static func check_base_url(raw: String) -> PKeyResult:
	var u := parse_url(raw)
	if u.is_empty():
		return PKeyResult.failure(PKeyErrors.INSECURE_BASE_URL, "base_url is not an absolute http(s) URL: %s" % raw)
	if u["scheme"] != "https" and not LOOPBACK_HOSTS.has(u["host"]):
		return PKeyResult.failure(PKeyErrors.INSECURE_BASE_URL, "base_url must be https (plain http only for localhost, 127.0.0.1 and [::1]): %s" % raw)
	var out := raw
	while out.ends_with("/"):
		out = out.substr(0, out.length() - 1)
	return PKeyResult.success(out)


static func _secure_target(u: Dictionary) -> bool:
	return u["scheme"] == "https" or LOOPBACK_HOSTS.has(u["host"])


## Resolve a Location header against the URL that answered.
static func resolve(base_url: String, location: String) -> String:
	if _scheme_re.search(location) != null:
		return location
	var b := parse_url(base_url)
	if b.is_empty():
		return location
	if location.begins_with("//"):
		return "%s:%s" % [b["scheme"], location]
	var authority := "%s://%s" % [b["scheme"], b["host"]]
	var default_port: int = 443 if b["scheme"] == "https" else 80
	if b["port"] != default_port:
		authority += ":%d" % b["port"]
	if location.begins_with("/"):
		return authority + location
	var path: String = b["path"].split("?")[0].split("#")[0]
	return authority + path.substr(0, path.rfind("/") + 1) + location


## One request, redirects followed by hand. `headers` is name -> value. `body` is sent as is.
## Options: range (bool: send no Accept-Encoding gzip).
func request(method: String, url: String, headers: Dictionary = {}, body: PackedByteArray = PackedByteArray(), opts: Dictionary = {}) -> PKeyResult:
	if local_only:
		return PKeyResult.failure(PKeyErrors.LOCAL_ONLY, "This client is local-only; network calls are refused.")
	if host == null or not host.is_inside_tree():
		return PKeyResult.failure(PKeyErrors.NETWORK, "The transport's host node is not in the scene tree.")
	var origin: String = parse_url(url).get("origin", "")
	if origin == "":
		return PKeyResult.failure(PKeyErrors.NETWORK, "Not an http(s) URL.")
	var m := method.to_upper()
	var h := headers.duplicate()
	var b := body
	var current := url
	var credentials := true
	# One wall-clock budget for the whole request: every redirect hop spends the same deadline,
	# so a chain of slow hops cannot take `timeout` seconds each.
	var deadline := Time.get_ticks_msec() + int(timeout * 1000.0) if timeout > 0.0 else 0
	for hop in MAX_REDIRECTS + 1:
		if deadline > 0 and Time.get_ticks_msec() >= deadline:
			return PKeyResult.failure(PKeyErrors.TIMEOUT, "No response within %.0f s." % timeout, {"result": HTTPRequest.RESULT_TIMEOUT})
		var target := parse_url(current)
		if target.is_empty() or not _secure_target(target):
			return PKeyResult.failure(PKeyErrors.INSECURE_REDIRECT, "Refusing a redirect to %s." % current)
		if credentials and target["origin"] != origin:
			credentials = false
		if not credentials:
			for k in h.keys():
				if String(k).to_lower() == "authorization":
					h.erase(k)
		var r := await _once(m, current, h, b, PKeyClaims.is_true(opts.get("range", false)), deadline)
		if not r.ok or r.detail.get("redirect", "") == "":
			return r
		var status: int = r.detail["status"]
		current = resolve(current, r.detail["redirect"])
		if status == 303 or ((status == 301 or status == 302) and m == "POST"):
			m = "GET"
			b = PackedByteArray()
			for k in h.keys():
				if String(k).to_lower() == "content-type":
					h.erase(k)
	return PKeyResult.failure(PKeyErrors.TOO_MANY_REDIRECTS, "More than %d redirects." % MAX_REDIRECTS)


## `deadline` is the request's `Time.get_ticks_msec()` deadline (0: none), shared by every hop.
func _once(method: String, url: String, headers: Dictionary, body: PackedByteArray, ranged: bool, deadline: int) -> PKeyResult:
	var lines := PackedStringArray()
	var logged := {}
	for k in headers:
		lines.append("%s: %s" % [k, headers[k]])
		logged[String(k).to_lower()] = "<redacted>" if String(k).to_lower() == "authorization" else headers[k]
	sent.append({"method": method, "url": url, "headers": logged})
	if sent.size() > 64:
		sent.pop_front()
	var req := HTTPRequest.new()
	req.max_redirects = 0
	req.timeout = 0.0
	req.body_size_limit = body_limit
	req.accept_gzip = not ranged
	req.use_threads = false
	host.add_child(req)
	var err := req.request_raw(url, lines, _METHODS.get(method, HTTPClient.METHOD_GET), body)
	if err != OK:
		req.queue_free()
		return PKeyResult.failure(PKeyErrors.NETWORK, "The request could not start (error %d)." % err, {"error": err})
	var res := await _await_completed(req, deadline)
	req.queue_free()
	if res.is_empty():
		return PKeyResult.failure(PKeyErrors.TIMEOUT, "No response within %.0f s." % timeout, {"result": HTTPRequest.RESULT_TIMEOUT})
	var result: int = res[0]
	var status: int = res[1]
	var response_headers := _headers(res[2])
	match result:
		HTTPRequest.RESULT_SUCCESS, HTTPRequest.RESULT_REDIRECT_LIMIT_REACHED:
			# 4.7 reports a refused redirect as REDIRECT_LIMIT_REACHED; 4.4 hands 303 and 307 back as
			# a plain success. Either way a redirect status with a Location is followed here.
			var location: String = response_headers.get("location", "")
			if REDIRECT_STATUSES.has(status) and location != "":
				return PKeyResult.success({"status": status, "headers": response_headers, "body": PackedByteArray(), "url": url, "redirect": location})
			return PKeyResult.success({"status": status, "headers": response_headers, "body": res[3], "url": url})
		HTTPRequest.RESULT_TIMEOUT:
			return PKeyResult.failure(PKeyErrors.TIMEOUT, "No response within %.0f s." % timeout, {"result": result})
		HTTPRequest.RESULT_BODY_SIZE_LIMIT_EXCEEDED:
			return PKeyResult.failure(PKeyErrors.RESPONSE_TOO_LARGE, "The response is larger than %d bytes." % body_limit, {"result": result})
	return PKeyResult.failure(PKeyErrors.NETWORK, "The request failed (HTTPRequest result %d)." % result, {"result": result})


## The request_completed arguments, or [] once the wall-clock `deadline` (computed once in
## `request()`; 0 means none) has passed (the request is then cancelled). Checked once per frame, as HTTPRequest polls; the
## deadline must be seen on two checks, so HTTPRequest always gets a poll after it passes (one
## hitch frame cannot expire a request it never let run).
func _await_completed(req: HTTPRequest, deadline: int) -> Array:
	var box := []
	req.request_completed.connect(func(result: int, status: int, hdrs: PackedStringArray, body: PackedByteArray) -> void:
		box.append_array([result, status, hdrs, body]), CONNECT_ONE_SHOT)
	var expired := false
	var tree := req.get_tree()
	while box.is_empty():
		if deadline > 0 and Time.get_ticks_msec() >= deadline:
			if expired:
				req.cancel_request()
				return []
			expired = true
		await tree.process_frame
	return box


static func _headers(lines: PackedStringArray) -> Dictionary:
	var out := {}
	for line in lines:
		var i := line.find(":")
		if i <= 0:
			continue
		var k := line.substr(0, i).strip_edges().to_lower()
		var v := line.substr(i + 1).strip_edges()
		out[k] = v if not out.has(k) else "%s, %s" % [out[k], v]
	return out
