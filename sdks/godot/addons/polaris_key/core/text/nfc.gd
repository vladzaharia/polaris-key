class_name PKeyNfc
extends RefCounted
## Unicode NFC (Unicode 16.0) for the peer HELLO cleaner (WIRE-CONTRACT-V5 §15.6, CC-14 D-20).
## Godot has no normalisation API, so this runs over the generated tables in `PKeyNfcData`: full
## canonical decomposition (Hangul algorithmically), canonical ordering by combining class,
## then composition with the exclusions already applied in the table.
##
## Work is per SEGMENT: a run that starts at a starter that cannot combine backwards (see
## `is_boundary`) and ends before the next one. `decompose`, `is_boundary` and `compose_segment`
## are public so a streaming caller (`PKeyDeviceLabel.clean_hello`) can stop early on a long input.

const S_BASE := 0xAC00
const L_BASE := 0x1100
const V_BASE := 0x1161
const T_BASE := 0x11A7
const L_COUNT := 19
const V_COUNT := 21
const T_COUNT := 28
const N_COUNT := V_COUNT * T_COUNT
const S_COUNT := L_COUNT * N_COUNT
## Insertion sort below this run length; a counting pass by class above it.
const SMALL_RUN := 24

static var _ready := false
static var _ccc: Dictionary = {}
static var _decomp: Dictionary = {}
static var _pairs: Dictionary = {}
static var _second: Dictionary = {}
static var _no_ccc_below := 0x300


## Builds the lookup dictionaries from the packed tables, once.
static func _init_tables() -> void:
	if _ready:
		return
	var c := PackedInt32Array(PKeyNfcData.CCC)
	var i := 0
	while i < c.size():
		for cp in range(c[i], c[i + 1] + 1):
			_ccc[cp] = c[i + 2]
		i += 3
	var d := PackedInt32Array(PKeyNfcData.DECOMP)
	i = 0
	while i < d.size():
		_decomp[d[i]] = d.slice(i + 2, i + 2 + d[i + 1])
		i += 2 + d[i + 1]
	var p := PackedInt32Array(PKeyNfcData.COMPOSE)
	i = 0
	while i < p.size():
		_pairs[(p[i] << 21) | p[i + 1]] = p[i + 2]
		_second[p[i + 1]] = true
		i += 3
	_ready = true


## The canonical combining class of `cp` (0 for a starter).
static func ccc(cp: int) -> int:
	if cp < 0x300:
		return 0
	_init_tables()
	return _ccc.get(cp, 0)


## True when `cp` starts a new segment: a starter that is not the second part of any primary
## composite (and not a Hangul vowel or trailing consonant), so nothing before it can combine with it.
static func is_boundary(cp: int) -> bool:
	if cp < 0x300:
		return true
	_init_tables()
	if _ccc.has(cp):
		return false
	if cp >= V_BASE and cp < V_BASE + V_COUNT:
		return false
	if cp > T_BASE and cp < T_BASE + T_COUNT:
		return false
	return not _second.has(cp)


## Appends the full canonical decomposition of `cp` to `seg`.
static func decompose(cp: int, seg: PackedInt32Array) -> void:
	if cp < 0xC0:
		seg.append(cp)
		return
	if cp >= S_BASE and cp < S_BASE + S_COUNT:
		var si := cp - S_BASE
		seg.append(L_BASE + si / N_COUNT)
		seg.append(V_BASE + (si % N_COUNT) / T_COUNT)
		if si % T_COUNT != 0:
			seg.append(T_BASE + si % T_COUNT)
		return
	_init_tables()
	var parts = _decomp.get(cp)
	if parts == null:
		seg.append(cp)
	else:
		seg.append_array(parts)


## The NFC form of `s`.
static func nfc(s: String) -> String:
	var out := PackedInt32Array()
	var seg := PackedInt32Array()
	var tmp := PackedInt32Array()
	for i in s.length():
		tmp.clear()
		decompose(s.unicode_at(i), tmp)
		for d in tmp:
			if is_boundary(d) and not seg.is_empty():
				out.append_array(compose_segment(seg))
				seg.clear()
			seg.append(d)
	if not seg.is_empty():
		out.append_array(compose_segment(seg))
	return to_string_cps(out)


## `cps` as a String.
static func to_string_cps(cps: PackedInt32Array) -> String:
	var out := ""
	for cp in cps:
		out += String.chr(cp)
	return out


## Canonical ordering then composition of one decomposed segment; returns the composed code points.
## Reorders `seg` in place.
static func compose_segment(seg: PackedInt32Array) -> PackedInt32Array:
	if seg.size() == 1:
		return seg.duplicate()
	_init_tables()
	_order(seg)
	var out := PackedInt32Array()
	var starter := -1
	var last_cc := 0
	for c in seg:
		var cc: int = 0 if c < 0x300 else _ccc.get(c, 0)
		if starter >= 0 and (last_cc == 0 or last_cc < cc):
			var comp := _combine(out[starter], c)
			if comp >= 0:
				out[starter] = comp
				continue
		if cc == 0:
			starter = out.size()
			last_cc = 0
		else:
			last_cc = cc
		out.append(c)
	return out


static func _combine(a: int, b: int) -> int:
	if a >= L_BASE and a < L_BASE + L_COUNT:
		if b >= V_BASE and b < V_BASE + V_COUNT:
			return S_BASE + ((a - L_BASE) * V_COUNT + (b - V_BASE)) * T_COUNT
		return -1
	if a >= S_BASE and a < S_BASE + S_COUNT:
		if (a - S_BASE) % T_COUNT == 0 and b > T_BASE and b < T_BASE + T_COUNT:
			return a + (b - T_BASE)
		return -1
	return _pairs.get((a << 21) | b, -1)


## Stable ordering of every run of non-zero classes: insertion for a short run, one counting pass
## by class for a long one (never a comparison sort, so a flood of marks stays linear).
static func _order(seg: PackedInt32Array) -> void:
	var n := seg.size()
	var i := 0
	while i < n:
		if ccc(seg[i]) == 0:
			i += 1
			continue
		var j := i + 1
		var sorted := true
		var prev: int = ccc(seg[i])
		while j < n:
			var cc := ccc(seg[j])
			if cc == 0:
				break
			if cc < prev:
				sorted = false
			prev = cc
			j += 1
		if not sorted:
			if j - i <= SMALL_RUN:
				_insertion(seg, i, j)
			else:
				_buckets(seg, i, j)
		i = j


static func _insertion(seg: PackedInt32Array, lo: int, hi: int) -> void:
	for a in range(lo + 1, hi):
		var v := seg[a]
		var cv := ccc(v)
		var b := a - 1
		while b >= lo and ccc(seg[b]) > cv:
			seg[b + 1] = seg[b]
			b -= 1
		seg[b + 1] = v


static func _buckets(seg: PackedInt32Array, lo: int, hi: int) -> void:
	var by_class := {}
	for a in range(lo, hi):
		var cc := ccc(seg[a])
		if not by_class.has(cc):
			by_class[cc] = PackedInt32Array()
		by_class[cc].append(seg[a])
	var keys: Array = by_class.keys()
	keys.sort()
	var at := lo
	for k in keys:
		for v in by_class[k]:
			seg[at] = v
			at += 1
