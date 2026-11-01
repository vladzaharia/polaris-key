extends RefCounted
# @pkey-feature connect.noise
# Opt-in timing evidence (CC-14 D-11, R-7): a dudect-style comparison of two input classes through the
# GDScript X25519 ladder and the bitwise GHASH (AES-256-GCM seal). It runs only under PKEY_TIMING=1, never in
# CI (a machine under load swamps it); CC-13.1/.2 run it on the owner's Windows, Linux and ARM devices. Each
# class is timed `samples` times, interleaved at random; the report is Welch's t between the classes after
# cropping the slowest 5 percent of each. |t| under 4.5 is no evidence of a difference; it is evidence of
# nothing else, and says nothing about a native lane.

const DEFAULT_SAMPLES := 400
const CROP := 0.95
const T_LIMIT := 4.5


func run(t: PKeyTestContext) -> void:
	if OS.get_environment("PKEY_TIMING") != "1":
		t.info("timing variance: skipped (set PKEY_TIMING=1; PKEY_TIMING_SAMPLES=n)")
		return
	var n := int(OS.get_environment("PKEY_TIMING_SAMPLES")) if OS.get_environment("PKEY_TIMING_SAMPLES") != "" else DEFAULT_SAMPLES
	var point := PKeyCurve25519.x25519_public(_filled(9, 32))
	var zero_scalar := _filled(0x00, 32)
	var ones_scalar := _filled(0xff, 32)
	var x_report := _measure(n, func(cls: int) -> void: PKeyCurve25519.x25519(zero_scalar if cls == 0 else ones_scalar, point))
	_report(t, "x25519 (scalar all 0x00 against all 0xff)", x_report)
	var key := _filled(7, 32)
	var nonce := _filled(1, 12)
	var plain_a := _filled(0x00, 4096)
	var plain_b := Crypto.new().generate_random_bytes(4096)
	var g_report := _measure(n, func(cls: int) -> void: PKeySyncAesGcm.seal(key, nonce, plain_a if cls == 0 else plain_b))
	_report(t, "ghash/seal (4 KiB of zeros against random)", g_report)


static func _filled(v: int, size: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(size)
	b.fill(v)
	return b


## Time `op(class)` n times per class, classes interleaved at random. {t, mean0, mean1, n}.
func _measure(n: int, op: Callable) -> Dictionary:
	var times: Array = [[], []]
	var order: Array = []
	for i in n:
		order.append(0)
		order.append(1)
	order.shuffle()
	op.call(0)
	op.call(1)
	for cls: int in order:
		var started := Time.get_ticks_usec()
		op.call(cls)
		(times[cls] as Array).append(float(Time.get_ticks_usec() - started))
	for c in 2:
		(times[c] as Array).sort()
		times[c] = (times[c] as Array).slice(0, int(float(n) * CROP))
	var a := _stats(times[0])
	var b := _stats(times[1])
	var se := sqrt(a["var"] / float(a["n"]) + b["var"] / float(b["n"]))
	return {"t": (a["mean"] - b["mean"]) / se if se > 0.0 else 0.0, "mean0": a["mean"], "mean1": b["mean"], "n": a["n"]}


static func _stats(xs: Array) -> Dictionary:
	var n := xs.size()
	var mean := 0.0
	for x: float in xs:
		mean += x
	mean /= float(maxi(n, 1))
	var v := 0.0
	for x: float in xs:
		v += (x - mean) * (x - mean)
	return {"mean": mean, "var": v / float(maxi(n - 1, 1)), "n": n}


func _report(t: PKeyTestContext, name: String, r: Dictionary) -> void:
	t.info("timing variance: %s: t=%.2f, mean %.0f us against %.0f us over %d samples a class" % [name, r["t"], r["mean0"], r["mean1"], r["n"]])
	t.check("timing variance: %s shows no difference (|t| < %.1f)" % [name, T_LIMIT], absf(r["t"]) < T_LIMIT, "%.2f" % r["t"])
