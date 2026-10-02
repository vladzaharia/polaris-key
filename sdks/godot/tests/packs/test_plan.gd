extends RefCounted
# @pkey-feature packs.plan
# plan-matrix.json (the generator-owned mirror; plans/P4-01.md §4.5): every planner row,
# variant case and target case through PKeyPackSelect, compared by canonical JSON, as
# conformance/runners/node/suites.ts does. Plan matrix v2 (plans/P4-10.md §4.4) adds the chunk
# rows and plan_target's chunk rule (`chunkIndex`).

const S := preload("res://tests/packs/support.gd")
const PLAN_MATRIX := "res://tests/corpus/v2/plan-matrix.json"


func run(t: PKeyTestContext) -> void:
	var m = S.read_json(PLAN_MATRIX)
	if not t.check("plan: plan-matrix.json parses", m is Dictionary):
		return
	t.info("plan-matrix.json sha256=%s" % FileAccess.get_sha256(PLAN_MATRIX))
	t.check("plan: planMatrixVersion", PKeyPackClaims.same(m.get("planMatrixVersion"), PKeyConstants.PLAN_MATRIX_VERSION), str(m.get("planMatrixVersion")))
	t.check("plan: requestWeight", PKeyPackClaims.same(m.get("requestWeight"), PKeyConstants.PLAN_REQUEST_WEIGHT), str(m.get("requestWeight")))
	var rows: Array = m.get("rows", [])
	var variants: Array = m.get("variantCases", [])
	var targets: Array = m.get("targetCases", [])
	t.check("plan: 28 rows, 11 variant cases, 22 target cases", rows.size() == 28 and variants.size() == 11 and targets.size() == 22, "%d/%d/%d" % [rows.size(), variants.size(), targets.size()])
	var started := Time.get_ticks_usec()
	var n := 0
	for row in rows:
		var got := PKeyPackSelect.plan(row["input"].duplicate(true))
		S.check_same(t, "plan row %s" % row["id"], got, row["expect"])
		n += 1
	for c in variants:
		var got := PKeyPackSelect.select_variant(c["variants"], c["prefs"])
		S.check_same(t, "plan variant %s" % c["id"], got, c["expect"])
		n += 1
	for c in targets:
		# plans/P4-10.md §4.4: `chunkIndex` is absent (null) on the cases before P4-10.
		var got := PKeyPackSelect.plan_target(c["variant"], c["recordSha256"], c["filesIndex"], c.get("chunkIndex"))
		S.check_same(t, "plan target %s" % c["id"], got, c["expect"])
		n += 1
	t.info("plan-matrix: %d evaluated in %.1f ms" % [n, (Time.get_ticks_usec() - started) / 1000.0])
	t.check("plan: coverage", n == rows.size() + variants.size() + targets.size() and n >= 50, "%d evaluated" % n)
