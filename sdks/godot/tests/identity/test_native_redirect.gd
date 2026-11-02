extends RefCounted
# @pkey-feature identity.redirect.native
# The native redirect sign-in (I-15b.7, WIRE-CONTRACT-V5 §12.12): PKeyNativeRedirect on the vectors
# client-core ships (packages/client-core/test/redirect.test.ts), the loopback listener on real
# sockets (each listener rule has a check below), and the session on a fake Worker: the bind before
# the push, the redemption from the pushing device, the scheme delivery, cancel and expiry.

const B := preload("res://tests/identity/support.gd")
const N := preload("res://addons/polaris_key/services/identity/native_redirect.gd")
const L := preload("res://addons/polaris_key/services/identity/loopback_listener.gd")

const ISS := "https://key.plrs.im/djdl/identity"
const STATE := "tidewater-state-0123456789"
const VERIFIER := "transcript-verifier-0123456789-abcdefghijklmnopqrst"
const CHALLENGE := "-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10"
const LOOP := "http://127.0.0.1:49152/pkey/callback"
const SCHEME := "com.tidewater.studio:/pkey/callback"
const RQ := "rq_fxXQ7DEgqPUfZlsJYdm76w"
const RURI := "urn:ietf:params:oauth:request_uri:A1xUxaz50yGeWfx8JDSnAw"
const REQUEST_ENDPOINT := "https://key.plrs.im/djdl/identity/request"
const AUTHORIZE := "https://key.plrs.im/djdl/identity/authorize"
const TOKEN := "https://key.plrs.im/djdl/identity/token"
const RETURN_PAGE := "https://key.plrs.im/signin/return"
const TOKEN_OK := {
	"access_token": "pkeyt_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW", "token_type": "Bearer", "scope": "profile email",
	"schemaVersion": 1, "device": {"id": "D"}, "license": {"id": "lic_1"}, "subject": "ps_abc",
}


func run(t: PKeyTestContext) -> void:
	await _helpers(t)
	await _listener(t)
	await _session(t)
	await _android(t)


func _push_opts(extra := {}) -> Dictionary:
	var o := {
		"request_endpoint": REQUEST_ENDPOINT, "authorize_endpoint": AUTHORIZE, "token_endpoint": TOKEN, "issuer": ISS,
		"client_id": "djdl", "redirect_uri": LOOP, "state": STATE, "code_verifier": VERIFIER, "device_name": "Ada's Mac",
	}
	o.merge(extra, true)
	return o


# ── The pure helpers ─────────────────────────────────────────────────────────────────────

