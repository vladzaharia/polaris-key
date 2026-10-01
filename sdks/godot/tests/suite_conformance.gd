extends RefCounted
# @pkey-feature core.verify core.bundle devices.fingerprint
# The Godot conformance runner: every section of the generator-owned corpus mirror
# (res://tests/corpus/v2/cases.json and fingerprint.json, written by `pnpm gen:corpus`; never
# edit them) through the shipped addon, mirroring conformance/runners/node/corpusV2.test.ts and
# fingerprint.test.ts vector for vector. No case id appears here: the corpus decides what is
# tested, and each section ends with a coverage check against its floor.
#
#   jwsCases         PKeyJws.verify              verdict, kid, decoded document
#   licenseDocCases  PKeyVerify (licence)        accept
#   configDocCases   PKeyVerify (config)         accept
#   trustCases       PKeyTrust                   accepted, the merged set, issuedAt
#   clockFloorCases  the reload path + PKeyGate  highWaterMark, effectiveNow, status
#   bundleCases      PKeyBundle.inspect          imports + docs, or the refusing step
#   deviceIds        PKeyDeviceId.from_raw       the derived id (fingerprint.json)
#   vectors          PKeyFingerprint             components and hwid (fingerprint.json)
#   windowsCimCommand / windowsCim / linuxAnchor / ramBuckets
#                    PKeyFingerprint             the §6.1 source rules (fingerprint.json)
#
# Under WIRE-CONTRACT-V3 §10, each string the generator lists in `expect.docNulReplaced` is
# compared in its U+FFFD form, exactly.

const CASES := "res://tests/corpus/v2/cases.json"
const FINGERPRINT := "res://tests/corpus/v2/fingerprint.json"
const CORPUS_VERSION := 2
const FLOORS := {
	"jwsCases": 36,
	"licenseDocCases": 16,
	"configDocCases": 18,
	"trustCases": 11,
	"clockFloorCases": 7,
	"bundleCases": 9,
	"deviceIds": 4,
	"vectors": 6,
	"windowsCim": 17,
	"linuxAnchor": 10,
	"ramBuckets": 13,
}


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var corpus = _load(t, CASES)
	if corpus == null:
		return true
	t.check("corpusVersion", corpus.get("corpusVersion") is float and int(corpus["corpusVersion"]) == CORPUS_VERSION, str(corpus.get("corpusVersion")))
	_jws_cases(t, _section(t, corpus, "jwsCases"))
	await _doc_cases(t, _section(t, corpus, "licenseDocCases"), "licenseDocCases", PKeyClaims.TYP_LICENSE)
	await _doc_cases(t, _section(t, corpus, "configDocCases"), "configDocCases", PKeyClaims.TYP_CONFIG)
	await _trust_cases(t, _section(t, corpus, "trustCases"))
	await _clock_floor_cases(t, _section(t, corpus, "clockFloorCases"))
	await _bundle_cases(t, _section(t, corpus, "bundleCases"))
	var fp = _load(t, FINGERPRINT)
	if fp != null:
		_device_ids(t, _section(t, fp, "deviceIds"))
		_fingerprint_vectors(t, fp)
		_source_rules(t, fp)
	return true


func _load(t: PKeyTestContext, path: String) -> Variant:
	if not t.check("%s present" % path.get_file(), FileAccess.file_exists(path), path):
		return null
	t.info("%s sha256=%s" % [path.get_file(), FileAccess.get_sha256(path)])
	var j := JSON.new()
	var err := j.parse(FileAccess.get_file_as_string(path))
	if not t.check("%s parses" % path.get_file(), err == OK and j.data is Dictionary, "error %d at line %d" % [err, j.get_error_line()]):
		return null
	return j.data


func _section(t: PKeyTestContext, corpus: Dictionary, name: String) -> Array:
	if not t.check("%s present" % name, corpus.get(name) is Array):
		return []
	return corpus[name]


func _coverage(t: PKeyTestContext, name: String, evaluated: int, total: int, ms: float) -> void:
	var floor_n: int = FLOORS[name]
	t.info("%s: %d/%d evaluated in %.1f ms" % [name, evaluated, total, ms])
	t.check("%s coverage" % name, evaluated == total and evaluated >= floor_n, "%d/%d evaluated, floor %d" % [evaluated, total, floor_n])


static func _ms_since(t0: int) -> float:
	return (Time.get_ticks_usec() - t0) / 1000.0


