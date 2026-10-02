class_name PKeyPackCdnTransport
extends PKeyPackTransport
## `pkey-cdn` (and `web`, which shares it until a Cache Storage shell lands: S-05 §4.3).

var core: PKeyCore
## One wall-clock deadline per object request (every hop and the whole body), seconds.
var object_timeout := 600.0
var record_limit := PKeyConstants.MAX_RECORD_JWS_BYTES


func _init(p_core: PKeyCore) -> void:
	core = p_core


func id() -> String:
	return PKeyConstants.Transport.WEB if OS.has_feature("web") else PKeyConstants.Transport.PKEY_CDN


func _template(service: String, name: String) -> String:
	if core.discovery_manifest == null:
		await core.discover()
	return PKeyUpdate._endpoint(core.discovery_manifest, service, name)


func fetch_record(sha256: String) -> Dictionary:
	var t: String = await _template("release", "record")
	if t == "":
		return {"ok": false, "code": String(PKeyErrors.SERVICE_UNAVAILABLE)}
	var r: Dictionary = await PKeyUpdate._get_jose(core, PKeyUpdate._expand(core, t, "sha256", sha256), record_limit)
	if not r["ok"]:
		return {"ok": false, "code": String(PKeyErrors.NETWORK) if r["code"] != String(PKeyErrors.SERVICE_UNAVAILABLE) else r["code"]}
	return {"ok": true, "body": r["body"]}


func fetch_object(req: Dictionary, on_response: Callable, on_chunk: Callable) -> Dictionary:
	var t: String = await _template("distribution", "blobs")
	if t == "":
		return {"status": 0, "content_range": "", "error": String(PKeyErrors.SERVICE_UNAVAILABLE)}
	var url := PKeyUpdate._expand(core, t, "sha256", String(req["sha256"]))
	var h := core.headers()
	# The bearer goes only to the control plane's own origin (a CDN never sees it); the HTTP
	# helper drops it again on any cross-origin redirect.
	if core.tokens.has_token() and PKeyTransport.parse_url(url).get("origin", "") == PKeyTransport.parse_url(core.base_url + "/").get("origin", "-"):
		h["Authorization"] = "Bearer %s" % core.tokens.current()
	return await PKeyPackHttp.fetch(core.transport, url, h, int(req.get("offset", 0)), String(req.get("if_range", "")), on_response, on_chunk, object_timeout)