func _helpers(t: PKeyTestContext) -> void:
	var iss_q := ISS.uri_encode()
	# classify and build
	t.check("native: classifies a loopback", N.classify_native_redirect_uri(LOOP) == "loopback")
	t.check("native: classifies [::1], a scheme and a claimed link", N.classify_native_redirect_uri("http://[::1]:5000/pkey/callback") == "loopback" and N.classify_native_redirect_uri(SCHEME) == "scheme" and N.classify_native_redirect_uri("https://app.example/open/pkey") == "claimed")
	for bad in ["http://localhost:49152/pkey/callback", "http://127.0.0.1/pkey/callback", "http://127.0.0.1:80/pkey/callback", "http://127.0.0.1:49152/other",
			"http://127.0.0.1:49152/pkey/callback?x=1", "http://127.0.0.1:49152/pkey/callback#f", "http://user@127.0.0.1:49152/pkey/callback", "com.x:/other",
			"com.x://pkey/callback", "https://user@app.example/open", "https://app.example/open#f", "https://app.example/", "javascript:/pkey/callback", "",
			"http://127.0.0.1:049152/pkey/callback", 7]:
		t.check("native: %s is no native redirect URI" % str(bad).left(48), N.classify_native_redirect_uri(bad) == "")
	t.check("native: builds the loopback and scheme URIs", N.native_redirect_uri("loopback", {"port": 49152}) == LOOP and N.native_redirect_uri("scheme", {"scheme": "com.tidewater.studio"}) == SCHEME)
	t.check("native: refuses port 80 and a reserved scheme", N.native_redirect_uri("loopback", {"port": 80}) == "" and N.native_redirect_uri("scheme", {"scheme": "https"}) == "" and N.native_redirect_uri("loopback", {"port": 0}) == "")

	# the class choice
	var d := {"loopback": true, "schemes": [SCHEME], "claimedHttps": ["https://app.example/open"]}
	var base := {"request_endpoint": REQUEST_ENDPOINT, "discovery": d, "can_listen": true}
	t.check("native: loopback first", N.choose_redirect_class(base) == {"kind": "loopback"})
	t.check("native: then the registered scheme", N.choose_redirect_class({"request_endpoint": REQUEST_ENDPOINT, "discovery": d, "can_listen": false, "registered_schemes": [SCHEME]}) == {"kind": "scheme", "redirect_uri": SCHEME})
	t.check("native: then claimed HTTPS", N.choose_redirect_class({"request_endpoint": REQUEST_ENDPOINT, "discovery": {"loopback": false, "schemes": [], "claimedHttps": d["claimedHttps"]}, "can_listen": true, "registered_claimed": ["https://app.example/open"]}) == {"kind": "claimed", "redirect_uri": "https://app.example/open"})
	var none := N.choose_redirect_class({"request_endpoint": REQUEST_ENDPOINT, "discovery": d, "can_listen": false, "registered_schemes": ["x:/pkey/callback"]})
	t.check("native: a scheme discovery does not list is no class", none["kind"] == "unavailable" and none["code"] == "redirect-unavailable" and none["reason"] == "no-class", str(none))
	t.check("native: no request endpoint, or no nativeRedirect, is request-not-served", N.choose_redirect_class({"request_endpoint": "", "discovery": d, "can_listen": true})["reason"] == "request-not-served" and N.choose_redirect_class({"request_endpoint": REQUEST_ENDPOINT, "discovery": null, "can_listen": true})["reason"] == "request-not-served")

	# the pushed request: the recording's bytes
	var form := "response_type=code&client_id=djdl&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fpkey%2Fcallback&state=" + STATE + "&code_challenge=" + CHALLENGE + "&code_challenge_method=S256&device_name=Ada%27s+Mac"
	var p := N.push_request(_push_opts())
	t.check("native: the loopback push is the recorded form", p["ok"] and p["body"] == form and p["url"] == REQUEST_ENDPOINT and p["content_type"] == "application/x-www-form-urlencoded", str(p.get("body")))
	t.check("native: the pending request holds the verifier, the body does not", p["ok"] and p["pending"]["code_verifier"] == VERIFIER and not String(p["body"]).contains(VERIFIER) and p["pending"]["redirect_class"] == "loopback")
	var ps := N.push_request(_push_opts({"redirect_uri": SCHEME, "return_uri": SCHEME}))
	t.check("native: a scheme push carries return_uri last", ps["ok"] and String(ps["body"]).ends_with("&device_name=Ada%27s+Mac&return_uri=com.tidewater.studio%3A%2Fpkey%2Fcallback"), str(ps.get("body")))
	var pc := N.push_request(_push_opts({"license_choice": "app", "choice_available": true}))
	t.check("native: license_choice=app sits before the label", pc["ok"] and String(pc["body"]).ends_with("&license_choice=app&device_name=Ada%27s+Mac") and pc["pending"]["license_choice"] == true)
	t.check("native: license_choice withheld without the choice endpoints", N.push_request(_push_opts({"license_choice": "app", "choice_available": false}))["body"] == form)
	var pe := N.push_request(_push_opts({"state": null, "code_verifier": null}))
	t.check("native: random entropy satisfies its own rules", pe["ok"] and pe["pending"]["state"].length() == 43 and not String(pe["body"]).contains(pe["pending"]["code_verifier"]))
	for row in [["a non-native redirect", {"redirect_uri": "http://app.example/auth"}], ["a return_uri that is not a scheme", {"return_uri": LOOP}], ["a short state", {"state": "short"}],
			["a bad verifier", {"code_verifier": "x"}], ["no issuer", {"issuer": ""}], ["a relative endpoint", {"request_endpoint": "/djdl/identity/request"}], ["an empty scope", {"scope": "  "}]]:
		t.check("native: refuses %s before anything is built" % row[0], not N.push_request(_push_opts(row[1]))["ok"])

	# the pushed answer
	var ok := {"request_uri": RURI, "expires_in": 600}
	t.check("native: parses the 201 answer", N.parse_pushed_answer(201, ok) == {"kind": "pushed", "request_uri": RURI, "expires_in": 600})
	t.check("native: a 200 is not a pushed answer", N.parse_pushed_answer(200, ok)["kind"] == "refused")
	t.check("native: a bad request_uri, a TTL past 600 and a missing body are malformed", N.parse_pushed_answer(201, {"request_uri": "urn:x", "expires_in": 600})["kind"] == "malformed" and N.parse_pushed_answer(201, {"request_uri": RURI, "expires_in": 601})["kind"] == "malformed" and N.parse_pushed_answer(201, null)["kind"] == "malformed")
	t.check("native: a refusal reads flat, retry capped and rounded up", N.parse_pushed_answer(429, {"error": "rate_limited", "retryAfter": 4.2}) == {"kind": "refused", "error": "rate_limited", "status": 429, "retry_after_seconds": 5} and N.parse_pushed_answer(502, "x")["error"] == "server_error")

	# the authorize URL
	var au := N.authorize_url_for(AUTHORIZE, "djdl", RURI)
	t.check("native: authorize carries client_id and request_uri only", au == AUTHORIZE + "?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AA1xUxaz50yGeWfx8JDSnAw", au)
	t.check("native: authorize refuses a non-pushed URI", N.authorize_url_for(AUTHORIZE, "djdl", "urn:bad") == "")

	# the redirect back
	var pend := {"state": STATE, "issuer": ISS, "redirect_uri": LOOP}
	var q := func(extra: String) -> String: return "%s?code=abc&state=%s&iss=%s&request=%s%s" % [LOOP, STATE, iss_q, RQ, extra]
	t.check("native: the exact loopback shape is a code with its handle", N.parse_native_callback(pend, q.call("")) == {"kind": "code", "code": "abc", "request": RQ})
	var reasons := [
		[q.call("&extra=1"), "unexpected-parameter"], [q.call("&code=two"), "malformed"], [q.call("#frag"), "malformed"],
		[String(q.call("")).replace("49152", "49153"), "redirect-mismatch"], [String(q.call("")).replace("127.0.0.1", "localhost"), "redirect-mismatch"],
		[String(q.call("")).replace(STATE, "other-state-0123456789"), "state-mismatch"], [String(q.call("")).replace(iss_q, "https%3A%2F%2Fevil.example"), "issuer-mismatch"],
		["%s?code=abc&state=%s&request=%s" % [LOOP, STATE, RQ], "issuer-mismatch"], ["%s?code=abc&state=%s&iss=%s" % [LOOP, STATE, iss_q], "request-invalid"],
		[String(q.call("")).replace(RQ, "rq_short"), "request-invalid"], ["%s?state=%s&iss=%s&request=%s" % [LOOP, STATE, iss_q, RQ], "missing-code"], [42, "malformed"],
	]
	for row in reasons:
		var r := N.parse_native_callback(pend, row[0])
		t.check("native: callback %s is %s" % [str(row[0]).right(40), row[1]], r["kind"] == "failed" and r["reason"] == row[1] and r["code"] == "sign-in-failed", str(r))
	var base_err := "%s?state=%s&iss=%s&request=%s" % [LOOP, STATE, iss_q, RQ]
	t.check("native: access_denied cancels, another error fails naming it", N.parse_native_callback(pend, base_err + "&error=access_denied")["kind"] == "cancelled" and N.parse_native_callback(pend, base_err + "&error=server_error") == {"kind": "failed", "code": "sign-in-failed", "reason": "authorization-error", "error": "server_error"})
	t.check("native: an extra parameter beside an error is refused", N.parse_native_callback(pend, base_err + "&error=access_denied&x=1")["reason"] == "unexpected-parameter")
	var sp := {"state": STATE, "issuer": ISS, "redirect_uri": SCHEME}
	var sbase := "%s?code=abc&state=%s&iss=%s" % [SCHEME, STATE, iss_q]
	t.check("native: a scheme delivery needs no handle, a present one must be valid", N.parse_native_callback(sp, sbase) == {"kind": "code", "code": "abc"} and N.parse_native_callback(sp, sbase + "&request=bad")["reason"] == "request-invalid" and N.parse_native_callback(sp, sbase.replace("com.tidewater.studio", "com.other.app"))["reason"] == "redirect-mismatch")
	t.check("native: the redirect URI's scheme and host compare case-insensitively", N.parse_native_callback(pend, String(q.call("")).replace("http://127.0.0.1", "HTTP://127.0.0.1"))["kind"] == "code")
	t.check("native: constant_time_equal", N.constant_time_equal("abc", "abc") and not N.constant_time_equal("abc", "abd") and not N.constant_time_equal("abc", "abcd") and not N.constant_time_equal("", "a") and N.constant_time_equal("", ""))

	# the token request
	var tr := N.native_token_request(p["pending"], "C0DE", "TRANSCRIPTDEVICE0000000000000001")
	t.check("native: the token form is the recorded one, no label", tr["body"] == "grant_type=authorization_code&client_id=djdl&code=C0DE&code_verifier=" + VERIFIER + "&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fpkey%2Fcallback" and tr["url"] == TOKEN, str(tr.get("body")))
	t.check("native: the token request names the pushing device", tr["headers"]["X-PKey-Device"] == "TRANSCRIPTDEVICE0000000000000001" and N.native_token_request(p["pending"], "C", "").is_empty())


