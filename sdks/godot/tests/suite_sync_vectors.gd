extends RefCounted
# Cloud Sync end-to-end primitives over the generator-owned mirror of conformance/corpus/v2/
# sync-vectors.json (WIRE-CONTRACT-V5 §13.10, U-40.1): the sections that need no AEAD. Sections that
# do (or that need the chunker, the file stream, HPKE) are typed N/A below, by name, and the suite
# fails on a section that is in neither list, so a new corpus section is noticed.

const VECTORS := "res://tests/corpus/v2/sync-vectors.json"

## Implemented sections (recoveryCodeCases only for the kinds `code` and `parse`).
const RUN := ["hkdfCases", "blindCases", "canonicalJsonCases", "recoveryCodeCases"]
## Typed N/A: the section needs a primitive this slice does not ship.
const NOT_APPLICABLE := {
	"envelopeCases": "needs AES-256-GCM (U-40.3, U-40.5)",
	"transferPlanCases": "needs the transfer planner (U-40.5)",
	"hpkeAnchor": "needs HPKE over X25519 and AES-256-GCM (U-40.5)",
	"wrapCases": "needs HPKE (U-40.5)",
	"adoptCases": "needs AES-256-GCM (U-40.5)",
	"cdcCases": "needs the chunker (U-40.5)",
	"cdcEditCases": "needs the chunker (U-40.5)",
	"deltaCases": "needs the chunker (U-40.5)",
	"chunkCases": "needs AES-256-GCM and zstd frames (U-40.5)",
	"fileStreamCases": "needs AES-256-GCM (U-40.5)",
	"manifestCases": "needs the chunk manifest (U-40.5)",
}
## Members of the file that are not sections.
const META := ["syncVectorsVersion", "description", "constants", "ringId"]


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var j := JSON.new()
	if not t.check("vectors parse", j.parse(FileAccess.get_file_as_string(VECTORS)) == OK and j.data is Dictionary, VECTORS):
		return true
	var d: Dictionary = j.data
	t.check("syncVectorsVersion is 1", d.get("syncVectorsVersion") == 1)
	for k in d:
		if META.has(k) or RUN.has(k):
			continue
		if NOT_APPLICABLE.has(k):
			t.info("N/A %s: %s" % [k, NOT_APPLICABLE[k]])
		else:
			t.check("section %s is run or typed N/A" % k, false)
	var n_blob := 0
	for c in d["recoveryCodeCases"]:
		if c["kind"] == "blob":
			n_blob += 1
	t.info("N/A recoveryCodeCases kind blob (%d rows): needs AES-256-GCM (U-40.5)" % n_blob)

	_hkdf(t, d["hkdfCases"])
	_blind(t, d["blindCases"])
	_kid(t, d)
	_canonical(t, d["canonicalJsonCases"])
	_recovery(t, d["recoveryCodeCases"])
	_extras(t)
	return true


func _hkdf(t: PKeyTestContext, rows: Array) -> void:
	var seen := {}
	for c in rows:
		var ikm := _hex(c["ikmHex"])
		var salt := _hex(c["saltHex"])
		var info := _hex(c["infoHex"])
		var got := PKeySyncHkdf.hkdf(ikm, salt, info, int(c["length"]))
		t.check("hkdf %s" % c["id"], got.hex_encode() == c["okmHex"], c["okmHex"])
		# The typed derivation behind the label, where there is one.
		var typed: Variant = _typed(String(c["label"]), ikm, salt, info)
		if typed != null:
			seen[c["label"]] = true
			t.check("derive %s" % c["id"], (typed as PackedByteArray).hex_encode() == c["okmHex"])
	for label in ["kid", "coll", "names", "chunk-id", "value", "file", "chunk", "recovery", "adopt"]:
		t.check("label %s is covered by a typed derivation" % label, seen.has(label))
	t.check("hkdf refuses a length over 255 blocks", PKeySyncHkdf.hkdf(PackedByteArray([1]), PackedByteArray(), PackedByteArray(), 255 * 32 + 1).is_empty())


func _typed(label: String, ikm: PackedByteArray, salt: PackedByteArray, info: PackedByteArray) -> Variant:
	# The name after the NUL that scopes a label, if any.
	var at := info.find(0)
	var name := info.slice(at + 1).get_string_from_utf8() if at >= 0 else ""
	match label:
		"kid": return PKeySyncHkdf.derive_kid(ikm)
		"coll": return PKeySyncHkdf.derive_coll_key(ikm, name)
		"names": return PKeySyncHkdf.derive_names_key(ikm)
		"chunk-id": return PKeySyncHkdf.derive_chunk_id_key(ikm, name)
		"value": return PKeySyncHkdf.derive_value_key(ikm, salt)
		"file": return PKeySyncHkdf.derive_file_key(ikm, salt)
		"chunk": return PKeySyncHkdf.derive_chunk_key(ikm, salt)
		"recovery": return PKeySyncHkdf.derive_recovery_key(ikm, salt.get_string_from_utf8())
		"adopt": return PKeySyncHkdf.derive_adopt_key(ikm)
	return null


