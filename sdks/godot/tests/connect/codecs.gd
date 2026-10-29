extends RefCounted
# @pkey-feature connect.protocol
# The `adverts`, `sas` and `handshakePayloads` rows of `peer-matrix.json` (WIRE-CONTRACT-V5 sections
# 15.4 and 15.5) through PKeyPeerAdvert, PKeyPeerSas and PKeyPeerPayload, row for row as the Node,
# Python, Kotlin and Swift runners do, with exact counts, plus what the corpus cannot say: the HELLO
# record and its display cleaning (section 15.6, the Connect security fixes), the payload encoders,
# and the refusals of the decoders. Reads res://tests/corpus/v2/peer-matrix.json (generator-owned;
# never edit it).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK \
			and j.data is Dictionary):
		return
	var m: Dictionary = j.data
	var a: Dictionary = m["adverts"]
	var s: Dictionary = m["sas"]
	var h: Dictionary = m["handshakePayloads"]
	t.check("advert row counts", _counts(a, {
		"epochs": 8, "names": 12, "tags": 5, "txt": 24, "instances": 9, "browse": 12}))
	t.check("sas row counts", _counts(s, {"commits": 3, "codes": 12, "reveals": 10, "nonces": 6}))
	t.check("payload row counts", _counts(h, {"payloads": 58, "intersection": 7}))
	t.check("advert epoch seconds", int(a["epochSeconds"]) == PKeyPeerAdvert.ADVERT_EPOCH_SECONDS)
	t.check("max payload", int(h["maxPayload"]) == PKeyPeerPayload.MAX_HANDSHAKE_PAYLOAD)
	_epochs(t, a["epochs"])
	_names(t, a["names"])
	_tags(t, a["tags"])
	_txt(t, a["txt"])
	_instances(t, a["instances"])
	_browse(t, a["browse"])
	_advert_edges(t)
	_commits(t, s["commits"])
	_codes(t, s["codes"])
	_reveals(t, s["reveals"])
	_nonces(t, s["nonces"])
	_sas_edges(t, s)
	_payloads(t, h["payloads"])
	_intersection(t, h["intersection"])
	_payload_encoders(t)
	_hello(t)


static func _counts(section: Dictionary, want: Dictionary) -> bool:
	for k in want:
		if (section[k] as Array).size() != int(want[k]):
			return false
	return true


static func _hex(s: String) -> PackedByteArray:
	return s.hex_decode()


# adverts

