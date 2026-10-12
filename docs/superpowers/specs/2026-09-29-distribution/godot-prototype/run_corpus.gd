extends SceneTree
## Drives conformance/corpus/v2/cases.json through the GDScript verifier, mirroring
## conformance/runners/node/corpusV2.test.ts for the jws / license / config / trust sections.

const Jws := preload("res://addons/polaris_key/core/jws.gd")

var fails := 0
var total := 0


func _eq(a: Variant, b: Variant) -> bool:
	var na := typeof(a) == TYPE_INT or typeof(a) == TYPE_FLOAT
	var nb := typeof(b) == TYPE_INT or typeof(b) == TYPE_FLOAT
	if na and nb:
		return float(a) == float(b)
	if typeof(a) != typeof(b):
		return false
	if a is Dictionary:
		if a.size() != b.size():
			return false
		for k in a:
			if not b.has(k) or not _eq(a[k], b[k]):
				return false
		return true
	if a is Array:
		if a.size() != b.size():
			return false
		for i in a.size():
			if not _eq(a[i], b[i]):
				return false
		return true
	return a == b


func _check(id: String, cond: bool, detail := "") -> void:
	total += 1
	if not cond:
		fails += 1
		print("FAIL ", id, " ", detail)


func _opts(c: Dictionary) -> Dictionary:
	var o := {"trust": c["trust"], "expectedAud": c["expectedAud"], "deviceId": c["deviceId"], "now": c["now"]}
	for k in ["expectedIss", "lastAcceptedIssuedAt", "checkFreshness"]:
		if c.has(k):
			o[k] = c[k]
	return o


func _init() -> void:
	var corpus: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://cases.json"))
	var t0 := Time.get_ticks_msec()
	for c in corpus["jwsCases"]:
		var r := Jws.verify_jws(c["jws"], c["trust"], c["typ"], int(c.get("maxPayloadBytes", 0)) if c.get("maxPayloadBytes") != null else 0)
		if c["expect"]["verify"] == "ok":
			var good: bool = not r.is_empty() and r["kid"] == c["expect"]["kid"]
			if good and c["expect"].has("doc"):
				good = _eq(r["payload"], c["expect"]["doc"])
			_check("jws/" + c["id"], good)
		else:
			_check("jws/" + c["id"], r.is_empty(), "should fail")
	for c in corpus["licenseDocCases"]:
		var d: Variant = Jws.verify_doc(c["jws"], "pkey-license+jws", _opts(c))
		_check("license/" + c["id"], (d != null) == bool(c["expect"]["accept"]))
	for c in corpus["configDocCases"]:
		var d: Variant = Jws.verify_doc(c["jws"], "pkey-config+jws", _opts(c))
		_check("config/" + c["id"], (d != null) == bool(c["expect"]["accept"]))
	for c in corpus["trustCases"]:
		var o := {"pinned": c["pinned"], "expectedAud": "djdl", "now": c["now"]}
		if c.has("checkFreshness"):
			o["checkFreshness"] = c["checkFreshness"]
		var r := Jws.verify_trust_manifest(c["manifestJws"], o)
		var accepted: bool = r["doc"] != null
		var discovered: Dictionary = r["discovered"] if accepted else c["before"]
		var good := accepted == bool(c["expect"]["accepted"]) and _eq(Jws.merge_trust(c["pinned"], discovered), c["expect"]["trust"])
		if good and c["expect"].has("issuedAt") and accepted:
			good = _eq(r["doc"]["issuedAt"], c["expect"]["issuedAt"])
		_check("trust/" + c["id"], good)
	print("corpus: %d/%d passed in %d ms" % [total - fails, total, Time.get_ticks_msec() - t0])
	quit(1 if fails > 0 else 0)
