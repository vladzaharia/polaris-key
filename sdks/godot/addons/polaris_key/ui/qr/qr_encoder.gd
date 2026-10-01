@tool
class_name PKeyQr
extends RefCounted
## A QR code encoder in pure GDScript (ISO/IEC 18004), sized for one job: rendering a device-code
## sign-in's `verification_uri_complete`. Byte mode, error-correction level M, versions 1-10 (up
## to 213 bytes), all eight masks scored by the standard's four penalty rules. Godot has no
## built-in encoder; this one is written for the addon rather than vendored (P1-07), and the `qr`
## suite holds it to fixtures produced by a reference encoder (qrcodegen) at the same version, level
## and mask.
##
##   var code := PKeyQr.encode("https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT")
##   if code != null: code.is_dark(x, y)
##
## The structure follows the standard's order: function patterns (finders and separators,
## timing, alignment, the dark module, reserved format and version areas), the data codewords
## with Reed-Solomon blocks interleaved, the zigzag placement, then the mask with the lowest
## penalty and its format bits.

const MIN_VERSION := 1
const MAX_VERSION := 10
## The format-information bits for error-correction level M.
const ECL_M_BITS := 0

## Per version (index 0 unused), level M: [EC codewords per block, blocks in group 1, data
## codewords per group-1 block, blocks in group 2, data codewords per group-2 block].
const _BLOCKS := [
	[],
	[10, 1, 16, 0, 0],
	[16, 1, 28, 0, 0],
	[26, 1, 44, 0, 0],
	[18, 2, 32, 0, 0],
	[24, 2, 43, 0, 0],
	[16, 4, 27, 0, 0],
	[18, 4, 31, 0, 0],
	[22, 2, 38, 2, 39],
	[22, 3, 36, 2, 37],
	[26, 4, 43, 1, 44],
]
## Alignment-pattern centre coordinates per version.
const _ALIGN := [
	[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
	[6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]
## The standard's penalty weights.
const _N1 := 3
const _N2 := 3
const _N3 := 40
const _N4 := 10

static var _exp := PackedByteArray()
static var _log := PackedByteArray()


static func _static_init() -> void:
	# GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
	_exp.resize(512)
	_log.resize(256)
	var x := 1
	for i in 255:
		_exp[i] = x
		_log[x] = i
		x <<= 1
		if x & 0x100:
			x ^= 0x11D
	for i in range(255, 512):
		_exp[i] = _exp[i - 255]


## The QR code for `text` (UTF-8, byte mode, level M): the smallest version from `min_version`
## that fits, the best-scoring mask unless `mask` (0-7) is forced. Null when `text` does not fit
## version 10 (213 bytes) or an argument is out of range.
static func encode(text: String, min_version := MIN_VERSION, mask := -1) -> PKeyQrCode:
	return encode_bytes(text.to_utf8_buffer(), min_version, mask)


static func encode_bytes(data: PackedByteArray, min_version := MIN_VERSION, mask := -1) -> PKeyQrCode:
	if min_version < MIN_VERSION or min_version > MAX_VERSION or mask < -1 or mask > 7:
		return null
	var version := -1
	for v in range(min_version, MAX_VERSION + 1):
		if data.size() <= capacity(v):
			version = v
			break
	if version < 0:
		return null
	var codewords := _codewords(data, version)
	var size := version * 4 + 17
	var modules := PackedByteArray()
	modules.resize(size * size)
	var function := PackedByteArray()
	function.resize(size * size)
	_draw_function_patterns(modules, function, size, version)
	_draw_codewords(modules, function, size, codewords)
	var chosen := mask
	if chosen < 0:
		var best := -1
		for m in 8:
			_apply_mask(modules, function, size, m)
			_draw_format(modules, function, size, m)
			var p := penalty(modules, size)
			if best < 0 or p < best:
				best = p
				chosen = m
			_apply_mask(modules, function, size, m)  # XOR again: undo
	_apply_mask(modules, function, size, chosen)
	_draw_format(modules, function, size, chosen)
	return PKeyQrCode.new(version, chosen, size, modules)


## How many bytes version `v` holds at level M in byte mode.
static func capacity(v: int) -> int:
	var data_bits := _data_codewords(v) * 8
	return (data_bits - 4 - _count_bits(v)) / 8


static func _count_bits(v: int) -> int:
	return 8 if v <= 9 else 16


static func _data_codewords(v: int) -> int:
	var b: Array = _BLOCKS[v]
	return b[1] * b[2] + b[3] * b[4]


# ── Data: bit stream, blocks, Reed-Solomon, interleave ──────────────────────────────────────

static func _codewords(data: PackedByteArray, version: int) -> PackedByteArray:
	var bits := PackedByteArray()  # one entry per bit, for clarity over speed (at most 1728)
	_append_bits(bits, 0b0100, 4)
	_append_bits(bits, data.size(), _count_bits(version))
	for byte in data:
		_append_bits(bits, byte, 8)
	var capacity_bits := _data_codewords(version) * 8
	_append_bits(bits, 0, mini(4, capacity_bits - bits.size()))
	_append_bits(bits, 0, (8 - bits.size() % 8) % 8)
	var stream := PackedByteArray()
	for i in range(0, bits.size(), 8):
		var b := 0
		for j in 8:
			b = (b << 1) | bits[i + j]
		stream.append(b)
	var pad := 0xEC
	while stream.size() < _data_codewords(version):
		stream.append(pad)
		pad = 0x11 if pad == 0xEC else 0xEC

	var spec: Array = _BLOCKS[version]
	var ec_len: int = spec[0]
	var generator := _rs_generator(ec_len)
	var data_blocks: Array[PackedByteArray] = []
	var ec_blocks: Array[PackedByteArray] = []
	var at := 0
	for group in 2:
		var count: int = spec[1 + group * 2]
		var length: int = spec[2 + group * 2]
		for k in count:
			var block := stream.slice(at, at + length)
			at += length
			data_blocks.append(block)
			ec_blocks.append(_rs_remainder(block, generator))
	var out := PackedByteArray()
	var longest := 0
	for block in data_blocks:
		longest = maxi(longest, block.size())
	for i in longest:
		for block in data_blocks:
			if i < block.size():
				out.append(block[i])
	for i in ec_len:
		for block in ec_blocks:
			out.append(block[i])
	return out


static func _append_bits(bits: PackedByteArray, value: int, count: int) -> void:
	for i in range(count - 1, -1, -1):
		bits.append((value >> i) & 1)


static func _mul(a: int, b: int) -> int:
	if a == 0 or b == 0:
		return 0
	return _exp[_log[a] + _log[b]]


## The monic generator polynomial of `degree`, highest coefficient first, leading 1 dropped.
static func _rs_generator(degree: int) -> PackedByteArray:
	var g := PackedByteArray([1])
	for i in degree:
		var next := PackedByteArray()
		next.resize(g.size() + 1)
		for j in g.size():
			next[j] ^= g[j]
			next[j + 1] ^= _mul(g[j], _exp[i])
		g = next
	return g.slice(1)


static func _rs_remainder(data: PackedByteArray, generator: PackedByteArray) -> PackedByteArray:
	var rem := PackedByteArray()
	rem.resize(generator.size())
	for byte in data:
		var factor := byte ^ rem[0]
		for i in rem.size() - 1:
			rem[i] = rem[i + 1] ^ _mul(generator[i], factor)
		rem[rem.size() - 1] = _mul(generator[generator.size() - 1], factor)
	return rem


# ── Function patterns ────────────────────────────────────────────────────────────────────────

static func _set_function(modules: PackedByteArray, function: PackedByteArray, size: int, x: int, y: int, dark: bool) -> void:
	modules[y * size + x] = 1 if dark else 0
	function[y * size + x] = 1


static func _draw_function_patterns(modules: PackedByteArray, function: PackedByteArray, size: int, version: int) -> void:
	for i in size:
		_set_function(modules, function, size, 6, i, i % 2 == 0)
		_set_function(modules, function, size, i, 6, i % 2 == 0)
	for c in [[3, 3], [size - 4, 3], [3, size - 4]]:
		for dy in range(-4, 5):
			for dx in range(-4, 5):
				var xx: int = c[0] + dx
				var yy: int = c[1] + dy
				if xx >= 0 and xx < size and yy >= 0 and yy < size:
					var dist := maxi(absi(dx), absi(dy))
					_set_function(modules, function, size, xx, yy, dist != 2 and dist != 4)
	var align: Array = _ALIGN[version]
	var last := align.size() - 1
	for i in align.size():
		for j in align.size():
			if (i == 0 and j == 0) or (i == 0 and j == last) or (i == last and j == 0):
				continue
			for dy in range(-2, 3):
				for dx in range(-2, 3):
					_set_function(modules, function, size, align[i] + dx, align[j] + dy, maxi(absi(dx), absi(dy)) != 1)
	_draw_format(modules, function, size, 0)  # reserves the area; redrawn after masking
	if version >= 7:
		var rem := version
		for i in 12:
			rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
		var bits := (version << 12) | rem
		for i in 18:
			var dark := ((bits >> i) & 1) == 1
			var a := size - 11 + i % 3
			var b := i / 3
			_set_function(modules, function, size, a, b, dark)
			_set_function(modules, function, size, b, a, dark)


## Both copies of the 15 format bits (level M, `mask`) and the dark module.
static func _draw_format(modules: PackedByteArray, function: PackedByteArray, size: int, mask: int) -> void:
	var data := (ECL_M_BITS << 3) | mask
	var rem := data
	for i in 10:
		rem = (rem << 1) ^ ((rem >> 9) * 0x537)
	var bits := ((data << 10) | rem) ^ 0x5412
	var bit := func(i: int) -> bool: return ((bits >> i) & 1) == 1
	for i in 6:
		_set_function(modules, function, size, 8, i, bit.call(i))
	_set_function(modules, function, size, 8, 7, bit.call(6))
	_set_function(modules, function, size, 8, 8, bit.call(7))
	_set_function(modules, function, size, 7, 8, bit.call(8))
	for i in range(9, 15):
		_set_function(modules, function, size, 14 - i, 8, bit.call(i))
	for i in 8:
		_set_function(modules, function, size, size - 1 - i, 8, bit.call(i))
	for i in range(8, 15):
		_set_function(modules, function, size, 8, size - 15 + i, bit.call(i))
	_set_function(modules, function, size, 8, size - 8, true)


# ── Placement and masking ────────────────────────────────────────────────────────────────────

static func _draw_codewords(modules: PackedByteArray, function: PackedByteArray, size: int, data: PackedByteArray) -> void:
	var i := 0
	var total := data.size() * 8
	var right := size - 1
	while right >= 1:
		if right == 6:
			right = 5
		var upward := ((right + 1) & 2) == 0
		for vert in size:
			var y := size - 1 - vert if upward else vert
			for j in 2:
				var x := right - j
				if function[y * size + x] == 0 and i < total:
					modules[y * size + x] = (data[i >> 3] >> (7 - (i & 7))) & 1
					i += 1
		right -= 2
	# Remainder bits (versions 2-6) stay light.


static func _mask_bit(mask: int, x: int, y: int) -> bool:
	match mask:
		0: return (x + y) % 2 == 0
		1: return y % 2 == 0
		2: return x % 3 == 0
		3: return (x + y) % 3 == 0
		4: return (x / 3 + y / 2) % 2 == 0
		5: return x * y % 2 + x * y % 3 == 0
		6: return (x * y % 2 + x * y % 3) % 2 == 0
		7: return ((x + y) % 2 + x * y % 3) % 2 == 0
	return false


static func _apply_mask(modules: PackedByteArray, function: PackedByteArray, size: int, mask: int) -> void:
	for y in size:
		for x in size:
			if function[y * size + x] == 0 and _mask_bit(mask, x, y):
				modules[y * size + x] ^= 1


# ── Penalty (ISO/IEC 18004 §7.8.3) ───────────────────────────────────────────────────────────

## The penalty score of a finished symbol: runs of five or more (N1), 2x2 blocks (N2),
## finder-like 1:1:3:1:1 patterns with four light modules on a side (N3), and dark/light
## imbalance (N4).
static func penalty(modules: PackedByteArray, size: int) -> int:
	var result := 0
	for pass_columns in [false, true]:
		for a in size:
			var run_dark := false
			var run := 0
			var history := PackedInt32Array([0, 0, 0, 0, 0, 0, 0])
			for b in size:
				var dark := modules[(b * size + a) if pass_columns else (a * size + b)] == 1
				if dark == run_dark:
					run += 1
					if run == 5:
						result += _N1
					elif run > 5:
						result += 1
				else:
					_history_add(history, run, size)
					if not run_dark:
						result += _finder_count(history) * _N3
					run_dark = dark
					run = 1
			# Terminate the line against the light border.
			if run_dark:
				_history_add(history, run, size)
				run = 0
			run += size
			_history_add(history, run, size)
			result += _finder_count(history) * _N3
	for y in size - 1:
		for x in size - 1:
			var c := modules[y * size + x]
			if c == modules[y * size + x + 1] and c == modules[(y + 1) * size + x] and c == modules[(y + 1) * size + x + 1]:
				result += _N2
	var dark_count := 0
	for m in modules:
		dark_count += m
	var total := size * size
	var k := ceili(absf(dark_count * 20.0 - total * 10.0) / total) - 1
	result += maxi(k, 0) * _N4
	return result


static func _history_add(history: PackedInt32Array, run: int, size: int) -> void:
	var r := run
	if history[0] == 0:
		r += size  # the light border before the line's first run
	for i in range(history.size() - 1, 0, -1):
		history[i] = history[i - 1]
	history[0] = r


static func _finder_count(h: PackedInt32Array) -> int:
	var n := h[1]
	var core := n > 0 and h[2] == n and h[3] == n * 3 and h[4] == n and h[5] == n
	return (1 if core and h[0] >= n * 4 and h[6] >= n else 0) + (1 if core and h[6] >= n * 4 and h[0] >= n else 0)
