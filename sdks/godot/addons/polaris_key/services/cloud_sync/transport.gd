extends RefCounted
## The Cloud Sync host's transport: one bearer HTTP exchange per request the machine queued. A port
## of Python `cloud_sync/transport.py` over PKeyTransport.
##
## It sends only what the machine produced, only to the product's own `/sync` routes (the URL comes
## from the Core, so the bearer never goes anywhere else), with the SDK's `X-PKey-*` headers. Rules:
##
##   * H-3  No redirect is followed: the transport is built with `follow_redirects = false`, so a
##          3xx is an answer the machine does not act on, and the bearer is never handed on.
##          (The engine's HTTPRequest forwards Authorization across hosts; PKeyTransport never lets
##          it follow one.) The body is read under an 8 MiB cap, streamed by the engine's limit.
##   * H-4  15 s per request, so purge and flush are bounded.
##   * the answer is parsed with the strict parser (never `JSON.parse_string`); a 2xx the machine
##          cannot read is not an answer; an error page keeps its status.
##
## Any failure to get an answer is `{"error": "transport"}`: the machine reads it as "nothing was
## processed" and retries on its next trigger. The host adds no request of its own (S3).

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")

const MAX_RESPONSE_BYTES := 8 * 1024 * 1024
const REQUEST_TIMEOUT_SECONDS := 15.0
const TRANSPORT_ERROR := {"error": "transport"}

static var _query_re: RegEx


## The product's own routes: `/<product>/sync/ops` and `/<product>/sync?<query>`.
static func is_sync_path(product: String, path: String) -> bool:
	if _query_re == null:
		_query_re = RegEx.create_from_string("\\A[A-Za-z0-9_=&.%-]*\\z")
	var base := "/%s/sync" % product
	if path == base + "/ops":
		return true
	if not path.begins_with(base + "?"):
		return false
	return _query_re.search(path.substr(base.length() + 1)) != null


## A transport for the sync routes: no redirects, 15 s, 8 MiB.
static func make(host: Node, local_only := false) -> PKeyTransport:
	var tr := PKeyTransport.new(host)
	tr.follow_redirects = false
	tr.timeout = REQUEST_TIMEOUT_SECONDS
	tr.body_limit = MAX_RESPONSE_BYTES
	tr.local_only = local_only
	return tr


## Send one machine request. `ctx` is `{product, token: String, headers: Callable(extra) -> Dictionary,
## url: Callable(path) -> String}`. The answer is `{status, body?}` or `{error: "transport"}`.
static func send_sync(tr: PKeyTransport, ctx: Dictionary, req: Dictionary) -> Dictionary:
	var token: String = ctx["token"]
	var path: Variant = req.get("path")
	if token == "" or not (path is String) or not is_sync_path(ctx["product"], path):
		return TRANSPORT_ERROR
	var method: String = req.get("method", "GET")
	var headers: Dictionary = ctx["headers"].call({"authorization": "Bearer " + token, "accept": "application/json"})
	var body := PackedByteArray()
	if method == "POST":
		headers["content-type"] = "application/json"
		body = JSON.stringify(req.get("body"), "", false).to_utf8_buffer()
	var r: PKeyResult = await tr.request(method, ctx["url"].call(path), headers, body, {"follow_redirects": false})
	if not r.ok:
		return TRANSPORT_ERROR
	var status: int = r.detail["status"]
	if status >= 300 and status < 400:
		return {"status": status}
	var bytes: PackedByteArray = r.detail["body"]
	if bytes.size() > MAX_RESPONSE_BYTES:
		return TRANSPORT_ERROR
	if bytes.is_empty():
		return {"status": status}
	var parsed := Types.load_json_bytes(bytes)
	if not parsed["ok"]:
		# A 2xx the machine cannot read is not an answer; an error page keeps its status.
		return TRANSPORT_ERROR if status >= 200 and status < 300 else {"status": status}
	return {"status": status, "body": parsed["value"]}