# ── The loopback listener, on real sockets ───────────────────────────────────────────────

class Accepted:
	var calls: Array = []
	var state := STATE

	func accept(url: String) -> Array:
		calls.append(url)
		if not url.contains("state=" + state + "&") and not url.ends_with("state=" + state):
			return ["", false]
		return [RETURN_PAGE + "?request=" + RQ, true]


static func _frame() -> void:
	await (Engine.get_main_loop() as SceneTree).process_frame


## Connect to `port`, send `request` (when not ""), and return the reply once the peer closes or
## `limit_ms` passes. The listener is polled each frame (no ticker in these checks).
func _exchange(listener: PKeyLoopbackListener, port: int, request: String, limit_ms := 1500) -> String:
	var c := StreamPeerTCP.new()
	if c.connect_to_host("127.0.0.1", port) != OK:
		return "(refused)"
	var out := PackedByteArray()
	var sent := request == ""
	var until := Time.get_ticks_msec() + limit_ms
	while Time.get_ticks_msec() < until:
		c.poll()
		var st := c.get_status()
		if st == StreamPeerTCP.STATUS_ERROR or (st == StreamPeerTCP.STATUS_NONE):
			break
		if st == StreamPeerTCP.STATUS_CONNECTED:
			if not sent:
				c.put_data(request.to_utf8_buffer())
				sent = true
			var n := c.get_available_bytes()
			if n > 0:
				out.append_array(c.get_data(n)[1])
		listener.poll()
		await _frame()
	c.disconnect_from_host()
	return out.get_string_from_utf8()


static func _req(path: String, host: String, extra := "") -> String:
	return "GET %s HTTP/1.1\r\nHost: %s\r\n%s\r\n" % [path, host, extra]


static func _status(reply: String) -> String:
	return reply.split("\r\n")[0] if reply != "" else "(none)"


func _good_path(state := STATE) -> String:
	return "/pkey/callback?code=C0DE&state=%s&iss=%s&request=%s" % [state, ISS.uri_encode(), RQ]


