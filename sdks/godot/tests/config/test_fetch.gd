extends RefCounted
# fetch_schema(): GET /<p>/config/schema, unsigned and unauthenticated, parsed into a Dictionary
# and kept in memory; null for a malformed body, a body that is not a catalog, an error status,
# a network failure, local-only, or Config off — never an error.

const S := preload("res://tests/config/support.gd")

var _answer := {}


func run(t: PKeyTestContext) -> void:
	var fixture = PKeyTestFixtures.read_json("res://tests/config/catalog.json")
	if not t.check("fetch: fixture catalog present", fixture is Dictionary):
		return
	var server := PKeyTestFixtures.new_server(func(_req: Dictionary) -> Dictionary: return _answer)
	var o := PKeyTestFixtures.options(server.base_url(), PKeyMemoryStore.new("", "pkeyt_secret_token"), [S.NOW])
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(o)
	await sdk.start()
	var cfg: PKeyConfig = sdk.config

	_answer = {"status": 200, "headers": {"Content-Type": "application/json"}, "body": FileAccess.get_file_as_string("res://tests/config/catalog.json")}
	var got = await cfg.fetch_schema()
	t.check("fetch: the served catalog parses", got is Dictionary and S.same(got, fixture) and got["entries"].size() == 7)
	var req: Dictionary = server.requests.back() if not server.requests.is_empty() else {}
	t.check("fetch: GET /djdl/config/schema", req.get("method") == "GET" and req.get("path") == "/djdl/config/schema", str(req.get("path")))
	t.check("fetch: no credential is sent", not req.get("headers", {}).has("authorization"))
	t.check("fetch: it is kept in memory", S.same(cfg.catalog(), fixture) and cfg.catalog_entry("audio.musicVolume").get("accessor") == "audio.music_volume")
	t.check("fetch: the label decodes to the same text", cfg.catalog_entry("audio.musicVolume")["label"] == "Música \"principal\"")

	for row in [
		["a body that is not JSON", {"status": 200, "body": "<html>"}],
		["lenient JSON (strict parse)", {"status": 200, "body": "{\"schemaVersion\": 1, \"entries\": [],}"}],
		["JSON that is not a catalog", {"status": 200, "body": "{\"schemaVersion\": \"1\", \"entries\": []}"}],
		["a JSON array", {"status": 200, "body": "[]"}],
		["a 404", {"status": 404, "body": "{\"error\":\"not_found\",\"message\":\"no active schema for product\"}"}],
		["a 500", {"status": 500, "body": ""}],
	]:
		_answer = row[1]
		t.check("fetch: null for %s" % row[0], (await cfg.fetch_schema()) == null)
	t.check("fetch: a failed fetch keeps the last good catalog", S.same(cfg.catalog(), fixture))

	var port := server.port
	server.stop()
	server.queue_free()
	var dead := PKeyTestFixtures.new_sdk()
	dead.configure(PKeyTestFixtures.options("http://127.0.0.1:%d" % port, PKeyMemoryStore.new(), [S.NOW]))
	await dead.start()
	t.check("fetch: null on a network failure", (await dead.config.fetch_schema()) == null)
	dead.queue_free()

	var local := PKeyTestFixtures.new_sdk()
	var lo := S.options()
	local.configure(lo)
	await local.start()
	t.check("fetch: null when local-only, with nothing sent", (await local.config.fetch_schema()) == null and local.core.transport.sent.is_empty())
	local.queue_free()
	sdk.queue_free()
