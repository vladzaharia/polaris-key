extends RefCounted
# @pkey-feature sync.files sync.files.delta
# The Cloud Sync file transport (U-23.G5), against a loopback fake of the Worker's file routes: the route
# allow-list, no redirects (the bearer goes nowhere else), Content-Digest, the answer caps, Retry-After under
# its 3600 s cap, the chunk and plan caps from the generated constants, a 503 with Retry-After, a 403
# quota_exceeded of scope user, 409 upload_incomplete and revision_conflict bodies, ranged downloads and the
# typed local refusals. The file and chunk transcripts replay through the same transport in suite_transcripts.

const FilesTransport := preload("res://addons/polaris_key/services/cloud_sync/files_transport.gd")

const PRODUCT := "diceroll"


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_paths(t)
	await _transport(t)
	await PKeyTestFixtures.frames(10)
	return true


func _noise(n: int) -> PackedByteArray:
	return Crypto.new().generate_random_bytes(n)


func _sha(b: PackedByteArray) -> String:
	return PKeySyncHkdf.sha256(b).hex_encode()


# ── The file transport ──────────────────────────────────────────────────────────────────────────

func _paths(t: PKeyTestContext) -> void:
	var id := "a".repeat(64)
	for ok in ["/diceroll/sync/files/saves/slot1/begin", "/diceroll/sync/files/saves/slot.1/finalize", "/diceroll/sync/files/saves/slot1/revisions",
			"/diceroll/sync/files/saves/slot1", "/diceroll/sync/files/saves/slot1?version=12", "/diceroll/sync/files/saves/slot1/upload/up_abc-1",
			"/diceroll/sync/files/saves/slot1/upload/up_abc-1/parts/9999", "/diceroll/sync/files/saves/slot1/upload/up_abc-1/chunks",
			"/diceroll/sync/files/saves/slot1/upload/up_abc-1/chunks/" + id, "/diceroll/sync/files/saves/chunks/" + id]:
		t.check("the allow-list takes %s" % ok, FilesTransport.is_files_path(PRODUCT, ok))
	for bad in ["/diceroll/sync/files/saves/../begin", "/diceroll/sync/files/saves/./begin", "/diceroll/sync/files/saves/slot1/begin?x=1",
			"/diceroll/sync/files/saves/slot1?version=x", "/diceroll/sync/files/saves/slot1?version=1&a=b", "/other/sync/files/saves/slot1/begin",
			"/diceroll/sync/files/saves/slot1/upload/up/chunks/" + "A".repeat(64), "/diceroll/sync/files/saves/slot1/upload/up/chunks/" + "a".repeat(63),
			"/diceroll/sync/files/saves/slot1/upload/up/parts/12345", "/diceroll/sync/files/saves/slot 1/begin", "/diceroll/sync/ops",
			"/diceroll/sync/files/saves/slot1/upload/up/parts/x", "//diceroll/sync/files/saves/slot1", "/diceroll/sync/files/saves/slot1/extra/segments/here/now"]:
		t.check("the allow-list refuses %s" % bad, not FilesTransport.is_files_path(PRODUCT, bad))
	t.check("Retry-After: seconds are read", FilesTransport.retry_after_seconds("7") == 7.0)
	t.check("Retry-After: an absurd number is capped before it is an integer", FilesTransport.retry_after_seconds("99999999999999999999") == 3600.0
			and FilesTransport.retry_after_seconds("86400") == 3600.0)
	t.check("Retry-After: a date or junk is none", FilesTransport.retry_after_seconds("Wed, 21 Oct 2026 07:28:00 GMT") == -1.0
			and FilesTransport.retry_after_seconds("-3") == -1.0 and FilesTransport.retry_after_seconds(null) == -1.0)


## A transport on a loopback server whose handler is `handler(req) -> {status, headers, body}`.
func _transport_rig(handler: Callable, token := "pkeyt_secret", local_only := false) -> Dictionary:
	var server := PKeyTestFixtures.new_server(handler)
	var host := Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(host)
	var tr := FilesTransport.make_transport(host, local_only)
	var ctx := func() -> Dictionary:
		return {"product": PRODUCT, "token": token, "headers": _headers, "url": func(path: String) -> String: return server.base_url() + path}
	return {"ft": FilesTransport.new(tr, ctx), "server": server, "host": host, "tr": tr}


