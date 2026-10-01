extends RefCounted
# PKeyTransport against two loopback servers (two ports, so two origins): redirects are followed
# by hand and the bearer never crosses an origin; the body cap and the timeout are PKeyResult
# errors; plain http to anything but loopback is refused at configure.

const BEARER := "Bearer pkeyt_secret"


func run(t: PKeyTestContext) -> void:
	var other := PKeyTestFixtures.new_server(func(req): return {"status": 200, "body": "other"})
	var main_handler := func(req: Dictionary) -> Dictionary:
		match req["path"]:
			"/echo":
				return {"status": 200, "body": "echo"}
			"/same":
				return {"status": 302, "headers": {"Location": "/echo"}}
			"/relative/start":
				return {"status": 307, "headers": {"Location": "next"}}
			"/relative/next":
				return {"status": 200, "body": "relative"}
			"/cross":
				return {"status": 302, "headers": {"Location": other.base_url() + "/landed"}}
			"/bounce":
				return {"status": 302, "headers": {"Location": other.base_url() + "/back"}}
			"/see-other":
				return {"status": 303, "headers": {"Location": "/echo"}}
			"/loop":
				return {"status": 302, "headers": {"Location": "/loop"}}
			"/insecure":
				return {"status": 302, "headers": {"Location": "http://example.com/x"}}
			"/big":
				return {"status": 200, "body": "A".repeat(600 * 1024)}
			"/hang":
				return {"hang": true}
			"/slow/1":
				OS.delay_msec(650)
				return {"status": 302, "headers": {"Location": "/slow/2"}}
			"/slow/2":
				OS.delay_msec(650)
				return {"status": 302, "headers": {"Location": "/echo"}}
		return {"status": 404}
	var server := PKeyTestFixtures.new_server(main_handler)
	other.handler = func(req: Dictionary) -> Dictionary:
		if req["path"] == "/back":
			return {"status": 302, "headers": {"Location": server.base_url() + "/echo"}}
		return {"status": 200, "body": "other"}
	var host := Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(host)
	var tr := PKeyTransport.new(host)
	# The success paths get a generous budget; only the /hang check below runs on 1 s.
	tr.timeout = 10.0
	await PKeyTestFixtures.frames(2)

	var r := await tr.request("GET", server.base_url() + "/same", {"Authorization": BEARER})
	var last: Dictionary = server.requests.back() if not server.requests.is_empty() else {"path": "", "headers": {}}
	t.check("transport: a same-origin redirect is followed", r.ok and r.detail["status"] == 200 and last["path"] == "/echo", str(r))
	t.check("transport: a same-origin redirect keeps Authorization", last["headers"].get("authorization") == BEARER, str(last["headers"]))

	r = await tr.request("GET", server.base_url() + "/relative/start", {"Authorization": BEARER})
	t.check("transport: a relative Location resolves against the path", r.ok and (r.detail["body"] as PackedByteArray).get_string_from_utf8() == "relative", str(r))

	r = await tr.request("GET", server.base_url() + "/cross", {"Authorization": BEARER, "X-PKey-Device": "d"})
	var landed: Dictionary = other.requests.back()
	t.check("transport: a cross-origin redirect is followed", r.ok and landed["path"] == "/landed", str(r))
	t.check("transport: a cross-origin redirect drops Authorization", not landed["headers"].has("authorization"), str(landed["headers"]))

	server.requests.clear()
	r = await tr.request("GET", server.base_url() + "/bounce", {"Authorization": BEARER})
	var home: Dictionary = server.requests.back()
	t.check("transport: Authorization stays dropped after bouncing back to the origin", r.ok and home["path"] == "/echo" and not home["headers"].has("authorization"), str(home))

	server.requests.clear()
	r = await tr.request("POST", server.base_url() + "/see-other", {"Content-Type": "application/json"}, "{\"a\":1}".to_utf8_buffer())
	var after: Dictionary = server.requests.back()
	t.check("transport: 303 becomes a GET without a body", r.ok and after["method"] == "GET" and (after["body"] as PackedByteArray).is_empty(), str(after))

	r = await tr.request("GET", server.base_url() + "/loop")
	t.check("transport: a redirect loop ends in too-many-redirects", not r.ok and r.code == PKeyErrors.TOO_MANY_REDIRECTS, str(r))

	r = await tr.request("GET", server.base_url() + "/insecure", {"Authorization": BEARER})
	t.check("transport: a redirect to plain http on another host is refused", not r.ok and r.code == PKeyErrors.INSECURE_REDIRECT, str(r))

	r = await tr.request("GET", server.base_url() + "/big")
	t.check("transport: a body over the 512 KiB cap is a PKeyResult error", not r.ok and r.code == PKeyErrors.BODY_TOO_LARGE, str(r))

	# The budget is wall time from the request's start: a long frame just before the call (here a
	# 1.5 s block) does not spend it. HTTPRequest.timeout counts process delta and would fire here.
	tr.timeout = 1.0
	OS.delay_msec(1500)
	r = await tr.request("GET", server.base_url() + "/echo")
	t.check("transport: a long frame before the request does not spend its timeout", r.ok and r.detail["status"] == 200, str(r))

	# Two 650 ms hops: each fits in 1 s, together they do not. The deadline is computed once per
	# request, so the redirect chain shares one budget instead of getting 1 s per hop.
	r = await tr.request("GET", server.base_url() + "/slow/1")
	t.check("transport: redirect hops share one timeout budget", not r.ok and r.code == PKeyErrors.TIMEOUT, str(r))

	var t0 := Time.get_ticks_msec()
	r = await tr.request("GET", server.base_url() + "/hang")
	t.check("transport: a timeout is a PKeyResult error", not r.ok and r.code == PKeyErrors.TIMEOUT, str(r))
	t.info("transport: the 1 s timeout fired after %d ms" % (Time.get_ticks_msec() - t0))

	var logged := false
	for s in tr.sent:
		logged = logged or s["headers"].get("authorization") == "<redacted>"
	t.check("transport: the request log never holds the bearer", logged and not JSON.stringify(tr.sent).contains("pkeyt_secret"))

	tr.local_only = true
	var before := server.requests.size()
	r = await tr.request("GET", server.base_url() + "/echo")
	t.check("transport: local-only refuses at the dial", not r.ok and r.code == PKeyErrors.LOCAL_ONLY and server.requests.size() == before)

	var detached := PKeyTransport.new(Node.new())
	r = await detached.request("GET", server.base_url() + "/echo")
	t.check("transport: a host outside the tree is an error, not a crash", not r.ok and r.code == PKeyErrors.NETWORK)
	detached.host.free()

	# The https rule, at configure.
	var cases := {
		"https://key.plrs.im": true,
		"https://key.plrs.im/": true,
		"http://localhost:8787": true,
		"http://127.0.0.1:9000": true,
		"http://[::1]:9000": true,
		"http://key.plrs.im": false,
		"http://example.com": false,
		"http://127.0.0.2": false,
		"ftp://key.plrs.im": false,
		"key.plrs.im": false,
	}
	for url in cases:
		var sdk := PKeyTestFixtures.new_sdk()
		var opts := PKeyOptions.new()
		opts.product = "djdl"
		opts.version = "1.0.0"
		opts.base_url = url
		opts.store = PKeyMemoryStore.new()
		var cr: PKeyResult = sdk.configure(opts)
		var want: bool = cases[url]
		t.check("transport: configure %s %s" % ["accepts" if want else "refuses", url], cr.ok == want and (want or cr.code == PKeyErrors.INSECURE_BASE_URL), str(cr))
		sdk.queue_free()
	var trimmed := PKeyTransport.check_base_url("https://key.plrs.im///")
	t.check("transport: trailing slashes are trimmed", trimmed.ok and trimmed.detail == "https://key.plrs.im")
	t.check("transport: resolve an absolute Location", PKeyTransport.resolve("https://a.test/x/y", "https://b.test/z") == "https://b.test/z")
	t.check("transport: resolve a scheme-relative Location", PKeyTransport.resolve("https://a.test:8443/x", "//b.test/z") == "https://b.test/z")
	t.check("transport: resolve an absolute path", PKeyTransport.resolve("https://a.test:8443/x/y?q", "/z") == "https://a.test:8443/z")

	host.queue_free()
	server.queue_free()
	other.queue_free()
