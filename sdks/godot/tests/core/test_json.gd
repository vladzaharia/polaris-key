extends RefCounted
# PKeyJson and PKeyB64Url against what `JSON.parse` and shared-jws do. Every REJECT row is
# something Godot's own parser accepts (notes/A5 §2) or a byte Marshalls would skip.

const REJECT := {
	"trailing comma in an object": "{\"a\":1,}",
	"trailing comma in an array": "[1,2,]",
	"leading zero": "01",
	"leading zero in a member": "{\"a\":01}",
	"negative leading zero": "-01",
	"a bare decimal point": "1.",
	"a leading decimal point": ".5",
	"a plus sign": "+1",
	"an exponent without digits": "1e",
	"a raw control character": "\"a\u0001b\"",
	"a raw tab in a string": "\"a\tb\"",
	"a raw newline in a string": "\"a\nb\"",
	"a duplicate key at depth 3": "{\"a\":{\"b\":{\"c\":1,\"c\":2}}}",
	"a duplicate key written with an escape": "{\"a\":1,\"\\u0061\":2}",
	"a duplicate key at the top": "{\"k\":1,\"k\":1}",
	"a bad escape": "\"\\x41\"",
	"a short unicode escape": "\"\\u12\"",
	"NaN": "NaN",
	"Infinity": "Infinity",
	"undefined": "undefined",
	"True": "True",
	"a single-quoted string": "'a'",
	"an unquoted key": "{a:1}",
	"a comment": "{\"a\":1} // c",
	"trailing data": "{} {}",
	"two values": "1 2",
	"a missing value": "{\"a\":}",
	"a missing colon": "{\"a\" 1}",
	"an unterminated string": "\"abc",
	"an unterminated object": "{\"a\":1",
	"an unterminated array": "[1",
	"a lone close": "]",
	"empty text": "",
	"whitespace only": "  \n ",
	"a vertical tab as whitespace": "\u000b1",
	"a lone surrogate (recorded divergence: JSON.parse accepts it)": "\"\\ud800\"",
}

const ACCEPT := {
	"an empty object": ["{}", {}],
	"an empty array": ["[]", []],
	"nested containers": ["{\"a\":[1,{\"b\":null}],\"c\":{}}", {"a": [1.0, {"b": null}], "c": {}}],
	"a top-level string": ["\"x\"", "x"],
	"a top-level number": ["-0.5e+2", -50.0],
	"true": ["true", true],
	"null": ["null", null],
	"whitespace around": [" \t\r\n{ \"a\" : 1 } \n", {"a": 1.0}],
	"escapes": ["\"\\\"\\\\\\/\\b\\f\\n\\r\\t\"", "\"\\/\b\f\n\r\t"],
	"a surrogate pair": ["\"\\ud83d\\ude00\"", "😀"],
	"the same key in two objects": ["[{\"k\":1},{\"k\":2}]", [{"k": 1.0}, {"k": 2.0}]],
	"non-ASCII text": ["{\"név\":\"ünïcödé-λ\"}", {"név": "ünïcödé-λ"}],
}