func _listener(t: PKeyTestContext) -> void:
	var acc := Accepted.new()
	var l := PKeyLoopbackListener.new()
	t.check("listener: binds an OS-assigned port on 127.0.0.1 when built", l.is_bound() and l.port > 1023, str(l.port))
	var rival := TCPServer.new()
	t.check("listener: holds the port from before the push (nothing else can bind it)", rival.listen(l.port, "127.0.0.1") != OK)
	l.start(acc.accept)
	var host := "127.0.0.1:%d" % l.port

	var r := await _exchange(l, l.port, _req("/other", host))
	t.check("listener: another path is a 404 with no body", _status(r) == "HTTP/1.1 404 Not Found" and r.ends_with("\r\n\r\n") and acc.calls.is_empty(), r)
	r = await _exchange(l, l.port, _req(_good_path(), "localhost:%d" % l.port))
	t.check("listener: a Host that is not 127.0.0.1:<port> is a 404", _status(r).begins_with("HTTP/1.1 404") and acc.calls.is_empty(), r)
	r = await _exchange(l, l.port, _req(_good_path(), "127.0.0.1:%d" % (l.port + 1)))
	t.check("listener: another port in Host is a 404", _status(r).begins_with("HTTP/1.1 404") and acc.calls.is_empty(), r)
	r = await _exchange(l, l.port, _req(_good_path(), host, "Host: evil.example\r\n"))
	t.check("listener: two Host headers are a 404", _status(r).begins_with("HTTP/1.1 404") and acc.calls.is_empty(), r)
	r = await _exchange(l, l.port, "POST %s HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\n\r\n" % [_good_path(), host])
	t.check("listener: a POST is a 404", _status(r).begins_with("HTTP/1.1 404") and acc.calls.is_empty(), r)
	r = await _exchange(l, l.port, "GET http://evil.example/pkey/callback?x=1 HTTP/1.1\r\nHost: %s\r\n\r\n" % host)
	t.check("listener: an absolute-form target is a 404", _status(r).begins_with("HTTP/1.1 404") and acc.calls.is_empty(), r)
	r = await _exchange(l, l.port, _req(_good_path("tidewater-state-0123456788"), host))
	t.check("listener: a wrong state is a 404 and the listener keeps listening", _status(r).begins_with("HTTP/1.1 404") and acc.calls.size() == 1 and not l.is_closed(), r)
	t.check("listener: the state is compared by the session in constant time, one flipped last character is refused", acc.calls.size() == 1 and N.parse_native_callback({"state": STATE, "issuer": ISS, "redirect_uri": LOOP}, LOOP + "?code=c&state=tidewater-state-0123456788&iss=" + ISS.uri_encode() + "&request=" + RQ)["reason"] == "state-mismatch")

	r = await _exchange(l, l.port, _req(_good_path(), host))
	var lines := r.split("\r\n")
	t.check("listener: the first good callback is ONE 303 to the return page", lines[0] == "HTTP/1.1 303 See Other" and lines.has("Location: %s?request=%s" % [RETURN_PAGE, RQ]), r)
	t.check("listener: the 303 is no-store, no-referrer, bodyless, with no CORS or cookie header", lines.has("Cache-Control: no-store") and lines.has("Referrer-Policy: no-referrer") and lines.has("Content-Length: 0") and r.ends_with("\r\n\r\n") and not r.to_lower().contains("access-control") and not r.to_lower().contains("set-cookie"), r)
	t.check("listener: the callback URL reached the handler on the listener's own origin", acc.calls.back() == "http://127.0.0.1:%d%s" % [l.port, _good_path()])
	for i in 30:
		l.poll()
		await _frame()
	t.check("listener: closes after the first good callback and releases the port", l.is_closed() and TCPServer.new().listen(l.port, "127.0.0.1") == OK)
	r = await _exchange(l, l.port, _req(_good_path(), host), 300)
	t.check("listener: a second callback finds nothing listening", r == "(refused)" or r == "", r)

	# caps and deadlines
	var l2 := PKeyLoopbackListener.new(600.0, 0.4)
	var acc2 := Accepted.new()
	l2.start(acc2.accept)
	var idle: Array = []
	for i in 10:
		var c := StreamPeerTCP.new()
		c.connect_to_host("127.0.0.1", l2.port)
		idle.append(c)
	for i in 10:
		for c in idle:
			c.poll()
		l2.poll()
		await _frame()
	t.check("listener: at most 8 connections are held; the rest are dropped at once", l2._conns.size() == 8, str(l2._conns.size()))
	var dropped := 0
	for c in idle:
		c.poll()
		if c.get_status() != StreamPeerTCP.STATUS_CONNECTED or (c.get_status() == StreamPeerTCP.STATUS_CONNECTED and c.get_available_bytes() == 0 and c.get_partial_data(1)[0] != OK):
			dropped += 1
	t.check("listener: the surplus connections were closed by the listener", dropped >= 2, str(dropped))
	await get_tree_wait(600)
	for i in 5:
		l2.poll()
		await _frame()
	t.check("listener: a connection that sends no head is dropped at the head deadline", l2._conns.is_empty(), str(l2._conns.size()))
	r = await _exchange(l2, l2.port, _req(_good_path(), "127.0.0.1:%d" % l2.port))
	t.check("listener: still serves a good callback after the idle ones were dropped", _status(r).begins_with("HTTP/1.1 303"), r)
	l2.close()
	for c in idle:
		c.disconnect_from_host()

	var l3 := PKeyLoopbackListener.new()
	var acc_l3 := Accepted.new()
	l3.start(acc_l3.accept)
	r = await _exchange(l3, l3.port, "GET /pkey/callback?" + "a".repeat(9000), 600)
	t.check("listener: a head past 8 KiB is dropped without an answer", r == "" and l3._conns.is_empty(), "%d bytes" % r.length())
	l3.close()

	var l4 := PKeyLoopbackListener.new(0.25)
	var acc_l4 := Accepted.new()
	l4.start(acc_l4.accept)
	var p4 := l4.port
	await get_tree_wait(400)
	l4.poll()
	t.check("listener: closes on its own after its lifetime and releases the port", l4.is_closed() and TCPServer.new().listen(p4, "127.0.0.1") == OK)

	var l5 := PKeyLoopbackListener.new()
	var acc_l5 := Accepted.new()
	l5.start(acc_l5.accept)
	var p5 := l5.port
	l5.close()
	t.check("listener: close() releases the port and is safe twice", l5.is_closed() and TCPServer.new().listen(p5, "127.0.0.1") == OK)
	l5.close()
	l5 = null
	l.close()


static func get_tree_wait(ms: int) -> void:
	var until := Time.get_ticks_msec() + ms
	while Time.get_ticks_msec() < until:
		await _frame()