# ── jwsCases (§1–§2) ─────────────────────────────────────────────────────────────────────

func _jws_cases(t: PKeyTestContext, cases: Array) -> void:
	# The comparator must not be vacuous: one extra key makes a document unequal.
	var first_doc = null
	for c in cases:
		if c is Dictionary and c.get("expect") is Dictionary and c["expect"].get("doc") is Dictionary:
			first_doc = c["expect"]["doc"]
			break
	if t.check("comparator has a document to self-check", first_doc is Dictionary):
		var altered: Dictionary = (first_doc as Dictionary).duplicate(true)
		altered["__pkey_comparator_probe__"] = true
		t.check("comparator rejects an extra key", altered != first_doc and (first_doc as Dictionary).duplicate(true) == first_doc)

	var evaluated := 0
	var annotated := 0
	var t0 := Time.get_ticks_usec()
	for i in cases.size():
		var c = cases[i]
		if not t.check("jwsCases %d well-formed" % i, _jws_well_formed(c)):
			continue
		var id: String = c["id"]
		var expect: Dictionary = c["expect"]
		var r = PKeyJws.verify(c["jws"], c["trust"], c.get("typ", ""), int(c.get("maxPayloadBytes", 0)))
		var got := "ok" if r != null else "fail"
		evaluated += 1
		if not t.check("%s verdict" % id, got == expect["verify"], "expect=%s got=%s" % [expect["verify"], got]):
			continue
		if r == null:
			continue
		if expect.has("kid"):
			t.check("%s kid" % id, r is Dictionary and r.get("kid") == expect["kid"], "got %s" % str(r.get("kid")))
		if expect.has("doc"):
			var doc = expect["doc"]
			if expect.has("docNulReplaced"):
				doc = _apply_nul_replaced(t, id, doc, expect["docNulReplaced"])
				annotated += 1
				if doc == null:
					continue
			t.check("%s doc" % id, r is Dictionary and r.has("payload") and r["payload"] == doc)
	t.info("jwsCases: %d with docNulReplaced" % annotated)
	_coverage(t, "jwsCases", evaluated, cases.size(), _ms_since(t0))


static func _jws_well_formed(c) -> bool:
	if not (c is Dictionary):
		return false
	if not (c.get("id") is String and c.get("jws") is String and c.get("trust") is Dictionary):
		return false
	if c.has("typ") and not (c["typ"] is String):
		return false
	if c.has("maxPayloadBytes") and not (c["maxPayloadBytes"] is float):
		return false
	var e = c.get("expect")
	if not (e is Dictionary and (e.get("verify") == "ok" or e.get("verify") == "fail")):
		return false
	if e.has("kid") and not (e["kid"] is String):
		return false
	if e.has("docNulReplaced") and not (e.has("doc") and e["docNulReplaced"] is Dictionary):
		return false
	return true


## Deep-copies `doc` and writes each WIRE-CONTRACT-V3 §10 replacement at its RFC 6901 pointer.
## Each pointer must resolve to a String and each replacement must hold U+FFFD; returns null (and
## records a failed check) otherwise.
static func _apply_nul_replaced(t: PKeyTestContext, id: String, doc, replaced: Dictionary) -> Variant:
	var out = doc.duplicate(true) if (doc is Dictionary or doc is Array) else doc
	for pointer in replaced:
		var value = replaced[pointer]
		var ok: bool = pointer is String and (pointer as String).begins_with("/") and value is String \
				and (value as String).contains(char(0xFFFD))
		if not t.check("%s docNulReplaced %s well-formed" % [id, str(pointer)], ok):
			return null
		var tokens := (pointer as String).substr(1).split("/", true)
		var parent = out
		var resolved := true
		for k in tokens.size():
			var token: String = tokens[k].replace("~1", "/").replace("~0", "~")
			var is_last: bool = k == tokens.size() - 1
			if parent is Dictionary and (parent as Dictionary).has(token):
				if is_last:
					resolved = parent[token] is String
					if resolved:
						parent[token] = value
				else:
					parent = parent[token]
			elif parent is Array and token.is_valid_int() and int(token) >= 0 and int(token) < (parent as Array).size():
				if is_last:
					resolved = parent[int(token)] is String
					if resolved:
						parent[int(token)] = value
				else:
					parent = parent[int(token)]
			else:
				resolved = false
			if not resolved:
				break
		if not t.check("%s docNulReplaced %s resolves to a string" % [id, pointer], resolved):
			return null
	return out


