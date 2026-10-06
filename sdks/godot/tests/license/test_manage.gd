extends RefCounted
# @pkey-feature license.manage
# PX-W8: the refusal link (WIRE-CONTRACT-V4 §5.3). PKeyManage against the same table as
# client-core's `test/manage.test.ts`, so a link this SDK builds is byte-identical to every other
# SDK's, and the 403 ladder: `manage_url` read from both envelopes, an invalid one dropped without
# losing the counts, and a body with no link (or an unknown member) still device-limit.

const S := preload("res://tests/license/support.gd")
const KEY := "pkey_djdl_KtreuRThCpYw-7Xncutlnw"
const FREE := "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64"
const ACTIVATE := "https://key.plrs.im/activate?product=djdl"

var h: PKeyLicenseTestSupport


func run(t: PKeyTestContext) -> void:
	_read(t)
	_with_return(t)
	_with_key(t)
	t.check("manage: form encoding", PKeyUri.form("aZ09*-._ ~/:é") == "aZ09*-._+%7E%2F%3A%C3%A9")
	h = PKeyLicenseTestSupport.new()
	if not t.check("manage: fixtures present", h.ready()):
		return
	await _ladder(t)
	h.free_server()


func _read(t: PKeyTestContext) -> void:
	var cases := [
		["a free-device link", {"manageUrl": FREE}, FREE],
		["an activate link", {"manageUrl": ACTIVATE}, ACTIVATE],
		["a loopback http link", {"manageUrl": "http://localhost:8787/activate?product=djdl"}, "http://localhost:8787/activate?product=djdl"],
		["a nested member", {"error": {"code": "x", "manageUrl": FREE}}, FREE],
		["javascript:", {"manageUrl": "javascript:alert(1)"}, null],
		["plain http", {"manageUrl": "http://key.plrs.im/activate"}, null],
		["userinfo", {"manageUrl": "https://user:pw@key.plrs.im/activate"}, null],
		["relative", {"manageUrl": "/activate?product=djdl"}, null],
		["no //", {"manageUrl": "https:key.plrs.im/activate"}, null],
		["a backslash in the authority", {"manageUrl": "https://key.plrs.im\\@evil.example/activate"}, null],
		["a backslash as a separator", {"manageUrl": "https://key.plrs.im\\evil/activate"}, null],
		["whitespace", {"manageUrl": "https://key.plrs.im/a b"}, null],
		["a number", {"manageUrl": 7}, null],
		["absent", {"error": "device_limit", "limit": 1, "deviceCount": 1}, null],
		["not an object", "device_limit", null],
		["null", null, null],
	]
	for c in cases:
		var got = PKeyManage.read(c[1])
		t.check("manage: read %s" % c[0], got == c[2] and typeof(got) == typeof(c[2]), str(got))
	var base := "https://key.plrs.im/activate?product="
	var exact := base + "a".repeat(PKeyManage.MAX_LENGTH - base.length())
	t.check("manage: MAX_LENGTH is 2048", PKeyManage.MAX_LENGTH == 2048)
	t.check("manage: a link of exactly MAX_LENGTH is kept", PKeyManage.is_valid(exact))
	t.check("manage: a longer link is dropped", PKeyManage.read({"manageUrl": exact + "a"}) == null)


func _with_return(t: PKeyTestContext) -> void:
	var cases := [
		[FREE, "myapp://done", "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64&return=myapp%3A%2F%2Fdone"],
		[ACTIVATE, "https://app.example/a b", "https://key.plrs.im/activate?product=djdl&return=https%3A%2F%2Fapp.example%2Fa+b"],
		[ACTIVATE + "#key=k", "x", "https://key.plrs.im/activate?product=djdl&return=x#key=k"],
		["https://key.plrs.im/#/p/djdl/free-device?return=old", "new", "https://key.plrs.im/#/p/djdl/free-device?return=new"],
		["https://key.plrs.im/#/p/djdl/free-device", "new", "https://key.plrs.im/#/p/djdl/free-device?return=new"],
		["javascript:alert(1)", "x", "javascript:alert(1)"],
		[FREE, "", FREE],
	]
	for c in cases:
		var got := PKeyManage.with_return(c[0], c[1])
		t.check("manage: with_return %s + %s" % [c[0], c[1]], got == c[2], got)


func _with_key(t: PKeyTestContext) -> void:
	var cases := [
		[ACTIVATE, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", "https://key.plrs.im/activate?product=djdl#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV"],
		["https://key.plrs.im/activate?product=djdl&next=free-device#key=old", "k y", "https://key.plrs.im/activate?product=djdl&next=free-device#key=k+y"],
		[FREE, "pkey_x", FREE],
		["https://key.plrs.im/signin?product=djdl", "k", "https://key.plrs.im/signin?product=djdl"],
		["javascript:alert(1)", "k", "javascript:alert(1)"],
		[ACTIVATE, "", ACTIVATE],
	]
	for c in cases:
		var got := PKeyManage.with_key(c[0], c[1])
		t.check("manage: with_key %s + %s" % [c[0], c[1]], got == c[2], got)


func _ladder(t: PKeyTestContext) -> void:
	var cases := [
		["flat", S.json(403, {"error": "device_limit", "limit": 1, "deviceCount": 1, "manageUrl": ACTIVATE}), 1, ACTIVATE],
		["nested", S.json(403, {"error": {"code": "device_limit", "limit": 2, "deviceCount": 2, "manageUrl": FREE}}), 2, FREE],
		["invalid", S.json(403, {"error": "device_limit", "limit": 3, "deviceCount": 3, "manageUrl": "javascript:x"}), 3, null],
		["unknown member", S.json(403, {"error": "device_limit", "limit": 4, "deviceCount": 4, "future": true}), 4, null],
	]
	var store := PKeyMemoryStore.new(h.F["device_id"])
	var sdk = await h.sdk(store)
	for c in cases:
		h.plan = {"/license/activate": [c[1]]}
		var r: PKeyActivationResult = await sdk.license.activate_with_key(KEY)
		t.check("manage: device-limit %s carries its link" % c[0], r.kind == PKeyActivationResult.KIND_DEVICE_LIMIT and r.limit == c[2] and r.device_count == c[2] and r.manage_url == c[3], "%s limit=%s url=%s" % [r, r.limit, r.manage_url])
		t.check("manage: device-limit %s is no auth failure (no token, nothing wiped)" % c[0], store.token == "")
	sdk.queue_free()
