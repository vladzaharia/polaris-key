extends RefCounted
# Every `jwsCases` entry of the generator-owned corpus mirror (res://tests/corpus/v2/cases.json,
# written by `pnpm gen:corpus`; never edit it) through PKeyJws.verify: the verdict, the `kid` on
# `ok`, and the decoded document. Under WIRE-CONTRACT-V3 §10, each string the generator lists in
# `expect.docNulReplaced` is compared in its U+FFFD form, exactly. No case id appears here: the
# corpus decides what is tested.

const CASES := "res://tests/corpus/v2/cases.json"
const CORPUS_VERSION := 2
const FLOOR := 36


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	if not t.check("corpus present", FileAccess.file_exists(CASES), CASES):
		return true
	t.info("corpus sha256=%s" % FileAccess.get_sha256(CASES))
	var j := JSON.new()
	var err := j.parse(FileAccess.get_file_as_string(CASES))
	if not t.check("corpus parses", err == OK and j.data is Dictionary, "error %d at line %d" % [err, j.get_error_line()]):
		return true
	var corpus: Dictionary = j.data
	t.check("corpusVersion", corpus.get("corpusVersion") is float and int(corpus["corpusVersion"]) == CORPUS_VERSION, str(corpus.get("corpusVersion")))
	if not t.check("jwsCases present", corpus.get("jwsCases") is Array):
		return true
	var cases: Array = corpus["jwsCases"]

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
	var total_ms := 0.0
	for i in cases.size():
		var c = cases[i]
		if not t.check("case %d well-formed" % i, _well_formed(c)):
			continue
		var id: String = c["id"]
		var expect: Dictionary = c["expect"]
		var typ: String = c.get("typ", "")
		var max_payload := int(c.get("maxPayloadBytes", 0))
		var t0 := Time.get_ticks_usec()
		var r = PKeyJws.verify(c["jws"], c["trust"], typ, max_payload)
		total_ms += (Time.get_ticks_usec() - t0) / 1000.0
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
	t.info("%d cases verified in %.1f ms; %d with docNulReplaced" % [evaluated, total_ms, annotated])
	t.check("coverage", evaluated == cases.size() and evaluated >= FLOOR, "%d/%d evaluated, floor %d" % [evaluated, cases.size(), FLOOR])
	return true


static func _well_formed(c) -> bool:
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