# ── licenseDocCases / configDocCases (§3) ────────────────────────────────────────────────

func _doc_cases(t: PKeyTestContext, cases: Array, name: String, typ: String) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in cases.size():
		var c = cases[i]
		var ok_shape: bool = c is Dictionary and c.get("id") is String and c.get("jws") is String \
				and c.get("trust") is Dictionary and c.get("typ") == typ and c.get("expectedAud") is String \
				and c.get("expectedIss") is String and c.get("deviceId") is String and c.get("now") is float \
				and c.get("expect") is Dictionary and c["expect"].get("accept") is bool
		if not t.check("%s %d well-formed" % [name, i], ok_shape):
			continue
		var opts := {
			"trust": c["trust"],
			"expected_aud": c["expectedAud"],
			"expected_iss": c["expectedIss"],
			"device_id": c["deviceId"],
			"now": c["now"],
		}
		if c.has("lastAcceptedIssuedAt"):
			opts["last_accepted_issued_at"] = c["lastAcceptedIssuedAt"]
		if c.has("checkFreshness"):
			opts["check_freshness"] = c["checkFreshness"]
		var doc = await PKeyVerify.verify_doc(c["jws"], typ, opts)
		evaluated += 1
		t.check("%s → accept:%s" % [c["id"], c["expect"]["accept"]], (doc != null) == c["expect"]["accept"])
	_coverage(t, name, evaluated, cases.size(), _ms_since(t0))


# ── trustCases (§1) ──────────────────────────────────────────────────────────────────────

func _trust_cases(t: PKeyTestContext, cases: Array) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in cases.size():
		var c = cases[i]
		var ok_shape: bool = c is Dictionary and c.get("id") is String and c.get("manifestJws") is String \
				and c.get("pinned") is Dictionary and c.get("before") is Dictionary and c.get("now") is float \
				and c.get("expect") is Dictionary and c["expect"].get("accepted") is bool \
				and c["expect"].get("trust") is Dictionary
		if not t.check("trustCases %d well-formed" % i, ok_shape):
			continue
		var id: String = c["id"]
		var opts := {"pinned": c["pinned"], "expected_aud": "djdl", "now": c["now"]}
		if c.has("checkFreshness"):
			opts["check_freshness"] = c["checkFreshness"]
		var r := await PKeyTrust.verify_manifest(c["manifestJws"], opts)
		evaluated += 1
		var accepted: bool = r["doc"] != null
		t.check("%s accepted" % id, accepted == c["expect"]["accepted"], "expect=%s got=%s" % [c["expect"]["accepted"], accepted])
		# Accepted: the discovered set REPLACES what was held; rejected: it is untouched.
		var discovered: Dictionary = r["discovered"] if accepted else c["before"]
		var merged := PKeyTrust.merge(c["pinned"], discovered)
		t.check("%s trust" % id, merged == c["expect"]["trust"], "got %s" % JSON.stringify(merged))
		if c["expect"].has("issuedAt"):
			var got = r["doc"]["issuedAt"] if accepted else null
			t.check("%s issuedAt" % id, got != null and got == c["expect"]["issuedAt"], "got %s" % str(got))
	_coverage(t, "trustCases", evaluated, cases.size(), _ms_since(t0))


# ── clockFloorCases (§4.2): the cache-reload path as pure data ───────────────────────────

