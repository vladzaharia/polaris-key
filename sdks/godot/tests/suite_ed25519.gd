extends RefCounted
# args: ref|fast [bench_iters]

func run(args: PackedStringArray) -> void:
	var impl_name: String = args[0] if args.size() > 0 else "ref"
	var iters: int = int(args[1]) if args.size() > 1 else 5
	var impl = PKeyEd25519Ref if impl_name == "ref" else PKeyEd25519
	if impl_name == "fast":
		var t_init := Time.get_ticks_usec()
		PKeyEd25519.warmup()
		print("fast: one-time table init %.2f ms" % ((Time.get_ticks_usec() - t_init) / 1000.0))
	var cases = JSON.parse_string(FileAccess.get_file_as_string("res://vectors/ed25519.json"))
	var ok := 0
	for c in cases:
		var sig: PackedByteArray = String(c.sig).hex_decode()
		var msg: PackedByteArray = String(c.msg).hex_decode()
		var pk: PackedByteArray = String(c.pk).hex_decode()
		var t0 := Time.get_ticks_usec()
		var got: bool = impl.verify(sig, msg, pk)
		var dt := (Time.get_ticks_usec() - t0) / 1000.0
		var pass_: bool = got == bool(c.expect)
		if pass_: ok += 1
		print("%-4s %-45s expect=%-5s got=%-5s %7.2f ms" % ["PASS" if pass_ else "FAIL", c.name, c.expect, got, dt])
	print("[%s] Ed25519 vectors: %d/%d passed" % [impl_name, ok, cases.size()])
	# Benchmark on RFC TEST 2 (1-byte message) and a ~1 KiB message.
	for idx in [1, 15]:
		var c = cases[idx]
		var sig: PackedByteArray = String(c.sig).hex_decode()
		var msg: PackedByteArray = String(c.msg).hex_decode()
		var pk: PackedByteArray = String(c.pk).hex_decode()
		var times := []
		for i in iters:
			var t0 := Time.get_ticks_usec()
			var r: bool = impl.verify(sig, msg, pk)
			times.append((Time.get_ticks_usec() - t0) / 1000.0)
			assert(r)
		times.sort()
		var s := 0.0
		for t in times: s += t
		print("[%s] bench %s (msg %d B) x%d: min %.2f ms, median %.2f ms, mean %.2f ms" % [impl_name, c.name, msg.size(), iters, times[0], times[times.size() / 2], s / times.size()])
