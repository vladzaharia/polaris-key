extends RefCounted
## The Cloud Sync file transport (U-23.G5; WIRE-CONTRACT-V5 §13.2, §13.8): the routes the transfer engine
## names, typed, over bearer HTTP. A port of sdk-node `cloudSync/files.ts` for the GDScript lane. It
## carries bytes to and from the product's own `/<p>/sync/files/...` routes and nothing else.
##
##   Paths      every URL is built from validated parts and then tested against a closed list of route
##              shapes (`is_files_path`). The collection, record id and upload id use the key charset and
##              may not be `.` or `..`; a chunk id is 64 lowercase hex characters; a part number is
##              1..9999. A value that fails is answered locally as `400 bad_path`, never sent.
##   Redirects  none are followed (the PKeyTransport is built with `follow_redirects = false`): a 3xx is a
##              refusal, so the bearer and the file never leave the product's origin.
##   Bodies     a PUT carries `Content-Digest: sha-256=:...:` of its body. An answer is read under a cap
##              equal to what the call expects: a ranged GET the length asked for, a chunk GET
##              `SYNC_CHUNK_MAX_STORED_BYTES`, an unranged GET the manifest's largest stored size, a JSON
##              answer 1 MiB, an error body 64 KiB. A longer body is `bad_response`. A request body (a
##              chunk) over `SYNC_CHUNK_MAX_STORED_BYTES`, or a plan over `SYNC_CHUNK_PLAN_MAX_IDS`, is
##              refused before it is sent.
##   Retries    none here: the engine owns them. A request that gets no answer is `status 0` (the engine
##              retries it); `Retry-After` is read as whole seconds, capped at 3600 before it is made an
##              integer.
##   Time       15 s plus one second per 64 KiB of body, sent or expected (a slow link is cut off).
##
## Every method is a coroutine answering the engine's reply Dictionary (`Transfer.reply_ok(value)` or
## `Transfer.reply_fail(status, code, retry_after, body)`). The bearer is read per request and never put in a
## reply, a log line or an error. A transport with no bearer answers `401 unauthorized` and sends nothing.

const Transfer := preload("res://addons/polaris_key/services/cloud_sync/transfer.gd")
const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")

const JSON_MAX_BYTES := 1048576
const ERROR_MAX_BYTES := 65536
## An unranged file GET: a `chunks` file's manifest, sealed (786,496 bytes plain) with its tags.
const MANIFEST_MAX_BYTES := 2 * 1048576
const MIN_BYTES_PER_SECOND := 65536
const BASE_SECONDS := 15.0
const RETRY_AFTER_CAP := 3600
## The largest ranged GET the engine asks for (`DOWNLOAD_RANGE_BYTES`) plus a little room.
const BODY_LIMIT := 8 * 1048576 + 4096

static var _key_re: RegEx
static var _chunk_re: RegEx
static var _range_re: RegEx
static var _digits_re: RegEx
static var _shapes: Array = []
static var _shape_product := ""

## The HTTP status of the last answer that arrived (0: none). The transcript replay reads it.
var last_status := 0

var _tr: PKeyTransport
var _ctx: Callable


static func _static_init() -> void:
	_key_re = RegEx.create_from_string(PKeyConstants.SYNC_KEY_PATTERN)
	_chunk_re = RegEx.create_from_string(PKeyConstants.SYNC_CHUNK_ID_PATTERN)
	_range_re = RegEx.create_from_string("^bytes ([0-9]{1,15})-([0-9]{1,15})/([0-9]{1,15})$")
	_digits_re = RegEx.create_from_string("^[0-9]+$")


## A PKeyTransport for the file routes: no redirects, the body limit of the largest range.
static func make_transport(host: Node, local_only := false) -> PKeyTransport:
	var tr := PKeyTransport.new(host)
	tr.follow_redirects = false
	tr.timeout = BASE_SECONDS
	tr.body_limit = BODY_LIMIT
	tr.local_only = local_only
	return tr


