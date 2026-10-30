extends RefCounted
# Cloud Sync end-to-end primitives over the generator-owned mirror of conformance/corpus/v2/
# sync-vectors.json (WIRE-CONTRACT-V5 §13.10, U-40.1): the the settings-size sections (primitives, AES-256-GCM, the
# envelope, HPKE, wrap, recovery, adopt, U-40.5) and, from U-23.G1, the chunker, the chunk objects and
# the manifest (cdcCases, cdcEditCases, deltaCases, chunkCases, manifestCases). Sections that need the
# file stream or the transfer planner are typed N/A below, by name, and the suite
# fails on a section that is in neither list, so a new corpus section is noticed.

const VECTORS := "res://tests/corpus/v2/sync-vectors.json"

## Implemented sections.
const RUN := ["hkdfCases", "blindCases", "canonicalJsonCases", "recoveryCodeCases", "envelopeCases", "hpkeAnchor", "wrapCases", "adoptCases",
		"cdcCases", "cdcEditCases", "deltaCases", "chunkCases", "manifestCases"]
## Typed N/A: the section needs a primitive this slice does not ship.
const NOT_APPLICABLE := {
	"transferPlanCases": "needs the transfer planner (U-23.G2)",
	"fileStreamCases": "needs the file stream (U-23.G2); GDScript AES-GCM refuses over 64 KiB until the 1 MiB-per-call cap (D-10)",
}
## Members of the file that are not sections.
const META := ["syncVectorsVersion", "description", "constants", "ringId"]


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var j := JSON.new()
	# 4.4's parser drops a U+0000 escape (newer engines read it as U+FFFD); spell it as U+FFFD
	# so every engine hands _name_of the same text.
	var nul_escape := RegEx.create_from_string("(?<!\\\\)((?:\\\\\\\\)*)\\\\u0000")
	var text := nul_escape.sub(FileAccess.get_file_as_string(VECTORS), "$1\\uFFFD", true)
	if not t.check("vectors parse", j.parse(text) == OK and j.data is Dictionary, VECTORS):
		return true
	var d: Dictionary = j.data
	t.check("syncVectorsVersion is 1", d.get("syncVectorsVersion") == 1)
	_constants = d["constants"]
	for k in d:
		if META.has(k) or RUN.has(k):
			continue
		if NOT_APPLICABLE.has(k):
			t.info("N/A %s: %s" % [k, NOT_APPLICABLE[k]])
		else:
			t.check("section %s is run or typed N/A" % k, false)
	_hkdf(t, d["hkdfCases"])
	_blind(t, d["blindCases"])
	_kid(t, d)
	_canonical(t, d["canonicalJsonCases"])
	_recovery(t, d["recoveryCodeCases"])
	_extras(t)
	_number_spelling(t)
	_aes_gcm(t, d)
	_envelope(t, d["envelopeCases"])
	_hpke_anchor(t, d["hpkeAnchor"]["vector"])
	_wrap(t, d["wrapCases"])
	_adopt(t, d["adoptCases"])
	_recovery_blobs(t, d["recoveryCodeCases"])
	_u405_extras(t)
	_cdc(t, d["cdcCases"])
	_chunks(t, d["chunkCases"])
	_manifest(t, d["manifestCases"])
	_cdc_edit(t, d["cdcEditCases"], d["deltaCases"])
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
	var got: Variant = null
	match label:
		"kid": got = PKeySyncHkdf.derive_kid(ikm)
		"coll": got = PKeySyncHkdf.derive_coll_key(ikm, name)
		"names": got = PKeySyncHkdf.derive_names_key(ikm)
		"chunk-id": got = PKeySyncHkdf.derive_chunk_id_key(ikm, name)
		"value": got = PKeySyncHkdf.derive_value_key(ikm, salt)
		"file": got = PKeySyncHkdf.derive_file_key(ikm, salt)
		"chunk": got = PKeySyncHkdf.derive_chunk_key(ikm, salt)
		"recovery": got = PKeySyncHkdf.derive_recovery_key(ikm, salt.get_string_from_utf8())
		"adopt": got = PKeySyncHkdf.derive_adopt_key(ikm)
	return got


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


## The ECMAScript spelling of doubles, pinned by bit pattern so it must not depend on how the
## engine prints floats (4.4 prints six digits and no denormals).
func _number_spelling(t: PKeyTestContext) -> void:
	var rows := {
		0x0000000000000001: "5e-324",
		0x0000000000000002: "1e-323",
		0x000FFFFFFFFFFFFF: "2.225073858507201e-308",
		0x7FEFFFFFFFFFFFFF: "1.7976931348623157e+308",
		0x3FB999999999999A: "0.1",
		0x4340000000000000: "9007199254740992",
		0x3CA0000000000000: "1.1102230246251565e-16",
		0x419D6F34547DF3B6: "123456789.123",
		0x40FE240000000000: "123456",
	}
	for bits in rows:
		var b := PackedByteArray()
		b.resize(8)
		b.encode_u64(0, bits)
		var got: Variant = PKeySyncCanonicalJson.format_number(b.decode_double(0))
		t.check("number spelling %x" % bits, got == rows[bits], "%s != %s" % [got, rows[bits]])


func _hex(s: String) -> PackedByteArray:
	return s.hex_decode()