func _clock_floor_cases(t: PKeyTestContext, cases: Array) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in cases.size():
		var c = cases[i]
		var ok_shape: bool = c is Dictionary and c.get("id") is String and c.get("pinned") is Dictionary \
				and c.get("expectedAud") is String and c.get("deviceId") is String and c.get("systemClock") is float \
				and c.get("expect") is Dictionary and c["expect"].get("highWaterMark") is float \
				and c["expect"].get("effectiveNow") is float and c["expect"].get("status") is String
		for k in ["trustJws", "licenseJws", "configJws"]:
			ok_shape = ok_shape and (not c.has(k) or c[k] is String)
		if not t.check("clockFloorCases %d well-formed" % i, ok_shape):
			continue
		var id: String = c["id"]
		var now: float = c["systemClock"]
		var trust: Dictionary = c["pinned"]
		var verified: Array = []
		if c.has("trustJws"):
			var m := await PKeyTrust.verify_manifest(c["trustJws"], {
				"pinned": c["pinned"], "expected_aud": c["expectedAud"], "now": now, "check_freshness": false,
			})
			if m["doc"] != null:
				trust = PKeyTrust.merge(c["pinned"], m["discovered"])
				verified.append(m["doc"]["issuedAt"])
		var reload := {
			"trust": trust, "expected_aud": c["expectedAud"], "device_id": c["deviceId"], "now": now,
			"check_freshness": false,
		}
		var license = null
		if c.has("licenseJws"):
			license = await PKeyVerify.verify_license_doc(c["licenseJws"], reload)
			if license != null:
				verified.append(license["issuedAt"])
		if c.has("configJws"):
			var config = await PKeyVerify.verify_config_doc(c["configJws"], reload)
			if config != null:
				verified.append(config["issuedAt"])
		var floor_at := PKeyClock.high_water_mark(verified)
		evaluated += 1
		t.check("%s highWaterMark" % id, floor_at == c["expect"]["highWaterMark"], "got %d" % int(floor_at))
		var eff := PKeyClock.effective_now(now, floor_at)
		t.check("%s effectiveNow" % id, eff == c["expect"]["effectiveNow"], "got %d" % int(eff))
		var state := PKeyGate.license_state({
			"license_service_enabled": true,
			"activation": "token",
			"doc": license,
			"now": now,
			"high_water_mark": floor_at,
		})
		t.check("%s status" % id, state["status"] == c["expect"]["status"], "expect=%s got=%s" % [c["expect"]["status"], state["status"]])
	_coverage(t, "clockFloorCases", evaluated, cases.size(), _ms_since(t0))


# ── bundleCases (§7), with the refusing step ─────────────────────────────────────────────

func _bundle_cases(t: PKeyTestContext, cases: Array) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in cases.size():
		var c = cases[i]
		var e = c.get("expect") if c is Dictionary else null
		var ok_shape: bool = c is Dictionary and c.get("id") is String and c.get("bundleJws") is String \
				and c.get("pinned") is Dictionary and c.get("expectedAud") is String and c.get("deviceId") is String \
				and c.get("now") is float and c.get("maxPayloadBytes") is float and e is Dictionary \
				and e.get("imports") is bool \
				and ((e["imports"] and e.get("docs") is Array) or (not e["imports"] and e.get("reason") is String))
		if not t.check("bundleCases %d well-formed" % i, ok_shape):
			continue
		var id: String = c["id"]
		# The cap is a property of the typ: the fixture must agree with the shipped constant.
		t.check("%s cap" % id, int(c["maxPayloadBytes"]) == PKeyClaims.MAX_BUNDLE_BYTES)
		var r := await PKeyBundle.inspect(c["bundleJws"], {
			"pinned": c["pinned"], "product": c["expectedAud"], "device_id": c["deviceId"], "now": c["now"],
		})
		evaluated += 1
		var got := {}
		if r["ok"]:
			var docs: Array = []
			for slice in ["license", "config"]:
				if r["bundle"]["docs"].has(slice):
					docs.append(slice)
			got = {"imports": true, "docs": docs}
		else:
			got = {"imports": false, "reason": r["reason"]}
		t.check("%s → %s" % [id, e.get("reason", "imports")], got == e, "got %s" % JSON.stringify(got))
		if r["ok"]:
			var b: Dictionary = r["bundle"]
			var shaped: bool = b.get("bundle_id") is String and (b["trust_jws"] as String).split(".").size() == 3 \
					and (b["effective_trust"] as Dictionary).size() >= (c["pinned"] as Dictionary).size()
			for slice in b["docs"]:
				var d: Dictionary = b["docs"][slice]
				shaped = shaped and (d["jws"] as String).split(".").size() == 3 and d["doc"].get("deviceId") == c["deviceId"] \
						and d["doc"].get("aud") == c["expectedAud"]
			t.check("%s yields the artifacts the cache write needs" % id, shaped)
	_coverage(t, "bundleCases", evaluated, cases.size(), _ms_since(t0))


# ── fingerprint.json deviceIds ───────────────────────────────────────────────────────────

func _device_ids(t: PKeyTestContext, vectors: Array) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in vectors.size():
		var v = vectors[i]
		var ok_shape: bool = v is Dictionary and v.get("id") is String and v.get("product") is String \
				and v.get("raw") is String and v.get("expected") is String
		if not t.check("deviceIds %d well-formed" % i, ok_shape):
			continue
		var got := PKeyDeviceId.from_raw(v["product"], v["raw"])
		evaluated += 1
		t.check("device-id %s" % v["id"], got == v["expected"], "expect=%s got=%s" % [v["expected"], got])
	_coverage(t, "deviceIds", evaluated, vectors.size(), _ms_since(t0))


