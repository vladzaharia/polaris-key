@tool
class_name PKeySyncCdc
extends RefCounted
## `pkey-sync-cdc/1` (WIRE-CONTRACT-V5 §13.8.3): content-defined chunking of a file's plaintext,
## `fastcdc-2016-nc1`, streaming. Every implementation cuts at the same offsets (`cdcCases`).
##
##   gear[i]  xorshift32 from seed 0x9e3779b9: x ^= x << 13; x ^= x >> 17; x ^= x << 5 (32-bit),
##            one step per entry, 256 entries
##   min, max avg / 4 and avg * 4 (64 KiB, 256 KiB and 1 MiB by default)
##   masks    bits = log2(avg); the strict mask has the top bits + 1 bits set, the loose mask the
##            top bits - 1
##   scan     per chunk, h starts at 0 at offset min; h = (h << 1) + gear[byte] (32-bit); up to
##            offset avg a cut where h & strict == 0, after it where h & loose == 0; the cut is
##            after the matching byte, else at max (or at the end of the input)
##   tail     what remains is one chunk when it is at most min bytes
##
## The scan of a chunk never looks past `max` bytes, so a chunk is decided as soon as `max` bytes
## are buffered (or the input ends) and a chunker holds at most `max` bytes at a time. Write it
## as `var c := PKeySyncCdc.Chunker.new(avg)`; `push` answers the chunks (each a fresh
## `PackedByteArray`) that the bytes complete, `finish` the rest.

const MASK32 := 0xFFFFFFFF
const _MIN_AVG := 64

static var _gear: PackedInt64Array


static func _static_init() -> void:
	var g := PackedInt64Array()
	g.resize(256)
	var x := PKeyConstants.SYNC_CDC_GEAR_SEED & MASK32
	for i in 256:
		x = (x ^ (x << 13)) & MASK32
		x = (x ^ (x >> 17)) & MASK32
		x = (x ^ (x << 5)) & MASK32
		g[i] = x
	_gear = g


## `{"avg", "min", "max"}` for an average chunk size, or an empty dictionary when it is not a
## power of two of at least 64.
static func params(avg: int = PKeyConstants.SYNC_CDC_AVG_BYTES) -> Dictionary:
	if avg < _MIN_AVG or (avg & (avg - 1)) != 0:
		return {}
	return {"avg": avg, "min": avg >> 2, "max": avg * 4}


static func _top_mask(n: int) -> int:
	if n >= 32:
		return MASK32
	return (~(MASK32 >> n)) & MASK32


## The length of the chunk at the start of `buf[0..len)`, which is the rest of the input or at
## least `max` bytes.
static func _cut_length(buf: PackedByteArray, len: int, avg: int, mn: int, mx: int) -> int:
	if len <= mn:
		return len
	var bits := 0
	var a := avg
	while a > 1:
		a >>= 1
		bits += 1
	var strict := _top_mask(bits + 1)
	var loose := _top_mask(bits - 1)
	var end := mini(len, mx)
	var normal := mini(end, avg)
	var g := _gear
	var h := 0
	var i := mn
	while i < normal:
		h = ((h << 1) + g[buf[i]]) & MASK32
		if (h & strict) == 0:
			return i + 1
		i += 1
	while i < end:
		h = ((h << 1) + g[buf[i]]) & MASK32
		if (h & loose) == 0:
			return i + 1
		i += 1
	return end


## The chunk lengths of a whole buffer (tests and tools; production code streams). An empty array
## for an input with no bytes, or for an unusable `avg`.
static func lengths(data: PackedByteArray, avg: int = PKeyConstants.SYNC_CDC_AVG_BYTES) -> PackedInt64Array:
	var out := PackedInt64Array()
	if params(avg).is_empty():
		return out
	var c := Chunker.new(avg)
	for ch in c.push(data):
		out.append((ch as PackedByteArray).size())
	for ch in c.finish():
		out.append((ch as PackedByteArray).size())
	return out


## A push chunker over bytes of any piece size.
class Chunker:
	extends RefCounted

	var avg := 0
	var min_bytes := 0
	var max_bytes := 0
	## `avg` is a power of two of at least 64; anything else leaves `valid` false and every push
	## answers nothing.
	var valid := false
	var _buf := PackedByteArray()

	func _init(average: int = PKeyConstants.SYNC_CDC_AVG_BYTES) -> void:
		var p := PKeySyncCdc.params(average)
		if p.is_empty():
			return
		valid = true
		avg = p["avg"]
		min_bytes = p["min"]
		max_bytes = p["max"]

	## The chunks that `data` completes, in order (`Array` of `PackedByteArray`).
	func push(data: PackedByteArray) -> Array:
		var out := []
		if not valid:
			return out
		var at := 0
		while at < data.size():
			var take := mini(max_bytes - _buf.size(), data.size() - at)
			_buf.append_array(data.slice(at, at + take))
			at += take
			if _buf.size() == max_bytes:
				_emit(out, PKeySyncCdc._cut_length(_buf, _buf.size(), avg, min_bytes, max_bytes))
		return out

	## The last chunks, once the input has ended. The chunker is empty afterwards.
	func finish() -> Array:
		var out := []
		while valid and _buf.size() > 0:
			_emit(out, PKeySyncCdc._cut_length(_buf, _buf.size(), avg, min_bytes, max_bytes))
		return out

	func _emit(out: Array, n: int) -> void:
		out.append(_buf.slice(0, n))
		_buf = _buf.slice(n)
