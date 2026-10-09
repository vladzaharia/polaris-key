extends RefCounted
# @pkey-feature core.verify core.bundle devices.fingerprint license.gate core.headers identity.devicelabel
# @pkey-feature update.feed release.record update.decide outlet.detect
# @pkey-feature update.content packs.revoke packs.delegation packs.delta.feed
# The Godot conformance runner: every section of the generator-owned corpus mirror
# (res://tests/corpus/v2/cases.json, gate-matrix.json, fingerprint.json and headers.json, written by
# `pnpm gen:corpus`; never
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
#   pointer sets     PKeyJws.verify              WIRE-CONTRACT-V4 §4.1: non_wire_integers equals
#                                                each case's `nonWireIntegers` over the seven JWS
#                                                families (feedCases, releaseRecordCases included),
#                                                the two P4-13 families (feedContentCases,
#                                                revocationCases) and the two pack families
#                                                (packRecordCases, and markerCases, whose JWS is the
#                                                marker's `release`)
#   feedCases        PKeyFeed.verify_feed        V4 §2.5 steps 3–8: ok with seq, issuedAt and the
#                                                document, or the refusing reason
#   releaseRecordCases PKeyReleaseRecord.verify_release_record  steps 12–15: ok with kind and the
#                                                document, or the refusing step
#   feedContentCases PKeyFeed.verify_feed + feed_content  plans/P4-13.md §2.2: the parsed content
#                                                members, through verify_feed, over the decoded
#                                                payload and through with_feed_content; the delta
#                                                menu (plans/P4-29.md §4.1) against
#                                                `expect.deltas`, null when absent, on every case
#   revocationCases  PKeyReleaseRecord.verify_revocation  §2.3 steps 12–16, the body alone
#                    (revocation_of), superseding (newer_revocation); replacement mode through
#                    verify_release_record
#   delegationCases  plans/P4-19.md §4.2: `record` and `release-only` through
#                    verify_release_record (a delegation passed in `record` mode only): ok with kind
#                    and the result's `delegation`, or the refusing step (`delegation`, `scope` and
#                    the rest), then record_revoked over `revoked`; `revocation` through
#                    verify_revocation; `feed` (a revocation entry's `kind`) through verify_feed +
#                    feed_content
#   update-matrix    vocabulary (the generated enums and PKeyVersion.SCHEMES), versionCases
#                    (PKeyVersion.compare_versions), capabilityCases (effective_capabilities),
#                    outletCases (resolve_update_outlet), bucketVectors (rollout_bucket), rows
#                    (decide_update, compared by value, and boot_decision), contentRows
#                    (plans/P4-13.md §2.6: decide_update with `content`, boot_decision, packSetId;
#                    `required` exactly on the revoked-content rows)
#   outlet-matrix    PKeyDecision's compiled tables equal kinds, platformNarrowing, subkinds and
#                    platformData.listingUrlPrefixes; PKeyOutlet's signal table and platform data
#                    equal signals and platformData; every row (PKeyOutlet.detect_outlet, P3-11)
#   timings          INFO only: one feed and one record verify, median of a few runs
#   gate-matrix rows the build-gate port + PKeyGate status, usable, reason, allowedRange
#   deviceIds        PKeyDeviceId.from_raw       the derived id (fingerprint.json)
#   vectors          PKeyFingerprint             components and hwid (fingerprint.json)
#   windowsCimCommand / windowsCim / linuxAnchor / ramBuckets
#                    PKeyFingerprint             the §6.1 source rules (fingerprint.json)
#   platformCases    PKeyHeaders.canonical_platform  the §5.2 value, or none (headers.json)
#   archCases        PKeyHeaders.canonical_arch      the §5.2 value, or none (headers.json)
#
# For headers.json the generated PKeyConstants.PLATFORM_SPELLINGS / ARCH_SPELLINGS must also equal
# the map derived from the non-null rows, with values in PLATFORM_VALUES / ARCH_VALUES, and one
# doctored row must fail the same comparison.
#
# Under WIRE-CONTRACT-V3 §10, each string the generator lists in `expect.docNulReplaced` is
# compared in its U+FFFD form, exactly.