func _blind(t: PKeyTestContext, rows: Array) -> void:
	for c in rows:
		var got := PKeySyncBlind.blind(_hex(c["rootHex"]), c["kind"], c["ctx"], c["n"])
		t.check("blind %s" % c["id"], got == c["blinded"], got)
		t.check("blind %s has the blinded shape" % c["id"], PKeySyncBlind.is_blinded_name(got))
	var root := _hex(rows[0]["rootHex"])
	t.check("blind refuses an unknown kind", PKeySyncBlind.blind(root, "nope", "a", "b") == "")
	t.check("blind refuses a short root", PKeySyncBlind.blind(root.slice(0, 31), "record", "a", "b") == "")
	t.check("shape: wrong length", not PKeySyncBlind.is_blinded_name("x:abc"))
	t.check("shape: no prefix", not PKeySyncBlind.is_blinded_name(String(rows[0]["blinded"]).substr(2)))
	t.check("shape: trailing newline", not PKeySyncBlind.is_blinded_name(String(rows[0]["blinded"]) + "\n"))


## The kid: the hkdf row, a recovery blob row's `kidHex` for its expected root, and the kid in the
## header of an envelope row (byte 1..17) for its root.
func _kid(t: PKeyTestContext, d: Dictionary) -> void:
	var n := 0
	for c in d["recoveryCodeCases"]:
		if c["kind"] == "blob" and c["expectRootHex"] != null:
			n += 1
			t.check("kid of blob %s" % c["id"], PKeySyncHkdf.derive_kid(_hex(c["expectRootHex"])).hex_encode() == c["kidHex"])
	for c in d["envelopeCases"]:
		if c.has("rootHex") and c["rootHex"] is String and c.get("envelopeHex") is String:
			var env := _hex(c["envelopeHex"])
			if env.size() >= 17 and env[0] == 1:
				var want := PKeySyncHkdf.derive_kid(_hex(c["rootHex"]))
				if want == env.slice(1, 17):
					n += 1
	t.check("kid rows checked", n >= 3, str(n))


func _canonical(t: PKeyTestContext, rows: Array) -> void:
	for c in rows:
		var r: Dictionary
		if c.has("special"):
			var x: float = {"NaN": NAN, "Infinity": INF, "-Infinity": -INF}[c["special"]]
			r = {"ok": PKeySyncCanonicalJson.format_number(x) != null}
			if r["ok"]:
				r["canonical"] = "?"
			var v := PKeySyncCanonicalJson.canonicalize_value(x)
			t.check("canonical %s (value path) refuses" % c["id"], not v["ok"])
		else:
			r = PKeySyncCanonicalJson.canonicalize_text(c["inputJson"])
		var e: Dictionary = c["expect"]
		if e["result"] == "ok":
			t.check("canonical %s" % c["id"], r["ok"] and r["canonical"] == e["canonical"],
					str(r.get("canonical", r.get("error"))))
			if r["ok"]:
				t.check("canonical %s bytes are the UTF-8 text" % c["id"], r["bytes"] == String(e["canonical"]).to_utf8_buffer())
		else:
			t.check("canonical %s is refused" % c["id"], not r["ok"], str(r))


func _recovery(t: PKeyTestContext, rows: Array) -> void:
	var codes := 0
	var parses := 0
	for c in rows:
		if c["kind"] == "code":
			codes += 1
			var code := _hex(c["codeHex"])
			t.check("recovery %s encodes" % c["id"], PKeySyncRecoveryCode.encode(code) == c["text"], PKeySyncRecoveryCode.encode(code))
			var back: Variant = PKeySyncRecoveryCode.parse(c["text"])
			t.check("recovery %s parses back" % c["id"], back is PackedByteArray and (back as PackedByteArray).hex_encode() == c["codeHex"])
		elif c["kind"] == "parse":
			parses += 1
			var got: Variant = PKeySyncRecoveryCode.parse(c["input"])
			if c["expectCodeHex"] == null:
				t.check("recovery %s is refused" % c["id"], got == null)
			else:
				t.check("recovery %s parses" % c["id"], got is PackedByteArray and (got as PackedByteArray).hex_encode() == c["expectCodeHex"])
	t.check("recovery rows ran", codes >= 4 and parses >= 11, "%d code, %d parse" % [codes, parses])
	var fresh := PKeySyncRecoveryCode.new_code()
	t.check("new_code is 16 bytes", fresh.size() == 16)
	var text := PKeySyncRecoveryCode.encode(fresh)
	var again: Variant = PKeySyncRecoveryCode.parse(text)
	t.check("a fresh code round-trips", again is PackedByteArray and again == fresh)
	t.check("encode refuses a short code", PKeySyncRecoveryCode.encode(fresh.slice(0, 15)) == "")
	# One flipped character fails the checksum; a non-ASCII character is refused.
	var bad := text.substr(0, 1) + ("1" if text[1] != "1" else "2") + text.substr(2)
	t.check("a changed character is refused", PKeySyncRecoveryCode.parse(bad) == null)
	t.check("a non-ASCII character is refused", PKeySyncRecoveryCode.parse(text + "\u00e9") == null)