# ── The session on a fake Worker ─────────────────────────────────────────────────────────

func _bed(token := "", loopback_page := true) -> B:
	var bed := B.new()
	var sdk := await bed.make_sdk(token)
	sdk.identity.redirect_acquisition_sync = false
	var root := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	var fragment := {
		"enabled": true, "configured": true, "issuer": root,
		"nativeRedirect": {"loopback": true, "schemes": [SCHEME], "claimedHttps": []},
		"endpoints": {"authorize": root + "/authorize", "token": root + "/token", "request": root + "/identity-request-placeholder"},
	}
	fragment["endpoints"]["request"] = root + "/request"
	if loopback_page:
		fragment["endpoints"]["signinReturn"] = bed.server.base_url() + "/signin/return"
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": fragment}}
	bed.pushes = [B.json(201, {"request_uri": RURI, "expires_in": 600})]
	bed.tokens = [B.json(200, TOKEN_OK)]
	sdk.identity.native_platform = "desktop"
	return bed


func _start(bed: B, extra := {}) -> PKeySignInSession:
	var opts := {"channel": "redirect", "browser": false, "loopback": true}
	opts.merge(extra, true)
	return await bed.sdk.identity.sign_in.start(opts)


func _root(bed: B) -> String:
	return "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]


func _return_page(bed: B) -> String:
	return bed.server.base_url() + "/signin/return"