func _epochs(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		good += int(t.check("epoch of %d" % int(r["now"]),
				PKeyPeerAdvert.advert_epoch(int(r["now"])) == int(r["epoch"])))
	t.check("every epoch row ran", good == 8, "%d/8" % good)


func _names(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		good += int(t.check("account instance %s" % r["id"], PKeyPeerAdvert.account_instance(
				_hex(r["kDisc"]), int(r["epoch"]), r["deviceId"]) == r["instance"]))
	t.check("every name row ran", good == 12, "%d/12" % good)


func _tags(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		good += int(t.check("product tag %s %d" % [r["slug"], int(r["epoch"])],
				PKeyPeerAdvert.product_tag(r["slug"], int(r["epoch"])) == r["h"]))
	t.check("every tag row ran", good == 5, "%d/5" % good)


func _txt(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		var got := PKeyPeerAdvert.parse_txt(r["entries"])
		var want: Dictionary = r["want"]
		var ok: bool = got["ok"] == want["ok"]
		if ok and got["ok"]:
			ok = got["mode"] == want["mode"] and got.get("h") == want.get("h")
		elif ok:
			ok = got["reason"] == want["reason"]
		good += int(t.check("txt %s" % r["id"], ok))
	t.check("every txt row ran", good == 24, "%d/24" % good)


func _instances(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		good += int(t.check("instance name '%s'" % r["name"],
				PKeyPeerAdvert.is_instance_name(r["name"]) == r["want"]))
	t.check("every instance row ran", good == 9, "%d/9" % good)


func _browse(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		var keys: Array = []
		for k in r["kDiscs"]:
			keys.append(_hex(k))
		var got := PKeyPeerAdvert.browse_account_instance(
				r["instance"], keys, int(r["now"]), r["roster"])
		var want: Variant = r["want"]
		var ok: bool = got.is_empty() if want == null else (got.get("device_id") == want["deviceId"] \
				and got.get("epoch_back") == int(want["epochBack"]) \
				and got.get("key_index") == int(want["keyIndex"]))
		good += int(t.check("browse %s" % r["id"], ok))
	t.check("every browse row ran", good == 12, "%d/12" % good)


func _advert_edges(t: PKeyTestContext) -> void:
	# RFC 4648 section 10 vectors, lower case, no padding.
	t.check("base32 vectors", PKeyPeerAdvert.base32_lower(PackedByteArray()) == "" \
			and PKeyPeerAdvert.base32_lower("f".to_utf8_buffer()) == "my" \
			and PKeyPeerAdvert.base32_lower("foobar".to_utf8_buffer()) == "mzxw6ytboi")
	t.check("device id bytes: 24 bytes for 32 characters",
			(PKeyPeerAdvert.device_id_bytes("leAZmawulGPwc1GRLRg7UxoOyzqRd3Zp") as PackedByteArray).size() == 24)
	for bad in ["", "short", "leAZmawulGPwc1GRLRg7UxoOyzqRd3Zp=", "leAZmawulGPwc1GRLRg7UxoOyzqRd3Z+"]:
		t.check("device id bytes refuse '%s'" % bad, PKeyPeerAdvert.device_id_bytes(bad) == null)
	var key := _hex("b6f1febb25a7f5773765eabc737083bb07db0a49f3cbbb35a8f21f52d0fb1e5f")
	t.check("an invalid device id has no instance", PKeyPeerAdvert.account_instance(key, 0, "x") == "")
	# A roster entry that is not a device id never matches and never breaks the browse.
	t.check("browse skips a malformed roster entry", PKeyPeerAdvert.browse_account_instance(
			"p1-owbkgd7fdem5rs4j", [key], 0, ["bad", "leAZmawulGPwc1GRLRg7UxoOyzqRd3Zp"]).get("device_id") \
			== "leAZmawulGPwc1GRLRg7UxoOyzqRd3Zp")
	t.check("browse reads at most two keys", PKeyPeerAdvert.browse_account_instance(
			"p1-owbkgd7fdem5rs4j", [PackedByteArray([1] as Array), PackedByteArray([2] as Array), key], 0,
			["leAZmawulGPwc1GRLRg7UxoOyzqRd3Zp"]).is_empty())
	t.check("txt entries that are not strings are ignored", PKeyPeerAdvert.parse_txt([1, null, "v=1", "m=a"])["ok"])


# sas

func _commits(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		var n_d := _hex(r["nD"])
		var ok: bool = PKeyPeerSas.commit(n_d).hex_encode() == r["c"] \
				and PKeyPeerSas.body("c", _hex(r["c"])).get_string_from_utf8() == r["commitBody"] \
				and PKeyPeerSas.body("nD", n_d).get_string_from_utf8() == r["revealBody"] \
				and (PKeyPeerSas.parse_body("c", r["commitBody"].to_utf8_buffer()) as PackedByteArray).hex_encode() == r["c"] \
				and (PKeyPeerSas.parse_body("nD", r["revealBody"].to_utf8_buffer()) as PackedByteArray) == n_d
		good += int(t.check("sas commit %s" % String(r["nD"]).left(8), ok))
	t.check("every commit row ran", good == 3, "%d/3" % good)


func _codes(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		var code := PKeyPeerSas.value(_hex(r["h"]), _hex(r["nD"]), _hex(r["nM"]), r["mode"])
		good += int(t.check("sas code %s" % r["id"],
				code == int(r["code"]) and PKeyPeerSas.display(code) == r["display"]))
	t.check("every code row ran", good == 12, "%d/12" % good)


func _reveals(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		good += int(t.check("sas reveal %s" % r["id"], PKeyPeerSas.reveal_ok(r["c"], r["nD"]) == r["want"]))
	t.check("every reveal row ran", good == 10, "%d/10" % good)


func _nonces(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		var got: Variant = PKeyPeerSas.decode_value(r["text"])
		var ok: bool = got == null if r["want"] == null else (got != null \
				and (got as PackedByteArray).hex_encode() == r["want"] \
				and PKeyPeerSas.encode_value(got) == r["text"])
		good += int(t.check("sas nonce %s" % r["id"], ok))
	t.check("every nonce row ran", good == 6, "%d/6" % good)


func _sas_edges(t: PKeyTestContext, s: Dictionary) -> void:
	var n: PackedByteArray = _hex(s["commits"][0]["nD"])
	t.check("display pads to six digits", PKeyPeerSas.display(0) == "000 000" \
			and PKeyPeerSas.display(5) == "000 005" and PKeyPeerSas.display(999999) == "999 999")
	t.check("nM body parses as nM only", PKeyPeerSas.parse_body("nM", PKeyPeerSas.body("nM", n)) == n \
			and PKeyPeerSas.parse_body("nD", PKeyPeerSas.body("nM", n)) == null \
			and PKeyPeerSas.parse_body("c", PKeyPeerSas.body("nD", n)) == null)
	t.check("encoders refuse a wrong length or member", PKeyPeerSas.encode_value(n.slice(0, 31)) == "" \
			and PKeyPeerSas.body("c", n.slice(0, 31)).is_empty() and PKeyPeerSas.body("x", n).is_empty())
	var good := PKeyPeerSas.body("nD", n).get_string_from_utf8()
	var bad_bodies := {
		"whitespace": ' ' + good, "trailing newline": good + "\n", "second member": good.replace("}", ',"x":1}'),
		"no braces": good.trim_prefix("{").trim_suffix("}"), "padded value": good.replace('"}', '="}'),
		"empty": "", "array": "[]", "short value": good.replace('"}', 'A"}'),
	}
	for k in bad_bodies:
		t.check("sas body refuses %s" % k, PKeyPeerSas.parse_body("nD", String(bad_bodies[k]).to_utf8_buffer()) == null)
	var with_nul := good.to_utf8_buffer()
	with_nul.append(0)
	with_nul.append_array(" trailing".to_utf8_buffer())
	t.check("sas body refuses a NUL byte", PKeyPeerSas.parse_body("nD", with_nul) == null)
	var bad_utf8 := good.to_utf8_buffer()
	bad_utf8[10] = 0xff
	t.check("sas body refuses ill-formed UTF-8", PKeyPeerSas.parse_body("nD", bad_utf8) == null)
	var v1 := PKeyPeerSas.value(n, n, n, "v")
	var v2 := PKeyPeerSas.value(n, n, n, "v")
	t.check("a code is the same for the same inputs and differs by mode", v1 == v2 \
			and v1 != PKeyPeerSas.value(n, n, n, "p"))


# handshake payloads

static func _payload_bytes(r: Dictionary) -> PackedByteArray:
	if r.has("payloadHex"):
		return _hex(r["payloadHex"])
	if r.has("payloadPad"):
		var p: Dictionary = r["payloadPad"]
		return (String(p["prefix"]) + String(p["fill"]).repeat(int(p["count"])) + String(p["suffix"])).to_utf8_buffer()
	return String(r["payload"]).to_utf8_buffer()


func _payloads(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		var bytes := _payload_bytes(r)
		var got := PKeyPeerPayload.parse_handshake_payload(r["mode"], int(r["message"]), bytes)
		var want: Dictionary = r["want"]
		var ok: bool = bytes.size() == int(r["length"]) and got["ok"] == want["ok"]
		if ok and got["ok"]:
			ok = got["caps"] == want.get("caps", []) \
					and got.get("ring", -1) == int(want.get("ring", -1)) and got.get("cert") == want.get("cert")
		good += int(t.check("payload %s" % r["id"], ok))
	t.check("every payload row ran", good == 58, "%d/58" % good)


func _intersection(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r in rows:
		good += int(t.check("caps intersection %s" % r["id"],
				PKeyPeerPayload.caps_intersection(r["local"], r["remote"]) == r["want"]))
	t.check("every intersection row ran", good == 7, "%d/7" % good)


func _payload_encoders(t: PKeyTestContext) -> void:
	t.check("message 1 bytes", PKeyPeerPayload.payload1().get_string_from_utf8() == '{"v":1}')
	var caps := ["app/1", "ring/1"]
	var account := {"cert": "e30.e30.c2ln", "ring": 7}
	t.check("message 2 in mode a: v, cert, ring, caps", PKeyPeerPayload.payload23("a", caps, account).get_string_from_utf8() \
			== '{"v":1,"cert":"e30.e30.c2ln","ring":7,"caps":["app/1","ring/1"]}')
	t.check("message 2 in mode v: v, caps", PKeyPeerPayload.payload23("v", caps).get_string_from_utf8() \
			== '{"v":1,"caps":["app/1","ring/1"]}')
	t.check("mode a needs an account", PKeyPeerPayload.payload23("a", caps).is_empty())
	t.check("an encoded payload parses back", PKeyPeerPayload.parse_handshake_payload(
			"a", 2, PKeyPeerPayload.payload23("a", caps, account)) == {
				"ok": true, "caps": caps, "ring": 7, "cert": "e30.e30.c2ln"})
	var big := {"cert": "x".repeat(9000), "ring": 1}
	t.check("a payload over 8 KiB is not built", PKeyPeerPayload.payload23("a", ["a/1"], big).is_empty())
	var many: Array = []
	for i in 40:
		many.append("c%d/1" % i)
	t.check("more than 32 caps is built but not accepted", PKeyPeerPayload.parse_handshake_payload(
			"v", 2, PKeyPeerPayload.payload23("v", many))["ok"] == false)


# HELLO

static func _hello_body(label: Variant, platform: String, app: String, extra := "") -> PackedByteArray:
	var o := {}
	if label != null:
		o["label"] = label
	o["platform"] = platform
	o["app"] = app
	o["maxMessage"] = 1048576
	var text := JSON.stringify(o)
	return (text.trim_suffix("}") + extra + "}").to_utf8_buffer()


func _hello(t: PKeyTestContext) -> void:
	# platform and app, as the client-core session test "shows only a known-shaped platform".
	var rows := [
		["macos", "Demo", "macos", "Demo"],
		["Android 14.1_x+y-z", "a", "Android 14.1_x+y-z", "a"],
		["x".repeat(32), "a", "x".repeat(32), "a"],
		["x".repeat(33), "a", "Unknown", "a"],
		["<b>ok</b>", "a", "Unknown", "a"],
		["mac" + char(0x202e) + "os", "a", "Unknown", "a"],
		["", "a", "Unknown", "a"],
		["a\nb", "a", "Unknown", "a"],
		["linux", "  Pay" + char(0x202e) + "ment  ", "linux", "Payment"],
		["linux", char(0x202e), "linux", "Unknown"],
		["linux", "", "linux", "Unknown"],
		["linux", "a".repeat(100), "linux", "a".repeat(64)],
		["linux", "Café TV", "linux", "Café TV"],
		["linux", "a\tb", "linux", "a b"],
	]
	for mode in ["v", "p", "a"]:
		for r in rows:
			var got := PKeyPeerPayload.parse_hello(mode, _hello_body(null, r[0], r[1]))
			t.check("hello %s platform '%s' app '%s'" % [mode, String(r[0]).left(8), String(r[1]).left(8)],
					got["ok"] and got["platform"] == r[2] and got["app"] == r[3] and not got.has("label")
					and got["max_message"] == 1048576)
	# A JSON NUL escape reaches Godot as U+FFFD; it is dropped from display data.
	var nul := '{"platform":"linux","app":"\\u202e\\u0000","label":"  Pay\\u202e\\u0000ment  ","maxMessage":9}'
	var got_nul := PKeyPeerPayload.parse_hello("v", nul.to_utf8_buffer())
	t.check("hello: an escaped NUL leaves no trace", got_nul["ok"] and got_nul["app"] == "Unknown" \
			and got_nul["label"] == "Payment" and got_nul["max_message"] == 9)
	var lab := PKeyPeerPayload.parse_hello("v", _hello_body("  Cafe " + char(0x202e) + "TV  ", "t", "a"))
	t.check("hello: the label is cleaned", lab["ok"] and lab["label"] == "Cafe TV")
	var long_label := PKeyPeerPayload.parse_hello("v", _hello_body("l".repeat(100), "t", "a"))
	t.check("hello: the label is cut to 64 code points", long_label["label"] == "l".repeat(64))
	var empty_label := PKeyPeerPayload.parse_hello("v", _hello_body(char(0x202e) + " ", "t", "a"))
	t.check("hello: a label with nothing left is none", empty_label["ok"] and not empty_label.has("label"))
	# 4 KiB in modes v and p, not in mode a.
	for mode in ["v", "p"]:
		t.check("hello %s: a label of 4100 characters is refused" % mode,
				not PKeyPeerPayload.parse_hello(mode, _hello_body("x".repeat(4100), "t", "a"))["ok"])
		t.check("hello %s: 4000 characters are read" % mode,
				PKeyPeerPayload.parse_hello(mode, _hello_body("x".repeat(4000), "t", "a"))["ok"])
		var room := PKeyPeerPayload.MAX_UNVERIFIED_HELLO - _hello_body("", "t", "a").size()
		var exact := _hello_body("x".repeat(room), "t", "a")
		var over := _hello_body("x".repeat(room + 1), "t", "a")
		t.check("hello %s: exactly 4096 bytes is read, 4097 is not" % mode, exact.size() == 4096 \
				and over.size() == 4097 and PKeyPeerPayload.parse_hello(mode, exact)["ok"] \
				and not PKeyPeerPayload.parse_hello(mode, over)["ok"])
	var big_a := PKeyPeerPayload.parse_hello("a", _hello_body("x".repeat(4100), "t", "a"))
	t.check("hello a: past 4 KiB is read", big_a["ok"] and big_a["label"] == "x".repeat(64))
	# Shape refusals.
	var bad := {
		"no platform": '{"app":"a","maxMessage":1}', "no app": '{"platform":"t","maxMessage":1}',
		"platform number": '{"platform":1,"app":"a","maxMessage":1}',
		"label number": '{"platform":"t","app":"a","label":1,"maxMessage":1}',
		"no maxMessage": '{"platform":"t","app":"a"}',
		"maxMessage zero": '{"platform":"t","app":"a","maxMessage":0}',
		"maxMessage fraction": '{"platform":"t","app":"a","maxMessage":1.5}',
		"maxMessage string": '{"platform":"t","app":"a","maxMessage":"1"}',
		"maxMessage over 2^53": '{"platform":"t","app":"a","maxMessage":9007199254740992}',
		"duplicate member": '{"platform":"t","app":"a","maxMessage":1,"app":"b"}',
		"trailing comma": '{"platform":"t","app":"a","maxMessage":1,}',
		"not an object": '["t","a",1]', "empty": "",
	}
	for k in bad:
		for mode in ["a", "v"]:
			t.check("hello %s refuses %s" % [mode, k], not PKeyPeerPayload.parse_hello(mode, String(bad[k]).to_utf8_buffer())["ok"])
	t.check("hello reads maxMessage 2^53 - 1", PKeyPeerPayload.parse_hello("a",
			'{"platform":"t","app":"a","maxMessage":9007199254740991}'.to_utf8_buffer())["max_message"] == 9007199254740991)
	t.check("hello ignores unknown members", PKeyPeerPayload.parse_hello("v",
			_hello_body(null, "t", "a", ',"x":[1,{"y":null}]'))["ok"])
	# The encoder and the reader agree.
	var body := PKeyPeerPayload.hello_body("Den", "linux", "Demo", 65536)
	t.check("hello body bytes", body.get_string_from_utf8() \
			== '{"label":"Den","platform":"linux","app":"Demo","maxMessage":65536}')
	var back := PKeyPeerPayload.parse_hello("v", body)
	t.check("hello body round trip", back == {"ok": true, "label": "Den", "platform": "linux", "app": "Demo", "max_message": 65536})
	t.check("hello body without a label", PKeyPeerPayload.hello_body("", "linux", "Demo").get_string_from_utf8() \
			== '{"platform":"linux","app":"Demo","maxMessage":1048576}')
