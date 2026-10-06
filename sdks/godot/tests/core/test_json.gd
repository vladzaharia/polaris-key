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

	# Numbers are float64 exactly as in JS, inside WIRE-CONTRACT-V4 §1.2 rule 8's range.
	var big := PKeyJson.parse("9007199254740991")
	t.check("json reads 2^53 - 1 exactly", big["ok"] and big["value"] is float and int(big["value"]) == 9007199254740991 and big["value"] == float("9007199254740991"), str(big))
	for out_of_range in ["1e400", "[-1e400, 1E-400]", "5e-324", "1e4294967297", "1e308", "1e-308", "0e1000000", "-0.0e1234567"]:
		t.check("json refuses %s (rule 8)" % out_of_range, not PKeyJson.parse(out_of_range)["ok"])
	for in_range in ["7", "-0", "7.0", "7e0", "1e-7", "1e+21", "1e-307", "9.99e307", "0e5", "0e999999"]:
		t.check("json keeps %s (rule 8)" % in_range, PKeyJson.parse(in_range)["ok"])
	# V4 §3: the pointers of the number tokens that cannot be wire integers.
	var nw := PKeyJson.parse("{\"seq\":7,\"b\":7.0,\"a/b\":[1,17e8,9007199254740991,9007199254740992],\"t~\":{\"x\":-0,\"y\":1.5}}")
	var ptrs: Array = nw["non_wire_integers"].keys() if nw["ok"] else []
	ptrs.sort()
	t.check("json reports the non-wire-integer pointers", ptrs == ["/a~1b/1", "/a~1b/3", "/b", "/t~0/y"], str(ptrs))
	var pset: PKeyJson.PointerSet = nw.get("non_wire_integers")
	t.check("json pointer set: size", pset != null and pset.size() == 4)
	for p in ["/a~1b/1", "/a~1b/3", "/b", "/t~0/y"]:
		t.check("json pointer set has %s" % p, pset != null and pset.has(p))
	for p in ["", "/seq", "/a/b/1", "/a~1b", "/a~1b/0", "/a~1b/2", "/a~1b/01", "/t~/y", "/t~2/y", "/t~0", "/t~0/x", "/t~0/y/0", "b"]:
		t.check("json pointer set lacks %s" % JSON.stringify(p), pset != null and not pset.has(p))
	var top := PKeyJson.parse("7.0")
	t.check("json pointer set: a top-level number is the empty pointer", top["ok"] and top["non_wire_integers"].has("") and top["non_wire_integers"].keys() == [""])
	# Long member names over many fractional numbers: one pointer string per number would cost
	# 8 000 × 32 000 characters here (about 1.5 GB). The set stays linear in the payload.
	var long_name := "a".repeat(32000)
	var fractions := PackedStringArray()
	fractions.resize(8000)
	fractions.fill("1.5")
	var long_text := "{\"config\":{\"k\":{\"value\":{\"" + long_name + "\":[" + ",".join(fractions) + "]}}}}"
	var mem_before := OS.get_static_memory_usage()
	var started := Time.get_ticks_msec()
	var long_scan := PKeyJson.walk(long_text)
	var elapsed := Time.get_ticks_msec() - started
	var grown := OS.get_static_memory_usage() - mem_before
	# The same bytes and numbers, but the long name is a sibling string, off every number's path:
	# a linear walk costs about the same on both; one pointer string per number costs the name's
	# length 8 000 times over on the first. Interleaved runs compared, so load cancels out.
	var short_name := "b".repeat(long_name.length())
	var pad_text := "{\"" + short_name + "\":\"\",\"config\":{\"k\":{\"value\":{\"x\":[" + ",".join(fractions) + "]}}}}"
	var ratio_ms := PKeyTestFixtures.fastest_ms([func(): PKeyJson.walk(long_text), func(): PKeyJson.walk(pad_text)])
	t.info("json pointer set: fastest of 3 — long path %.1f ms, same bytes off the path %.1f ms" % [ratio_ms[0], ratio_ms[1]])
	var long_set: PKeyJson.PointerSet = long_scan["non_wire_integers"]
	t.check("json pointer set stays linear: accepted", long_text.length() < 65536 and long_scan["error"] == "", str(long_scan["error"]))
	t.check("json pointer set stays linear: 8000 numbers", long_set.size() == 8000)
	t.check("json pointer set stays linear: lookup", long_set.has("/config/k/value/" + long_name + "/7999") and not long_set.has("/config/k/value/" + long_name + "/8000"))
	t.check("json pointer set stays linear: memory", grown < 64 * 1024 * 1024, "grew %d bytes" % grown)
	t.check("json pointer set stays linear: a long path costs at most 3× the same bytes off the path", ratio_ms[0] <= 3.0 * ratio_ms[1] + 25.0, "%.1f ms vs %.1f ms" % [ratio_ms[0], ratio_ms[1]])
	t.check("json pointer set stays linear: no hang (guard 120 s)", elapsed < 120000, "%d ms" % elapsed)

	# WIRE-CONTRACT-V3 §10: a real \u0000 escape becomes U+FFFD; an escaped backslash stays text.
	var nul := PKeyJson.parse("{\"a\":\"x\\u0000y\",\"b\":\"x\\\\u0000y\"}")
	t.check("json §10: \\u0000 decodes as U+FFFD", nul["ok"] and nul["value"]["a"] == "x" + char(0xFFFD) + "y", str(nul))
	t.check("json §10: an escaped backslash before u0000 stays text", nul["ok"] and nul["value"]["b"] == "x\\u0000y", str(nul))
	var nul_dup := PKeyJson.parse("{\"a\\u0000\":1,\"a\\ufffd\":2}")
	t.check("json V4 §1.2 rule 7: a member name holding U+0000 is refused", not nul_dup["ok"])
	t.check("json V4 rule 7: an escaped backslash before u0000 in a name is text", PKeyJson.parse("{\"a\\\\u0000\":1}")["ok"])

	# Bytes: a raw NUL is refused before decoding; a BOM and ill-formed UTF-8 are refused (V4 §1.2).
	var raw_nul := PackedByteArray([0x22, 0x61, 0x00, 0x62, 0x22])
	t.check("json rejects a raw NUL byte", not PKeyJson.parse_bytes(raw_nul)["ok"])
	var truncating := "{\"a\":1}".to_utf8_buffer()
	truncating.append_array(PackedByteArray([0x00, 0x7b]))
	t.check("json rejects data after a raw NUL byte", not PKeyJson.parse_bytes(truncating)["ok"])
	var bom := PackedByteArray([0xEF, 0xBB, 0xBF])
	bom.append_array("{\"a\":1}".to_utf8_buffer())
	t.check("json refuses a leading BOM", not PKeyJson.parse_bytes(bom)["ok"])
	for bad in [PackedByteArray([0x22, 0xFF, 0x22]), PackedByteArray([0x22, 0xED, 0xA0, 0x80, 0x22]), PackedByteArray([0x22, 0xC0, 0xAF, 0x22])]:
		t.check("json refuses ill-formed UTF-8 %s" % bad.hex_encode(), not PKeyJson.parse_bytes(bad)["ok"])
	t.check("json accepts well-formed UTF-8", PKeyJson.parse_bytes("\"ünï 💻\"".to_utf8_buffer())["ok"])

	# A bundle-sized string is one token, not a GDScript loop per byte.
	var long := "\"" + "A".repeat(350000) + "\""
	var t0 := Time.get_ticks_usec()
	var lr := PKeyJson.parse(long)
	t.check("json validates a 350 KB string", lr["ok"] and (lr["value"] as String).length() == 350000)
	t.info("json: 350 KB string validated in %.1f ms" % ((Time.get_ticks_usec() - t0) / 1000.0))
	var escapes := "\"" + "\\n".repeat(30000) + "\""
	t.check("json validates 30 000 escapes", PKeyJson.parse(escapes)["ok"])
	# V4 §1.2 rule 9: at most 64 levels, the top-level value as level 1.
	t.check("json validates 64 levels of nesting", PKeyJson.parse("[".repeat(64) + "]".repeat(64))["ok"])
	t.check("json refuses 65 levels of nesting", not PKeyJson.parse("[".repeat(65) + "]".repeat(65))["ok"])

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

	# V4 §3: the whole-string pattern helper and the integer-claim helper.
	for term in ["\n", "\r\n", "\r", char(0x85), char(0x2028), char(0x2029)]:
		t.check("matches_whole refuses a trailing terminator %s" % str(term.unicode_at(0)), not PKeyClaims.matches_whole("[a-z][a-z0-9-]{0,63}", "direct" + term))
	t.check("matches_whole accepts the whole value", PKeyClaims.matches_whole("[a-z][a-z0-9-]{0,63}", "direct"))
	t.check("semver refuses 1.2.3 and a newline", PKeySemver.parse("1.2.3\n") == null)
	t.check("is_wire_integer: 0 at minimum 0", PKeyClaims.is_wire_integer(0.0, "/issuedAt", 0, null))
	t.check("is_wire_integer: 2^53 - 1", PKeyClaims.is_wire_integer(9007199254740991.0, "/seq", 1, PKeyJson.PointerSet.new()))
	t.check("is_wire_integer refuses 2^53", not PKeyClaims.is_wire_integer(9007199254740992.0, "/seq", 1, null))
	t.check("is_wire_integer refuses a flagged pointer", not PKeyClaims.is_wire_integer(7.0, "/seq", 1, PKeyJson.PointerSet.from_pointers(["/seq"])))
	t.check("is_wire_integer refuses below the minimum", not PKeyClaims.is_wire_integer(0.0, "/seq", 1, null))
	t.check("is_wire_integer refuses a fraction and a bool", not PKeyClaims.is_wire_integer(7.5, "/seq", 1, null) and not PKeyClaims.is_wire_integer(true, "/seq", 1, null))
