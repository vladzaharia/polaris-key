extends RefCounted
# The public download model (SDK parity §3.8): GET /<p>/distribution/download.json, unsigned and
# without a bearer, read into this platform's primary action, the rest and the builds.

const S := preload("res://tests/license/support.gd")

const MODEL := {
	"schemaVersion": 1,
	"product": {"slug": "djdl", "name": "DJDL"},
	"channel": "stable",
	"pageUrl": "https://dl.example/djdl",
	"listing": {"name": "DJDL", "subtitle": null, "description": null, "developerName": null, "website": null},
	"release": {"releaseId": "rel_1", "version": "1.2.0", "title": null, "publishedAt": 1700000000, "summary": null},
	"platforms": [
		{"platform": "linux", "label": "Linux", "primary": "download:direct:linux", "actions": ["flathub:flathub", "download:direct:linux"], "builds": [{"version": "1.2.0", "platform": "linux", "arch": "x86_64", "url": "https://dl.example/b", "size": 10, "sha256": "ab"}]},
		{"platform": "windows", "label": "Windows", "primary": null, "actions": ["steam:steam"], "builds": []},
	],
	"actions": [
		{"id": "download:direct:linux", "kind": "download", "label": "Download"},
		{"id": "flathub:flathub", "kind": "flathub", "label": "Flathub"},
		{"id": "steam:steam", "kind": "steam", "label": "Steam"},
	],
	"keys": [],
}


func run(t: PKeyTestContext) -> void:
	var h := PKeyLicenseTestSupport.new()
	h.plan["/distribution/download.json"] = [S.json(200, MODEL)]
	var off = await h.sdk(PKeyMemoryStore.new(h.F["device_id"], h.F["token"]))
	var refused: PKeyResult = await off.distribution.download_model()
	t.check("distribution: Distribution off -> service-unavailable without a request", not refused.ok and refused.code == PKeyErrors.SERVICE_UNAVAILABLE and h.requests("GET", "/distribution/download.json").is_empty(), str(refused))
	off.queue_free()

	var sdk = await h.sdk(PKeyMemoryStore.new(h.F["device_id"], h.F["token"]), PackedStringArray(["license", "config", "release", "distribution"]))
	var r: PKeyResult = await sdk.distribution.download_model()
	var reqs: Array = h.requests("GET", "/distribution/download.json")
	t.check("distribution: the model is read", r.ok and r.detail["release"]["version"] == "1.2.0", str(r))
	t.check("distribution: no bearer is sent (a public document)", reqs.size() == 1 and not reqs[0]["headers"].has("authorization"))
	var linux: Dictionary = sdk.distribution.this_platform(null, "linux")
	t.check("distribution: the primary action first, the rest after", linux["primary"]["id"] == "download:direct:linux" and linux["others"].size() == 1 and linux["others"][0]["id"] == "flathub:flathub" and linux["builds"].size() == 1, str(linux))
	var win: Dictionary = sdk.distribution.this_platform(r.detail, "windows")
	t.check("distribution: no declared primary -> the first action", win["primary"]["id"] == "steam:steam" and win["others"].is_empty())
	t.check("distribution: a platform the model lacks -> {}", sdk.distribution.this_platform(r.detail, "ios").is_empty())
	t.check("distribution: web maps to no page platform", PKeyDistribution.page_platform("web") == "" and PKeyDistribution.page_platform("macos") == "macos")
	h.plan["/distribution/download.json"] = [S.json(200, {"schemaVersion": 1})]
	r = await sdk.distribution.download_model()
	t.check("distribution: a body that is not a model -> invalid-response", not r.ok and r.code == PKeyErrors.INVALID_RESPONSE)
	h.plan["/distribution/download.json"] = [S.json(404, {"error": "not_found"})]
	r = await sdk.distribution.download_model()
	t.check("distribution: no public page -> not_found", not r.ok and r.code == PKeyErrors.NOT_FOUND)
	sdk.queue_free()
	h.free_server()
