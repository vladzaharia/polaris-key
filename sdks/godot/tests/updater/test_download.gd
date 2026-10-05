extends RefCounted
# @pkey-feature update.driver
# PKeyDownload (the sidecar pack's download) against PKeyFakeServer: a full 200, a Range resume
# (206 appended), a server that ignores Range (200 starts over), 416 for a complete part, gzip
# off (Accept-Encoding: identity), the bearer dropped on a cross-origin redirect, the record's size
# as a cap, local-only, and the one wall-clock deadline (the part is kept for the next attempt).

const S := preload("res://tests/updater/support.gd")


func run(t: PKeyTestContext) -> void:
	var sup := S.new()
	var server := sup.serve()
	var dir := PKeyTestFixtures.scratch_dir("download")
	var body := S.bytes(300 * 1024 + 17, 7)
	var tr := PKeyTransport.new(server)
	var auth := {"Authorization": "Bearer pkeyt_secret", "X-PKey-Device": "dev_7c1e2d"}

	# A full download.
	sup.plan = {"/f/": [S.ranged(body)]}
	var dest := dir.path_join("a.pck")
	var progress: Array = []
	var r := await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": body.size(), "progress": func(g, n): progress.append([g, n])})
	var req: Dictionary = sup.requests("/f/")[0] if not sup.requests("/f/").is_empty() else {}
	t.check("download: a 200 lands in <dest>.part with every byte", r.ok and r.detail["path"] == dest + ".part" and S.read(dest + ".part") == body and r.detail["status"] == 200 and not r.detail["resumed"], str(r))
	t.check("download: no gzip and no Range on a fresh download", req.get("headers", {}).get("accept-encoding") == "identity" and not req.get("headers", {}).has("range"), str(req.get("headers")))
	t.check("download: progress reported up to the total", not progress.is_empty() and progress[-1] == [body.size(), body.size()])

	# Resume: a part with the first bytes asks for the rest and appends the 206.
	server.requests.clear()
	S.write(dest + ".part", body.slice(0, 100000))
	r = await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": body.size()})
	req = sup.requests("/f/")[0] if not sup.requests("/f/").is_empty() else {}
	t.check("download: a partial file resumes with Range: bytes=100000-", req.get("headers", {}).get("range") == "bytes=100000-", str(req.get("headers")))
	t.check("download: the 206 is appended and the file is whole", r.ok and r.detail["status"] == 206 and r.detail["resumed"] and S.read(dest + ".part") == body, str(r))

	# A server that ignores Range: the 200 starts the file over.
	server.requests.clear()
	sup.plan = {"/f/": [S.ranged(body, false)]}
	S.write(dest + ".part", body.slice(0, 5000))
	r = await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": body.size()})
	t.check("download: a 200 to a Range request starts over, never appends", r.ok and S.read(dest + ".part") == body and not r.detail["resumed"], str(r))

	# A complete part: nothing is requested at all.
	server.requests.clear()
	r = await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": body.size()})
	t.check("download: a complete part is done without a request", r.ok and sup.requests("/f/").is_empty())

	# 416 for a part the server says is complete (size known to the server only).
	server.requests.clear()
	sup.plan = {"/f/": [{"status": 416, "headers": {"Content-Range": "bytes */10"}}, S.ranged(body)]}
	S.write(dest + ".part", body.slice(0, 10))
	r = await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": body.size()})
	t.check("download: a 416 for an incomplete part restarts it once from zero", r.ok and S.read(dest + ".part") == body and sup.requests("/f/").size() == 2, str(r))

	# A cross-origin redirect drops the bearer; a same-origin one keeps it.
	server.requests.clear()
	DirAccess.remove_absolute(dest + ".part")
	var sup2 := S.new()
	var server2 := sup2.serve()
	sup2.plan = {"/f/": [S.ranged(body)]}
	var other := server2.base_url()
	sup.plan = {
		"/r/same": [{"status": 302, "headers": {"Location": "/r/cross"}}],
		"/r/cross": [{"status": 302, "headers": {"Location": other + "/f/a"}}],
	}
	r = await PKeyDownload.fetch(tr, server.base_url() + "/r/same", dest, auth, {"expected_size": body.size()})
	var hops := server.requests.map(func(q): return [q["path"], q["headers"].has("authorization")])
	hops.append_array(server2.requests.map(func(q): return [q["path"], q["headers"].has("authorization"), q["headers"].has("x-pkey-device")]))
	t.check("download: redirects followed by hand; the bearer kept on the same origin and dropped across origins (other headers kept)", r.ok and hops == [["/r/same", true], ["/r/cross", true], ["/f/a", false, true]] and S.read(dest + ".part") == body, str(hops))
	sup2.free_server()
	var logged: Array = tr.sent.filter(func(x): return String(x["url"]).ends_with("/r/same"))
	t.check("download: the transport log never holds the bearer", not logged.is_empty() and logged[0]["headers"].get("authorization") == "<redacted>")

	# An insecure redirect is refused.
	DirAccess.remove_absolute(dest + ".part")
	sup.plan = {"/r/": [{"status": 302, "headers": {"Location": "http://example.com/f/a"}}]}
	r = await PKeyDownload.fetch(tr, server.base_url() + "/r/x", dest, auth, {"expected_size": body.size()})
	t.check("download: a redirect to plain http off loopback is refused", not r.ok and r.code == PKeyErrors.INSECURE_REDIRECT, str(r))

	# The record's size caps the body.
	DirAccess.remove_absolute(dest + ".part")
	sup.plan = {"/f/": [S.ranged(body)]}
	r = await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": body.size() - 1})
	t.check("download: more bytes than the record's size is refused and the part removed", not r.ok and r.code == PKeyErrors.RESPONSE_TOO_LARGE and not FileAccess.file_exists(dest + ".part"), str(r))
	r = await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {})
	t.check("download: no expected size, no download", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS)
	sup.plan = {"/f/": [{"status": 404}]}
	r = await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": 10})
	t.check("download: a 404 is http-error with its status", not r.ok and r.code == PKeyErrors.HTTP_ERROR and r.detail.get("status") == 404)
	# SDK parity §3.10: a gated build's refusal keeps the server's code, so the updater can attest
	# and retry once (PKeyUpdater.with_attestation).
	sup.plan = {"/f/": [{"status": 403, "headers": {"Content-Type": "application/json"}, "body": "{\"error\":{\"code\":\"attestation_required\",\"message\":\"this operation requires an attested device\"}}"}]}
	r = await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": 10})
	t.check("download: a 403 keeps the server's code", not r.ok and r.code == &"attestation_required" and r.detail.get("status") == 403 and r.message == "this operation requires an attested device", str(r))
	var core_ish := PKeyCore.new()
	core_ish.options = PKeyOptions.new()
	var attests := [0]
	core_ish.attest_hook = func() -> PKeyResult:
		attests[0] += 1
		sup.plan = {"/f/": [S.ranged(body)]}
		return PKeyResult.success({"trust_level": "attested"})
	DirAccess.remove_absolute(dest + ".part")
	r = await core_ish.with_attestation(func() -> PKeyResult: return await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": body.size()}))
	t.check("download: attestation_required attests once and the retry downloads", r.ok and attests[0] == 1 and r.detail.get("attested_retry") == true and S.read(dest + ".part") == body, str(r))
	DirAccess.remove_absolute(dest + ".part")

	# local-only refuses before dialling.
	var lo := PKeyTransport.new(server)
	lo.local_only = true
	server.requests.clear()
	r = await PKeyDownload.fetch(lo, server.base_url() + "/f/a", dest, auth, {"expected_size": 10})
	t.check("download: local-only refuses without a request", not r.ok and r.code == PKeyErrors.LOCAL_ONLY and server.requests.is_empty())

	# One wall-clock deadline: a server that never answers times out, and a part is kept.
	S.write(dest + ".part", body.slice(0, 1000))
	sup.plan = {"/f/": [{"hang": true}]}
	var started := Time.get_ticks_msec()
	r = await PKeyDownload.fetch(tr, server.base_url() + "/f/a", dest, auth, {"expected_size": body.size(), "timeout": 0.5})
	var took := Time.get_ticks_msec() - started
	t.check("download: the request's one deadline ends a hung download (timeout) and keeps the part", not r.ok and r.code == PKeyErrors.TIMEOUT and took < 3000 and S.read(dest + ".part").size() == 1000, "%s in %d ms" % [r, took])

	sup.free_server()
	PKeyTestFixtures.remove_tree(dir)