func _session(t: PKeyTestContext) -> void:
	var bed := await _bed()
	var root := _root(bed)
	var probe := {"held": false, "port": 0}
	bed.on_push = func(req: Dictionary) -> void:
		var m := RegEx.create_from_string("redirect_uri=http%3A%2F%2F127\\.0\\.0\\.1%3A(\\d+)%2Fpkey").search((req["body"] as PackedByteArray).get_string_from_utf8())
		if m != null:
			probe["port"] = int(m.get_string(1))
			probe["held"] = TCPServer.new().listen(probe["port"], "127.0.0.1") != OK
	var seen := []
	var s := await _start(bed, {"login_hint": "ada@example.com", "scope": "profile email"})
	t.check("native session: starts on the redirect channel as a loopback", s.ok and s.channel == &"redirect" and s.redirect_class == "loopback" and s.redirect_uri.begins_with("http://127.0.0.1:") and s.redirect_uri.ends_with("/pkey/callback"), str(s))
	t.check("native session: the port was already held when the Worker received the push", probe["held"] and s.redirect_uri == "http://127.0.0.1:%d/pkey/callback" % probe["port"], str(probe))
	var push: Dictionary = bed.push_requests[0] if bed.push_requests.size() == 1 else {}
	t.check("native session: one form POST to request, carrying the device header and the SDK headers", bed.push_requests.size() == 1 and String(push["headers"].get("content-type", "")).begins_with("application/x-www-form-urlencoded") and push["headers"].get("x-pkey-device") == bed.F["device_id"] and push["headers"].has("x-pkey-sdk") and not push["headers"].has("authorization"), str(push.get("headers")))
	t.check("native session: the push carries the challenge and never the verifier", String(push["body"]).contains("code_challenge_method=S256") and not String(push["body"]).contains("code_verifier") and String(push["body"]).contains("login_hint=ada%40example.com"))
	t.check("native session: authorize_url is client_id and request_uri only", s.authorize_url == "%s/authorize?client_id=djdl&request_uri=urn%%3Aietf%%3Aparams%%3Aoauth%%3Arequest_uri%%3AA1xUxaz50yGeWfx8JDSnAw" % root, s.authorize_url)
	t.check("native session: expires in 600 s on the client's clock", s.expires_in == 600 and is_equal_approx(s.expires_at, bed.clock[0] + 600.0))
	t.check("native session: the browser was not asked for (browser: false)", not s.opened)
	s.outcome.connect(func(o): seen.append(o))
	var box := B.follow(s)
	var state := _param(push["body"], "state")
	var cb := "/pkey/callback?code=C0DE&state=%s&iss=%s&request=%s" % [state, root.uri_encode(), RQ]
	var port: int = int(s.redirect_uri.get_slice(":", 2).get_slice("/", 0))
	var reply := await _exchange(s._native.listener, port, _req(cb, "127.0.0.1:%d" % port))
	t.check("native session: the browser is sent to the return page with the card's handle", _status(reply) == "HTTP/1.1 303 See Other" and reply.contains("Location: %s?request=%s\r\n" % [_return_page(bed), RQ]), reply)
	await B.until(func(): return box.size() == 1)
	var o: PKeySignInOutcome = box[0] if box.size() == 1 else null
	t.check("native session: wait() signs in", o != null and o.kind == PKeySignInOutcome.KIND_SIGNED_IN and o.subject == "ps_abc" and o.scope == "profile email" and o.license_id == "lic_1", str(o))
	t.check("native session: the outcome signal fired once", seen.size() == 1 and seen[0] == o)
	var req: Dictionary = bed.token_requests[0] if bed.token_requests.size() == 1 else {}
	var body := String(req.get("body", ""))
	t.check("native session: the code is redeemed from the pushing device", bed.token_requests.size() == 1 and req["headers"].get("x-pkey-device") == bed.F["device_id"] and not req["headers"].has("authorization"), str(req.get("headers")))
	t.check("native session: the token form carries the verifier and the same redirect URI, no label", body.begins_with("grant_type=authorization_code&client_id=djdl&code=C0DE&code_verifier=") and body.contains("&redirect_uri=" + s.redirect_uri.uri_encode()) and not body.contains("device_name"), body.replace("code_verifier=", "cv="))
	t.check("native session: the token is stored", bed.sdk.core.tokens.current() == TOKEN_OK["access_token"])
	t.check("native session: the listener is closed and a settled session answers the same outcome", s._native.listener.is_closed() and await s.wait() == o and not s.reopen())
	var again: PKeySignInOutcome = await s.handle_redirect(cb)
	t.check("native session: a replayed callback is refused with no second request", again.code == PKeyErrors.SIGN_IN_FAILED and bed.token_requests.size() == 1, str(again))
	t.check("native session: str() holds no code or verifier", not str(s).contains("C0DE") and not str(s).contains(s._native.pending.get("code_verifier", "-")))
	bed.free_all()

	# Cancel: closes the listener, drops the pending request, a late callback finds nothing.
	bed = await _bed()
	root = _root(bed)
	var s2 := await _start(bed)
	var port2: int = s2._native.listener.port
	var box2 := B.follow(s2)
	await B.until(func(): return s2.is_waiting())
	s2.cancel()
	await B.until(func(): return box2.size() == 1)
	t.check("native session: cancel() settles cancelled", box2.size() == 1 and box2[0].kind == PKeySignInOutcome.KIND_CANCELLED, str(box2))
	t.check("native session: cancel() released the listener's port and dropped the pending request", s2._native.listener.is_closed() and TCPServer.new().listen(port2, "127.0.0.1") == OK and s2._native.pending.is_empty())
	var late: PKeySignInOutcome = await s2.handle_redirect("http://127.0.0.1:%d/pkey/callback?code=C0DE&state=x&iss=y&request=%s" % [port2, RQ])
	t.check("native session: a callback after cancel sends nothing", late.code == PKeyErrors.SIGN_IN_FAILED and bed.token_requests.is_empty())
	bed.free_all()

	# access_denied from the card is a cancel; the browser still reaches the return page.
	bed = await _bed()
	root = _root(bed)
	var s3 := await _start(bed)
	var st3 := _param(bed.push_requests[0]["body"], "state")
	var port3: int = s3._native.listener.port
	var box3 := B.follow(s3)
	var rep3 := await _exchange(s3._native.listener, port3, _req("/pkey/callback?error=access_denied&state=%s&iss=%s&request=%s" % [st3, root.uri_encode(), RQ], "127.0.0.1:%d" % port3))
	await B.until(func(): return box3.size() == 1)
	t.check("native session: access_denied settles cancelled with no token request", box3.size() == 1 and box3[0].kind == PKeySignInOutcome.KIND_CANCELLED and bed.token_requests.is_empty() and rep3.contains("cancelled=1"), rep3)
	bed.free_all()

	# Expiry: the pushed request's 600 s on the client's clock.
	bed = await _bed()
	root = _root(bed)
	var s4 := await _start(bed)
	var port4: int = s4._native.listener.port
	var box4 := B.follow(s4)
	await B.until(func(): return s4.is_waiting())
	bed.clock[0] += 601.0
	await B.until(func(): return box4.size() == 1, 200)
	t.check("native session: past 600 s wait() settles expired and closes the listener", box4.size() == 1 and box4[0].kind == PKeySignInOutcome.KIND_EXPIRED and box4[0].code == PKeyErrors.SIGN_IN_EXPIRED and TCPServer.new().listen(port4, "127.0.0.1") == OK, str(box4))
	t.check("native session: reopen() after the lapse is false", not s4.reopen())
	bed.free_all()

	# Scheme delivery through handle_redirect.
	bed = await _bed()
	root = _root(bed)
	bed.sdk.identity.native_platform = "other"
	var s5 := await _start(bed, {"loopback": false, "registered_schemes": [SCHEME], "return_uri": SCHEME})
	t.check("native session: no listener means a registered scheme", s5.ok and s5.redirect_class == "scheme" and s5.redirect_uri == SCHEME and s5._native.listener == null, str(s5))
	t.check("native session: the push names the scheme and its return_uri", String(bed.push_requests[0]["body"]).contains("redirect_uri=com.tidewater.studio%3A%2Fpkey%2Fcallback") and String(bed.push_requests[0]["body"]).ends_with("&return_uri=com.tidewater.studio%3A%2Fpkey%2Fcallback"), bed.push_requests[0]["body"])
	var st5 := _param(bed.push_requests[0]["body"], "state")
	var iss5 := root.uri_encode()
	var wrong: PKeySignInOutcome = await bed.sdk.identity.sign_in.handle_redirect("%s?code=C0DE&state=wrong-state-0123456789&iss=%s" % [SCHEME, iss5])
	t.check("native session: a delivery with another state is refused and leaves the sign-in waiting", wrong.code == PKeyErrors.SIGN_IN_FAILED and bed.token_requests.is_empty() and not s5._native.pending.is_empty())
	var other: PKeySignInOutcome = await bed.sdk.identity.sign_in.handle_redirect("com.other.app:/pkey/callback?code=C0DE&state=%s&iss=%s" % [st5, iss5])
	t.check("native session: a delivery for another redirect URI is refused the same way", other.code == PKeyErrors.SIGN_IN_FAILED and bed.token_requests.is_empty())
	var done: PKeySignInOutcome = await bed.sdk.identity.sign_in.handle_redirect("%s?code=C0DE&state=%s&iss=%s" % [SCHEME, st5, iss5])
	t.check("native session: handle_redirect redeems the scheme delivery", done.kind == PKeySignInOutcome.KIND_SIGNED_IN and bed.token_requests.size() == 1 and bed.token_requests[0]["headers"].get("x-pkey-device") == bed.F["device_id"], str(done))
	var twice: PKeySignInOutcome = await bed.sdk.identity.sign_in.handle_redirect("%s?code=C0DE&state=%s&iss=%s" % [SCHEME, st5, iss5])
	t.check("native session: single use, a second delivery sends nothing", twice.code == PKeyErrors.SIGN_IN_FAILED and bed.token_requests.size() == 1)
	bed.free_all()

	# No class: nothing is sent, redirect-unavailable.
	bed = await _bed()
	root = _root(bed)
	bed.sdk.identity.native_platform = "other"
	var s6 := await _start(bed, {"loopback": true})
	t.check("native session: a host that cannot listen and has no scheme answers redirect-unavailable before any request", not s6.ok and s6.code == &"redirect-unavailable" and bed.push_requests.is_empty(), str(s6))
	bed.free_all()

	# Discovery without the pushed-request endpoint, or without a return page for the listener.
	bed = await _bed()
	root = _root(bed)
	var frag: Dictionary = bed.sdk.core.discovery_manifest["services"]["identity"]
	frag["endpoints"].erase("request")
	var s7 := await _start(bed)
	t.check("native session: discovery with no request endpoint is redirect-unavailable", not s7.ok and s7.code == &"redirect-unavailable" and s7.detail.get("reason") == "request-not-served" and bed.push_requests.is_empty(), str(s7))
	bed.free_all()
	bed = await _bed("", false)
	root = _root(bed)
	var s8 := await _start(bed)
	t.check("native session: no return page means no listener, so no class", not s8.ok and s8.code == &"redirect-unavailable" and bed.push_requests.is_empty(), str(s8))
	bed.free_all()

	# The Worker refuses the push: typed, and the listener it bound is released.
	bed = await _bed()
	root = _root(bed)
	var held := {"port": 0}
	bed.on_push = func(req: Dictionary) -> void:
		var m := RegEx.create_from_string("redirect_uri=http%3A%2F%2F127\\.0\\.0\\.1%3A(\\d+)%2Fpkey").search((req["body"] as PackedByteArray).get_string_from_utf8())
		held["port"] = int(m.get_string(1)) if m != null else 0
	bed.pushes = [B.json(400, {"error": "redirect_uri_mismatch"})]
	var s9 := await _start(bed)
	t.check("native session: a refused push is the Worker's own code and nothing stays bound", not s9.ok and s9.code == &"redirect_uri_mismatch" and held["port"] > 0 and TCPServer.new().listen(held["port"], "127.0.0.1") == OK, str(s9))
	bed.pushes = [{"status": 429, "headers": {"Content-Type": "application/json", "Retry-After": "7"}, "body": "{\"error\":\"rate_limited\"}"}]
	var s10 := await _start(bed)
	t.check("native session: a 429 push carries Retry-After", not s10.ok and s10.code == &"rate_limited" and s10.detail.get("retry_after_seconds") == 7, str(s10.detail))
	bed.pushes = [B.json(201, {"request_uri": "urn:x", "expires_in": 600})]
	var s11 := await _start(bed)
	t.check("native session: a pushed answer without a request_uri is invalid-response", not s11.ok and s11.code == PKeyErrors.INVALID_RESPONSE, str(s11))
	bed.free_all()

	# The refusal of the redemption: the Worker's own code, the token kept.
	bed = await _bed(B.TOKEN)
	root = _root(bed)
	bed.tokens = [B.json(400, {"error": "invalid_grant"})]
	var s12 := await _start(bed)
	var st12 := _param(bed.push_requests[0]["body"], "state")
	var refused: PKeySignInOutcome = await s12.handle_redirect("http://127.0.0.1:%d/pkey/callback?code=C0DE&state=%s&iss=%s&request=%s" % [s12._native.listener.port, st12, root.uri_encode(), RQ])
	t.check("native session: invalid_grant is typed and the stored token is kept", refused.code == &"invalid_grant" and bed.sdk.core.tokens.current() == B.TOKEN, str(refused))
	bed.free_all()