## `tr` is a PKeyTransport (see `make_transport`); `ctx` is `func() -> {product, token: String, headers:
## Callable(extra) -> Dictionary, url: Callable(path) -> String}`, read per request.
func _init(tr: PKeyTransport, ctx: Callable) -> void:
	_tr = tr
	_ctx = ctx


# ── Paths ───────────────────────────────────────────────────────────────────────────────────────

static func _seg_ok(v: Variant) -> bool:
	return v is String and v != "." and v != ".." and _key_re.search(v) != null


static func _escape(s: String) -> String:
	var out := ""
	for i in s.length():
		var c := s[i]
		out += "\\" + c if "\\.[]{}()*+?^$|-".contains(c) else c
	return out


## Whether `path_and_query` is one of the file routes for `product`. Dot segments are refused outright; the
## only query is `version=<digits>` on the file GET.
static func is_files_path(product: String, path_and_query: String) -> bool:
	if not _seg_ok(product):
		return false
	var q := path_and_query.find("?")
	var path := path_and_query if q < 0 else path_and_query.substr(0, q)
	var query := "" if q < 0 else path_and_query.substr(q + 1)
	for part in path.split("/"):
		if part == "." or part == "..":
			return false
	if _shape_product != product:
		var seg := "[A-Za-z0-9._:-]{1,128}"
		var hex := "[0-9a-f]{64}"
		var base := "/%s/sync/files/%s" % [_escape(product), seg]
		var rec := base + "/" + seg
		var upload := rec + "/upload/" + seg
		_shapes = []
		for shape in [rec + "/(?:begin|finalize|revisions)", rec, upload, upload + "/parts/[0-9]{1,4}", upload + "/chunks", upload + "/chunks/" + hex, base + "/chunks/" + hex]:
			_shapes.append(RegEx.create_from_string("^" + shape + "$"))
		_shape_product = product
	var matched := false
	var is_record := false
	for i in _shapes.size():
		if _shapes[i].search(path) != null:
			matched = true
			is_record = i == 1
			break
	if not matched:
		return false
	if query == "":
		return true
	if not is_record:
		return false
	var rx := RegEx.create_from_string("^version=[0-9]{1,9}$")
	return rx.search(query) != null


func _bad(what: String) -> Dictionary:
	return Transfer.reply_fail(400, "bad_path", -1.0, {"detail": what})


func _record_path(product: String, t: Dictionary) -> Variant:
	if not (_seg_ok(t.get("collection")) and _seg_ok(t.get("record"))):
		return null
	return "/%s/sync/files/%s/%s" % [product, t["collection"], t["record"]]


func _upload_path(product: String, t: Dictionary, upload_id: Variant) -> Variant:
	var rec: Variant = _record_path(product, t)
	if rec == null or not _seg_ok(upload_id):
		return null
	return "%s/upload/%s" % [rec, upload_id]


# ── The exchange ────────────────────────────────────────────────────────────────────────────────

## `Retry-After` as whole seconds, or -1.0. A value longer than six digits is read as the cap before it is
## made an integer.
static func retry_after_seconds(raw: Variant) -> float:
	if not (raw is String):
		return -1.0
	var s := (raw as String).strip_edges()
	if s == "" or _digits_re.search(s) == null:
		return -1.0
	if s.length() > 6:
		return float(RETRY_AFTER_CAP)
	return float(mini(s.to_int(), RETRY_AFTER_CAP))


## The headers and body of one request, or `{reply}` when it cannot go: not a route, no bearer, a bad digest.
func _prepare(ctx: Dictionary, path: String, sent: Dictionary) -> Dictionary:
	if not is_files_path(ctx["product"], path):
		return {"reply": _bad("route")}
	var token: String = ctx["token"]
	if token == "":
		return {"reply": Transfer.reply_fail(401, "unauthorized")}
	var headers: Dictionary = ctx["headers"].call({"authorization": "Bearer " + token, "accept": "application/octet-stream, application/json"})
	var body := PackedByteArray()
	if sent.has("json"):
		headers["content-type"] = "application/json"
		body = JSON.stringify(sent["json"], "", false).to_utf8_buffer()
	elif sent.has("body"):
		body = sent["body"]
		var sha: Variant = sent.get("sha256")
		if not (sha is String) or sha.length() != 64 or not _is_hex(sha):
			return {"reply": _bad("digest")}
		headers["content-type"] = "application/octet-stream"
		headers["content-digest"] = "sha-256=:%s:" % Marshalls.raw_to_base64((sha as String).hex_decode())
	if sent.has("range"):
		var asked: Array = sent["range"]
		headers["range"] = "bytes=%d-%d" % [asked[0], asked[1] - 1]
	if sent.get("if_match") != null:
		headers["if-match"] = String(sent["if_match"])
	return {"headers": headers, "body": body}


