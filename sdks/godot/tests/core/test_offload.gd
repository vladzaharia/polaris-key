extends RefCounted
# Bundle-sized verification leaves the main thread (S-04): on a threaded build the 350 KB
# `bundle-payload-at-cap` verify runs on WorkerThreadPool while frames keep coming; without
# threads it is sliced across frames within the budget; small inputs stay inline. Every path
# returns exactly what the synchronous verifier returns. Timings are INFO.


func run(t: PKeyTestContext) -> void:
	var c = PKeyTestFixtures.jws_case("bundle-payload-at-cap")
	if not t.check("offload: fixture bundle-payload-at-cap present", c is Dictionary):
		return
	var small = PKeyTestFixtures.jws_case("valid-stable")
	var want = PKeyJws.verify(c["jws"], c["trust"], c["typ"], int(c["maxPayloadBytes"]))
	t.check("offload: the synchronous verify accepts the bundle", want is Dictionary)

	var saved := PKeyJws.mode
	PKeyJws.mode = PKeyJws.Mode.AUTO
	var r := await _timed(c, false)
	t.check("offload: AUTO matches the synchronous result", _same(r["result"], want))
	if OS.has_feature("threads"):
		t.check("offload: AUTO moves a 350 KB verify off the main thread", r["frames"] >= 2, "%d frames" % r["frames"])
	t.info("offload: AUTO %s: %.1f ms over %d frames, worst frame %.1f ms" % ["thread" if OS.has_feature("threads") else "sliced", r["ms"], r["frames"], r["worst"]])

	PKeyJws.mode = PKeyJws.Mode.THREAD
	r = await _timed(c, false)
	t.check("offload: THREAD matches and frames keep coming", _same(r["result"], want) and r["frames"] >= 2, "%d frames" % r["frames"])
	t.info("offload: thread: %.1f ms over %d frames, worst frame %.1f ms" % [r["ms"], r["frames"], r["worst"]])

	PKeyJws.mode = PKeyJws.Mode.SLICED
	var budget := PKeyJws.slice_budget_usec
	PKeyJws.set_slice_budget_ms(4.0)
	r = await _timed(c, false)
	t.check("offload: SLICED matches and spans frames", _same(r["result"], want) and r["frames"] >= 2, "%d frames" % r["frames"])
	t.info("offload: sliced at 4 ms: %.1f ms over %d frames, worst frame %.1f ms" % [r["ms"], r["frames"], r["worst"]])
	PKeyJws.slice_budget_usec = budget

	PKeyJws.mode = PKeyJws.Mode.AUTO
	var sr := await _timed(small, false)
	t.check("offload: AUTO keeps a small verify inline", sr["frames"] == 0 and sr["result"] is Dictionary, "%d frames" % sr["frames"])
	sr = await _timed(small, true)
	t.check("offload: an offloaded small verify (gameplay) matches", sr["result"] is Dictionary and (not OS.has_feature("threads") or sr["frames"] >= 1))

	# A tampered bundle fails on every path.
	var bad := String(c["jws"])
	bad = bad.substr(0, bad.length() - 3) + ("AAA" if not bad.ends_with("AAA") else "BBB")
	for m in [PKeyJws.Mode.THREAD, PKeyJws.Mode.SLICED, PKeyJws.Mode.INLINE]:
		PKeyJws.mode = m
		var got = await PKeyJws.verify_async(bad, c["trust"], c["typ"], int(c["maxPayloadBytes"]))
		t.check("offload: a bad signature fails in mode %d" % m, got == null)
	PKeyJws.mode = saved

	t.check("offload: the slice budget clamps to 4–8 ms", _clamped(2.0) == 4000 and _clamped(6.0) == 6000 and _clamped(20.0) == 8000)
	PKeyJws.slice_budget_usec = budget


## Two verify results are the same: kid, payload and the pointer set's pointers (a PointerSet is
## an object, so `==` on the result Dictionaries would compare identities).
static func _same(a: Variant, b: Variant) -> bool:
	if not (a is Dictionary and b is Dictionary):
		return a == b
	return a["kid"] == b["kid"] and a["payload"] == b["payload"] and a["non_wire_integers"].keys() == b["non_wire_integers"].keys()


static func _clamped(ms: float) -> int:
	PKeyJws.set_slice_budget_ms(ms)
	return PKeyJws.slice_budget_usec


## Runs verify_async while counting frames and the longest gap between two frames.
static func _timed(c: Dictionary, offload: bool) -> Dictionary:
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
	var result = await PKeyJws.verify_async(c["jws"], c["trust"], c.get("typ", ""), int(c.get("maxPayloadBytes", 0)), offload)
	var ms := (Time.get_ticks_usec() - t0) / 1000.0
	tree.process_frame.disconnect(tick)
	return {"result": result, "frames": frames[0], "worst": worst[0], "ms": ms}