func _param(form: String, name: String) -> String:
	for part in form.split("&"):
		if part.begins_with(name + "="):
			return part.substr(name.length() + 1).uri_decode()
	return ""


# ── Android: the registered scheme, the plugin's browser, the OS delivery (I-48.17b) ─────

## A sign-in on a faked Android: the project registered SCHEME, the plugin routes it, discovery lists it.
func _phone(scheme_setting := "com.tidewater.studio", authorize := AUTHORIZE) -> Array:
	var bed := await _bed("", false)
	var frag: Dictionary = bed.sdk.core.discovery_manifest["services"]["identity"]
	frag["issuer"] = ISS
	frag["endpoints"]["authorize"] = authorize
	bed.sdk.identity.native_platform = "android"
	var fake := PKeyFakeAndroidNative.new()
	fake.auth_filters = [SCHEME]
	var droid := PKeyAndroid.new()
	droid.platform = "android"
	droid.native = fake
	droid.timeout_s = 2.0
	var opener := PKeyAndroidRedirect.new()
	opener.android = droid
	opener.settings = {"scheme": scheme_setting} if scheme_setting != "" else {}
	bed.sdk.identity.native_opener = opener
	return [bed, fake, droid, opener]


func _pump(droid: PKeyAndroid) -> void:
	droid.poll()
	await (Engine.get_main_loop() as SceneTree).process_frame