# ── fingerprint.json vectors (§6) and source rules (§6.1) ────────────────────────────────

func _fingerprint_vectors(t: PKeyTestContext, fp: Dictionary) -> void:
	t.check("fingerprintVersion", fp.get("fingerprintVersion") == float(PKeyConstants.FINGERPRINT_VERSION))
	t.check("componentOrder is the SDK's canonical order", fp.get("componentOrder") == PKeyFingerprint.COMPONENTS, str(fp.get("componentOrder")))
	t.check("component and hwid lengths", fp.get("componentHashLength") == float(PKeyFingerprint.COMPONENT_LENGTH) and fp.get("hwidLength") == float(PKeyFingerprint.HWID_LENGTH))
	var vectors := _section(t, fp, "vectors")
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in vectors.size():
		var v = vectors[i]
		var ok_shape: bool = v is Dictionary and v.get("id") is String and v.get("product") is String \
				and v.get("raw") is Dictionary and v.get("components") is Dictionary and v.get("hwid") is String
		if not t.check("vectors %d well-formed" % i, ok_shape):
			continue
		var got := PKeyFingerprint.hash_components(v["product"], v["raw"])
		evaluated += 1
		t.check("fingerprint %s components" % v["id"], got["components"] == v["components"], JSON.stringify(got["components"]))
		t.check("fingerprint %s hwid" % v["id"], got["hwid"] == v["hwid"], "expect=%s got=%s" % [v["hwid"], got["hwid"]])
	_coverage(t, "vectors", evaluated, vectors.size(), _ms_since(t0))


func _source_rules(t: PKeyTestContext, fp: Dictionary) -> void:
	t.check("windowsCimCommand: the SDK runs exactly the pinned command", fp.get("windowsCimCommand") == {
		"program": PKeyFingerprint.WINDOWS_CIM_COMMAND["program"],
		"args": PKeyFingerprint.WINDOWS_CIM_COMMAND["args"],
		"stdin": PKeyFingerprint.WINDOWS_CIM_COMMAND["stdin"],
		"timeoutMs": float(PKeyFingerprint.WINDOWS_CIM_COMMAND["timeoutMs"]),
	}, JSON.stringify(fp.get("windowsCimCommand")))

	var cim := _section(t, fp, "windowsCim")
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in cim.size():
		var c = cim[i]
		if not t.check("windowsCim %d well-formed" % i, c is Dictionary and c.get("id") is String and c.get("stdout") is String and c.get("expected") is Dictionary):
			continue
		var got := PKeyFingerprint.parse_windows_cim(c["stdout"])
		evaluated += 1
		t.check("windowsCim %s" % c["id"], got == c["expected"], JSON.stringify(got))
	_coverage(t, "windowsCim", evaluated, cim.size(), _ms_since(t0))

	var anchors := _section(t, fp, "linuxAnchor")
	evaluated = 0
	t0 = Time.get_ticks_usec()
	for i in anchors.size():
		var c = anchors[i]
		if not t.check("linuxAnchor %d well-formed" % i, c is Dictionary and c.get("id") is String and c.get("files") is Dictionary and (c.get("expected") == null or c["expected"] is Dictionary)):
			continue
		var got = PKeyFingerprint.linux_anchor_source(c["files"])
		evaluated += 1
		t.check("linuxAnchor %s" % c["id"], got == c["expected"] if c["expected"] != null else got == null, JSON.stringify(got))
	_coverage(t, "linuxAnchor", evaluated, anchors.size(), _ms_since(t0))

	var buckets := _section(t, fp, "ramBuckets")
	evaluated = 0
	t0 = Time.get_ticks_usec()
	for i in buckets.size():
		var c = buckets[i]
		if not t.check("ramBuckets %d well-formed" % i, c is Dictionary and c.get("id") is String and c.get("bytes") is float and (c.get("bucket") == null or c["bucket"] is String)):
			continue
		var got := PKeyFingerprint.ram_bucket(int(c["bytes"]))
		evaluated += 1
		var want: String = c["bucket"] if c["bucket"] != null else ""
		t.check("ramBuckets %s" % c["id"], got == want, "expect=%s got=%s" % [want, got])
	_coverage(t, "ramBuckets", evaluated, buckets.size(), _ms_since(t0))
