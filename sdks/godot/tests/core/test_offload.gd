extends RefCounted
# Bundle-sized verification leaves the main thread (S-04): on a threaded build the 350 KB
# `bundle-payload-at-cap` verify runs on WorkerThreadPool; without threads it is sliced across
# frames within the budget; small inputs stay inline. Every path returns exactly what the
# synchronous verifier returns. The checks read what the verify reports it did (PKeyJws.last_mode,
# last_slices, last_thread) and drive the slice budget with a fake clock, never frame counts or
# milliseconds (P1-13), so they hold under any load. Timings and frame counts are INFO.

## The fake clock's step: each reading advances it this many microseconds, so a 4 ms budget
## takes five readings (one to set the deadline, then one per unit of work, four units).
const FAKE_TICK_USEC := 1000


func run(t: PKeyTestContext) -> void:
	var c = PKeyTestFixtures.jws_case("bundle-payload-at-cap")
	if not t.check("offload: fixture bundle-payload-at-cap present", c is Dictionary):
		return
	var small = PKeyTestFixtures.jws_case("valid-stable")
	var want = PKeyJws.verify(c["jws"], c["trust"], c["typ"], int(c["maxPayloadBytes"]))
	t.check("offload: the synchronous verify accepts the bundle", want is Dictionary)
	var main := OS.get_main_thread_id()
	var threads := OS.has_feature("threads")

	var saved := PKeyJws.mode
	PKeyJws.mode = PKeyJws.Mode.AUTO
	# A fake clock, so the no-threads slice count never depends on the machine's speed.
	var now := [0]
	var fake := func() -> int:
		now[0] += FAKE_TICK_USEC
		return now[0]
	var saved_clock := PKeyJws.slice_clock
	PKeyJws.slice_clock = fake
	var r := await _timed(c, false)
	PKeyJws.slice_clock = saved_clock
	t.check("offload: AUTO matches the synchronous result", _same(r["result"], want))
	if threads:
		t.check("offload: AUTO moves a 350 KB verify off the main thread", r["mode"] == PKeyJws.Mode.THREAD and r["thread"] != 0 and r["thread"] != main, _how(r))
	else:
		t.check("offload: AUTO slices a 350 KB verify without threads", r["mode"] == PKeyJws.Mode.SLICED and r["slices"] >= 2, _how(r))
	t.info("offload: AUTO %s: %.1f ms over %d frames, worst frame %.1f ms" % ["thread" if threads else "sliced", r["ms"], r["frames"], r["worst"]])

	PKeyJws.mode = PKeyJws.Mode.THREAD
	r = await _timed(c, false)
	t.check("offload: THREAD matches and runs off the main thread", _same(r["result"], want) and r["mode"] == PKeyJws.Mode.THREAD and r["thread"] != 0 and r["thread"] != main, _how(r))
	t.info("offload: thread: %.1f ms over %d frames, worst frame %.1f ms" % [r["ms"], r["frames"], r["worst"]])

	PKeyJws.mode = PKeyJws.Mode.SLICED
	var budget := PKeyJws.slice_budget_usec
	PKeyJws.set_slice_budget_ms(4.0)
	# A real clock: the result matches whatever the machine's speed.
	r = await _timed(c, false)
	t.check("offload: SLICED matches", _same(r["result"], want) and r["mode"] == PKeyJws.Mode.SLICED and r["slices"] >= 1, _how(r))
	t.info("offload: sliced at 4 ms (real clock): %.1f ms over %d slices, %d frames, worst frame %.1f ms" % [r["ms"], r["slices"], r["frames"], r["worst"]])
	# A fake clock: the slice count is exact on any machine. Four readings per 4 ms slice, so
	# the bundle (thousands of SHA-512 blocks, 8 per unit) takes many slices; a budget that the
	# slicing ignored would take one.
	now[0] = 0
	PKeyJws.slice_clock = fake
	r = await _timed(c, false)
	var fake_slices: int = r["slices"]
	t.check("offload: SLICED at a 4 ms budget spans slices (fake clock)", _same(r["result"], want) and r["mode"] == PKeyJws.Mode.SLICED and fake_slices >= 2 and r["frames"] >= r["slices"] - 1, _how(r))
	now[0] = 0
	r = await _timed(c, false)
	t.check("offload: the slice count is the same on a second run (deterministic)", _same(r["result"], want) and r["slices"] == fake_slices, "%d then %d slices" % [fake_slices, r["slices"]])
	# A clock that never advances never ends a slice: the whole job in one.
	PKeyJws.slice_clock = func() -> int: return 0
	r = await _timed(c, false)
	t.check("offload: a stopped clock runs the job in one slice", _same(r["result"], want) and r["slices"] == 1, _how(r))
	PKeyJws.slice_clock = Callable()
	t.info("offload: sliced at 4 ms (fake clock, %d µs a reading): %d slices" % [FAKE_TICK_USEC, fake_slices])
	PKeyJws.slice_budget_usec = budget

	PKeyJws.mode = PKeyJws.Mode.AUTO
	var sr := await _timed(small, false)
	t.check("offload: AUTO keeps a small verify inline", sr["result"] is Dictionary and sr["mode"] == PKeyJws.Mode.INLINE and sr["slices"] == 0 and sr["thread"] == main, _how(sr))
	sr = await _timed(small, true)
	var offloaded: bool = sr["mode"] == PKeyJws.Mode.THREAD and sr["thread"] != main if threads else sr["mode"] == PKeyJws.Mode.SLICED
	t.check("offload: an offloaded small verify (gameplay) matches and leaves the calling thread", sr["result"] is Dictionary and offloaded, _how(sr))

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


## What a run reports it did, for check details.
static func _how(r: Dictionary) -> String:
	return "mode %d, %d slices, thread %d (main %d)" % [r["mode"], r["slices"], r["thread"], OS.get_main_thread_id()]


## Runs verify_async and returns its result with what PKeyJws reports the run did (mode, slices,
## thread). Frames and the longest gap between two frames are counted for the INFO lines only.
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
	PKeyJws.last_mode = PKeyJws.Mode.AUTO
	PKeyJws.last_slices = -1
	PKeyJws.last_thread = -1
	var t0 := Time.get_ticks_usec()
	var result = await PKeyJws.verify_async(c["jws"], c["trust"], c.get("typ", ""), int(c.get("maxPayloadBytes", 0)), offload)
	var ms := (Time.get_ticks_usec() - t0) / 1000.0
	tree.process_frame.disconnect(tick)
	return {"result": result, "mode": PKeyJws.last_mode, "slices": PKeyJws.last_slices, "thread": PKeyJws.last_thread, "frames": frames[0], "worst": worst[0], "ms": ms}