## Known answers for AES-256-GCM: NIST SP 800-38D test cases 13 to 16 (the original GCM spec set), the
## corpus's RFC 9180 anchor row, and generated rows (cryptography 49) over awkward lengths.
var _gcm_nist := [
	["tc13", "00".repeat(32), "00".repeat(12), "", "", "", "530f8afbc74536b9a963b4f1c4cb738b"],
	["tc14", "00".repeat(32), "00".repeat(12), "00".repeat(16), "", "cea7403d4d606b6e074ec5d3baf39d18", "d0d1c8a799996bf0265b98b5d48ab919"],
	["tc15", "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308", "cafebabefacedbaddecaf888",
		"d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255",
		"", "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad", "b094dac5d93471bdec1a502270e3cc6c"],
	["tc16", "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308", "cafebabefacedbaddecaf888",
		"d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
		"feedfacedeadbeeffeedfacedeadbeefabaddad2", "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662", "76fc6ece0f4e1768cddf8853bb2d551b"],
]
## [row, plaintext length, aad length, sha256 of ciphertext || tag]; the inputs are the generators below.
const GCM_GENERATED := [
	[0, 0, 0, "2513b3a3bcdbf6228d253f37cae32fa31bdbe38041721f06fca874fab1bd9660"],
	[1, 0, 20, "27c611d04d02bd526a5c557dea8640ed902f312eec60cd0175ffa41f37036894"],
	[2, 1, 0, "284e7099b258f18af75c0860fbe6155f3d58213570128bdb012d10a23358c974"],
	[3, 15, 3, "c881d4d2e8a2546de5d14e32a46f9faf954e860486c1e8c1159eec80bea6c32d"],
	[4, 16, 16, "3acefc24bba9db140addd6bbae4ecd01eb2ae9e68422e09de325c4943652b170"],
	[5, 17, 17, "583a26f5406615b6b9d18789804aa2d66e564ee274054aebb7ae88640bf8ef2f"],
	[6, 100, 0, "dccfc53f97d18418d790f7b9c1bda95b1872cc4a00594fecf90be8d3bfb9970e"],
	[7, 8192, 13, "c786d39a3561125d5c60f3cc4639d7c293e0e39c4df4ec826d8be6ec74158999"],
	[8, 65536, 0, "bf67f08359cf5a0b4d607e9e985e337f32920a5351cdbec136c2a308be7cfc50"],
]


