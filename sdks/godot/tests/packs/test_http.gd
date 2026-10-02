extends RefCounted
# @pkey-feature packs.state
# PolarisKey.update.packs over HTTP (PKeyPackCdnTransport + PKeyPackHttp) against PKeyFakeServer:
# the pinned record from discovery's `release.endpoints.record`, objects from
# `distribution.endpoints.blobs` with gzip off, the device bearer to the control plane's origin
# only (and dropped on a cross-origin redirect), an interrupted object resumed with Range and
# If-Range at the next ensure, a 403 (P4-05's `delivery_gate_missing`) as `pack-not-entitled`,
# the pack signals, packSetId on the device report, and the boot's FETCH events.

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")
const TOKEN := "pkeyt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

var plan := {}
var cut := {}  # sha256 -> bytes to send before dropping the connection (once)


func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"]).get_slice("?", 0)
	for prefix in plan:
		if path.begins_with(prefix):
			var a = plan[prefix]
			return a.call(req) if a is Callable else a
	return {"status": 404, "headers": {"Content-Type": "application/json"}, "body": "{\"error\":{\"code\":\"not_found\"}}"}


## Serve objects by SHA-256 with Range/If-Range (the strong ETag "<sha256>").
func _objects(objects: Dictionary) -> Callable:
	return func(req: Dictionary) -> Dictionary:
		var h := String(req["path"]).get_slice("?", 0).get_file()
		if not objects.has(h):
			return {"status": 404}
		var b: PackedByteArray = objects[h]
		var r := String(req["headers"].get("range", ""))
		var ir := String(req["headers"].get("if-range", ""))
		var body := b
		var status := 200
		var headers := {"Content-Type": "application/octet-stream", "ETag": "\"%s\"" % h}
		if r.begins_with("bytes=") and r.ends_with("-") and ir == "\"%s\"" % h:
			var from := int(r.substr(6, r.length() - 7))
			body = b.slice(from)
			status = 206
			headers["Content-Range"] = "bytes %d-%d/%d" % [from, b.size() - 1, b.size()]
		if cut.has(h):
			var n: int = cut[h]
			cut.erase(h)
			# Advertise the whole length but send `n` bytes: the client sees the body end early.
			headers["Content-Length"] = str(body.size())
			return {"status": status, "headers": headers, "body": body.slice(0, n), "truncate": true}
		return {"status": status, "headers": headers, "body": body}


