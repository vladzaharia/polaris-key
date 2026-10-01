extends RefCounted
# SHA-512 known-answer vectors (vectors/sha512.json) through PKeySha512. Timing is INFO only.

const VECTORS := "res://tests/vectors/sha512.json"
const FLOOR := 24


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var j := JSON.new()
	var err := j.parse(FileAccess.get_file_as_string(VECTORS))
	if not t.check("vectors parse", err == OK and j.data is Array, VECTORS):
		return true
	var cases: Array = j.data
	var evaluated := 0
	for i in cases.size():
		var c = cases[i]
		if not t.check("vector %d well-formed" % i, c is Dictionary and c.get("msg") is String and c.get("sha512") is String):
			continue
		var m: PackedByteArray = String(c["msg"]).hex_decode()
		var t0 := Time.get_ticks_usec()
		var got := PKeySha512.hash(m).hex_encode()
		var dt := (Time.get_ticks_usec() - t0) / 1000.0
		t.check("len=%d" % m.size(), got == c["sha512"], "%.2f ms" % dt if got == c["sha512"] else "got " + got)
		evaluated += 1
	t.check("coverage", evaluated == cases.size() and evaluated >= FLOOR, "%d/%d evaluated, floor %d" % [evaluated, cases.size(), FLOOR])
	var big := PackedByteArray()
	big.resize(262144)
	var t1 := Time.get_ticks_usec()
	PKeySha512.hash(big)
	t.info("SHA-512 of 256 KiB: %.1f ms" % ((Time.get_ticks_usec() - t1) / 1000.0))
	return true
