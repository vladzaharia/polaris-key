extends RefCounted
# Ed25519 vectors (vectors/ed25519.json: RFC 8032 plus edge cases, verdicts from Node/OpenSSL)
# through both verifiers, PKeyEd25519 and PKeyEd25519Ref. Timing is INFO only.
# args: [bench <iterations>] adds a timing loop on two vectors (S-04).

const VECTORS := "res://tests/vectors/ed25519.json"
const FLOOR := 26


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var j := JSON.new()
	var err := j.parse(FileAccess.get_file_as_string(VECTORS))
	if not t.check("vectors parse", err == OK and j.data is Array, VECTORS):
		return true
	var cases: Array = j.data
	var t_init := Time.get_ticks_usec()
	PKeyEd25519.warmup()
	t.info("PKeyEd25519 one-time table init %.2f ms" % ((Time.get_ticks_usec() - t_init) / 1000.0))
	var bench_iters := int(args[1]) if args.size() > 1 and args[0] == "bench" else 0
	for impl_name in ["PKeyEd25519", "PKeyEd25519Ref"]:
		var impl = PKeyEd25519 if impl_name == "PKeyEd25519" else PKeyEd25519Ref
		var evaluated := 0
		for i in cases.size():
			var c = cases[i]
			var shape_ok: bool = c is Dictionary and c.get("name") is String and c.get("pk") is String \
					and c.get("msg") is String and c.get("sig") is String and c.get("expect") is bool
			if not t.check("%s vector %d well-formed" % [impl_name, i], shape_ok):
				continue
			var t0 := Time.get_ticks_usec()
			var got: bool = impl.verify(String(c["sig"]).hex_decode(), String(c["msg"]).hex_decode(), String(c["pk"]).hex_decode())
			var dt := (Time.get_ticks_usec() - t0) / 1000.0
			t.check("%s %s" % [impl_name, c["name"]], got == c["expect"], "expect=%s got=%s %.2f ms" % [c["expect"], got, dt])
			evaluated += 1
		t.check("%s coverage" % impl_name, evaluated == cases.size() and evaluated >= FLOOR, "%d/%d evaluated, floor %d" % [evaluated, cases.size(), FLOOR])
		if bench_iters > 0:
			_bench(t, impl_name, impl, cases, bench_iters)
	return true


func _bench(t: PKeyTestContext, impl_name: String, impl, cases: Array, iters: int) -> void:
	# RFC 8032 TEST 2 (1-byte message) and a ~1 KiB message, as in the prototype.
	for idx in [1, 15]:
		if idx >= cases.size():
			continue
		var c: Dictionary = cases[idx]
		var sig: PackedByteArray = String(c["sig"]).hex_decode()
		var msg: PackedByteArray = String(c["msg"]).hex_decode()
		var pk: PackedByteArray = String(c["pk"]).hex_decode()
		var times: Array[float] = []
		var all_ok := true
		for i in iters:
			var t0 := Time.get_ticks_usec()
			all_ok = impl.verify(sig, msg, pk) and all_ok
			times.append((Time.get_ticks_usec() - t0) / 1000.0)
		t.check("%s bench %s verifies" % [impl_name, c["name"]], all_ok)
		times.sort()
		var total := 0.0
		for x in times:
			total += x
		t.info("%s bench %s (msg %d B) x%d: min %.2f ms, median %.2f ms, mean %.2f ms" % [
			impl_name, c["name"], msg.size(), iters, times[0], times[times.size() / 2], total / times.size()])