func _android(t: PKeyTestContext) -> void:
	var rig := await _phone()
	var bed: B = rig[0]
	var fake: PKeyFakeAndroidNative = rig[1]
	var droid: PKeyAndroid = rig[2]
	var s: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect"})
	t.check("android redirect: the registered scheme is the class, with no listener", s.ok and s.redirect_class == "scheme" and s.redirect_uri == SCHEME and s._native.listener == null, str(s))
	t.check("android redirect: the page opened through the plugin, on the issuer's host, for the scheme", s.opened and fake.auth_opened.size() == 1 and fake.auth_opened[0]["url"] == s.authorize_url and fake.auth_opened[0]["issuerHost"] == "key.plrs.im" and fake.auth_opened[0]["scheme"] == "com.tidewater.studio" and fake.auth_opened[0]["claimedUri"] == "", str(fake.auth_opened))
	t.check("android redirect: the push named the scheme", String(bed.push_requests[0]["body"]).contains("redirect_uri=com.tidewater.studio%3A%2Fpkey%2Fcallback"), bed.push_requests[0]["body"])
	t.check("android redirect: Open browser again opens the same page", s.reopen() and fake.auth_opened.size() == 2 and fake.auth_opened[1]["url"] == s.authorize_url)
	var box := B.follow(s)
	var state := _param(bed.push_requests[0]["body"], "state")
	var iss := ISS.uri_encode()
	t.check("android redirect: a foreign scheme is dropped by the plugin", not fake.auth_deliver("com.other.app:/pkey/callback?code=C0DE&state=%s&iss=%s" % [state, iss]))
	t.check("android redirect: a redirect with a fragment is dropped by the plugin", not fake.auth_deliver("%s?code=C0DE&state=%s&iss=%s#x" % [SCHEME, state, iss]))
	t.check("android redirect: a delivery with another state reaches the sign-in and is refused", fake.auth_deliver("%s?code=C0DE&state=wrong-state-0123456789&iss=%s" % [SCHEME, iss]))
	await _pump(droid)
	await B.until(func(): return true, 3)
	t.check("android redirect: the refusal sent nothing and left the sign-in waiting", bed.token_requests.is_empty() and box.is_empty() and not s._native.pending.is_empty())
	var good := "%s?code=C0DE&state=%s&iss=%s" % [SCHEME, state, iss]
	t.check("android redirect: the OS delivers the right redirect", fake.auth_deliver(good))
	await _pump(droid)
	await B.until(func(): return box.size() == 1)
	var o: PKeySignInOutcome = box[0] if box.size() == 1 else null
	t.check("android redirect: handle_redirect redeemed it from this device", o != null and o.kind == PKeySignInOutcome.KIND_SIGNED_IN and bed.token_requests.size() == 1 and bed.token_requests[0]["headers"].get("x-pkey-device") == bed.F["device_id"], str(o))
	t.check("android redirect: the same URL again is dropped (single use)", not fake.auth_deliver(good) and bed.token_requests.size() == 1)
	t.check("android redirect: nothing waits natively once it settled", not fake.auth_deliver("%s?code=C0DE2&state=%s&iss=%s" % [SCHEME, state, iss]))
	t.check("android redirect: str() holds no code", not str(s).contains("C0DE"))
	droid.free()
	bed.free_all()

	# Cancel drops the native wait.
	rig = await _phone()
	bed = rig[0]
	fake = rig[1]
	droid = rig[2]
	var s2: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect"})
	var st2 := _param(bed.push_requests[0]["body"], "state")
	s2.cancel()
	await B.until(func(): return s2._native.closed)
	t.check("android redirect: after cancel() a redirect is dropped", not fake.auth_deliver("%s?code=C0DE&state=%s&iss=%s" % [SCHEME, st2, ISS.uri_encode()]) and bed.token_requests.is_empty())
	droid.free()
	bed.free_all()

	# No scheme registered, no plugin: redirect-unavailable before anything is sent.
	rig = await _phone("")
	bed = rig[0]
	var s3: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect"})
	t.check("android redirect: no registered scheme or link is redirect-unavailable, nothing sent", not s3.ok and s3.code == &"redirect-unavailable" and bed.push_requests.is_empty(), str(s3))
	rig[2].free()
	bed.free_all()
	rig = await _phone()
	bed = rig[0]
	rig[1].auth_redirect = false
	var s4: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect"})
	t.check("android redirect: a plugin without the redirect ops is redirect-unavailable, nothing sent", not s4.ok and s4.code == &"redirect-unavailable" and bed.push_requests.is_empty(), str(s4))
	rig[2].free()
	bed.free_all()

	# The manifest has no filter for it: the plugin refuses to open; the page is never shown.
	rig = await _phone()
	bed = rig[0]
	fake = rig[1]
	fake.auth_filters = []
	var s5: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect"})
	t.check("android redirect: a manifest without the intent filter opens nothing", s5.ok and not s5.opened and fake.auth_opened.is_empty() and not s5.reopen())
	rig[2].free()
	bed.free_all()

	# An authorize endpoint off the issuer's host is refused natively.
	rig = await _phone("com.tidewater.studio", "https://evil.example/authorize")
	bed = rig[0]
	fake = rig[1]
	var s6: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect"})
	t.check("android redirect: an off-host authorize page is never opened", s6.ok and not s6.opened and fake.auth_opened.is_empty(), str(fake.auth_opened))
	rig[2].free()
	bed.free_all()

	# The registered redirects, from the project settings' shapes.
	var o2 := PKeyAndroidRedirect.new()
	o2.settings = {"scheme": "com.tidewater.studio", "claimed_uri": "https://game.example/open/pkey"}
	t.check("android redirect: registered() names the scheme URI and the claimed link", o2.registered() == {"schemes": [SCHEME], "claimed": ["https://game.example/open/pkey"]} and o2.owns(SCHEME) and o2.owns("https://game.example/open/pkey") and not o2.owns("com.other.app:/pkey/callback"))
	o2.settings = {"scheme": "https", "claimed_uri": "http://game.example/open"}
	t.check("android redirect: a reserved scheme and a non-HTTPS link register nothing", o2.registered() == {"schemes": [], "claimed": []})
