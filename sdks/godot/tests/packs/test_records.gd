extends RefCounted
# @pkey-feature packs.record
# The pack records and markers of cases.json (V4 §3.5 steps 12–15 with `pin.kind`, §3.7;
# plans/P4-01.md §4.6): every packRecordCases vector through PKeyReleaseRecord (the pack claims
# included) and every markerCases vector through PKeyPackMarker.verify_marker, as the Node
# runner's "pack records and markers" section does. (The conformance suite already holds their
# non-wire-integer pointer sets.)

const S := preload("res://tests/packs/support.gd")
const CASES := "res://tests/corpus/v2/cases.json"


func run(t: PKeyTestContext) -> void:
	var corpus = S.read_json(CASES)
	if not t.check("records: cases.json parses", corpus is Dictionary):
		return
	var records: Array = corpus.get("packRecordCases", [])
	var markers: Array = corpus.get("markerCases", [])
	t.check("records: 170 pack-record and 17 marker cases", records.size() == 170 and markers.size() == 17, "%d/%d" % [records.size(), markers.size()])
	var started := Time.get_ticks_usec()
	var n := 0
	for c in records:
		var opts := {
			"release_keys": c["releaseKeys"], "product_trust": c["productTrust"],
			"expected_aud": c["expectedAud"], "expected_hash": c["expectedHash"],
		}
		if c.get("pin") is Dictionary:
			opts["pin"] = c["pin"]
		var r: Dictionary = await PKeyReleaseRecord.verify_release_record(c["jws"], opts)
		var want: Dictionary = c["expect"]
		if want["verify"] == "ok":
			var ok: bool = r["ok"] and PKeyPackClaims.same(r["record"].get("kind"), want.get("kind"))
			if ok and want.has("doc"):
				ok = S.same(r["record"], want["doc"])
			t.check("record %s → ok" % c["id"], ok, S.canon(r).left(300))
		else:
			t.check("record %s → %s" % [c["id"], want["step"]], not r["ok"] and r.get("step") == want["step"], S.canon(r).left(200))
		n += 1
	for c in markers:
		var r: Dictionary = await PKeyPackMarker.verify_marker(c["marker"], {"release_keys": c["releaseKeys"], "product_trust": c["productTrust"], "expected_aud": c["expectedAud"]})
		var want: Dictionary = c["expect"]
		if want["verify"] == "ok":
			var got := {"verify": "ok", "packId": r.get("packId"), "version": r.get("version"), "recordSha256": r.get("recordSha256")} if r["ok"] else r
			t.check("marker %s → ok" % c["id"], r["ok"] and S.same(got, want) and PKeyPackClaims.same(r["record"].get("kind"), "pack"), S.canon(got))
		else:
			t.check("marker %s → %s" % [c["id"], want["step"]], S.same(r, {"ok": false, "error": "marker-rejected", "step": want["step"]}), S.canon(r))
		n += 1
	t.info("records: %d evaluated in %.1f ms" % [n, (Time.get_ticks_usec() - started) / 1000.0])
	t.check("records: coverage", n == records.size() + markers.size() and n >= 176, "%d evaluated" % n)
