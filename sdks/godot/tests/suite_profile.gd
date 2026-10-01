extends RefCounted
# Timings (not in the `ci` set; INFO lines, with a few checks that the measured paths worked):
#   PKEY_TEST_SUITES=profile GODOT_TEMPLATE=… sdks/godot/tools/run_tests.sh
#
#   1. the session's verifications (P1-02): the trust manifest, the licence and the config
#      document from the sync-etag-304 transcript, cold (key not yet prepared) and warm (the
#      per-kid cache), median of RUNS;
#   2. a 350 KB bundle import (`bundle-payload-at-cap`, which fails at the claims step only
#      after the full signature check) through PolarisKey.import_bundle, inline, on a worker
#      thread and sliced, with the frames that passed and the worst frame while it ran;
#   3. field arithmetic and the verify phases of both Ed25519 verifiers (P1-01).

const RUNS := 9


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _session(t)
	await _bundle(t)
	_arith(t)
	return true


func _session(t: PKeyTestContext) -> void:
	var f := PKeyTestFixtures.sync_docs()
	if not t.check("profile: sync fixtures present", not f.is_empty()):
		return
	var trust_opts := {"pinned": f["trust"], "expected_aud": f["product"], "now": f["now"]}
	var effective := {}
	var docs := {"license": PKeyClaims.TYP_LICENSE, "config": PKeyClaims.TYP_CONFIG}
	for phase in ["cold", "warm"]:
		var times := {"trust": [], "license": [], "config": []}
		for i in RUNS:
			if phase == "cold":
				PKeyJws.clear_key_cache()
			var t0 := Time.get_ticks_usec()
			var m := await PKeyTrust.verify_manifest(f["trust_jws"], trust_opts)
			times["trust"].append((Time.get_ticks_usec() - t0) / 1000.0)
			effective = PKeyTrust.merge(f["trust"], m["discovered"])
			var opts := {"trust": effective, "expected_aud": f["product"], "device_id": f["device_id"], "now": f["now"]}
			for slice in docs:
				t0 = Time.get_ticks_usec()
				var d = await PKeyVerify.verify_doc(f[slice], docs[slice], opts)
				times[slice].append((Time.get_ticks_usec() - t0) / 1000.0)
				if i == 0 and phase == "cold":
					t.check("profile: the %s document verifies" % slice, d != null)
		var total := _median(times["trust"]) + _median(times["license"]) + _median(times["config"])
		t.info("profile: session verify (%s key): trust %.2f ms, licence %.2f ms, config %.2f ms, total %.2f ms (median of %d)" % [
			phase, _median(times["trust"]), _median(times["license"]), _median(times["config"]), total, RUNS])


func _bundle(t: PKeyTestContext) -> void:
	var c = PKeyTestFixtures.jws_case("bundle-payload-at-cap")
	if not t.check("profile: bundle-payload-at-cap present", c is Dictionary):
		return
	var input_bytes: int = String(c["jws"]).split(".")[0].length() + 1 + String(c["jws"]).split(".")[1].length()
	t.info("profile: bundle signing input %d bytes" % input_bytes)
	var saved := PKeyJws.mode
	var modes := {"inline": PKeyJws.Mode.INLINE, "thread": PKeyJws.Mode.THREAD, "sliced (6 ms)": PKeyJws.Mode.SLICED}
	if not OS.has_feature("threads"):
		modes.erase("thread")
	for name in modes:
		PKeyJws.mode = modes[name]
		var sdk := PKeyTestFixtures.new_sdk()
		var opts := PKeyOptions.new()
		opts.product = "djdl"
		opts.version = "1.0.0"
		opts.pinned_trust_keys = c["trust"]
		opts.store = PKeyMemoryStore.new("dev_7c1e2d")
		opts.local_only = true
		var cl := [1700001000]
		opts.now_source = func(): return cl[0]
		sdk.configure(opts)
		await sdk.start()
		var tree := Engine.get_main_loop() as SceneTree
		var frames := [0]
		var worst := [0.0]
		var last := [Time.get_ticks_usec()]
		var tick := func():
			var now := Time.get_ticks_usec()
			worst[0] = maxf(worst[0], (now - last[0]) / 1000.0)
			last[0] = now
			frames[0] += 1
		tree.process_frame.connect(tick)
		var t0 := Time.get_ticks_usec()
		var r: PKeyResult = await sdk.import_bundle(c["jws"])
		var ms := (Time.get_ticks_usec() - t0) / 1000.0
		tree.process_frame.disconnect(tick)
		t.check("profile: the 350 KB bundle is verified, then refused at the claims step (%s)" % name, r.code == &"bundle-claims-rejected", str(r))
		t.info("profile: 350 KB bundle import, %s: %.1f ms, %d frames passed, worst frame %.1f ms" % [name, ms, frames[0], worst[0]])
		if name == "thread":
			t.check("profile: the main thread keeps ticking during a threaded bundle verify", frames[0] >= 2, "%d frames" % frames[0])
		sdk.queue_free()
	PKeyJws.mode = saved


static func _median(xs: Array) -> float:
	var s := xs.duplicate()
	s.sort()
	return s[s.size() / 2] if not s.is_empty() else 0.0


func _arith(t: PKeyTestContext) -> void:
	PKeyEd25519.warmup()
	var F = PKeyEd25519
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
	t.info("fe_mul: %.2f us  fe_sq: %.2f us  fe_add: %.2f us" % [(t1 - t0) / float(N), (t2 - t1) / float(N), (t3 - t2) / float(N)])
	# TweetNaCl M for comparison
	var R = PKeyEd25519Ref
	var ga := R.gf(); var gb := R.gf(); var gc := R.gf()
	for i in 16:
		ga[i] = 1000 + i; gb[i] = 60000 - i
	t0 = Time.get_ticks_usec()
	for i in 5000: R.M(gc, ga, gb)
	t1 = Time.get_ticks_usec()
	t.info("tweetnacl M (looped, 16 limbs): %.2f us" % [(t1 - t0) / 5000.0])
	# Phase breakdown on RFC TEST 2
	var pk := "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c".hex_decode()
	var sig := "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00".hex_decode()
	var msg := "72".hex_decode()
	var reps := 20
	var tA := 0; var tH := 0; var tD := 0; var tB := 0
	var all_ok := true
	for r in reps:
		var s0 := Time.get_ticks_usec()
		var A := F._pt(4)
		F.ge_frombytes_negate_vartime(A, pk)
		var s1 := Time.get_ticks_usec()
		var hin := sig.slice(0, 32); hin.append_array(pk); hin.append_array(msg)
		var h := F.sc_reduce(PKeySha512.hash(hin))
		var s2 := Time.get_ticks_usec()
		var Rp := F._pt(3)
		F.ge_double_scalarmult_vartime(Rp, h, A, sig.slice(32, 64))
		var s3 := Time.get_ticks_usec()
		var chk := PackedByteArray(); chk.resize(32)
		F.ge_tobytes(chk, Rp)
		var s4 := Time.get_ticks_usec()
		tA += s1 - s0; tH += s2 - s1; tD += s3 - s2; tB += s4 - s3
		all_ok = all_ok and chk == sig.slice(0, 32)
	t.check("phase breakdown reproduces R on RFC 8032 TEST 2", all_ok)
	t.info("phases (avg ms): decompress A %.2f | sha512+reduce %.2f | double-scalarmult %.2f | encode (invert) %.2f" % [tA / 1000.0 / reps, tH / 1000.0 / reps, tD / 1000.0 / reps, tB / 1000.0 / reps])
