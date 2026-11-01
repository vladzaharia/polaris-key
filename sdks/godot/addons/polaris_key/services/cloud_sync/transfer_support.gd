extends RefCounted
## Pure helpers of the file transfer engine (`transfer.gd`): a source over bytes, the work that runs off the
## main thread or one segment at a time on a native AEAD lane, and the check of a finalize answer.

## A seal or an open of at least this many bytes runs on a worker thread (the GDScript AES-GCM lane takes
## about a second a MiB, so on the main thread a 32 MiB save would freeze the game).
const THREAD_MIN_BYTES := 65536
## Bytes a native-lane whole-file seal or open does between two frame yields.
const YIELD_BYTES := 4194304


## A source over bytes in memory: `size` and `read(start, end)`.
class BytesSource:
	extends RefCounted
	var size := 0
	var _data := PackedByteArray()

	func _init(data: PackedByteArray) -> void:
		_data = data
		size = data.size()

	func read(start: int, end: int) -> PackedByteArray:
		return _data.slice(start, end)


## Runs `fn` (a computation over values it holds, touching no node) and answers its result: on a worker
## thread when `size` is at least `THREAD_MIN_BYTES`, else inline. The caller awaits it either way.
static func off_thread(fn: Callable, size: int) -> Variant:
	var tree := Engine.get_main_loop() as SceneTree
	if size < THREAD_MIN_BYTES or tree == null:
		return fn.call()
	var out: Array = [null]
	var task := WorkerThreadPool.add_task(func() -> void: out[0] = fn.call(), false, "pkey file codec")
	while not WorkerThreadPool.is_task_completed(task):
		await tree.process_frame
	WorkerThreadPool.wait_for_task_completion(task)
	return out[0]


## `codec.<method>(args)` off the main thread. A guarded codec (one with `inner()`) is asked on the main
## thread before and after: if it went stale (locked or root replaced) meanwhile, the result is thrown away
## and `failed` answered; the worker only runs the immutable inner codec.
static func codec_off(codec: Object, method: String, args: Array, size: int, failed: Variant) -> Variant:
	var target: Object = codec
	var guarded := codec.has_method("inner")
	if guarded:
		if codec.locked():
			return failed
		target = codec.inner()
		if target == null:
			return failed
	# A native AEAD lane is called from the main thread only (PKeySyncAead), so the work stays here: a
	# whole file goes one segment at a time with a frame yield every `YIELD_BYTES`, anything else is one
	# bounded call. The GDScript lane runs on a worker thread.
	if PKeySyncAead.lane_name() != "gdscript":
		var inline: Variant
		if (method == "seal_whole" or method == "open_whole") and target.has_method("whole_sealer"):
			inline = await whole_by_segment(codec if guarded else null, target, method, args[0], failed)
		else:
			inline = target.callv(method, args)
		if guarded and codec.locked():
			return failed
		return inline
	var r: Variant = await off_thread(func() -> Variant: return target.callv(method, args), size)
	if guarded and codec.locked():
		return failed
	return r


## `seal_whole` / `open_whole` of an E2e codec on the main thread, one segment per step. A guarded codec is
## asked before every segment: once it went stale the result is thrown away (`failed`).
static func whole_by_segment(guard: Object, target: Object, method: String, data: PackedByteArray, failed: Variant) -> Variant:
	var tree := Engine.get_main_loop() as SceneTree
	var sealing := method == "seal_whole"
	var worker: Object = target.whole_sealer() if sealing else target.whole_opener()
	var out := PackedByteArray()
	if sealing:
		out = worker.header.duplicate()
	var step := PKeySyncFileStream.SEGMENT_BYTES
	var at := 0
	var since := 0
	while at < data.size():
		if guard != null and guard.locked():
			return failed
		var end := mini(data.size(), at + step)
		for seg in worker.push(data.slice(at, end)):
			out.append_array(seg)
		if worker.error != "":
			return failed if sealing else {"ok": false, "reason": worker.error}
		since += end - at
		at = end
		if since >= YIELD_BYTES and tree != null:
			since = 0
			await tree.process_frame
	if guard != null and guard.locked():
		return failed
	var last: PackedByteArray = worker.finish()
	if worker.error != "":
		return failed if sealing else {"ok": false, "reason": worker.error}
	out.append_array(last)
	return out if sealing else {"ok": true, "plain": out}


## The finalize answer must describe the file that was begun: its size, hash and format, and a newer version.
static func finalized_matches(got: Variant, rec: Dictionary, format: String, base_version: Variant) -> bool:
	if not (got is Dictionary):
		return false
	var size: Variant = whole(got.get("size"))
	var version: Variant = whole(got.get("version"))
	if size == null or size != int(rec["size"]):
		return false
	if got.get("sha256") != rec["sha256"] or got.get("format") != format:
		return false
	if version == null or version < 1:
		return false
	var base: Variant = whole(base_version)
	if base != null and version <= base:
		return false
	return true


## A JSON number that is a whole value in the range of an int, as an int; else null.
static func whole(x: Variant) -> Variant:
	if typeof(x) == TYPE_INT:
		return x
	if typeof(x) == TYPE_FLOAT and is_finite(x) and absf(x) <= 9007199254740991.0 and x == floorf(x):
		return int(x)
	return null
