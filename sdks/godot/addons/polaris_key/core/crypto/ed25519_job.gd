class_name PKeyEd25519Job
extends RefCounted
## One Ed25519 verify (the `PKeyEd25519.verify` algorithm) as a resumable job, over a key
## prepared once by `PKeyEd25519.prepare_key`.
##
## `run()` does it all at once: inline, or as a `WorkerThreadPool` task. `step(budget_usec)`
## does as much as fits in the budget and returns, so a bundle-sized verify can be spread
## across frames where there are no threads (S-04: a 4–8 ms slice keeps the worst frame near
## idle). The phases are SHA-512 over R || A || M (the cost of a big message), the scalar
## reduction and window setup, the interleaved double-scalar multiply (16 bits per slice
## check), and the final encode and compare.
##
## Thread safety: a job owns all of its mutable state. The prepared key and the `Bi` table are
## only read, and `prepare_key` has already run `warmup()` on the calling thread.

var ok := false
var done := false
## The thread `run()` ran on (`OS.get_thread_caller_id()`), 0 until it runs: a test hook that
## says whether a verify really left the main thread, whatever the machine's load.
var ran_on := 0

var _sig: PackedByteArray
var _Ai: Array
var _sha: PKeySha512Stream
var _phase := 0
var _i := 255
var _aslide: PackedInt32Array
var _bslide: PackedInt32Array
var _r: Array
var _t: Array
var _u: Array
var _t0: PackedInt64Array


func _init(sig: PackedByteArray, msg: PackedByteArray, key: Array) -> void:
	if key.size() != 3 or sig.size() != 64 or not PKeyEd25519.s_is_canonical(sig):
		done = true
		return
	_sig = sig
	_Ai = key[2]
	var hin := sig.slice(0, 32)
	hin.append_array(key[0])
	hin.append_array(msg)
	_sha = PKeySha512Stream.new(hin)


## How far the job is, 0.0 to 1.0: the SHA-512 pass (the cost of a big message) is the first
## 90 %, the double-scalar multiply the rest. For the sliced verify's progress signal.
func progress() -> float:
	if done:
		return 1.0
	match _phase:
		0:
			return 0.9 * float(_sha._blk) / float(maxi(_sha._nw, 1))
		1:
			return 0.9
		2:
			return 0.9 + 0.1 * float(255 - _i) / 256.0
	return 1.0


## Runs to completion.
func run() -> void:
	ran_on = OS.get_thread_caller_id()
	step(0)


## Works until done or until `budget_usec` microseconds have passed (0: no budget). Returns
## `done`. `clock` returns the time in microseconds (empty: `Time.get_ticks_usec`); a test
## injects a fake one so the slice count does not depend on the machine's speed or load.
func step(budget_usec: int, clock: Callable = Callable()) -> bool:
	var timed := budget_usec > 0
	var fake := clock.is_valid()
	var deadline := 0
	if timed:
		deadline = (int(clock.call()) if fake else Time.get_ticks_usec()) + budget_usec
	while not done:
		match _phase:
			0:
				if _sha.step(8):
					_phase = 1
			1:
				_setup(PKeyEd25519.sc_reduce(_sha.digest()))
				_phase = 2
			2:
				_ladder(16)
				if _i < 0:
					_phase = 3
			3:
				_finish()
		if timed and (int(clock.call()) if fake else Time.get_ticks_usec()) >= deadline:
			break
	return done


func _setup(h: PackedByteArray) -> void:
	_aslide = PKeyEd25519.slide(h)
	_bslide = PKeyEd25519.slide(_sig.slice(32, 64))
	_t0 = PKeyEd25519.fe_new()
	_t = PKeyEd25519._pt(4)
	_u = PKeyEd25519._pt(4)
	_r = PKeyEd25519._pt(3)
	PKeyEd25519.fe_0(_r[0])
	PKeyEd25519.fe_1(_r[1])
	PKeyEd25519.fe_1(_r[2])
	_i = 255
	while _i >= 0:
		if _aslide[_i] != 0 or _bslide[_i] != 0:
			break
		_i -= 1


## Up to `n` iterations of ge_double_scalarmult_vartime's main loop, from bit `_i` down.
func _ladder(n: int) -> void:
	var bi: Array = PKeyEd25519._bi
	var r := _r
	var t := _t
	var u := _u
	var t0 := _t0
	var i := _i
	var stop := maxi(i - n, -1)
	while i > stop:
		PKeyEd25519.ge_p2_dbl(t, r, t0)
		var ai: int = _aslide[i]
		if ai > 0:
			PKeyEd25519.ge_p1p1_to_p3(u, t)
			PKeyEd25519.ge_add(t, u, _Ai[ai >> 1], t0)
		elif ai < 0:
			PKeyEd25519.ge_p1p1_to_p3(u, t)
			PKeyEd25519.ge_sub(t, u, _Ai[(-ai) >> 1], t0)
		var b: int = _bslide[i]
		if b > 0:
			PKeyEd25519.ge_p1p1_to_p3(u, t)
			PKeyEd25519.ge_madd(t, u, bi[b >> 1], t0)
		elif b < 0:
			PKeyEd25519.ge_p1p1_to_p3(u, t)
			PKeyEd25519.ge_msub(t, u, bi[(-b) >> 1], t0)
		PKeyEd25519.ge_p1p1_to_p2(r, t)
		i -= 1
	_i = i


func _finish() -> void:
	var chk := PackedByteArray()
	chk.resize(32)
	PKeyEd25519.ge_tobytes(chk, _r)
	var d: int = 0
	for k in 32:
		d |= chk[k] ^ _sig[k]
	ok = d == 0
	done = true