func run(t: PKeyTestContext) -> void:
	for name in REJECT:
		var r := PKeyJson.parse(REJECT[name])
		t.check("json rejects %s" % name, not r["ok"], str(r.get("value")))
	for name in ACCEPT:
		var r := PKeyJson.parse(ACCEPT[name][0])
		t.check("json accepts %s" % name, r["ok"] and r["value"] == ACCEPT[name][1] and typeof(r["value"]) == typeof(ACCEPT[name][1]), str(r))

	# Numbers are float64 exactly as in JS.
	var big := PKeyJson.parse("9007199254740991")
	t.check("json reads 2^53 - 1 exactly", big["ok"] and big["value"] is float and int(big["value"]) == 9007199254740991 and big["value"] == float("9007199254740991"), str(big))
	var inf := PKeyJson.parse("1e400")
	t.check("json reads 1e400 as infinity", inf["ok"] and inf["value"] is float and is_inf(inf["value"]) and inf["value"] > 0, str(inf))
	var neg := PKeyJson.parse("[-1e400, 1E-400]")
	t.check("json reads -1e400 and an underflow", neg["ok"] and is_inf(neg["value"][0]) and neg["value"][1] == 0.0, str(neg))

	# WIRE-CONTRACT-V3 §10: a real \u0000 escape becomes U+FFFD; an escaped backslash stays text.
	var nul := PKeyJson.parse("{\"a\":\"x\\u0000y\",\"b\":\"x\\\\u0000y\"}")
	t.check("json §10: \\u0000 decodes as U+FFFD", nul["ok"] and nul["value"]["a"] == "x" + char(0xFFFD) + "y", str(nul))
	t.check("json §10: an escaped backslash before u0000 stays text", nul["ok"] and nul["value"]["b"] == "x\\u0000y", str(nul))
	var nul_dup := PKeyJson.parse("{\"a\\u0000\":1,\"a\\ufffd\":2}")
	t.check("json §10: the replacement applies before the duplicate-key scan", not nul_dup["ok"])

	# Bytes: a raw NUL is refused before decoding; one BOM is dropped (TextDecoder).
	var raw_nul := PackedByteArray([0x22, 0x61, 0x00, 0x62, 0x22])
	t.check("json rejects a raw NUL byte", not PKeyJson.parse_bytes(raw_nul)["ok"])
	var truncating := "{\"a\":1}".to_utf8_buffer()
	truncating.append_array(PackedByteArray([0x00, 0x7b]))
	t.check("json rejects data after a raw NUL byte", not PKeyJson.parse_bytes(truncating)["ok"])
	var bom := PackedByteArray([0xEF, 0xBB, 0xBF])
	bom.append_array("{\"a\":1}".to_utf8_buffer())
	t.check("json drops one leading BOM", PKeyJson.parse_bytes(bom)["ok"])

	# A bundle-sized string is one token, not a GDScript loop per byte.
	var long := "\"" + "A".repeat(350000) + "\""
	var t0 := Time.get_ticks_usec()
	var lr := PKeyJson.parse(long)
	t.check("json validates a 350 KB string", lr["ok"] and (lr["value"] as String).length() == 350000)
	t.info("json: 350 KB string validated in %.1f ms" % ((Time.get_ticks_usec() - t0) / 1000.0))
	var escapes := "\"" + "\\n".repeat(30000) + "\""
	t.check("json validates 30 000 escapes", PKeyJson.parse(escapes)["ok"])
	var deep := "[".repeat(200) + "]".repeat(200)
	t.check("json validates 200 levels of nesting", PKeyJson.parse(deep)["ok"])

	# base64url.
	t.check("b64url strict decodes", PKeyB64Url.decode_strict("AQID") == PackedByteArray([1, 2, 3]))
	t.check("b64url strict decodes unpadded", PKeyB64Url.decode_strict("AQ") == PackedByteArray([1]))
	t.check("b64url strict decodes the url alphabet", PKeyB64Url.decode_strict("-_8") == PackedByteArray([0xfb, 0xff]))
	for bad in ["AQ==", "AQ=", "A+8", "A/8", "AQ ID", "AQID\n", "\nAQID", "A", "AQIDB", "AQ*D"]:
		t.check("b64url strict refuses %s" % JSON.stringify(bad), PKeyB64Url.decode_strict(bad) == null)
	t.check("b64url strict decodes empty", PKeyB64Url.decode_strict("") == PackedByteArray())
	t.check("b64url round-trips", PKeyB64Url.decode_strict(PKeyB64Url.encode(PackedByteArray([0, 255, 254, 1]))) == PackedByteArray([0, 255, 254, 1]))
	for ok_key in ["AQID", "AQ", "AQ==", "AQ=", "AQID\t\n  ", "+/8", "-_8="]:
		t.check("b64url lenient accepts %s" % JSON.stringify(ok_key), PKeyB64Url.decode_lenient(ok_key) != null)
	for bad_key in ["A", "AQ===", "A=Q", "AQ*D"]:
		t.check("b64url lenient refuses %s" % JSON.stringify(bad_key), PKeyB64Url.decode_lenient(bad_key) == null)

	# The resumable SHA-512 agrees with the one-shot hash on every known-answer vector.
	var vectors = PKeyTestFixtures.read_json("res://tests/vectors/sha512.json")
	var n := 0
	if t.check("sha512 stream: vectors present", vectors is Array):
		for v in vectors:
			var m: PackedByteArray = String(v["msg"]).hex_decode()
			var s := PKeySha512Stream.new(m)
			while not s.step(1):
				pass
			t.check("sha512 stream len=%d" % m.size(), s.digest().hex_encode() == v["sha512"])
			n += 1
		t.check("sha512 stream coverage", n == vectors.size() and n >= 24, "%d/%d" % [n, vectors.size()])