## What the corpus does not pin: the integer rule, exact rounding at the edges of the double range
## (the engine's own parser reads 5e-324 as 0), and deep or malformed text.
func _extras(t: PKeyTestContext) -> void:
	for pair in [["1e-310", "000012688b70e62b"], ["2.5e-320", "00000000000013c4"],
			["4.9406564584124654e-324", "0000000000000001"], ["2.4703282292062328e-324", "0000000000000001"],
			["2.4703282292062327e-324", "0000000000000000"], ["2.2250738585072011e-308", "000fffffffffffff"],
			["0.1", "3fb999999999999a"], ["8.5e-5", "3f164840e1719f80"],
			["1.7976931348623158e308", "7fefffffffffffff"]]:
		var s: String = pair[0]
		var mant := s.split("e")[0]
		var ex := int(s.split("e")[1]) if s.contains("e") else 0
		var dot := mant.find(".")
		var digits := mant.replace(".", "").lstrip("0")
		var e10 := ex - (0 if dot < 0 else mant.length() - dot - 1)
		var x := PKeySyncCanonicalJson.parse_decimal(digits, e10)
		var b := PackedByteArray()
		b.resize(8)
		b.encode_double(0, x)
		t.check("exact rounding of %s" % s, b.decode_u64(0) == ("0x" + pair[1]).hex_to_int(), "%x" % b.decode_u64(0))
	t.check("1.7976931348623159e308 overflows and is refused", not PKeySyncCanonicalJson.canonicalize_text("1.7976931348623159e308")["ok"])
	t.check("1e400 is refused", not PKeySyncCanonicalJson.canonicalize_text("1e400")["ok"])
	t.check("1e-400 is 0", PKeySyncCanonicalJson.canonicalize_text("1e-400").get("canonical") == "0")
	t.check("1e99999999999 is refused", not PKeySyncCanonicalJson.canonicalize_text("1e99999999999")["ok"])
	t.check("1e-99999999999 is 0", PKeySyncCanonicalJson.canonicalize_text("1e-99999999999").get("canonical") == "0")
	for bad in ["[1,]", "{\"a\":1,}", "01", "1.", ".5", "+1", "[1 2]", "\"a", "\"\\x\"", "\"\t\"", "nul", "[1]x", "", "{\"a\":1,\"a\":2}", "{1:2}", "\"\\u12\""]:
		t.check("strict: %s is refused" % bad.c_escape(), not PKeySyncCanonicalJson.canonicalize_text(bad)["ok"])
	t.check("strict: white space is dropped", PKeySyncCanonicalJson.canonicalize_text(" { \"b\" : [ 1 , 2 ] ,\n \"a\" : null } ").get("canonical") == "{\"a\":null,\"b\":[1,2]}")
	t.check("nesting past the limit is refused", not PKeySyncCanonicalJson.canonicalize_text("[".repeat(70) + "]".repeat(70))["ok"])
	t.check("nesting at the limit is accepted", PKeySyncCanonicalJson.canonicalize_text("[".repeat(64) + "]".repeat(64))["ok"])
	# The value path: an integer over 2^53 is refused, 2^53 itself is not.
	t.check("int 2^53 is accepted", PKeySyncCanonicalJson.canonicalize_value(9007199254740992).get("canonical") == "9007199254740992")
	t.check("int 2^53 + 1 is refused", not PKeySyncCanonicalJson.canonicalize_value(9007199254740993)["ok"])
	t.check("int -(2^53 + 1) is refused", not PKeySyncCanonicalJson.canonicalize_value(-9007199254740993)["ok"])
	t.check("an int and an integral float spell the same", PKeySyncCanonicalJson.canonicalize_value([3, 3.0, -0.0]).get("canonical") == "[3,3,0]")
	t.check("a built object is sorted", PKeySyncCanonicalJson.canonicalize_value({"b": 1, "a": [true, null, "x\u00e9"]}).get("canonical") == "{\"a\":[true,null,\"x\u00e9\"],\"b\":1}")
	t.check("an astral character stays raw", PKeySyncCanonicalJson.canonicalize_value("\U0001F600").get("canonical") == "\"\U0001F600\"")
	t.check("NaN value is refused", not PKeySyncCanonicalJson.canonicalize_value(NAN)["ok"])
	t.check("a non-string key is refused", not PKeySyncCanonicalJson.canonicalize_value({1: 2})["ok"])


func _hex(s: String) -> PackedByteArray:
	return s.hex_decode()
