extends RefCounted

func run(args: PackedStringArray) -> void:
	PKEd25519Fast.warmup()
	var F = PKEd25519Fast
	var a := F.fe_new(); var b := F.fe_new(); var c := F.fe_new()
	for i in 10:
		a[i] = 1234567 + i * 1000; b[i] = 7654321 - i * 999
	var N := 20000
	var t0 := Time.get_ticks_usec()
	for i in N: F.fe_mul(c, a, b)
	var t1 := Time.get_ticks_usec()
	for i in N: F.fe_sq(c, a)
	var t2 := Time.get_ticks_usec()
	for i in N: F.fe_add(c, a, b)
	var t3 := Time.get_ticks_usec()
	print("fe_mul: %.2f us  fe_sq: %.2f us  fe_add: %.2f us" % [(t1 - t0) / float(N), (t2 - t1) / float(N), (t3 - t2) / float(N)])
	# TweetNaCl M for comparison
	var R = PKEd25519Ref
	var ga := R.gf(); var gb := R.gf(); var gc := R.gf()
	for i in 16:
		ga[i] = 1000 + i; gb[i] = 60000 - i
	t0 = Time.get_ticks_usec()
	for i in 5000: R.M(gc, ga, gb)
	t1 = Time.get_ticks_usec()
	print("tweetnacl M (looped, 16 limbs): %.2f us" % [(t1 - t0) / 5000.0])
	# Phase breakdown on RFC TEST 2
	var pk := "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c".hex_decode()
	var sig := "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00".hex_decode()
	var msg := "72".hex_decode()
	var reps := 20
	var tA := 0; var tH := 0; var tD := 0; var tB := 0
	for r in reps:
		var s0 := Time.get_ticks_usec()
		var A := F._pt(4)
		F.ge_frombytes_negate_vartime(A, pk)
		var s1 := Time.get_ticks_usec()
		var hin := sig.slice(0, 32); hin.append_array(pk); hin.append_array(msg)
		var h := F.sc_reduce(PKSha512.hash(hin))
		var s2 := Time.get_ticks_usec()
		var Rp := F._pt(3)
		F.ge_double_scalarmult_vartime(Rp, h, A, sig.slice(32, 64))
		var s3 := Time.get_ticks_usec()
		var chk := PackedByteArray(); chk.resize(32)
		F.ge_tobytes(chk, Rp)
		var s4 := Time.get_ticks_usec()
		tA += s1 - s0; tH += s2 - s1; tD += s3 - s2; tB += s4 - s3
		assert(chk == sig.slice(0, 32))
	print("phases (avg ms): decompress A %.2f | sha512+reduce %.2f | double-scalarmult %.2f | encode (invert) %.2f" % [tA / 1000.0 / reps, tH / 1000.0 / reps, tD / 1000.0 / reps, tB / 1000.0 / reps])