## One request. `sent`: {json?, body?, sha256?, range?: [start, end), if_match?}. Returns `{res}` (the
## transport's detail: status, headers, body) or `{reply}` (a failure already in the engine's shape).
func _exchange(method: String, path: String, sent: Dictionary = {}, expect_bytes := 0) -> Dictionary:
	var ctx: Dictionary = _ctx.call()
	var prepared := _prepare(ctx, path, sent)
	if prepared.has("reply"):
		return prepared
	var body: PackedByteArray = prepared["body"]
	# Files are opaque bytes: never ask for gzip (it breaks Range, and a stored file is sealed anyway).
	var limit := maxi(maxi(expect_bytes, ERROR_MAX_BYTES), JSON_MAX_BYTES if expect_bytes == 0 else 0)
	_tr.timeout = BASE_SECONDS + float(maxi(expect_bytes, body.size()) / MIN_BYTES_PER_SECOND)
	last_status = 0
	var r: PKeyResult = await _tr.request(method, ctx["url"].call(path), prepared["headers"], body, {"follow_redirects": false, "range": true, "body_limit": mini(limit, BODY_LIMIT)})
	if not r.ok:
		# A local-only client dials nothing and says so; it is a refusal, not a network failure to retry.
		if r.code == PKeyErrors.LOCAL_ONLY:
			return {"reply": Transfer.reply_fail(400, "local_only")}
		return {"reply": Transfer.reply_fail(0, "network")}
	var detail: Dictionary = r.detail
	var status: int = detail["status"]
	last_status = status
	if status >= 300 and status < 400:
		return {"reply": Transfer.reply_fail(status, "redirect_refused")}
	return {"res": detail}


static func _is_hex(s: String) -> bool:
	for i in s.length():
		var c := s.unicode_at(i)
		if not ((c >= 48 and c <= 57) or (c >= 97 and c <= 102)):
			return false
	return true


## The refusal an error answer is: the server's code, `Retry-After`, and the body's extra members (`missing`,
## `server`), which sit beside `error` or inside it.
static func _refusal(res: Dictionary) -> Dictionary:
	var status: int = res["status"]
	var raw: PackedByteArray = res["body"]
	var parsed: Dictionary = {"ok": false}
	if raw.size() <= ERROR_MAX_BYTES and not raw.is_empty():
		parsed = Types.load_json_bytes(raw)
	var code := "http_%d" % status
	var extra := {}
	if parsed["ok"] and parsed["value"] is Dictionary:
		var top: Dictionary = parsed["value"]
		var err: Variant = top.get("error")
		if err is Dictionary and err.get("code") is String:
			code = err["code"]
		elif err is String:
			code = err
		for k in top:
			if k != "error":
				extra[k] = top[k]
		if err is Dictionary:
			for k in err:
				if k != "code" and k != "message":
					extra[k] = err[k]
	return Transfer.reply_fail(status, code, retry_after_seconds((res["headers"] as Dictionary).get("retry-after")), extra)


func _empty(r: Dictionary) -> Dictionary:
	if r.has("reply"):
		return r["reply"]
	var res: Dictionary = r["res"]
	if res["status"] < 200 or res["status"] >= 300:
		return _refusal(res)
	return Transfer.reply_ok(null)


