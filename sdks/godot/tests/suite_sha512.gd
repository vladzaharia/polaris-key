extends RefCounted

func run(args: PackedStringArray) -> void:
	var cases = JSON.parse_string(FileAccess.get_file_as_string("res://vectors/sha512.json"))
	var ok := 0
	for c in cases:
		var m: PackedByteArray = String(c.msg).hex_decode()
		var t0 := Time.get_ticks_usec()
		var d := PKeySha512.hash(m)
		var dt := Time.get_ticks_usec() - t0
		var pass_: bool = d.hex_encode() == c.sha512
		if pass_: ok += 1
		print("len=%d %s %.2f ms" % [m.size(), "PASS" if pass_ else "FAIL got " + d.hex_encode(), dt / 1000.0])
	print("SHA-512: %d/%d passed" % [ok, cases.size()])
	# throughput
	var big := PackedByteArray(); big.resize(262144)
	var t1 := Time.get_ticks_usec()
	PKeySha512.hash(big)
	print("SHA-512 of 256 KiB: %.1f ms" % ((Time.get_ticks_usec() - t1) / 1000.0))
