extends RefCounted
# @pkey-feature release.download update.check
# The URL builders against res://tests/fixtures/release-urls.json, the vectors sdk-node's own
# test (packages/sdk-node/test/godotUrlVectors.test.ts) holds Node to: download_url and
# install_url byte for byte (encodeURIComponent's encoding, not String.uri_encode's), and
# appcast_url out of a discovery document served by the loopback server (empty before discovery,
# with Update off, and for a malformed channel; an alias goes out canonically).

const FLOOR := 8

var sup: PKeyUpdateTestSupport


func run(t: PKeyTestContext) -> void:
	var v = PKeyUpdateTestSupport.vectors()
	if not t.check("urls: vectors present", v is Dictionary and v.get("download") is Array and v.get("appcast") is Array, PKeyUpdateTestSupport.VECTORS):
		return
	sup = PKeyUpdateTestSupport.new()
	if not t.check("urls: fixtures and server", sup.ready()):
		return
	_encoding(t)
	_download(t, v)
	await _appcast(t, v)
	sup.free_server()


func _encoding(t: PKeyTestContext) -> void:
	# What JS leaves alone that String.uri_encode() would not.
	t.check("uri: component keeps encodeURIComponent's set", PKeyUri.component("AZaz09-_.!~*'()") == "AZaz09-_.!~*'()")
	t.check("uri: component encodes the rest as upper-case UTF-8", PKeyUri.component(" /?#&=%+é😀") == "%20%2F%3F%23%26%3D%25%2B%C3%A9%F0%9F%98%80", PKeyUri.component(" /?#&=%+é😀"))
	t.check("uri: form keeps * - . _ and turns a space into +", PKeyUri.form("a b*-._~!") == "a+b*-._%7E%21", PKeyUri.form("a b*-._~!"))


## download_url and install_url need no server and send nothing.
func _download(t: PKeyTestContext, v: Dictionary) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(v["baseUrl"], PKeyMemoryStore.new(sup.F["device_id"]), [sup.F["now"]], v["product"], sup.F["trust"], "1.2.3")
	opts.expected_services = PackedStringArray(["release", "update"])
	var cr: PKeyResult = sdk.configure(opts)
	if not t.check("download: configure", cr.ok, str(cr)):
		sdk.queue_free()
		return
	var evaluated := 0
	for d in v["download"]:
		var got: String = sdk.release.download_url(d["version"], d["binary"], d["arch"], d["checksum"], d["dmg"])
		t.check("download: %s %s %s checksum=%s dmg=%s" % [d["version"], d["binary"], d["arch"], d["checksum"], d["dmg"]], got == d["expect"], "%s != %s" % [got, d["expect"]])
		evaluated += 1
	t.check("download: coverage", evaluated == v["download"].size() and evaluated >= FLOOR, "%d/%d" % [evaluated, v["download"].size()])
	t.check("install: equals Node's installUrl", sdk.release.install_url() == v["installUrl"], sdk.release.install_url())
	sdk.queue_free()


func _appcast(t: PKeyTestContext, v: Dictionary) -> void:
	sup.server.requests.clear()
	sup.plan = {".well-known/polaris.json": [PKeyUpdateTestSupport.json(200, v["discovery"])]}
	var sdk = await sup.sdk(PackedStringArray(["release", "update"]), "1.2.3", "", v["product"])
	t.check("appcast: empty before discovery", sdk.update.appcast_url("beta", "arm64") == "" and sdk.update.appcast_url() == "")
	var d: PKeyResult = await sdk.discover()
	t.check("appcast: the vectors' discovery document parses", d.ok, str(d))
	var evaluated := 0
	for a in v["appcast"]:
		var want: String = a["expect"] if a["expect"] is String else ""
		var got: String = sdk.update.appcast_url(a["channel"], a["arch"])
		t.check("appcast: channel %s arch %s" % [JSON.stringify(a["channel"]), JSON.stringify(a["arch"])], got == want, "%s != %s" % [got, want])
		evaluated += 1
	t.check("appcast: coverage", evaluated == v["appcast"].size() and evaluated >= FLOOR, "%d/%d" % [evaluated, v["appcast"].size()])
	var beta: String = sdk.update.appcast_url("beta", "arm64")
	t.check("appcast: an alias goes out canonically (staging -> beta, latest -> stable)", sdk.update.appcast_url("staging", "arm64") == beta and sdk.update.appcast_url("latest") == sdk.update.appcast_url())
	t.check("appcast: a malformed channel builds nothing", sdk.update.appcast_url("1.2.3", "arm64") == "" and sdk.update.appcast_url("../x") == "")
	t.check("appcast: only discovery was requested", sup.server.requests.size() == 1)
	sdk.queue_free()

	var off_ran := 0
	for off in v.get("appcastOff", []):
		var off_doc: Dictionary = v["discovery"].duplicate(true)
		off_doc["services"]["update"] = off["update"]
		var parsed := PKeyDiscovery.parse(off_doc, v["product"])
		var got := PKeyDiscovery.appcast_url_from(parsed.get("manifest"), "beta", "arm64")
		t.check("appcast off: %s" % off.get("note", ""), parsed["kind"] == "ok" and got == "" and off["expect"] == null, got)
		off_ran += 1
	t.check("appcast off: coverage", off_ran >= 2, str(off_ran))

	# The same through the SDK: Update off in this session's discovery document.
	var doc: Dictionary = v["discovery"].duplicate(true)
	doc["services"]["update"] = {"enabled": false}
	sup.plan = {".well-known/polaris.json": [PKeyUpdateTestSupport.json(200, doc)]}
	sdk = await sup.sdk(PackedStringArray(["release", "update"]), "1.2.3", "", v["product"])
	await sdk.discover()
	t.check("appcast: empty once discovery says Update is off", sdk.update.appcast_url("beta", "arm64") == "")
	sdk.queue_free()