func run(t: PKeyTestContext) -> void:
	var big := PackedByteArray()
	big.resize(120000)
	for k in big.size():
		big[k] = (k * 37 + 5) % 241
	var p := F.tree_pack("djdl.music", "1.0.0", 1, {"track.ogg": big, "readme.txt": "music"})
	var server := PKeyTestFixtures.new_server(_answer)
	var other := PKeyTestFixtures.new_server(_answer)
	var base := server.base_url() + "/djdl"
	plan = {
		"/djdl/release/records/": func(req: Dictionary) -> Dictionary:
			var h := String(req["path"]).get_file()
			return {"status": 200, "headers": {"Content-Type": "application/jose"}, "body": p["jws"]} if h == p["recordSha256"] else {"status": 404},
		"/djdl/distribution/blobs/": _objects(p["objects"]),
	}
	var root := S.scratch("http")
	var stamp_file := root.path_join("pkey-content.json")
	S.write_file(stamp_file, F.stamp_text(F.stamp_for([p])).to_utf8_buffer())
	var sdk := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(server.base_url(), PKeyMemoryStore.new("dev_7c1e2d", TOKEN), [1759500000.0], "djdl", F.product_trust())
	opts.pinned_release_keys = F.release_keys()
	opts.expected_services = PackedStringArray(["release", "distribution"])
	var c: PKeyResult = sdk.configure(opts)
	if not t.check("http: configure", c.ok, str(c)):
		return
	await sdk.start()
	sdk.core.discovery_manifest = {"product": "djdl", "services": {
		"release": {"enabled": true, "endpoints": {"record": base + "/release/records/{sha256}"}},
		"distribution": {"enabled": true, "endpoints": {"blobs": base + "/distribution/blobs/{sha256}"}},
	}}
	var packs: PKeyPacks = sdk.update.packs
	packs.root = root.path_join("pkey")
	packs.stamp_path = stamp_file
	packs.embedded_dir = root.path_join("none")
	var signals: Array = []
	packs.pack_progress.connect(func(id, bytes, total): if signals.is_empty() or signals[-1][0] != "pack_progress": signals.append(["pack_progress", id]))
	packs.set_changed.connect(func(a): signals.append(["set_changed", a]))
	packs.pack_ready.connect(func(id): signals.append(["pack_ready", id]))
	packs.pack_failed.connect(func(id, err): signals.append(["pack_failed", id, err]))

	# An interrupted object, then the resume at the next ensure.
	cut[p["fullSha256"]] = 30000
	var r := await packs.ensure(["djdl.music"])
	t.check("http: a dropped connection fails the ensure with network-error (pack_failed)", not r.ok and r.code == PKeyErrors.NETWORK and signals.has(["pack_failed", "djdl.music", "network-error"]), "%s %s" % [r, S.canon(signals)])
	signals.clear()
	server.requests.clear()
	r = await packs.ensure(["djdl.music"])
	var blob_reqs: Array = server.requests.filter(func(q): return String(q["path"]).contains("/distribution/blobs/"))
	var resumed: Array = blob_reqs.filter(func(q): return q["headers"].has("range"))
	t.check("http: the next ensure installs it", r.ok and FileAccess.get_file_as_bytes(packs.path("djdl.music").path_join("track.ogg")) == big, str(r))
	t.check("http: it resumed with Range and If-Range: \"<sha256>\"", not resumed.is_empty() and resumed[0]["headers"].get("if-range") == "\"%s\"" % p["fullSha256"] and String(resumed[0]["headers"].get("range")).begins_with("bytes="), S.canon(blob_reqs.map(func(q): return q["headers"])))
	t.check("http: every object request asks for identity (gzip breaks Range)", not blob_reqs.is_empty() and blob_reqs.all(func(q): return q["headers"].get("accept-encoding") == "identity"))
	t.check("http: the bearer goes to the control plane's own origin", blob_reqs.all(func(q): return q["headers"].get("authorization") == "Bearer " + TOKEN))
	S.check_same(t, "http: the signals fire in order: progress, set_changed, pack_ready", signals, [["pack_progress", "djdl.music"], ["set_changed", "hot"], ["pack_ready", "djdl.music"]])
	var report: Dictionary = sdk.devices.snapshot()
	t.check("http: the device report carries content.packSetId", report.get("content", {}).get("packSetId") == PKeyPackClaims.pack_set_id([{"packId": "djdl.music", "releaseSha256": p["recordSha256"]}]), S.canon(report.get("content")))

	# A blob host on another origin (a redirect): the bearer never follows it.
	var p2 := F.tree_pack("djdl.extra", "1.0.0", 1, {"x.bin": big.slice(0, 50000)})
	S.write_file(stamp_file, F.stamp_text(F.stamp_for([p, p2])).to_utf8_buffer())
	packs.content = PKeyPackClaims.parse_content_stamp(FileAccess.get_file_as_bytes(stamp_file))["content"]
	packs.engine.stamp = packs.content
	plan["/djdl/release/records/"] = func(req: Dictionary) -> Dictionary:
		var h := String(req["path"]).get_file()
		var jws: String = p["jws"] if h == p["recordSha256"] else (p2["jws"] if h == p2["recordSha256"] else "")
		return {"status": 200, "headers": {"Content-Type": "application/jose"}, "body": jws} if jws != "" else {"status": 404}
	plan["/djdl/distribution/blobs/"] = func(req: Dictionary) -> Dictionary:
		return {"status": 302, "headers": {"Location": other.base_url() + "/cdn/" + String(req["path"]).get_file()}}
	plan["/cdn/"] = _objects(p2["objects"])
	other.requests.clear()
	r = await packs.ensure(["djdl.extra"])
	t.check("http: objects behind a cross-origin redirect install", r.ok, str(r))
	t.check("http: …and the bearer is dropped at the other origin", not other.requests.is_empty() and other.requests.all(func(q): return not q["headers"].has("authorization")), S.canon(other.requests.map(func(q): return q["headers"])))

	# A 403 from the blob route (P4-05: delivery_gate_missing, not_entitled) is a failed fetch.
	var p3 := F.tree_pack("djdl.gated", "1.0.0", 1, {"y.bin": "gated"})
	packs.content = F.stamp_for([p, p2, p3])
	packs.engine.stamp = packs.content
	plan["/djdl/release/records/"] = func(_req: Dictionary) -> Dictionary:
		return {"status": 200, "headers": {"Content-Type": "application/jose"}, "body": p3["jws"]}
	plan["/djdl/distribution/blobs/"] = {"status": 403, "headers": {"Content-Type": "application/json"}, "body": "{\"error\":{\"code\":\"delivery_gate_missing\"}}"}
	r = await packs.ensure(["djdl.gated"])
	t.check("http: a 403 delivery_gate_missing from the blob route is pack-not-entitled, not a network error", not r.ok and String(r.code) == "pack-not-entitled", str(r))

	# The boot's FETCH events through boot_fetch (the stamp's required packs, all current now).
	var events: Array = []
	packs.content = F.stamp_for([p, p2])
	packs.engine.stamp = packs.content
	var done: Dictionary = await packs.boot_fetch(func(e): events.append(e))
	t.check("http: boot_fetch with everything current is ok with both installed, after one fetch.progress {0, 0} (client-core's runBootFetch)", done["result"] == "ok" and done["installed"].size() == 2 and S.same(events, [{"type": "fetch.progress", "done": 0, "total": 0}]), "%s %s" % [S.canon(done), S.canon(events)])
	sdk.queue_free()
	server.queue_free()
	other.queue_free()
	S.remove_tree(root)