## A route whose success is a JSON object under the cap; `accept` is a Callable(Dictionary) -> bool.
func _json(r: Dictionary, accept := Callable()) -> Dictionary:
	if r.has("reply"):
		return r["reply"]
	var res: Dictionary = r["res"]
	var status: int = res["status"]
	if status < 200 or status >= 300:
		return _refusal(res)
	var raw: PackedByteArray = res["body"]
	var bad := Transfer.reply_fail(status, PKeyConstants.ErrorCode.BAD_RESPONSE)
	if raw.size() > JSON_MAX_BYTES:
		return bad
	var parsed := Types.load_json_bytes(raw)
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return bad
	if accept.is_valid() and not accept.call(parsed["value"]):
		return bad
	return Transfer.reply_ok(parsed["value"])


static func _begin_ok(v: Dictionary) -> bool:
	if not (v.get("uploadId") is String and _seg_ok(v["uploadId"])):
		return false
	if not (v.get("mode") == "single" or v.get("mode") == "multipart" or v.get("mode") == "chunks"):
		return false
	if not (typeof(v.get("expiresAt")) in [TYPE_INT, TYPE_FLOAT] and is_finite(v["expiresAt"])):
		return false
	return not v.has("partBytes") or _int(v["partBytes"])


static func _status_ok(v: Dictionary) -> bool:
	return v.get("mode") is String


static func _finalize_ok(v: Dictionary) -> bool:
	return _int(v.get("version")) and _int(v.get("size")) and v.get("sha256") is String and (v.get("format") == "whole" or v.get("format") == "chunks")


static func _revisions_ok(v: Dictionary) -> bool:
	return v.get("revisions") is Array


static func _int(v: Variant) -> bool:
	return (typeof(v) == TYPE_INT) or (typeof(v) == TYPE_FLOAT and is_finite(v) and v == floorf(v) and absf(v) < 9007199254740992.0)


# ── The engine's transport port ─────────────────────────────────────────────────────────────────

func begin(target: Dictionary, request: Dictionary) -> Dictionary:
	var rec: Variant = _record_path(_ctx.call()["product"], target)
	if rec == null:
		return _bad("record")
	return _json(await _exchange("POST", rec + "/begin", {"json": request}), _begin_ok)


func status(target: Dictionary, upload_id: String) -> Dictionary:
	var path: Variant = _upload_path(_ctx.call()["product"], target, upload_id)
	if path == null:
		return _bad("upload")
	return _json(await _exchange("GET", path), _status_ok)


func put_single(target: Dictionary, upload_id: String, body: PackedByteArray, sha256: String) -> Dictionary:
	var path: Variant = _upload_path(_ctx.call()["product"], target, upload_id)
	if path == null:
		return _bad("upload")
	return _empty(await _exchange("PUT", path, {"body": body, "sha256": sha256}))


func put_part(target: Dictionary, upload_id: String, n: int, body: PackedByteArray, sha256: String) -> Dictionary:
	var path: Variant = _upload_path(_ctx.call()["product"], target, upload_id)
	if path == null or n < 1 or n > PKeyConstants.SYNC_MAX_PARTS:
		return _bad("part")
	return _empty(await _exchange("PUT", "%s/parts/%d" % [path, n], {"body": body, "sha256": sha256}))


func abort(target: Dictionary, upload_id: String) -> Dictionary:
	var path: Variant = _upload_path(_ctx.call()["product"], target, upload_id)
	if path == null:
		return _bad("upload")
	return _empty(await _exchange("DELETE", path))


func finalize(target: Dictionary, request: Dictionary) -> Dictionary:
	var rec: Variant = _record_path(_ctx.call()["product"], target)
	if rec == null:
		return _bad("record")
	return _json(await _exchange("POST", rec + "/finalize", {"json": request}), _finalize_ok)


func plan_chunks(target: Dictionary, upload_id: String, request: Dictionary) -> Dictionary:
	var path: Variant = _upload_path(_ctx.call()["product"], target, upload_id)
	if path == null:
		return _bad("upload")
	var entries: Variant = request.get("chunks")
	if not (entries is Array) or entries.size() > PKeyConstants.SYNC_CHUNK_PLAN_MAX_IDS:
		return _bad("plan")
	return _json(await _exchange("POST", path + "/chunks", {"json": request}))