const CASES := "res://tests/corpus/v2/cases.json"
const FINGERPRINT := "res://tests/corpus/v2/fingerprint.json"
const GATE_MATRIX := "res://tests/corpus/v2/gate-matrix.json"
const HEADERS := "res://tests/corpus/v2/headers.json"
## WIRE-CONTRACT-V4 §12.7.1 (PX-W13): the device label, through PKeyDeviceLabel.normalize.
const DEVICE_LABEL := "res://tests/corpus/v2/device-label.json"
const UPDATE_MATRIX := "res://tests/corpus/v2/update-matrix.json"
const OUTLET_MATRIX := "res://tests/corpus/v2/outlet-matrix.json"
const HEADERS_VERSION := 2
const CORPUS_VERSION := 2
const FLOORS := {
	"jwsCases": 85,
	"licenseDocCases": 16,
	"configDocCases": 18,
	"trustCases": 30,
	"clockFloorCases": 7,
	"bundleCases": 23,
	"pointerSets": 539,
	"feedCases": 80,
	"releaseRecordCases": 49,
	"feedContentCases": 76,
	"revocationCases": 27,
	"contentRows": 44,
	"delegationCases": 46,
	"versionCases": 25,
	"capabilityCases": 10,
	"outletCases": 12,
	"outletRows": 48,
	"bucketVectors": 6,
	"updateRows": 65,
	"gate-matrix": 38,
	"deviceIds": 4,
	"vectors": 6,
	"windowsCim": 17,
	"linuxAnchor": 10,
	"ramBuckets": 13,
	"platformCases": 31,
	"archCases": 31,
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
	_pointer_sets(t, corpus)
	await _feed_cases(t, _section(t, corpus, "feedCases"))
	await _record_cases(t, _section(t, corpus, "releaseRecordCases"))
	await _feed_content_cases(t, _section(t, corpus, "feedContentCases"))
	await _revocation_cases(t, _section(t, corpus, "revocationCases"))
	await _delegation_cases(t, _section(t, corpus, "delegationCases"))
	var um = _load(t, UPDATE_MATRIX)
	if um != null:
		_update_matrix(t, um)
		_content_rows(t, um)
	var om = _load(t, OUTLET_MATRIX)
	if om != null:
		_outlet_tables(t, om)
		_outlet_detection(t, om)
	await _update_timings(t, corpus)
	var matrix = _load(t, GATE_MATRIX)
	if matrix != null:
		_gate_matrix(t, matrix)
	var fp = _load(t, FINGERPRINT)
	if fp != null:
		_device_ids(t, _section(t, fp, "deviceIds"))
		_fingerprint_vectors(t, fp)
		_source_rules(t, fp)
	var headers = _load(t, HEADERS)
	if headers != null:
		_header_cases(t, headers)
	var labels = _load(t, DEVICE_LABEL)
	if labels != null:
		_device_label_cases(t, labels)
	return true


## Every device-label.json row through PKeyDeviceLabel.normalize ("" is the corpus's null).
func _device_label_cases(t: PKeyTestContext, corpus: Dictionary) -> void:
	t.check("deviceLabelVersion", corpus.get("deviceLabelVersion") is float and int(corpus["deviceLabelVersion"]) == PKeyConstants.DEVICE_LABEL_VERSION, str(corpus.get("deviceLabelVersion")))
	var rows := _section(t, corpus, "cases")
	for row in rows:
		var want: String = "" if row["expect"] == null else String(row["expect"])
		var got := PKeyDeviceLabel.normalize(String(row["raw"]))
		t.check("device-label %s" % row["id"], got == want, "%s -> %s, want %s" % [JSON.stringify(row["raw"]), JSON.stringify(got), JSON.stringify(want)])
	t.check("device-label: at least 20 rows", rows.size() >= 20, str(rows.size()))


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


# ── WIRE-CONTRACT-V4 §4.1: the non-wire-integer pointer sets ────────────────────────────────
# Every case of the seven JWS families, and of the two pack families of plans/P4-01.md §4.6
# (packRecordCases; markerCases, whose JWS is the marker text's `release` member, "" when the text
# is not an object holding a string there), goes through PKeyJws.verify with its family's keys,
# typ and cap. Whenever it verifies, `non_wire_integers` must equal the case's `nonWireIntegers` as a
# set (absent = empty), and a case that carries the member must verify.

func _pointer_sets(t: PKeyTestContext, corpus: Dictionary) -> void:
	var families := [
		["jwsCases", "jws", "trust", "", 0],
		["licenseDocCases", "jws", "trust", PKeyClaims.TYP_LICENSE, 0],
		["configDocCases", "jws", "trust", PKeyClaims.TYP_CONFIG, 0],
		["trustCases", "manifestJws", "pinned", PKeyClaims.TYP_TRUST, 0],
		["bundleCases", "bundleJws", "pinned", PKeyClaims.TYP_BUNDLE, PKeyClaims.MAX_BUNDLE_BYTES],
		["feedCases", "jws", "trust", PKeyClaims.TYP_FEED, 0],
		["releaseRecordCases", "jws", "releaseKeys", PKeyClaims.TYP_RELEASE, 0],
		["feedContentCases", "jws", "trust", PKeyClaims.TYP_FEED, 0],
		["revocationCases", "jws", "releaseKeys", PKeyClaims.TYP_RELEASE, 0],
		["packRecordCases", "jws", "releaseKeys", PKeyClaims.TYP_RELEASE, 0],
		["markerCases", "marker", "releaseKeys", PKeyClaims.TYP_RELEASE, 0],
	]
	var evaluated := 0
	var total := 0
	var t0 := Time.get_ticks_usec()
	for f in families:
		var cases := _section(t, corpus, f[0])
		total += cases.size()
		for c in cases:
			if not (c is Dictionary and c.get(f[1]) is String and c.get(f[2]) is Dictionary):
				t.check("%s/%s well-formed for the pointer set" % [f[0], str(c.get("id"))], false)
				continue
			var typ: String = f[3] if f[3] != "" else str(c.get("typ", ""))
			var cap: int = f[4] if f[0] != "jwsCases" else int(c.get("maxPayloadBytes", 0))
			var jws: String = _marker_release(c[f[1]]) if f[0] == "markerCases" else c[f[1]]
			var r = PKeyJws.verify(jws, c[f[2]], typ, cap)
			evaluated += 1
			var where := "%s/%s pointer set" % [f[0], c["id"]]
			if c.has("nonWireIntegers") and r == null:
				t.check(where, false, "carries nonWireIntegers, so it must verify")
				continue
			if r == null:
				continue
			var want := {}
			for p in c.get("nonWireIntegers", []):
				want[p] = true
			var got: PKeyJson.PointerSet = r.get("non_wire_integers")
			var listed := got.keys()
			t.check(where, got.size() == want.size() and listed.size() == want.size() and want.keys().all(func(k): return got.has(k) and listed.has(k)), "got %s" % str(listed))
	_coverage(t, "pointerSets", evaluated, total, _ms_since(t0))


## A marker's `release`, when its text is a JSON object holding a string there; otherwise "".
static func _marker_release(text: String) -> String:
	var r := PKeyJson.parse(text)
	if not r["ok"]:
		return ""
	var m = r["value"]
	if m is Dictionary and m.get("release") is String:
		return m["release"]
	return ""


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


# ── feedCases (V4 §2.3, §2.5 steps 3–8) ────────────────────────────────────────────────────

func _feed_cases(t: PKeyTestContext, cases: Array) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in cases.size():
		var c = cases[i]
		var e = c.get("expect") if c is Dictionary else null
		var ok_shape: bool = c is Dictionary and c.get("id") is String and c.get("jws") is String \
				and c.get("trust") is Dictionary and c.get("expectedAud") is String and c.get("channel") is String \
				and c.get("platform") is String and c.get("now") is float and c.get("checkFreshness") is bool \
				and (not c.has("floors") or c["floors"] is Dictionary) and e is Dictionary \
				and ((e.get("verify") == "ok" and e.get("seq") is float and e.get("issuedAt") is float) \
					or (e.get("verify") == "fail" and e.get("reason") is String))
		if not t.check("feedCases %d well-formed" % i, ok_shape):
			continue
		var id: String = c["id"]
		var r := await PKeyFeed.verify_feed(c["jws"], {
			"trust": c["trust"],
			"expected_aud": c["expectedAud"],
			"channel": c["channel"],
			"platform": c["platform"],
			"now": c["now"],
			"check_freshness": c["checkFreshness"],
			"floors": c.get("floors"),
		})
		evaluated += 1
		var want: String = "ok" if e["verify"] == "ok" else e["reason"]
		var got: String = "ok" if r["ok"] else String(r.get("reason"))
		if not t.check("%s → %s" % [id, want], got == want, "got %s" % got):
			continue
		if r["ok"]:
			var feed: Dictionary = r["feed"]
			t.check("%s seq and issuedAt" % id, _json_eq(feed.get("seq"), e["seq"]) and _json_eq(feed.get("issuedAt"), e["issuedAt"]))
			if e.has("doc"):
				t.check("%s doc" % id, _json_eq(feed, e["doc"]))
	_coverage(t, "feedCases", evaluated, cases.size(), _ms_since(t0))


# ── releaseRecordCases (V4 §2.4, §2.5 steps 12–15) ─────────────────────────────────────────

func _record_cases(t: PKeyTestContext, cases: Array) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in cases.size():
		var c = cases[i]
		var e = c.get("expect") if c is Dictionary else null
		var ok_shape: bool = c is Dictionary and c.get("id") is String and c.get("jws") is String \
				and c.get("releaseKeys") is Dictionary and c.get("productTrust") is Dictionary \
				and c.get("expectedAud") is String and c.get("expectedHash") is String \
				and (not c.has("pin") or c["pin"] is Dictionary) and e is Dictionary \
				and ((e.get("verify") == "ok" and e.get("kind") is String) or (e.get("verify") == "fail" and e.get("step") is String))
		if not t.check("releaseRecordCases %d well-formed" % i, ok_shape):
			continue
		var id: String = c["id"]
		var opts := {
			"release_keys": c["releaseKeys"],
			"product_trust": c["productTrust"],
			"expected_aud": c["expectedAud"],
			"expected_hash": c["expectedHash"],
		}
		if c.has("pin"):
			opts["pin"] = c["pin"]
		var r := await PKeyReleaseRecord.verify_release_record(c["jws"], opts)
		evaluated += 1
		var want: String = "ok" if e["verify"] == "ok" else e["step"]
		var got: String = "ok" if r["ok"] else String(r.get("step"))
		if not t.check("%s → %s" % [id, want], got == want, "got %s" % got):
			continue
		if r["ok"]:
			t.check("%s kind" % id, _json_eq(r["record"].get("kind"), e["kind"]))
			if e.has("doc"):
				t.check("%s doc" % id, _json_eq(r["record"], e["doc"]))
	_coverage(t, "releaseRecordCases", evaluated, cases.size(), _ms_since(t0))


# ── update-matrix.json (plans/P3-01.md §2.8, §4.6) ─────────────────────────────────────────

func _update_matrix(t: PKeyTestContext, m: Dictionary) -> void:
	t.check("updateMatrixVersion", _json_eq(m.get("updateMatrixVersion"), PKeyConstants.UPDATE_MATRIX_VERSION), str(m.get("updateMatrixVersion")))
	var vocab = m.get("vocabulary")
	var want_vocab := {
		"actions": PKeyConstants.UPDATE_ACTION_VALUES,
		"noneReasons": PKeyConstants.UPDATE_NONE_REASON_VALUES,
		"blockedReasons": PKeyConstants.UPDATE_BLOCKED_REASON_VALUES,
		"methods": PKeyConstants.BINARY_METHOD_VALUES,
		"boot": ["none", "optional", "required"],
		"schemes": Array(PKeyVersion.SCHEMES),
	}
	t.check("update-matrix vocabulary equals the generated enums and PKeyVersion.SCHEMES", vocab is Dictionary and _json_eq(vocab, want_vocab), JSON.stringify(vocab))

	# versionCases
	var cases: Array = m.get("versionCases", []) if m.get("versionCases") is Array else []
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for c in cases:
		if not t.check("versionCases %s well-formed" % str(c.get("name") if c is Dictionary else c), c is Dictionary and c.get("name") is String and c.get("scheme") is String and c.get("a") is String and c.get("b") is String and c.has("expect")):
			continue
		var got = PKeyVersion.compare_versions(c["scheme"], c["a"], c["b"])
		evaluated += 1
		t.check("version %s" % c["name"], _json_eq(got, c["expect"]), "got %s" % str(got))
	_coverage(t, "versionCases", evaluated, cases.size(), _ms_since(t0))

	# capabilityCases
	cases = m.get("capabilityCases", []) if m.get("capabilityCases") is Array else []
	evaluated = 0
	t0 = Time.get_ticks_usec()
	for c in cases:
		if not t.check("capabilityCases %s well-formed" % str(c.get("name") if c is Dictionary else c), c is Dictionary and c.get("name") is String and c.get("kind") is String and c.get("platform") is String and c.get("expect") is Dictionary):
			continue
		var got := PKeyDecision.effective_capabilities(c["kind"], {"platform": c["platform"], "subkind": c.get("subkind"), "server": c.get("server")})
		evaluated += 1
		t.check("capability %s" % c["name"], _json_eq(got, c["expect"]), JSON.stringify(got))
	_coverage(t, "capabilityCases", evaluated, cases.size(), _ms_since(t0))

	# outletCases
	cases = m.get("outletCases", []) if m.get("outletCases") is Array else []
	evaluated = 0
	t0 = Time.get_ticks_usec()
	for c in cases:
		if not t.check("outletCases %s well-formed" % str(c.get("name") if c is Dictionary else c), c is Dictionary and c.get("name") is String and c.get("expect") is Dictionary):
			continue
		var got = PKeyDecision.resolve_update_outlet({"host": c.get("host"), "stamp": c.get("stamp"), "detected": c.get("detected")})
		evaluated += 1
		t.check("outlet %s" % c["name"], got is Dictionary and _json_eq(got, c["expect"]), JSON.stringify(got))
	_coverage(t, "outletCases", evaluated, cases.size(), _ms_since(t0))
	var bad_hosts := ["epic", {"id": "Direct Build", "kind": "direct"}, {"id": "direct", "kind": "epic"}, {"id": "direct", "kind": "direct", "subkind": "brew"}, 7, ""]
	for host in bad_hosts:
		t.check("outlet: an invalid host %s is refused (invalid-options)" % JSON.stringify(host), PKeyDecision.resolve_update_outlet({"host": host}) == null)

	# bucketVectors
	cases = m.get("bucketVectors", []) if m.get("bucketVectors") is Array else []
	evaluated = 0
	t0 = Time.get_ticks_usec()
	for v in cases:
		if not t.check("bucketVectors %s well-formed" % str(v.get("name") if v is Dictionary else v), v is Dictionary and v.get("name") is String and v.get("salt") is String and v.get("installId") is String and v.get("bucket") is float and v.get("u32") is float):
			continue
		var got := PKeyDecision.rollout_bucket(v["salt"], v["installId"])
		evaluated += 1
		t.check("bucket %s" % v["name"], got == int(v["bucket"]) and int(v["u32"]) % 10000 == int(v["bucket"]), "got %d" % got)
	_coverage(t, "bucketVectors", evaluated, cases.size(), _ms_since(t0))

	# rows: every decision and its boot value
	cases = m.get("rows", []) if m.get("rows") is Array else []
	evaluated = 0
	t0 = Time.get_ticks_usec()
	var all_boot_ok := true
	for row in cases:
		if not t.check("rows %s well-formed" % str(row.get("name") if row is Dictionary else row), row is Dictionary and row.get("name") is String and row.get("input") is Dictionary and row.get("expect") is Dictionary and row["expect"].get("decision") is Dictionary and row["expect"].get("boot") is String):
			continue
		var decision := PKeyDecision.decide_update(row["input"])
		evaluated += 1
		t.check("row %s" % row["name"], _json_eq(decision, row["expect"]["decision"]), JSON.stringify(decision))
		var boot := PKeyDecision.boot_decision(decision)
		t.check("row %s boot" % row["name"], boot == row["expect"]["boot"], boot)
		all_boot_ok = all_boot_ok and (row["expect"]["boot"] == "none" or row["expect"]["boot"] == "optional")
	t.check("every P3-01 row's boot value is none or optional: no floor stops play", all_boot_ok)
	_coverage(t, "updateRows", evaluated, cases.size(), _ms_since(t0))
	# The comparator is not vacuous: one changed member makes a decision unequal.
	if cases.size() > 0 and cases[0] is Dictionary and cases[0].get("expect") is Dictionary:
		var d: Dictionary = (cases[0]["expect"]["decision"] as Dictionary).duplicate(true)
		d["discardStaged"] = not PKeyClaims.is_true(d.get("discardStaged"))
		t.check("rows comparator rejects a changed member", not _json_eq(d, cases[0]["expect"]["decision"]))
		d = (cases[0]["expect"]["decision"] as Dictionary).duplicate(true)
		d["extra"] = null
		t.check("rows comparator rejects an extra member", not _json_eq(d, cases[0]["expect"]["decision"]))


# ── feedContentCases (plans/P4-13.md §2.2) ─────────────────────────────────────────────────

func _feed_content_cases(t: PKeyTestContext, cases: Array) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in cases.size():
		var c = cases[i]
		var e = c.get("expect") if c is Dictionary else null
		var ok_shape: bool = c is Dictionary and c.get("id") is String and c.get("jws") is String \
				and c.get("trust") is Dictionary and c.get("expectedAud") is String and c.get("channel") is String \
				and c.get("platform") is String and c.get("now") is float and c.get("checkFreshness") is bool \
				and e is Dictionary and e.get("verify") == "ok" and e.get("content") is Dictionary
		if not t.check("feedContentCases %d well-formed" % i, ok_shape):
			continue
		var id: String = c["id"]
		var r := await PKeyFeed.verify_feed(c["jws"], {
			"trust": c["trust"], "expected_aud": c["expectedAud"], "channel": c["channel"],
			"platform": c["platform"], "now": c["now"], "check_freshness": c["checkFreshness"],
		})
		evaluated += 1
		if not t.check("%s verifies" % id, r["ok"], str(r.get("reason"))):
			continue
		var want: Dictionary = e["content"]
		# plans/P4-29.md §4.1: `expect.content` holds the three P4-13 members; every case pins the
		# delta menu in `expect.deltas` (absent: null).
		var want_deltas = e.get("deltas")
		var got: Dictionary = r.get("content")
		t.check("%s content" % id, _json_eq(_without_deltas(got), want), JSON.stringify(got).left(400))
		t.check("%s deltas" % id, got.has("deltas") and _json_eq(got["deltas"], want_deltas), JSON.stringify(got.get("deltas")).left(400))
		# The decision's own reading of the decoded payload agrees with the token-rule reading here
		# only when no member failed the token rule; through the decision's copy it always does.
		var copy := PKeyFeed.with_feed_content(r["feed"], r["content"])
		var again := PKeyFeed.feed_content(copy)
		t.check("%s content through with_feed_content" % id, _json_eq(_without_deltas(again), want) and _json_eq(again.get("deltas"), want_deltas))
	_coverage(t, "feedContentCases", evaluated, cases.size(), _ms_since(t0))


## feed_content's result without the delta menu (plans/P4-29.md §4.1: `expect.content` holds the
## three P4-13 members only).
static func _without_deltas(content: Dictionary) -> Dictionary:
	var out := content.duplicate()
	out.erase("deltas")
	return out


# ── revocationCases (plans/P4-13.md §2.3) ──────────────────────────────────────────────────

static func _revocation_opts(c: Dictionary) -> Dictionary:
	return {"release_keys": c["releaseKeys"], "product_trust": c["productTrust"], "expected_aud": c["expectedAud"], "entry": c.get("entry")}


func _revocation_cases(t: PKeyTestContext, cases: Array) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	var by_id := {}
	for c in cases:
		if c is Dictionary and c.get("id") is String:
			by_id[c["id"]] = c
	for i in cases.size():
		var c = cases[i]
		var e = c.get("expect") if c is Dictionary else null
		var ok_shape: bool = c is Dictionary and c.get("id") is String and c.get("jws") is String \
				and (c.get("mode") == "revocation" or c.get("mode") == "replacement") \
				and c.get("releaseKeys") is Dictionary and c.get("productTrust") is Dictionary and c.get("expectedAud") is String \
				and e is Dictionary and (e.get("verify") == "ok" or (e.get("verify") == "fail" and e.get("step") is String)) \
				and ((c.get("mode") == "revocation" and c.get("entry") is Dictionary) or (c.get("mode") == "replacement" and c.get("expectedHash") is String and c.get("pin") is Dictionary))
		if not t.check("revocationCases %d well-formed" % i, ok_shape):
			continue
		var id: String = c["id"]
		var want: String = "ok" if e["verify"] == "ok" else e["step"]
		evaluated += 1
		if c["mode"] == "replacement":
			var rr := await PKeyReleaseRecord.verify_release_record(c["jws"], {
				"release_keys": c["releaseKeys"], "product_trust": c["productTrust"], "expected_aud": c["expectedAud"],
				"expected_hash": c["expectedHash"], "pin": c["pin"],
			})
			var got_r: String = "ok" if rr["ok"] else String(rr.get("step"))
			if t.check("%s → %s" % [id, want], got_r == want, "got %s" % got_r) and rr["ok"]:
				t.check("%s kind" % id, _json_eq(rr["record"].get("kind"), e.get("kind")))
			continue
		var r := await PKeyReleaseRecord.verify_revocation(c["jws"], _revocation_opts(c))
		var got: String = "ok" if r["ok"] else String(r.get("step"))
		if not t.check("%s → %s" % [id, want], got == want, "got %s" % got) or not r["ok"]:
			continue
		var rev: Dictionary = r["revocation"]
		var body := {"pack": rev["pack"], "target": rev["target"], "replacement": rev["replacement"], "reason": rev["reason"], "issuedAt": rev["issuedAt"]}
		t.check("%s revocation" % id, _json_eq(body, e.get("revocation")), JSON.stringify(body))
		t.check("%s pin is the entry's" % id, _json_eq(rev["record"], c["entry"]["record"]) and _json_eq(rev["version"], c["entry"]["version"]) and _json_eq(rev["seq"], c["entry"]["seq"]))
		# The body alone reads the same.
		var raw = PKeyB64Url.decode_strict(String(c["jws"]).get_slice(".", 1))
		var parsed := PKeyJson.parse_bytes(raw) if raw is PackedByteArray else {"ok": false}
		var alone = PKeyReleaseRecord.revocation_of(parsed["value"], parsed["non_wire_integers"]) if parsed["ok"] else null
		t.check("%s revocation_of over the payload" % id, alone is Dictionary and _json_eq(alone, e.get("revocation")))
		if e.has("supersedes"):
			var other = by_id.get(e["supersedes"])
			var winner = by_id.get(e.get("winner"))
			if not t.check("%s supersedes a case in the section" % id, other is Dictionary and winner is Dictionary):
				continue
			var o := await PKeyReleaseRecord.verify_revocation(other["jws"], _revocation_opts(other))
			if not t.check("%s: the superseded case verifies" % id, o["ok"]):
				continue
			var win := PKeyReleaseRecord.newer_revocation(rev, o["revocation"])
			var back := PKeyReleaseRecord.newer_revocation(o["revocation"], rev)
			t.check("%s newer_revocation is symmetric" % id, is_same(win, back))
			t.check("%s winner" % id, _json_eq(win["record"], winner["entry"]["record"]), String(win["record"]))
	_coverage(t, "revocationCases", evaluated, cases.size(), _ms_since(t0))


# ── delegationCases (plans/P4-19.md §4.2) ────────────────────────────────────────────────

func _delegation_cases(t: PKeyTestContext, cases: Array) -> void:
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	var modes := {}
	for i in cases.size():
		var c = cases[i]
		var e = c.get("expect") if c is Dictionary else null
		var ok_shape: bool = c is Dictionary and c.get("id") is String and c.get("jws") is String \
				and ["record", "release-only", "revocation", "feed"].has(c.get("mode")) and e is Dictionary \
				and (e.get("verify") == "ok" or (e.get("verify") == "fail" and e.get("step") is String))
		if not t.check("delegationCases %d well-formed" % i, ok_shape):
			continue
		var id: String = c["id"]
		modes[c["mode"]] = int(modes.get(c["mode"], 0)) + 1
		evaluated += 1
		if c["mode"] == "feed":
			var r := await PKeyFeed.verify_feed(c["jws"], {
				"trust": c["trust"], "expected_aud": c["expectedAud"], "channel": c["channel"],
				"platform": c["platform"], "now": c["now"], "check_freshness": c["checkFreshness"],
			})
			if t.check("%s verifies" % id, r["ok"], str(r.get("reason"))):
				# plans/P4-29.md §2.2: these feeds carry no delta menu.
				t.check("%s content" % id, _json_eq(_without_deltas(r["content"]), e.get("content")), JSON.stringify(r["content"]).left(400))
				t.check("%s deltas" % id, r["content"].has("deltas") and r["content"]["deltas"] == null)
			continue
		var want: String = "ok" if e["verify"] == "ok" else e["step"]
		if c["mode"] == "revocation":
			var rv := await PKeyReleaseRecord.verify_revocation(c["jws"], _revocation_opts(c))
			var got_v: String = "ok" if rv["ok"] else String(rv.get("step"))
			if t.check("%s → %s" % [id, want], got_v == want, "got %s" % got_v) and rv["ok"]:
				var rev: Dictionary = rv["revocation"]
				var body := {"pack": rev["pack"], "target": rev["target"], "replacement": rev["replacement"], "reason": rev["reason"], "issuedAt": rev["issuedAt"]}
				t.check("%s revocation" % id, _json_eq(body, e.get("revocation")), JSON.stringify(body))
			continue
		var opts := {
			"release_keys": c["releaseKeys"], "product_trust": c["productTrust"], "expected_aud": c["expectedAud"],
			"expected_hash": c["expectedHash"],
		}
		if c.get("pin") is Dictionary:
			opts["pin"] = c["pin"]
		if c["mode"] == "record" and c.get("delegation") is String:
			opts["delegation"] = c["delegation"]
		var r := await PKeyReleaseRecord.verify_release_record(c["jws"], opts)
		var got: String = "ok" if r["ok"] else String(r.get("step"))
		if not t.check("%s → %s" % [id, want], got == want, "got %s" % got) or not r["ok"]:
			continue
		t.check("%s kind" % id, _json_eq(r["record"].get("kind"), e.get("kind")))
		t.check("%s delegation" % id, _json_eq(r["delegation"], e.get("delegation")), JSON.stringify(r["delegation"]))
		if c.has("revoked"):
			var d = r["delegation"]
			var why = PKeyReleaseRecord.record_revoked(c["expectedHash"], d["sha256"] if d is Dictionary else null, c["revoked"])
			t.check("%s record_revoked" % id, _json_eq(why, e.get("revoked")), str(why))
	t.info("delegationCases by mode: %s" % JSON.stringify(modes))
	_coverage(t, "delegationCases", evaluated, cases.size(), _ms_since(t0))


# ── update-matrix.json contentRows (plans/P4-13.md §2.6) ───────────────────────────────────

func _content_rows(t: PKeyTestContext, m: Dictionary) -> void:
	var rows: Array = m.get("contentRows", []) if m.get("contentRows") is Array else []
	t.check("contentRows present", m.get("contentRows") is Array)
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	var required_exact := true
	var floors_usable := true
	var plain_unchanged := true
	for row in rows:
		var name = row.get("name") if row is Dictionary else row
		if not t.check("contentRows %s well-formed" % str(name), row is Dictionary and row.get("name") is String and row.get("input") is Dictionary \
				and row["input"].get("content") is Dictionary and row.get("expect") is Dictionary \
				and row["expect"].get("decision") is Dictionary and row["expect"].get("boot") is String):
			continue
		var want: Dictionary = row["expect"]["decision"]
		var decision := PKeyDecision.decide_update(row["input"])
		evaluated += 1
		t.check("content row %s" % row["name"], _json_eq(decision, want), JSON.stringify(decision).left(600))
		var boot := PKeyDecision.boot_decision(decision)
		t.check("content row %s boot" % row["name"], boot == row["expect"]["boot"], boot)
		if row["expect"].has("packSetId"):
			var entries: Array = []
			for x in decision.get("set", []):
				entries.append({"packId": x["pack"], "releaseSha256": x["sha256"]})
			t.check("content row %s packSetId" % row["name"], decision.get("action") == "packs" and PKeyPackClaims.pack_set_id(entries) == row["expect"]["packSetId"])
		# Decision 4: a revocation of REQUIRED content is the only thing that stops play.
		var revoked: bool = want.get("reason") == "revoked-content" or want.get("contentBlock") == "revoked-content"
		required_exact = required_exact and ((row["expect"]["boot"] == "required") == revoked)
		floors_usable = floors_usable and PKeyFeed.feed_content(row["input"]["feed"])["packFloors"] != null
		# Without `content` every answer is P3-01's: the content members alone change nothing.
		var plain: Dictionary = (row["input"] as Dictionary).duplicate()
		plain.erase("content")
		var d0 := PKeyDecision.decide_update(plain)
		plain_unchanged = plain_unchanged and d0.get("action") != "packs" and not d0.has("contentBlock")
	t.check("contentRows: required exactly on the revoked-content rows (decision 4)", required_exact)
	t.check("contentRows: every row's feed has usable packFloors", floors_usable)
	t.check("contentRows: without content every answer is P3-01's", plain_unchanged)
	_coverage(t, "contentRows", evaluated, rows.size(), _ms_since(t0))


# ── outlet-matrix.json: the compiled tables ────────────────────────────────────────────────

func _outlet_tables(t: PKeyTestContext, m: Dictionary) -> void:
	t.check("outletMatrixVersion", _json_eq(m.get("outletMatrixVersion"), PKeyConstants.OUTLET_MATRIX_VERSION))
	var kinds := {}
	for kind in PKeyDecision.CAPABILITY_DEFAULTS:
		var row: Dictionary = (PKeyDecision.CAPABILITY_DEFAULTS[kind] as Dictionary).duplicate()
		row["platforms"] = PKeyDecision.OUTLET_PLATFORMS[kind]
		kinds[kind] = row
	t.check("CAPABILITY_DEFAULTS and OUTLET_PLATFORMS equal outlet-matrix kinds", _json_eq(kinds, m.get("kinds")), JSON.stringify(kinds))
	t.check("PLATFORM_NARROWING equals outlet-matrix platformNarrowing", _json_eq(PKeyDecision.PLATFORM_NARROWING, m.get("platformNarrowing")))
	t.check("SUBKIND_NARROWING equals outlet-matrix subkinds", _json_eq(PKeyDecision.SUBKIND_NARROWING, m.get("subkinds")))
	var pd = m.get("platformData")
	t.check("LISTING_URL_PREFIXES equals outlet-matrix platformData.listingUrlPrefixes", pd is Dictionary and _json_eq(PKeyDecision.LISTING_URL_PREFIXES, pd.get("listingUrlPrefixes")))
	var vocab = m.get("vocabulary")
	t.check("outlet-matrix vocabulary kinds, subkinds and confidence equal the generated enums", vocab is Dictionary \
			and _json_eq(vocab.get("kinds"), PKeyConstants.OUTLET_KIND_VALUES) \
			and _json_eq(vocab.get("subkinds"), PKeyConstants.OUTLET_SUBKIND_VALUES) \
			and _json_eq(vocab.get("confidence"), PKeyConstants.OUTLET_CONFIDENCE_VALUES))


# ── outlet-matrix.json: detection (plans/P3-01.md §2.9, P3-11) ─────────────────────────────

func _outlet_detection(t: PKeyTestContext, m: Dictionary) -> void:
	var t0 := Time.get_ticks_usec()
	var names: Array = []
	var specs: Array = []
	for spec in PKeyOutlet.OUTLET_SIGNALS:
		names.append(spec[0])
		specs.append({"signal": spec[0], "confidence": spec[1]})
	var vocab = m.get("vocabulary")
	t.check("OUTLET_SIGNALS is the signal vocabulary, in order", vocab is Dictionary and _json_eq(names, vocab.get("signals")))
	var listed: Array = []
	for s in m.get("signals", []):
		if s is Dictionary:
			listed.append({"signal": s.get("signal"), "confidence": s.get("confidence")})
	t.check("OUTLET_SIGNALS carries each signal's confidence", _json_eq(listed, specs), JSON.stringify(listed))
	var pd = m.get("platformData")
	var data := {}
	if pd is Dictionary:
		data = (pd as Dictionary).duplicate()
		data.erase("listingUrlPrefixes")
	t.check("PLATFORM_DATA equals outlet-matrix platformData", _json_eq(PKeyOutlet.PLATFORM_DATA, data), JSON.stringify(data))
	var rows: Array = m.get("rows", []) if m.get("rows") is Array else []
	var evaluated := 0
	for row in rows:
		if not t.check("outlet-matrix row %s well-formed" % str(row.get("name") if row is Dictionary else row), row is Dictionary and row.get("name") is String and row.get("expect") is Dictionary):
			continue
		evaluated += 1
		var got := PKeyOutlet.detect_outlet(row.get("stamp"), row.get("signals"))
		t.check("detect %s" % row["name"], _json_eq(got, row["expect"]), JSON.stringify(got))
	_coverage(t, "outletRows", evaluated, rows.size(), _ms_since(t0))


# ── timings (INFO): one feed verify and one record verify ──────────────────────────────────

func _update_timings(t: PKeyTestContext, corpus: Dictionary) -> void:
	var feed_case = null
	var record_case = null
	for c in corpus.get("feedCases", []):
		if c is Dictionary and c.get("id") == "feed-valid":
			feed_case = c
	for c in corpus.get("releaseRecordCases", []):
		if c is Dictionary and c.get("id") == "record-valid-app":
			record_case = c
	if not t.check("timings: the control feed and record are present", feed_case != null and record_case != null):
		return
	# Run 0 starts with an empty per-kid key cache (the first decide() of a session); runs 1–8 reuse
	# the decompressed keys. Each run is a feed verify then a record verify, inline on this thread.
	var runs := 9
	var feed_ms: Array = []
	var record_ms: Array = []
	var both_ms: Array = []
	var ok := true
	PKeyJws.clear_key_cache()
	for i in runs:
		var t0 := Time.get_ticks_usec()
		var f := await PKeyFeed.verify_feed(feed_case["jws"], {
			"trust": feed_case["trust"], "expected_aud": feed_case["expectedAud"], "channel": feed_case["channel"],
			"platform": feed_case["platform"], "now": feed_case["now"],
		})
		var t1 := Time.get_ticks_usec()
		var r := await PKeyReleaseRecord.verify_release_record(record_case["jws"], {
			"release_keys": record_case["releaseKeys"], "product_trust": record_case["productTrust"],
			"expected_aud": record_case["expectedAud"], "expected_hash": record_case["expectedHash"], "pin": record_case["pin"],
		})
		var t2 := Time.get_ticks_usec()
		ok = ok and f["ok"] and r["ok"]
		feed_ms.append((t1 - t0) / 1000.0)
		record_ms.append((t2 - t1) / 1000.0)
		both_ms.append((t2 - t0) / 1000.0)
	t.check("timings: every timed verify accepted", ok)
	var cold := [feed_ms[0], record_ms[0], both_ms[0]]
	var warm_feed := feed_ms.slice(1)
	var warm_record := record_ms.slice(1)
	var warm_both := both_ms.slice(1)
	warm_feed.sort()
	warm_record.sort()
	warm_both.sort()
	var mid := 4
	t.info("timing feed+record verify (%s, %s build): cold feed %.2f ms + record %.2f ms = %.2f ms; warm median feed %.2f ms, record %.2f ms, both %.2f ms (min %.2f, max %.2f over %d runs)" % [
		"editor" if OS.has_feature("editor") else "template", "debug" if OS.is_debug_build() else "release",
		cold[0], cold[1], cold[2], warm_feed[mid], warm_record[mid], warm_both[mid], warm_both[0], warm_both[warm_both.size() - 1], warm_both.size()])


## JSON equality by value: every number compared as a number (JSON reads 7 as 7.0), the member
## sets equal, no cross-type `==` (a String against a bool is a runtime error in GDScript).
static func _json_eq(a: Variant, b: Variant) -> bool:
	if PKeyClaims.is_number(a) and PKeyClaims.is_number(b):
		return float(a) == float(b)
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size():
			return false
		for k in a:
			if not b.has(k) or not _json_eq(a[k], b[k]):
				return false
		return true
	if (a is Array or a is PackedStringArray) and (b is Array or b is PackedStringArray):
		if a.size() != b.size():
			return false
		for i in a.size():
			if not _json_eq(a[i], b[i]):
				return false
		return true
	return typeof(a) == typeof(b) and a == b


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
		# The floor is a required option (null: no floor).
		opts["last_accepted_issued_at"] = c.get("lastAcceptedIssuedAt")
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
		# V4 §4.1: the evidence first (ascending manifest issuedAt), then the manifest against the
		# pins minus those tombstones.
		var held := await PKeyTrust.load_pin_revocations(c.get("pinRevocations"), {"pinned": c["pinned"], "expected_aud": "djdl"})
		var opts := {"pinned": c["pinned"], "tombstones": held["tombstones"], "expected_aud": "djdl", "now": c["now"]}
		if c.has("checkFreshness"):
			opts["check_freshness"] = c["checkFreshness"]
		var r := await PKeyTrust.verify_manifest(c["manifestJws"], opts)
		evaluated += 1
		var accepted: bool = r["doc"] != null
		t.check("%s accepted" % id, accepted == c["expect"]["accepted"], "expect=%s got=%s" % [c["expect"]["accepted"], accepted])
		var tombstones: Array = held["tombstones"].duplicate()
		for kid in r["revoked_pins"]:
			if not tombstones.has(kid):
				tombstones.append(kid)
		tombstones = PKeyTrust.sort_kids(tombstones)
		var want_revoked: Array = c["expect"].get("revokedPins", [])
		t.check("%s revokedPins" % id, tombstones == want_revoked, "got %s" % JSON.stringify(tombstones))
		# Accepted: the discovered set REPLACES what was held; rejected: it is untouched. Either way
		# the pins are the USABLE ones: a tombstoned pin is in no set.
		var discovered: Dictionary = r["discovered"] if accepted else c["before"]
		var merged := PKeyTrust.merge(PKeyTrust.usable_pins(c["pinned"], tombstones), discovered)
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
			"last_accepted_issued_at": null,
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
		var held := await PKeyTrust.load_pin_revocations(c.get("pinRevocations"), {"pinned": c["pinned"], "expected_aud": c["expectedAud"]})
		var floors: Dictionary = c.get("floors", {"license": null, "config": null})
		var r := await PKeyBundle.inspect(c["bundleJws"], {
			"pinned": c["pinned"], "tombstones": held["tombstones"], "product": c["expectedAud"], "device_id": c["deviceId"],
			"now": c["now"], "floors": floors, "profile": c.get("profile", "import"),
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


# ── headers.json (WIRE-CONTRACT-V3 §5.2) ──────────────────────────────────────────────────────

## ASCII-only folding, restated so the runner does not lean on the code it checks.
static func _fold(raw: String) -> String:
	var out := ""
	for i in raw.length():
		var c := raw.unicode_at(i)
		out += String.chr(c + 32) if c >= 65 and c <= 90 else String.chr(c)
	return out


## The addon answers "" for "no value"; the corpus writes null.
static func _header_passes(fn: Callable, row: Dictionary) -> bool:
	var got: String = fn.call(String(row["raw"]))
	var want = row["expect"]
	return got == "" if want == null else got == String(want)


func _header_cases(t: PKeyTestContext, corpus: Dictionary) -> void:
	t.check("headersVersion", corpus.get("headersVersion") is float and int(corpus["headersVersion"]) == HEADERS_VERSION, str(corpus.get("headersVersion")))
	for spec in [
		["platformCases", PKeyHeaders.canonical_platform, PKeyConstants.PLATFORM_SPELLINGS, PKeyConstants.PLATFORM_VALUES],
		["archCases", PKeyHeaders.canonical_arch, PKeyConstants.ARCH_SPELLINGS, PKeyConstants.ARCH_VALUES],
	]:
		var name: String = spec[0]
		var fn: Callable = spec[1]
		var table: Dictionary = spec[2]
		var values: Array = spec[3]
		var rows := _section(t, corpus, name)
		var started := Time.get_ticks_usec()
		var evaluated := 0
		var derived := {}
		for row in rows:
			t.check("%s %s" % [name, row["id"]], _header_passes(fn, row), "raw %s -> %s" % [JSON.stringify(row["raw"]), fn.call(String(row["raw"]))])
			if row["expect"] != null:
				derived[_fold(String(row["raw"]))] = String(row["expect"])
			evaluated += 1
		_coverage(t, name, evaluated, rows.size(), (Time.get_ticks_usec() - started) / 1000.0)
		var in_vocabulary := true
		for v in table.values():
			in_vocabulary = in_vocabulary and values.has(v)
		t.check("%s: the generated table equals the rows" % name, table == derived and in_vocabulary, "%s vs %s" % [table, derived])
		var sample: Dictionary = {}
		for row in rows:
			if row["expect"] != null:
				sample = row
				break
		var doctored := sample.duplicate()
		doctored["expect"] = "macos" if sample["expect"] == "linux" else "linux"
		t.check("%s: a doctored row fails the same comparison" % name, _header_passes(fn, sample) and not _header_passes(fn, doctored))
	# WIRE-CONTRACT-V4 §5.2 rule 5: the update platform is the header value only for a build
	# target; tvos, visionos and watchos are header values only (SP-08).
	for v in ["macos", "ios", "android", "windows", "linux", "web"]:
		t.check("update_platform_for(%s) is itself" % v, PKeyHeaders.update_platform_for(v) == v, PKeyHeaders.update_platform_for(v))
	for v in ["tvos", "visionos", "watchos", ""]:
		t.check("update_platform_for(%s) is none" % JSON.stringify(v), PKeyHeaders.update_platform_for(v) == "", PKeyHeaders.update_platform_for(v))
	t.check("update_platform() follows platform() on a build target", PKeyHeaders.update_platform() == PKeyHeaders.update_platform_for(PKeyHeaders.platform()), PKeyHeaders.update_platform())


# ── gate-matrix (§5, §5.1): the build-gate port and the licence gate ─────────────────────
#
# Each row pairs build-gate inputs (`gate`) with licence inputs (`license`). The build gate is
# the SERVER's (packages/worker/src/core/gate.ts `checkBuildGate`, replayed against these same
# rows by packages/worker/test/gateMatrixCorpus.test.ts), ported here from the SDK's own
# PKeySemver and PKeyChannel; clients never compute it, they record the Worker's 403. Its
# verdict feeds PKeyGate.license_state as the `blocked` hint. `expect.reason` describes the
# derived hint, which on the activation-precedes-blocked row is deliberately not the status.

## The rows P0-04 appended to gate-matrix v2 (WIRE-CONTRACT-V3 §5.1), and the carried row it
## retired (the pre-R3-01 dev bypass).
const P0_04_CHANNEL_ROWS := [
	"ok — beta header, channels [stable, beta]",
	"ok — beta header, channels [stable, staging] (alias)",
	"ok — staging header, channels [stable, beta] (alias)",
	"channel-not-entitled — beta header, channels [stable]",
	"ok — manual channel header, entitled by name",
	"channel-not-entitled — manual channel header, not entitled",
	"channel-not-entitled — malformed channel header",
	"ok — 0.0.0-beta build with beta entitlement",
	"channel-not-entitled — 0.0.0-beta build without a beta entitlement",
	"ok — 0.0.0-staging build is the beta channel, channels [stable, beta]",
	"ok — latest header is the stable channel",
	"ok — pr-42 header, channels grant the pr family",
	"ok — pr header on a 0.0.0-pr-42 build, channels [stable, pr-42]",
	"channel-not-entitled — pr-7 header, channels grant only pr-42",
	"channel-not-entitled — stable header cannot loosen a 0.0.0-pr-42 build",
	"channel-not-entitled — dev header without the dev entitlement",
	"version-too-old — dev build without the dev entitlement gets no bypass (R3-01)",
	"ok — dev build with the dev entitlement bypasses the window (R3-01)",
]
const RETIRED_ROW := "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel"


func _gate_matrix(t: PKeyTestContext, matrix: Dictionary) -> void:
	t.check("gateMatrixVersion", PKeyClaims.is_number(matrix.get("gateMatrixVersion")) and int(matrix["gateMatrixVersion"]) == PKeyConstants.GATE_MATRIX_VERSION, str(matrix.get("gateMatrixVersion")))
	var rows: Array = _section(t, matrix, "rows")
	var names: Array = []
	var evaluated := 0
	var t0 := Time.get_ticks_usec()
	for i in rows.size():
		var row = rows[i]
		if not t.check("gate-matrix %d well-formed" % i, _matrix_row_ok(row)):
			continue
		var name: String = row["name"]
		names.append(name)
		var g: Dictionary = row["gate"]
		var l: Dictionary = row["license"]
		var expect: Dictionary = row["expect"]
		var blocked = check_build_gate(g)
		var doc = null
		if l.has("issuedAt") and l.has("expiresAt") and l.has("graceUntil"):
			doc = {
				"aud": "djdl", "iss": "key.plrs.im", "licenseId": "lic_matrix", "deviceId": "dev_matrix",
				"issuedAt": l["issuedAt"], "expiresAt": l["expiresAt"], "graceUntil": l["graceUntil"], "entitlements": {},
			}
		var state := PKeyGate.license_state({
			"license_service_enabled": l["licenseServiceEnabled"],
			"activation": l.get("activation"),
			"doc": doc,
			"now": l["now"],
			"last_sync_unauthorized": l.get("lastSyncUnauthorized", false),
			"last_verified_at": l.get("lastVerifiedAt"),
			"blocked": blocked,
		})
		evaluated += 1
		t.check("%s status" % name, state["status"] == expect["status"], "expect=%s got=%s" % [expect["status"], state["status"]])
		t.check("%s ok" % name, PKeyGate.is_usable(state) == expect["ok"], "usable=%s" % PKeyGate.is_usable(state))
		if expect.has("reason"):
			var got = blocked["reason"] if blocked is Dictionary else null
			t.check("%s reason" % name, got is String and got == expect["reason"], "expect=%s got=%s" % [expect["reason"], str(got)])
		t.check("%s allowedRange" % name, _same(state.get("allowed_range"), expect.get("allowedRange")), "expect=%s got=%s" % [JSON.stringify(expect.get("allowedRange")), JSON.stringify(state.get("allowed_range"))])
	_coverage(t, "gate-matrix", evaluated, rows.size(), _ms_since(t0))
	var missing := P0_04_CHANNEL_ROWS.filter(func(n): return not names.has(n))
	t.check("gate-matrix carries every P0-04 channel row", missing.is_empty(), JSON.stringify(missing))
	t.check("gate-matrix no longer carries the retired dev-bypass row", not names.has(RETIRED_ROW))
	# The port is not vacuous: a malformed header and an unentitled channel are refused, the
	# window still applies to a dev build without the dev grant, and the grant reopens it.
	var base := {"version": "2.0.0", "compatMin": "1.0.0", "compatMax": "3.0.0", "entitlements": {}}
	t.check("gate port: a well-formed stable build passes", not (check_build_gate(base) is Dictionary))
	t.check("gate port: the dev grant reopens the window for a dev build", not (check_build_gate(dev_base().merged({"entitlements": _grant(["dev"])}, true)) is Dictionary))
	t.check("gate port: a malformed header is refused", _reason(check_build_gate(base.merged({"channel": "Beta"}, true))) == "channel-not-entitled")
	t.check("gate port: a header with a trailing newline is refused", _reason(check_build_gate(base.merged({"channel": "beta\n"}, true))) == "channel-not-entitled")
	t.check("gate port: an unknown name is not stable", _reason(check_build_gate(base.merged({"channel": "nightly"}, true))) == "channel-not-entitled")
	var dev := dev_base()
	t.check("gate port: a dev build without the dev grant meets the window", _reason(check_build_gate(dev)) == "version-too-old")
	t.check("gate port: allowDevBuilds opens the bypass (server override)", not (check_build_gate(dev.merged({"allowDevBuilds": true}, true)) is Dictionary))
	t.check("gate port: allowDevBuilds false closes it even with the grant", _reason(check_build_gate(dev.merged({"allowDevBuilds": false, "entitlements": _grant(["dev"])}, true))) == "version-too-old")


static func _matrix_row_ok(row) -> bool:
	if not (row is Dictionary and row.get("name") is String and row.get("gate") is Dictionary \
			and row.get("license") is Dictionary and row.get("expect") is Dictionary):
		return false
	var g: Dictionary = row["gate"]
	var l: Dictionary = row["license"]
	var e: Dictionary = row["expect"]
	return g.get("version") is String and g.get("compatMin") is String and g.get("compatMax") is String \
			and g.get("entitlements") is Dictionary and (not g.has("channel") or g["channel"] is String) \
			and l.get("licenseServiceEnabled") is bool and PKeyClaims.is_number(l.get("now")) \
			and e.get("status") is String and e.get("ok") is bool


static func dev_base() -> Dictionary:
	return {"version": "0.0.0-dev.1", "compatMin": "5.0.0", "compatMax": "6.0.0", "entitlements": {}}


## Equal JSON values, without GDScript's cross-type `==` errors (a Dictionary against null).
static func _same(a: Variant, b: Variant) -> bool:
	return typeof(a) == typeof(b) and (a == null or a == b)


static func _reason(blocked: Variant) -> Variant:
	return blocked["reason"] if blocked is Dictionary else null


static func _grant(names: Array) -> Dictionary:
	return {"channels": {"state": "default", "value": names, "updatedAt": 1699990000}}


## The server's `checkBuildGate` over a row's `gate` block: null when the build passes, else
## {reason, allowedRange?}. WIRE-CONTRACT-V3 §5.1 rule 5, in order: the dev bypass
## (`allowDevBuilds ?? granted includes "dev"`), the version window (product compat range
## intersected with the grant's app.min/maxVersion, tighter wins), a malformed header, then
## every channel in {build-implied, header} against the grant.
static func check_build_gate(g: Dictionary) -> Variant:
	var version: String = g["version"]
	var ents: Dictionary = g["entitlements"]
	var granted := PKeyChannel.granted(ents)
	var dev_allowed: bool = g["allowDevBuilds"] if g.get("allowDevBuilds") is bool else granted.has(PKeyConstants.CHANNEL_DEV)
	if PKeySemver.is_dev_build(version) and dev_allowed:
		return null
	var lo := _tighter(g["compatMin"], _str_ent(ents, "app.minVersion"), 1)
	var hi := _tighter(g["compatMax"], _str_ent(ents, "app.maxVersion"), -1)
	var allowed := {}
	if lo != "":
		allowed["min"] = lo
	if hi != "":
		allowed["max"] = hi
	var below := lo != "" and PKeySemver.compare(version, lo) < 0
	var above := hi != "" and PKeySemver.compare(version, hi) > 0
	if below or above:
		return {"reason": "version-too-old" if below else "version-too-new", "allowedRange": allowed}
	var declared = null
	if g.has("channel"):
		declared = PKeyChannel.normalize_header(g["channel"], version)
		if declared == null:
			return {"reason": "channel-not-entitled"}
	for channel in [PKeyChannel.implied(version), declared]:
		if channel != null and not PKeyChannel.entitled(granted, channel):
			return {"reason": "channel-not-entitled"}
	return null


static func _str_ent(ents: Dictionary, key: String) -> String:
	var e = ents.get(key)
	return e["value"] if e is Dictionary and e.get("value") is String else ""


## The tighter bound of `a` and `b` ("" is absent): the higher minimum (`sign` 1) or the lower
## maximum (`sign` -1), the first argument winning a tie, as the Worker's tighterMin/tighterMax.
static func _tighter(a: String, b: String, sign: int) -> String:
	if a == "":
		return b
	if b == "":
		return a
	return a if PKeySemver.compare(a, b) * sign >= 0 else b