static func _headers(extra: Dictionary) -> Dictionary:
	var h := {"x-pkey-device": "dev1"}
	h.merge(extra, true)
	return h


func _rig_done(r: Dictionary) -> void:
	r["server"].stop()
	r["server"].queue_free()
	r["host"].queue_free()


func _transport(t: PKeyTestContext) -> void:
	var target := {"collection": "saves", "record": "slot1"}
	var seen: Array = []
	var next: Array = []
	var handler := func(req: Dictionary) -> Dictionary:
		seen.append(req)
		return next.pop_front() if not next.is_empty() else {"status": 599, "body": "no answer queued"}
	var rig := _transport_rig(handler)
	var ft: Object = rig["ft"]

	# begin: the JSON body, the bearer, the validated answer
	next.append({"status": 200, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"uploadId": "up_1", "mode": "single", "expiresAt": 1760086400000})})
	var begun: Dictionary = await ft.begin(target, {"size": 5, "sha256": "b".repeat(64), "format": "whole", "enc": "none", "baseVersion": "*"})
	t.check("begin: the answer is the value", begun["ok"] and begun["value"]["uploadId"] == "up_1" and begun["value"]["mode"] == "single", str(begun))
	t.check("begin: POST to the record's begin route with the bearer and JSON", seen[0]["method"] == "POST"
			and seen[0]["path"] == "/diceroll/sync/files/saves/slot1/begin" and seen[0]["headers"]["authorization"] == "Bearer pkeyt_secret"
			and seen[0]["headers"]["content-type"] == "application/json")
	var sent_json: Dictionary = JSON.parse_string(seen[0]["body"].get_string_from_utf8())
	t.check("begin: the body is the request as sent", int(sent_json["size"]) == 5 and sent_json["sha256"] == "b".repeat(64)
			and sent_json["format"] == "whole" and sent_json["enc"] == "none" and sent_json["baseVersion"] == "*" and sent_json.size() == 5, str(sent_json))
	t.check("begin: the status of the answer is kept", ft.last_status == 200)
	next.append({"status": 200, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"uploadId": "../x", "mode": "single", "expiresAt": 1})})
	begun = await ft.begin(target, {})
	t.check("begin: an upload id that could steer a path is not an answer", not begun["ok"] and begun["code"] == PKeyConstants.ErrorCode.BAD_RESPONSE)
	next.append({"status": 200, "body": "not json"})
	begun = await ft.begin(target, {})
	t.check("begin: an answer that is not JSON is bad_response", not begun["ok"] and begun["code"] == PKeyConstants.ErrorCode.BAD_RESPONSE)

	# a PUT carries Content-Digest of its bytes
	var body := _noise(300)
	next.append({"status": 204})
	var put: Dictionary = await ft.put_single(target, "up_1", body, _sha(body))
	var digest: String = seen[seen.size() - 1]["headers"].get("content-digest", "")
	t.check("put: 204 is ok with no value", put["ok"] and put["value"] == null and ft.last_status == 204)
	t.check("put: Content-Digest is the base64 SHA-256 of the body", digest == "sha-256=:%s:" % Marshalls.raw_to_base64(PKeySyncHkdf.sha256(body)), digest)
	t.check("put: the bytes go as application/octet-stream", seen[seen.size() - 1]["body"] == body and seen[seen.size() - 1]["headers"]["content-type"] == "application/octet-stream")
	var before := seen.size()
	var bad_digest: Dictionary = await ft.put_single(target, "up_1", body, "zz")
	t.check("put: a digest that is not hex is refused locally, nothing sent", not bad_digest["ok"] and bad_digest["code"] == "bad_path" and seen.size() == before)

	# nothing steered: bad ids are answered locally
	for case in [["a record", await ft.begin({"collection": "saves", "record": "../x"}, {})], ["a collection", await ft.begin({"collection": "a/b", "record": "x"}, {})],
			["an upload id", await ft.status(target, "up/1")],
			["a part", await ft.put_part(target, "up_1", 0, body, _sha(body))],
			["a part over the cap", await ft.put_part(target, "up_1", 10000, body, _sha(body))],
			["a chunk id", await ft.get_chunk("saves", "xyz")], ["a version", await ft.get_file(target, {"version": -1, "range": null, "if_match": null})],
			["a range", await ft.get_file(target, {"version": null, "range": [5, 5], "if_match": null})]]:
		t.check("%s that is not a route is refused locally" % case[0], not case[1]["ok"] and case[1]["code"] == "bad_path" and case[1]["status"] == 400)
	t.check("nothing was sent for them", seen.size() == before)

	# the caps the constants name
	var chunk := _noise(PKeyConstants.SYNC_CHUNK_MAX_STORED_BYTES + 1)
	var big_chunk: Dictionary = await ft.put_chunk(target, "up_1", "a".repeat(64), chunk, _sha(chunk))
	t.check("put_chunk: a chunk over SYNC_CHUNK_MAX_STORED_BYTES is refused before it is sent", not big_chunk["ok"] and seen.size() == before)
	var ids := []
	for i in PKeyConstants.SYNC_CHUNK_PLAN_MAX_IDS + 1:
		ids.append(["%064x" % i, 100])
	var plan: Dictionary = await ft.plan_chunks(target, "up_1", {"chunks": ids})
	t.check("plan_chunks: more than SYNC_CHUNK_PLAN_MAX_IDS ids is refused before it is sent", not plan["ok"] and seen.size() == before)
	next.append({"status": 200, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"missing": ["1".repeat(64)], "present": [["2".repeat(64), 300]]})})
	plan = await ft.plan_chunks(target, "up_1", {"chunks": ids.slice(0, PKeyConstants.SYNC_CHUNK_PLAN_MAX_IDS)})
	t.check("plan_chunks: SYNC_CHUNK_PLAN_MAX_IDS ids go, the answer is the value", plan["ok"] and plan["value"]["missing"].size() == 1
			and seen[seen.size() - 1]["path"].ends_with("/upload/up_1/chunks"))

	# errors keep the server's code, Retry-After, and the body's extra members
	next.append({"status": 503, "headers": {"retry-after": "9", "content-type": "application/json"}, "body": JSON.stringify({"error": {"code": "unavailable"}})})
	var r503: Dictionary = await ft.finalize(target, {"uploadId": "up_1"})
	t.check("503: status, code and Retry-After are the reply", not r503["ok"] and r503["status"] == 503 and r503["code"] == "unavailable" and r503["retry_after"] == 9.0, str(r503))
	next.append({"status": 503, "headers": {"retry-after": "99999999999999999999"}, "body": ""})
	r503 = await ft.finalize(target, {"uploadId": "up_1"})
	t.check("503: an absurd Retry-After is capped at 3600 and a body-less error keeps its status", r503["status"] == 503
			and r503["retry_after"] == 3600.0 and r503["code"] == "http_503", str(r503))
	next.append({"status": 403, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"error": {"code": "quota_exceeded", "scope": "user"}})})
	var quota: Dictionary = await ft.finalize(target, {"uploadId": "up_1"})
	t.check("403 quota_exceeded scope user: the code and the scope", quota["status"] == 403 and quota["code"] == "quota_exceeded" and quota["body"].get("scope") == "user", str(quota))
	next.append({"status": 409, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"error": {"code": "upload_incomplete", "missing": ["3".repeat(64)]}})})
	var incomplete: Dictionary = await ft.finalize(target, {"uploadId": "up_1"})
	t.check("409 upload_incomplete: `missing` is in the body", incomplete["code"] == "upload_incomplete" and incomplete["body"]["missing"] == ["3".repeat(64)], str(incomplete))
	next.append({"status": 409, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"error": {"code": "revision_conflict"}, "server": {"version": 4}})})
	var conflict: Dictionary = await ft.begin(target, {})
	t.check("409 revision_conflict: the server's version is in the body", conflict["code"] == "revision_conflict" and conflict["body"]["server"]["version"] == 4, str(conflict))

	# downloads: a ranged read is bounded by the range, Content-Range and ETag are read
	var file := _noise(1000)
	next.append({"status": 206, "headers": {"content-range": "bytes 100-299/1000", "etag": "\"e1\""}, "body": file.slice(100, 300)})
	var ranged: Dictionary = await ft.get_file(target, {"version": 3, "range": [100, 300], "if_match": "\"e1\""})
	var req: Dictionary = seen[seen.size() - 1]
	t.check("get_file: Range, If-Match and ?version go out", req["path"] == "/diceroll/sync/files/saves/slot1?version=3"
			and req["headers"]["range"] == "bytes=100-299" and req["headers"]["if-match"] == "\"e1\"", str(req["headers"]))
	t.check("get_file: no gzip on a file", not req["headers"].get("accept-encoding", "").contains("gzip"), str(req["headers"]))
	t.check("get_file: a 206 is the data, the ETag and the range", ranged["ok"] and ranged["value"]["status"] == 206
			and ranged["value"]["data"] == file.slice(100, 300) and ranged["value"]["etag"] == "\"e1\"" and ranged["value"]["content_range"] == [100, 300, 1000], str(ranged))
	next.append({"status": 200, "headers": {}, "body": file})
	ranged = await ft.get_file(target, {"version": null, "range": [0, 100], "if_match": null})
	t.check("get_file: a server that ignores Range and sends more than was asked is not buffered", not ranged["ok"] and ranged["code"] == PKeyConstants.ErrorCode.BAD_RESPONSE, str(ranged))
	next.append({"status": 200, "headers": {"etag": "\"e2\""}, "body": file})
	var whole: Dictionary = await ft.get_file(target, {"version": null, "range": null, "if_match": null})
	t.check("get_file: an unranged 200 is the whole body", whole["ok"] and whole["value"]["data"] == file and whole["value"]["content_range"] == null)
	next.append({"status": 404, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"error": {"code": "not_found"}})})
	var gone: Dictionary = await ft.get_file(target, {"version": null, "range": null, "if_match": null})
	t.check("get_file: 404 is a refusal with its code", not gone["ok"] and gone["status"] == 404 and gone["code"] == "not_found")
	next.append({"status": 200, "headers": {}, "body": _noise(PKeyConstants.SYNC_CHUNK_MAX_STORED_BYTES + 5)})
	var oversized: Dictionary = await ft.get_chunk("saves", "c".repeat(64))
	t.check("get_chunk: an object over the stored cap is not an answer", not oversized["ok"], str(oversized.get("code")))
	next.append({"status": 200, "headers": {}, "body": chunk.slice(0, 5000)})
	var got: Dictionary = await ft.get_chunk("saves", "c".repeat(64))
	t.check("get_chunk: the object's bytes, from the collection's chunk route", got["ok"] and got["value"] == chunk.slice(0, 5000)
			and seen[seen.size() - 1]["path"] == "/diceroll/sync/files/saves/chunks/" + "c".repeat(64))
	next.append({"status": 200, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"revisions": [{"version": 2, "size": 5, "sha256": "d".repeat(64), "format": "whole"}]})})
	var revs: Dictionary = await ft.revisions(target)
	t.check("revisions: the list", revs["ok"] and revs["value"]["revisions"][0]["version"] == 2)
	next.append({"status": 204})
	var aborted: Dictionary = await ft.abort(target, "up_1")
	t.check("abort: DELETE on the upload", aborted["ok"] and seen[seen.size() - 1]["method"] == "DELETE" and seen[seen.size() - 1]["path"] == "/diceroll/sync/files/saves/slot1/upload/up_1")

	# redirects are never followed, and the bearer goes nowhere else
	var count := seen.size()
	next.append({"status": 302, "headers": {"location": "http://127.0.0.2:9/steal"}, "body": ""})
	var redirected: Dictionary = await ft.status(target, "up_1")
	t.check("a 302 is a refusal: one request, nothing followed", not redirected["ok"] and redirected["status"] == 302
			and redirected["code"] == "redirect_refused" and seen.size() == count + 1, str(redirected))
	_rig_done(rig)

	# no bearer: 401 and nothing sent
	var quiet := _transport_rig(handler, "")
	var none: Dictionary = await quiet["ft"].begin(target, {})
	t.check("no token: 401 unauthorized and nothing sent", not none["ok"] and none["status"] == 401 and none["code"] == "unauthorized")
	_rig_done(quiet)
	# local-only: a refusal to dial, not a network failure to retry
	var local := _transport_rig(handler, "pkeyt_secret", true)
	var refused: Dictionary = await local["ft"].begin(target, {})
	t.check("local-only: a refusal the engine does not retry", not refused["ok"] and refused["status"] == 400 and refused["code"] == "local_only")
	_rig_done(local)
	# no answer at all is status 0 (the engine retries it)
	var dead := _transport_rig(handler)
	dead["server"].stop()
	var silent: Dictionary = await dead["ft"].status(target, "up_1")
	t.check("no answer: status 0, which the engine retries", not silent["ok"] and silent["status"] == 0)
	_rig_done(dead)