func put_chunk(target: Dictionary, upload_id: String, chunk_id: String, body: PackedByteArray, sha256: String) -> Dictionary:
	var path: Variant = _upload_path(_ctx.call()["product"], target, upload_id)
	if path == null or _chunk_re.search(chunk_id) == null or body.size() > PKeyConstants.SYNC_CHUNK_MAX_STORED_BYTES:
		return _bad("chunk")
	return _empty(await _exchange("PUT", "%s/chunks/%s" % [path, chunk_id], {"body": body, "sha256": sha256}))


## The path and the `sent` members of a file GET, or `{reply}` when the query is not one.
func _file_query(rec: String, query: Dictionary) -> Dictionary:
	var rng: Variant = query.get("range")
	var sent := {}
	if rng != null:
		if not (rng is Array and rng.size() == 2 and _int(rng[0]) and _int(rng[1]) and rng[0] >= 0 and rng[1] > rng[0]):
			return {"reply": _bad("range")}
		sent["range"] = [int(rng[0]), int(rng[1])]
	if query.get("if_match") != null:
		sent["if_match"] = query["if_match"]
	var path := rec
	var version: Variant = query.get("version")
	if version != null:
		if not (_int(version) and version >= 0 and version < 1000000000):
			return {"reply": _bad("version")}
		path += "?version=%d" % int(version)
	# The body is bounded by the range asked, even for a 200 (a server that ignores Range and sends more
	# is refused, never buffered).
	var cap: int = (sent["range"][1] - sent["range"][0]) if sent.has("range") else MANIFEST_MAX_BYTES
	return {"path": path, "sent": sent, "cap": cap}


## `query`: {version, range: [start, end) | null, if_match}. The value is {status, data, etag, content_range:
## [start, end, total] | null}.
func get_file(target: Dictionary, query: Dictionary) -> Dictionary:
	var rec: Variant = _record_path(_ctx.call()["product"], target)
	if rec == null:
		return _bad("record")
	var q := _file_query(rec, query)
	if q.has("reply"):
		return q["reply"]
	var cap: int = q["cap"]
	var r := await _exchange("GET", q["path"], q["sent"], cap)
	if r.has("reply"):
		return r["reply"]
	var res: Dictionary = r["res"]
	var status: int = res["status"]
	if status < 200 or status >= 300:
		return _refusal(res)
	var data: PackedByteArray = res["body"]
	if (status != 200 and status != 206) or data.size() > cap:
		return Transfer.reply_fail(status, PKeyConstants.ErrorCode.BAD_RESPONSE)
	var headers: Dictionary = res["headers"]
	var content_range: Variant = null
	var m := _range_re.search(String(headers.get("content-range", "")))
	if m != null:
		content_range = [m.get_string(1).to_int(), m.get_string(2).to_int() + 1, m.get_string(3).to_int()]
	return Transfer.reply_ok({"status": status, "data": data, "etag": headers.get("etag"), "content_range": content_range})


## The kept revisions of a file, newest first: the value is the server's `{revisions: [...]}`.
func revisions(target: Dictionary) -> Dictionary:
	var rec: Variant = _record_path(_ctx.call()["product"], target)
	if rec == null:
		return _bad("record")
	return _json(await _exchange("GET", rec + "/revisions"), _revisions_ok)


func get_chunk(collection: String, chunk_id: String) -> Dictionary:
	var product: String = _ctx.call()["product"]
	if not _seg_ok(collection) or _chunk_re.search(chunk_id) == null:
		return _bad("chunk")
	var cap := PKeyConstants.SYNC_CHUNK_MAX_STORED_BYTES
	var r := await _exchange("GET", "/%s/sync/files/%s/chunks/%s" % [product, collection, chunk_id], {}, cap)
	if r.has("reply"):
		return r["reply"]
	var res: Dictionary = r["res"]
	var status: int = res["status"]
	if status < 200 or status >= 300:
		return _refusal(res)
	var data: PackedByteArray = res["body"]
	if status != 200 or data.size() > cap:
		return Transfer.reply_fail(status, PKeyConstants.ErrorCode.BAD_RESPONSE)
	return Transfer.reply_ok(data)