func _gen(n: int, mul: int, shift: int, add: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	for j in n:
		b[j] = (add + j * mul + ((j >> shift) if shift > 0 else 0) ) & 255
	return b


func _aes_gcm(t: PKeyTestContext, d: Dictionary) -> void:
	for c in _gcm_nist:
		var key := _hex(c[1])
		var nonce := _hex(c[2])
		var pt := _hex(c[3])
		var aad := _hex(c[4])
		var want := _hex(c[5] + c[6])
		t.check("gcm %s seals" % c[0], PKeySyncAesGcm.seal(key, nonce, pt, aad) == want)
		var opened: Variant = PKeySyncAesGcm.open(key, nonce, want, aad)
		t.check("gcm %s opens" % c[0], opened != null and (opened as PackedByteArray) == pt)
	var e: Dictionary = d["hpkeAnchor"]["vector"]
	var enc: Dictionary = e["encryption"]
	var sealed := PKeySyncAesGcm.seal(_hex(e["key"]), _hex(enc["nonce"]), _hex(enc["pt"]), _hex(enc["aad"]))
	t.check("gcm RFC 9180 anchor seals", sealed.hex_encode() == enc["ct"], enc["ct"])
	var rfc_open: Variant = PKeySyncAesGcm.open(_hex(e["key"]), _hex(enc["nonce"]), sealed, _hex(enc["aad"]))
	t.check("gcm RFC 9180 anchor opens", rfc_open != null and (rfc_open as PackedByteArray) == _hex(enc["pt"]))
	for r in GCM_GENERATED:
		var i: int = r[0]
		var key := _gen(32, 1, 0, i * 7)
		var nonce := _gen(12, 3, 0, i * 13)
		var aad := _gen(r[2], 5, 0, i)
		var pt := _gen(r[1], 31, 3, i)
		var out := PKeySyncAesGcm.seal(key, nonce, pt, aad)
		t.check("gcm generated %d (%d bytes, aad %d)" % [i, r[1], r[2]], _sha(out) == r[3])
		var back: Variant = PKeySyncAesGcm.open(key, nonce, out, aad)
		t.check("gcm generated %d round-trips" % i, back != null and (back as PackedByteArray) == pt)
	# Refusals and tampering.
	var k := _gen(32, 1, 0, 9)
	var n := _gen(12, 1, 0, 2)
	var m := "hello".to_utf8_buffer()
	var s := PKeySyncAesGcm.seal(k, n, m, PackedByteArray([1]))
	t.check("tamper: ciphertext", PKeySyncAesGcm.open(k, n, _flip(s, 0), PackedByteArray([1])) == null)
	t.check("tamper: tag", PKeySyncAesGcm.open(k, n, _flip(s, s.size() - 1), PackedByteArray([1])) == null)
	t.check("tamper: aad", PKeySyncAesGcm.open(k, n, s, PackedByteArray([2])) == null)
	t.check("tamper: missing aad", PKeySyncAesGcm.open(k, n, s) == null)
	t.check("tamper: nonce", PKeySyncAesGcm.open(k, _flip(n, 11), s, PackedByteArray([1])) == null)
	t.check("tamper: key", PKeySyncAesGcm.open(_flip(k, 0), n, s, PackedByteArray([1])) == null)
	t.check("a short input is refused", PKeySyncAesGcm.open(k, n, s.slice(0, 15), PackedByteArray([1])) == null)
	t.check("a 31-byte key is refused", PKeySyncAesGcm.seal(k.slice(0, 31), n, m).is_empty())
	t.check("a 16-byte key is refused", PKeySyncAesGcm.seal(k.slice(0, 16), n, m).is_empty())
	t.check("an 11-byte nonce is refused", PKeySyncAesGcm.seal(k, n.slice(0, 11), m).is_empty())
	t.check("a 13-byte nonce is refused", PKeySyncAesGcm.seal(k, _gen(13, 1, 0, 0), m).is_empty())
	t.check("65537 bytes are refused", PKeySyncAesGcm.seal(k, n, _gen(65537, 1, 0, 0)).is_empty())
	t.check("65536 bytes are accepted", PKeySyncAesGcm.seal(k, n, _gen(65536, 1, 0, 0)).size() == 65536 + 16)
	t.check("an open of 65537 bytes is refused", PKeySyncAesGcm.open(k, n, _gen(65537 + 16, 1, 0, 0)) == null)
	t.check("an empty message opens to empty", (PKeySyncAesGcm.open(k, n, PKeySyncAesGcm.seal(k, n, PackedByteArray())) as PackedByteArray).is_empty())
	_aes_gcm_timing(t, k, n)


func _flip(b: PackedByteArray, at: int) -> PackedByteArray:
	var c := b.duplicate()
	c[at] ^= 1
	return c


func _sha(b: PackedByteArray) -> String:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update(b)
	return h.finish().hex_encode()


## Timing (informational, never asserted) and a constant-time sanity check of the tag compare: the
## best of several runs for a mismatch in the first byte and in the last must agree within a factor
## of 1.5 (a wide band: this is a smoke check on a shared machine, not a dudect run).
func _aes_gcm_timing(t: PKeyTestContext, k: PackedByteArray, n: PackedByteArray) -> void:
	var pt := _gen(8192, 31, 3, 1)
	var aad := _gen(16, 1, 0, 0)
	var seal_best := 1 << 60
	var open_best := 1 << 60
	var sealed := PackedByteArray()
	for _i in 3:
		var t0 := Time.get_ticks_usec()
		sealed = PKeySyncAesGcm.seal(k, n, pt, aad)
		seal_best = mini(seal_best, Time.get_ticks_usec() - t0)
		t0 = Time.get_ticks_usec()
		var o: Variant = PKeySyncAesGcm.open(k, n, sealed, aad)
		open_best = mini(open_best, Time.get_ticks_usec() - t0)
		t.check("8 KiB opens", o != null)
	t.info("aes-gcm 8 KiB: seal %.1f ms, open %.1f ms (best of 3)" % [seal_best / 1000.0, open_best / 1000.0])
	var a := _gen(4096, 1, 0, 0)
	var first := a.duplicate()
	first[0] ^= 1
	var last := a.duplicate()
	last[4095] ^= 1
	var best_first := 1 << 60
	var best_last := 1 << 60
	for _r in 7:
		var t1 := Time.get_ticks_usec()
		for _i in 20:
			PKeySyncAesGcm.equal_constant_time(a, first)
		best_first = mini(best_first, Time.get_ticks_usec() - t1)
		t1 = Time.get_ticks_usec()
		for _i in 20:
			PKeySyncAesGcm.equal_constant_time(a, last)
		best_last = mini(best_last, Time.get_ticks_usec() - t1)
	var ratio := float(maxi(best_first, best_last)) / float(maxi(1, mini(best_first, best_last)))
	t.info("tag compare, 4096 bytes x20: mismatch first %d us, last %d us, ratio %.3f" % [best_first, best_last, ratio])
	t.check("tag compare time does not depend on the mismatch position", ratio < 1.5, "ratio %.3f" % ratio)


# ── U-40.5: envelope, HPKE, wrap, recovery blob, adopt ───────────────────────────────────────────

## A name from the vectors as UTF-8: the engine's JSON turns the corpus's U+0000 into U+FFFD, and the
## vectors have no real U+FFFD in a name, so the replacement character reads as NUL here.
func _name_of(s: String) -> PackedByteArray:
	var b := s.to_utf8_buffer()
	var out := PackedByteArray()
	var i := 0
	while i < b.size():
		if i + 2 < b.size() and b[i] == 0xEF and b[i + 1] == 0xBF and b[i + 2] == 0xBD:
			out.append(0)
			i += 3
		else:
			out.append(b[i])
			i += 1
	return out


func _envelope(t: PKeyTestContext, rows: Array) -> void:
	var t0 := Time.get_ticks_usec()
	for c in rows:
		var root := _hex(c["rootHex"])
		var env := _hex(c["envelopeHex"])
		var want: Dictionary = c["expect"]
		if c.has("seal"):
			# An alias case was sealed under the source name the reader accepts (expect.name).
			var again := PKeySyncEnvelope.seal_value(root, c["collection"], _name_of(want["name"]), c["seal"]["value"], _hex(c["seal"]["saltHex"]))
			t.check("envelope %s seals to the vector" % c["id"], again == env)
		var aliases: Array = []
		for a in c["aliases"]:
			aliases.append(_name_of(a))
		var got := PKeySyncEnvelope.open_value(root, c["collection"], _name_of(c["name"]), env, aliases)
		if want["result"] == "ok":
			var same: bool = got["ok"] and got["name_bytes"] == _name_of(want["name"]) and PKeySyncCanonicalJson.canonicalize_value(got["value"]).get("canonical") == PKeySyncCanonicalJson.canonicalize_value(want["value"]).get("canonical")
			t.check("envelope %s opens" % c["id"], same)
			if got["ok"]:
				var any := PKeySyncEnvelope.open_value_any_name(root, c["collection"], env)
				t.check("envelope %s opens under any name" % c["id"], any["ok"] and any["name_bytes"] == got["name_bytes"])
		else:
			t.check("envelope %s is refused as %s" % [c["id"], want["reason"]], not got["ok"] and got["reason"] == want["reason"], str(got.get("reason")))
	t.info("envelope section: %d rows in %.1f ms" % [rows.size(), (Time.get_ticks_usec() - t0) / 1000.0])
	var consts: Dictionary = {"envelopeOverheadBytes": PKeySyncEnvelope.OVERHEAD_BYTES, "envelopeFixedBytes": PKeySyncEnvelope.FIXED_BYTES, "paddingBlockBytes": PKeySyncEnvelope.PAD_BLOCK}
	var same_consts := true
	for k in consts:
		same_consts = same_consts and int(_constants.get(k, -1)) == consts[k]
	t.check("envelope constants match the corpus", same_consts)


var _constants := {}


func _hpke_anchor(t: PKeyTestContext, v: Dictionary) -> void:
	var enc: Dictionary = v["encryption"]
	var info := _hex(v["info"])
	var sealed := PKeySyncHpke.seal(_hex(v["pkRm"]), info, _hex(enc["aad"]), _hex(enc["pt"]), _hex(v["skEm"]))
	t.check("hpke anchor seals (enc)", not sealed.is_empty() and (sealed["enc"] as PackedByteArray).hex_encode() == v["enc"])
	t.check("hpke anchor seals (ct)", not sealed.is_empty() and (sealed["ct"] as PackedByteArray).hex_encode() == enc["ct"])
	t.check("hpke anchor public key of skRm", PKeyCurve25519.x25519_public(_hex(v["skRm"])).hex_encode() == v["pkRm"])
	var opened: Variant = PKeySyncHpke.open(PKeySyncHpke.dh_of_private(_hex(v["skRm"])), _hex(v["pkRm"]), _hex(v["enc"]), info, _hex(enc["aad"]), _hex(enc["ct"]))
	t.check("hpke anchor opens", opened != null and (opened as PackedByteArray).hex_encode() == enc["pt"])
	t.check("hpke anchor refuses another aad", PKeySyncHpke.open(PKeySyncHpke.dh_of_private(_hex(v["skRm"])), _hex(v["pkRm"]), _hex(v["enc"]), info, _hex(enc["aad"] + "00"), _hex(enc["ct"])) == null)
	t.check("hpke anchor refuses another info", PKeySyncHpke.open(PKeySyncHpke.dh_of_private(_hex(v["skRm"])), _hex(v["pkRm"]), _hex(v["enc"]), _hex(v["info"] + "00"), _hex(enc["aad"]), _hex(enc["ct"])) == null)
	# Timing of one seal and one open of a wrapped root (informational).
	var seal_best := 1 << 60
	var open_best := 1 << 60
	var priv := _gen(32, 3, 0, 5)
	var pub := PKeyCurve25519.x25519_public(priv)
	var dh := PKeySyncHpke.dh_of_private(priv)
	for _i in 3:
		var t0 := Time.get_ticks_usec()
		var r := PKeySyncHpke.seal(pub, info, PackedByteArray([1]), _gen(32, 1, 0, 0))
		seal_best = mini(seal_best, Time.get_ticks_usec() - t0)
		t0 = Time.get_ticks_usec()
		var o: Variant = PKeySyncHpke.open(dh, pub, r["enc"], info, PackedByteArray([1]), r["ct"])
		open_best = mini(open_best, Time.get_ticks_usec() - t0)
		t.check("hpke round trip", o != null)
	t.info("hpke wrap of a root: seal %.1f ms, open %.1f ms (best of 3, X25519 in GDScript)" % [seal_best / 1000.0, open_best / 1000.0])


func _wrap(t: PKeyTestContext, rows: Array) -> void:
	for c in rows:
		var priv := _hex(c["recipientPrivateHex"])
		var pub := PKeyCurve25519.x25519_public(priv)
		var w: Dictionary = c["wrap"]
		var kid := _hex(c["kidHex"])
		if c.has("seal"):
			var s: Dictionary = c["seal"]
			t.check("wrap %s recipient public" % c["id"], pub.hex_encode() == s["recipientPublicHex"])
			t.check("wrap %s info" % c["id"], PKeySyncWrap.wrap_info(c["product"], c["deviceId"], c["ringId"], int(c["epoch"])).hex_encode() == s["infoHex"])
			var again := PKeySyncWrap.wrap_root(pub, c["product"], c["deviceId"], c["ringId"], int(c["epoch"]), kid, _hex(s["rootHex"]), _hex(s["ephemeralPrivateHex"]))
			t.check("wrap %s seals to the vector" % c["id"], not again.is_empty() and again["kem"] == w["kem"] and (again["enc"] as PackedByteArray).hex_encode() == w["encHex"] and (again["ct"] as PackedByteArray).hex_encode() == w["ctHex"])
		var got: Variant = PKeySyncWrap.unwrap_root(PKeySyncHpke.dh_of_private(priv), pub, c["product"], c["deviceId"], c["ringId"], int(c["epoch"]), kid, int(w["kem"]), _hex(w["encHex"]), _hex(w["ctHex"]))
		if c["expectRootHex"] == null:
			t.check("wrap %s is refused" % c["id"], got == null)
		else:
			t.check("wrap %s opens" % c["id"], got != null and (got as PackedByteArray).hex_encode() == c["expectRootHex"])


func _adopt(t: PKeyTestContext, rows: Array) -> void:
	for c in rows:
		var cur := _hex(c["currentRootHex"])
		var kid := _hex(c["kidHex"])
		if c.has("seal"):
			var again := PKeySyncWrap.seal_adopt(cur, c["fromRingId"], int(c["epoch"]), kid, _hex(c["seal"]["oldRootHex"]), _hex(c["seal"]["nonceHex"]))
			t.check("adopt %s seals to the vector" % c["id"], again.hex_encode() == c["blobHex"])
		var got: Variant = PKeySyncWrap.open_adopt(cur, c["fromRingId"], int(c["epoch"]), kid, _hex(c["blobHex"]))
		if c["expectRootHex"] == null:
			t.check("adopt %s is refused" % c["id"], got == null)
		else:
			t.check("adopt %s opens" % c["id"], got != null and (got as PackedByteArray).hex_encode() == c["expectRootHex"])


func _recovery_blobs(t: PKeyTestContext, rows: Array) -> void:
	for c in rows:
		if c["kind"] != "blob":
			continue
		var code := _hex(c["codeHex"])
		var kid := _hex(c["kidHex"])
		if c.has("seal"):
			var again := PKeySyncWrap.wrap_recovery(code, c["ringId"], int(c["epoch"]), kid, _hex(c["seal"]["rootHex"]), _hex(c["seal"]["nonceHex"]))
			t.check("recovery blob %s seals to the vector" % c["id"], again.hex_encode() == c["blobHex"])
		var got: Variant = PKeySyncWrap.unwrap_recovery(code, c["ringId"], int(c["epoch"]), kid, _hex(c["blobHex"]))
		if c["expectRootHex"] == null:
			t.check("recovery blob %s is refused" % c["id"], got == null)
		else:
			t.check("recovery blob %s opens" % c["id"], got != null and (got as PackedByteArray).hex_encode() == c["expectRootHex"])


func _u405_extras(t: PKeyTestContext) -> void:
	var root := _gen(32, 7, 0, 1)
	# A fresh random salt per seal (S9): two seals of one value differ, and both open.
	var a := PKeySyncEnvelope.seal_value(root, "$settings", "theme", "dark")
	var b := PKeySyncEnvelope.seal_value(root, "$settings", "theme", "dark")
	t.check("two seals of one value differ (fresh salt)", not a.is_empty() and a != b)
	t.check("a sealed envelope has the contract size", a.size() == PKeySyncEnvelope.FIXED_BYTES + 64)
	t.check("a fresh envelope opens", PKeySyncEnvelope.open_value(root, "$settings", "theme", a)["ok"])
	t.check("a bad salt length is refused", PKeySyncEnvelope.seal_value(root, "$settings", "theme", "x", PackedByteArray([1])).is_empty())
	t.check("a bad root is refused", PKeySyncEnvelope.seal_value(root.slice(0, 31), "$settings", "theme", "x").is_empty())
	t.check("NaN is refused", PKeySyncEnvelope.seal_value(root, "$settings", "theme", NAN).is_empty())
	var m := PKeySyncEnvelope.seal_value(root, "$settings", PKeySyncEnvelope.member_name("inv", "gold"), 3)
	t.check("a merge member opens under its name", PKeySyncEnvelope.open_value(root, "$settings", PKeySyncEnvelope.member_name("inv", "gold"), m)["ok"])
	t.check("a merge member does not open under its member name alone", PKeySyncEnvelope.open_value(root, "$settings", "gold", m).get("reason") == "name")
	# Hostile wraps (S9: the all-zero DH and the enc length).
	var priv := _gen(32, 3, 0, 5)
	var pub := PKeyCurve25519.x25519_public(priv)
	t.check("a wrap to a low-order key is refused", PKeySyncWrap.wrap_root(PackedByteArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "p", "d", "r", 1, _gen(16, 1, 0, 0), root).is_empty())
	t.check("a wrap with epoch 2^32 is refused", PKeySyncWrap.wrap_root(pub, "p", "d", "r", 4294967296, _gen(16, 1, 0, 0), root).is_empty())
	var w := PKeySyncWrap.wrap_root(pub, "p", "d", "r", 1, _gen(16, 1, 0, 0), root)
	var back: Variant = PKeySyncWrap.unwrap_root(PKeySyncHpke.dh_of_private(priv), pub, "p", "d", "r", 1, _gen(16, 1, 0, 0), 32, w["enc"], w["ct"])
	t.check("a fresh wrap round-trips", back != null and (back as PackedByteArray) == root)
	t.check("a 33-byte enc is refused", PKeySyncHpke.open(PKeySyncHpke.dh_of_private(priv), pub, (w["enc"] as PackedByteArray) + PackedByteArray([0]), PKeySyncWrap.wrap_info("p", "d", "r", 1), _gen(16, 1, 0, 0), w["ct"]) == null)
	# AES-GCM (review N4): AAD over the limit, a wrong tag on an empty message, and the empty message.
	var k := _gen(32, 1, 0, 9)
	var n := _gen(12, 1, 0, 2)
	t.check("an AAD over 64 KiB is refused by seal", PKeySyncAesGcm.seal(k, n, PackedByteArray(), _gen(65537, 1, 0, 0)).is_empty())
	t.check("an AAD over 64 KiB is refused by open", PKeySyncAesGcm.open(k, n, PKeySyncAesGcm.seal(k, n, PackedByteArray()), _gen(65537, 1, 0, 0)) == null)
	var e := PKeySyncAesGcm.seal(k, n, PackedByteArray())
	var bad := e.duplicate()
	bad[0] ^= 1
	t.check("a wrong tag on an empty message is refused", PKeySyncAesGcm.open(k, n, bad) == null)
	var ok_empty: Variant = PKeySyncAesGcm.open(k, n, e)
	t.check("an empty message opens to an empty array, not null", ok_empty != null and (ok_empty as PackedByteArray).is_empty())


## The deterministic bytes of a vector row: SHA-256 counter blocks `sha256(prefix + label + u32be(n))`.
func _counter_bytes(prefix: String, label: String, length: int) -> PackedByteArray:
	var out := PackedByteArray()
	out.resize(length)
	var at := 0
	var n := 0
	while at < length:
		var ctr := PackedByteArray()
		ctr.resize(4)
		ctr.encode_u32(0, n)
		var swapped := PackedByteArray([ctr[3], ctr[2], ctr[1], ctr[0]])
		var block := PKeySyncHkdf.sha256((prefix + label).to_utf8_buffer() + swapped)
		for i in mini(32, length - at):
			out[at + i] = block[i]
		at += 32
		n += 1
	return out


## The input of a `cdcCases` row (counter blocks, or one repeated byte).
func _cdc_input(i: Dictionary, prefix := "pkey-sync vector cdc ") -> PackedByteArray:
	if i["kind"] == "byte":
		var b := PackedByteArray()
		b.resize(int(i["length"]))
		b.fill(int(i["value"]))
		return b
	return _counter_bytes(prefix, i["label"], int(i["length"]))


func _int_array(a: Array) -> Array:
	var out := []
	for x in a:
		out.append(int(x))
	return out


func _lens_of(data: PackedByteArray, avg: int, piece: int) -> Array:
	var c := PKeySyncCdc.Chunker.new(avg)
	var lens := []
	var at := 0
	while at < data.size():
		for ch in c.push(data.slice(at, at + piece)):
			lens.append((ch as PackedByteArray).size())
		at += piece
	for ch in c.finish():
		lens.append((ch as PackedByteArray).size())
	return lens


func _cdc(t: PKeyTestContext, rows: Array) -> void:
	for c in rows:
		var avg := int(c["avg"])
		var p := PKeySyncCdc.params(avg)
		t.check("cdc %s params" % c["id"], p.get("min") == int(c["min"]) and p.get("max") == int(c["max"]), str(p))
		var input := _cdc_input(c["input"])
		var want := _int_array(c["lens"])
		# Whole, then in awkward pieces: the cuts do not depend on how the input arrives. The big
		# inputs run once in pieces (GDScript scans a megabyte in about a second).
		var pieces := [maxi(input.size(), 1), 65537] if input.size() < (1 << 20) else [65537]
		if input.size() < (1 << 20):
			pieces.append(1000)
		for piece in pieces:
			t.check("cdc %s in pieces of %d" % [c["id"], piece], _lens_of(input, avg, piece) == want)
		t.check("cdc %s lengths add up" % c["id"], want.reduce(func(a, b): return a + b, 0) == input.size())
	t.check("cdc refuses an average that is not a power of two", PKeySyncCdc.params(1000).is_empty())
	t.check("cdc refuses an average under 64", PKeySyncCdc.params(32).is_empty())
	t.check("cdc defaults are 64 KiB, 256 KiB, 1 MiB", PKeySyncCdc.params() == {"avg": 262144, "min": 65536, "max": 1048576})
	var dead := PKeySyncCdc.Chunker.new(100)
	t.check("a chunker with a bad average answers nothing", not dead.valid and dead.push(PackedByteArray([1, 2, 3])).is_empty() and dead.finish().is_empty())
	t.check("the static lengths helper agrees", PKeySyncCdc.lengths(_cdc_input(rows[8]["input"]), int(rows[8]["avg"])) == PackedInt64Array(_int_array(rows[8]["lens"])))


func _chunks(t: PKeyTestContext, rows: Array) -> void:
	for c in rows:
		var root := _hex(c["rootHex"])
		var id: String = c["id"]
		if c["kind"] == "id":
			var plain := _hex(c["plainHex"])
			t.check("chunk %s e2e id" % id, PKeySyncChunks.chunk_id_hex(root, c["collection"], plain) == c["e2eIdHex"])
			t.check("chunk %s server id" % id, PKeySyncChunks.chunk_id_hex(null, c["collection"], plain) == c["serverIdHex"])
			continue
		if c["kind"] == "pair":
			t.check("chunk %s nonces differ" % id, c["rawNonceHex"] != c["zstdNonceHex"])
			for pair in [[c["rawObjectHex"], c["rawNonceHex"], 0], [c["zstdObjectHex"], c["zstdNonceHex"], 1]]:
				var obj := _hex(pair[0])
				t.check("chunk %s codec %d nonce" % [id, pair[2]], obj.slice(2, 14).hex_encode() == pair[1])
				var o := PKeySyncChunks.open(root, c["collection"], _hex(c["idHex"]), obj)
				t.check("chunk %s codec %d opens" % [id, pair[2]], o["ok"] and (o["plain"] as PackedByteArray).hex_encode() == c["plainHex"] and o["codec"] == pair[2])
			continue
		var opened := PKeySyncChunks.open(root, c["collection"], _hex(c["idHex"]), _hex(c["objectHex"]))
		var e: Dictionary = c["expect"]
		if e["result"] == "ok":
			t.check("chunk %s opens" % id, opened["ok"] and (opened["plain"] as PackedByteArray).hex_encode() == e["plainHex"] and opened["codec"] == int(e["codec"]), str(opened.get("reason")))
		else:
			t.check("chunk %s is refused as %s" % [id, e["reason"]], not opened["ok"] and opened["reason"] == e["reason"], str(opened))
		if c.has("seal"):
			var sealed := PKeySyncChunks.seal(root, c["collection"], _hex(c["idHex"]), int(c["seal"]["codec"]), _hex(c["seal"]["bodyHex"]))
			t.check("chunk %s seals to the object" % id, sealed.hex_encode() == c["objectHex"])
	# What the corpus does not pin.
	var root := _gen(32, 5, 0, 1)
	var plain := _gen(3000, 7, 3, 2)
	var cid := PKeySyncChunks.chunk_id(root, "saves", plain)
	var obj := PKeySyncChunks.seal(root, "saves", cid, PKeySyncChunks.CODEC_RAW, plain)
	t.check("a fresh raw chunk round-trips", PKeySyncChunks.open(root, "saves", cid, obj)["ok"])
	t.check("sealing the same chunk twice gives the same object", PKeySyncChunks.seal(root, "saves", cid, PKeySyncChunks.CODEC_RAW, plain) == obj)
	t.check("seal refuses a bad codec", PKeySyncChunks.seal(root, "saves", cid, 2, plain).is_empty())
	t.check("seal refuses a short id", PKeySyncChunks.seal(root, "saves", cid.slice(0, 31), 0, plain).is_empty())
	t.check("seal refuses a short root", PKeySyncChunks.seal(root.slice(0, 31), "saves", cid, 0, plain).is_empty())
	t.check("chunk_id refuses a short root", PKeySyncChunks.chunk_id(root.slice(0, 31), "saves", plain).is_empty())
	t.check("an object under another collection is refused as auth", PKeySyncChunks.open(root, "other", cid, obj).get("reason") == "auth")
	var big := _gen(PKeySyncAesGcm.MAX_BYTES + 1, 3, 0, 1)
	t.check("a body over the AES-GCM cap is not sealed", PKeySyncChunks.seal(root, "saves", PKeySyncChunks.chunk_id(root, "saves", big), 0, big).is_empty())
	var long_obj := PackedByteArray([1, 0])
	long_obj.resize(2 + 12 + PKeySyncAesGcm.MAX_BYTES + 1 + 16)
	long_obj[0] = 1
	t.check("an object over the AES-GCM cap is unsupported, not auth", PKeySyncChunks.open(root, "saves", cid, long_obj).get("reason") == "unsupported")
	t.check("id_bytes reads 64 lowercase hex characters", PKeySyncChunks.id_bytes(cid.hex_encode()) == cid)
	t.check("id_bytes refuses uppercase", PKeySyncChunks.id_bytes(cid.hex_encode().to_upper()) == null)
	t.check("id_bytes refuses a trailing newline", PKeySyncChunks.id_bytes(cid.hex_encode() + "\n") == null)
	t.check("id_bytes refuses a short id", PKeySyncChunks.id_bytes("ab") == null)
	# The zstd content-size reader, past the corpus: single-segment 1-, 2- and 4-byte fields and a
	# frame with no declared size.
	t.check("zstd size, one byte", PKeySyncChunks.zstd_content_size(_hex("28b52ffd2007")) == 7)
	t.check("zstd size, two bytes carry the 256 offset", PKeySyncChunks.zstd_content_size(_hex("28b52ffd600100")) == 256 + 1)
	t.check("zstd size, absent", PKeySyncChunks.zstd_content_size(_hex("28b52ffd000000")) == -1)
	t.check("zstd size, no magic", PKeySyncChunks.zstd_content_size(_hex("00b52ffd2007")) == -1)
	var seen := []
	var short_frame := _hex("28b52ffd2007")
	var short_obj := PKeySyncChunks.seal(root, "saves", cid, 1, short_frame)
	var bad := PKeySyncChunks.open(root, "saves", cid, short_obj, func(_f: PackedByteArray, size: int) -> PackedByteArray:
		seen.append(size)
		return PackedByteArray([1, 2, 3]))
	t.check("a decoder that answers the wrong size is refused as decode", bad.get("reason") == "decode" and seen == [7], str(bad))


func _manifest(t: PKeyTestContext, rows: Array) -> void:
	for c in rows:
		var bytes := _hex(c["manifestHex"])
		var parsed := PKeySyncManifest.parse(bytes)
		var e: Dictionary = c["expect"]
		if e["result"] == "invalid":
			t.check("manifest %s is refused as %s" % [c["id"], e["reason"]], not parsed["ok"] and parsed["reason"] == e["reason"], str(parsed.get("reason")))
			continue
		if not t.check("manifest %s parses" % c["id"], parsed["ok"], str(parsed.get("reason"))):
			continue
		var m: Dictionary = parsed["manifest"]
		t.check("manifest %s plain size" % c["id"], m["plain_size"] == int(e["plainSize"]))
		t.check("manifest %s plain hash" % c["id"], (m["plain_sha256"] as PackedByteArray).hex_encode() == e["plainSha256Hex"])
		var got := []
		for r in m["records"]:
			got.append({"idHex": (r["id"] as PackedByteArray).hex_encode(), "plainLen": r["plain_len"]})
		var want := []
		for r in e["records"]:
			want.append({"idHex": r["idHex"], "plainLen": int(r["plainLen"])})
		t.check("manifest %s records" % c["id"], got == want)
		t.check("manifest %s encodes back to the same bytes" % c["id"], PKeySyncManifest.encode(m) == bytes)
	t.check("manifest encode refuses a short hash", PKeySyncManifest.encode({"plain_size": 0, "plain_sha256": PackedByteArray([1]), "records": []}).is_empty())
	t.check("manifest encode refuses a short id", PKeySyncManifest.encode({"plain_size": 1, "plain_sha256": _gen(32, 1, 0, 0), "records": [{"id": _gen(31, 1, 0, 0), "plain_len": 1}]}).is_empty())


## The edited bytes of a `cdcEditCases` row (the recipe in the file's description).
func _apply_edit(base: PackedByteArray, e: Dictionary) -> PackedByteArray:
	var at := int(e["at"])
	var length := int(e["length"])
	var out := base.slice(0, at)
	if e["op"] != "delete":
		out.append_array(_counter_bytes("pkey-sync vector cdc-edit ", e["label"], length))
	# An insert keeps the tail from `at`; a delete and an overwrite skip `length` bytes.
	out.append_array(base.slice(at if e["op"] == "insert" else at + length))
	return out


func _cdc_edit(t: PKeyTestContext, rows: Array, deltas: Array) -> void:
	var sides := {}
	for c in rows:
		var root := _hex(c["rootHex"])
		var avg := int(c["avg"])
		var base := _cdc_input(c["base"])
		var edited := _apply_edit(base, c["edit"])
		var edit_ids := {}
		for side in [["base", base, "baseLens", "baseIdsHex", "baseManifestHex"], ["edited", edited, "editedLens", "editedIdsHex", "editedManifestHex"]]:
			var buf: PackedByteArray = side[1]
			var chunker := PKeySyncCdc.Chunker.new(avg)
			var chunks := []
			var at := 0
			while at < buf.size():
				chunks.append_array(chunker.push(buf.slice(at, at + 65537)))
				at += 65537
			chunks.append_array(chunker.finish())
			var lens := []
			var ids := []
			for ch in chunks:
				lens.append((ch as PackedByteArray).size())
				ids.append(PKeySyncChunks.chunk_id_hex(root, c["collection"], ch))
			var label := "cdc edit %s %s" % [c["id"], side[0]]
			t.check(label + " lengths", lens == _int_array(c[side[2]]))
			t.check(label + " ids", ids == Array(c[side[3]]))
			var parsed := PKeySyncManifest.parse(_hex(c[side[4]]))
			if not t.check(label + " manifest parses", parsed["ok"], str(parsed.get("reason"))):
				continue
			var m: Dictionary = parsed["manifest"]
			t.check(label + " manifest size and hash", m["plain_size"] == buf.size() and m["plain_sha256"] == PKeySyncHkdf.sha256(buf))
			var m_ids := []
			var m_lens := []
			for r in m["records"]:
				m_ids.append((r["id"] as PackedByteArray).hex_encode())
				m_lens.append(r["plain_len"])
			t.check(label + " manifest records", m_ids == ids and m_lens == lens)
			t.check(label + " manifest encodes back", PKeySyncManifest.encode(m).hex_encode() == c[side[4]])
			edit_ids[side[0]] = ids
		var have := {}
		for id in c["baseIdsHex"]:
			have[id] = true
		var kept := []
		var changed := []
		var edited_ids: Array = c["editedIdsHex"]
		for i in edited_ids.size():
			(kept if have.has(edited_ids[i]) else changed).append(i)
		t.check("cdc edit %s kept and changed indexes" % c["id"], kept == _int_array(c["keptIndexes"]) and changed == _int_array(c["changedIndexes"]))
		sides[c["id"]] = c
	for d in deltas:
		var want_ids := _delta_side(sides, d["want"])
		var have := {}
		for id in _delta_have(sides, d["have"]):
			have[id] = true
		var move := {}
		var bytes := 0
		for r in want_ids:
			if not have.has(r["id"]) and not move.has(r["id"]):
				move[r["id"]] = r["plain_len"]
				bytes += r["plain_len"]
		t.check("delta %s moves the listed chunks" % d["id"], Array(move.keys()) == Array(d["moveIdsHex"]))
		t.check("delta %s moves the listed bytes" % d["id"], bytes == int(d["moveBytes"]))


## The (id, length) records of a delta side, from its manifest.
func _delta_side(rows: Dictionary, w: Dictionary) -> Array:
	var row: Dictionary = rows[w["row"]]
	var parsed := PKeySyncManifest.parse(_hex(row["baseManifestHex"] if w["side"] == "base" else row["editedManifestHex"]))
	var out := []
	for r in parsed["manifest"]["records"]:
		out.append({"id": (r["id"] as PackedByteArray).hex_encode(), "plain_len": r["plain_len"]})
	return out


func _delta_have(rows: Dictionary, h: Dictionary) -> Array:
	if h.has("idsHex"):
		return h["idsHex"]
	var out := []
	for r in _delta_side(rows, h):
		out.append(r["id"])
	return out
