@tool
class_name PKeySyncCanonicalJson
extends RefCounted
## Canonical JSON (WIRE-CONTRACT-V5 §13.10.3 and §13.10.8), the text of an element name and of the
## sealed plaintext `P`. Object keys are sorted by UTF-16 code unit at every level, there is no
## white space, a string is escaped as ECMAScript `JSON.stringify` does, and a number is an IEEE
## double written as ECMAScript `Number::toString`.
##
## Godot's JSON parser and number printer cannot be used here: the parser is lenient, turns U+0000
## into U+FFFD, rounds the last bit of a number wrongly (and reads `5e-324` as 0), and a `String`
## cannot hold U+0000. So `canonicalize_text` runs its own strict RFC 8259 parser that reads every
## number as a binary64 with exact (big-integer) correct rounding and keeps strings as UTF-16 code
## units, and `canonicalize_value` takes a built value.
##
## Refused, never spelled differently: a number that is not finite (NaN, Infinity, or a literal
## that overflows), a string or key with a lone surrogate, an integer-typed value whose magnitude is
## over 2^53 (a number in JSON text is a double, as in every other SDK), a duplicate key, nesting
## past MAX_DEPTH, and any text that is not strict JSON.
##
## Results are `{"ok": true, "canonical": String, "bytes": PackedByteArray}` or
## `{"ok": false, "error": String}`. `bytes` is the UTF-8 text, the form every caller hashes or pads.

const MAX_DEPTH := 64
const MAX_SAFE_INT := 9007199254740992  # 2^53
const _MAX_DIGITS := 800
const _INF_BITS := 0x7FF0000000000000
const _HEX := "0123456789abcdef"


static func canonicalize_text(json: String) -> Dictionary:
	var p := _Parser.new()
	p.text = json
	p.n = json.length()
	var out: Variant = p.parse_document()
	if out == null:
		return {"ok": false, "error": p.err}
	return _ok(out)


## `value`: null, bool, int, float, String, Array, Dictionary (String keys).
static func canonicalize_value(value: Variant) -> Dictionary:
	var err := [""]
	var out: Variant = _from_value(value, 1, err)
	if out == null:
		return {"ok": false, "error": err[0]}
	return _ok(out)


static func _ok(bytes: PackedByteArray) -> Dictionary:
	return {"ok": true, "canonical": bytes.get_string_from_utf8(), "bytes": bytes}


static func _from_value(v: Variant, depth: int, err: Array) -> Variant:
	if depth > MAX_DEPTH:
		err[0] = "nesting too deep"
		return null
	match typeof(v):
		TYPE_NIL:
			return "null".to_utf8_buffer()
		TYPE_BOOL:
			return ("true" if v else "false").to_utf8_buffer()
		TYPE_INT:
			if absi(v) > MAX_SAFE_INT:
				err[0] = "integer beyond 2^53"
				return null
			return format_number(float(v)).to_utf8_buffer()
		TYPE_FLOAT:
			var s: Variant = format_number(v)
			if s == null:
				err[0] = "number is not finite"
				return null
			return String(s).to_utf8_buffer()
		TYPE_STRING, TYPE_STRING_NAME:
			var u: Variant = _units_of(String(v))
			if u == null:
				err[0] = "lone surrogate"
				return null
			var q: Variant = quote_units(u)
			if q == null:
				err[0] = "lone surrogate"
			return q
		TYPE_ARRAY:
			var out := PackedByteArray([91])
			var first := true
			for e in v:
				var b: Variant = _from_value(e, depth + 1, err)
				if b == null:
					return null
				if not first:
					out.append(44)
				first = false
				out.append_array(b)
			out.append(93)
			return out
		TYPE_DICTIONARY:
			var members: Array = []
			for k in v:
				if not (k is String or k is StringName):
					err[0] = "object key is not a string"
					return null
				var ku: Variant = _units_of(String(k))
				if ku == null:
					err[0] = "lone surrogate"
					return null
				var vb: Variant = _from_value(v[k], depth + 1, err)
				if vb == null:
					return null
				members.append([ku, vb])
			return _object_bytes(members, err)
	err[0] = "unsupported value type"
	return null


## The code units of a `String`, or null when it holds a surrogate code point.
static func _units_of(s: String) -> Variant:
	var u := PackedInt32Array()
	for i in s.length():
		var c := s.unicode_at(i)
		if c >= 0xD800 and c <= 0xDFFF:
			return null
		if c > 0xFFFF:
			c -= 0x10000
			u.append(0xD800 + (c >> 10))
			u.append(0xDC00 + (c & 0x3FF))
		else:
			u.append(c)
	return u


## `members`: Array of [key units, value bytes]. Sorts by key units; refuses a duplicate key.
static func _object_bytes(members: Array, err: Array) -> Variant:
	members.sort_custom(func(a: Array, b: Array) -> bool: return _units_cmp(a[0], b[0]) < 0)
	var out := PackedByteArray([123])
	for i in members.size():
		if i > 0:
			if _units_cmp(members[i - 1][0], members[i][0]) == 0:
				err[0] = "duplicate key"
				return null
			out.append(44)
		var kq: Variant = quote_units(members[i][0])
		if kq == null:
			err[0] = "lone surrogate"
			return null
		out.append_array(kq)
		out.append(58)
		out.append_array(members[i][1])
	out.append(125)
	return out


static func _units_cmp(a: PackedInt32Array, b: PackedInt32Array) -> int:
	var n := mini(a.size(), b.size())
	for i in n:
		if a[i] != b[i]:
			return -1 if a[i] < b[i] else 1
	return signi(a.size() - b.size())


## The quoted, escaped UTF-8 bytes of a string given as UTF-16 code units, or null for a lone
## surrogate.
static func quote_units(u: PackedInt32Array) -> Variant:
	var out := PackedByteArray([34])
	var i := 0
	var n := u.size()
	while i < n:
		var c := u[i]
		i += 1
		if c >= 0xD800 and c <= 0xDBFF:
			if i >= n or u[i] < 0xDC00 or u[i] > 0xDFFF:
				return null
			c = 0x10000 + ((c - 0xD800) << 10) + (u[i] - 0xDC00)
			i += 1
		elif c >= 0xDC00 and c <= 0xDFFF:
			return null
		if c < 0x20 or c == 34 or c == 92:
			out.append(92)
			match c:
				34: out.append(34)
				92: out.append(92)
				8: out.append(98)
				9: out.append(116)
				10: out.append(110)
				12: out.append(102)
				13: out.append(114)
				_:
					out.append_array("u00".to_utf8_buffer())
					out.append(_HEX.unicode_at(c >> 4))
					out.append(_HEX.unicode_at(c & 15))
		elif c < 0x80:
			out.append(c)
		elif c < 0x800:
			out.append(0xC0 | (c >> 6))
			out.append(0x80 | (c & 0x3F))
		elif c < 0x10000:
			out.append(0xE0 | (c >> 12))
			out.append(0x80 | ((c >> 6) & 0x3F))
			out.append(0x80 | (c & 0x3F))
		else:
			out.append(0xF0 | (c >> 18))
			out.append(0x80 | ((c >> 12) & 0x3F))
			out.append(0x80 | ((c >> 6) & 0x3F))
			out.append(0x80 | (c & 0x3F))
	out.append(34)
	return out


# ── Numbers ─────────────────────────────────────────────────────────────────────────────────


## ECMAScript `Number::toString` of a double, or null when it is not finite.
static func format_number(x: float) -> Variant:
	if is_nan(x) or is_inf(x):
		return null
	if x == 0.0:
		return "0"
	var sign := ""
	if x < 0.0:
		sign = "-"
		x = -x
	var sci := String.num_scientific(x)  # shortest digits that round-trip: "d.ddde+XX", "100", "0.1"
	var exp10 := 0
	var e_at := sci.find("e")
	var mant := sci
	if e_at >= 0:
		mant = sci.substr(0, e_at)
		exp10 = int(sci.substr(e_at + 1))
	var point := mant.find(".")
	var digits := mant.replace(".", "")
	var pos := digits.length() if point < 0 else point
	var lead := 0
	while lead < digits.length() - 1 and digits[lead] == "0":
		lead += 1
	digits = digits.substr(lead)
	pos -= lead
	var end := digits.length()
	while end > 1 and digits[end - 1] == "0":
		end -= 1
	digits = digits.substr(0, end)
	var k := digits.length()
	var n := pos + exp10  # value = 0.<digits> * 10^n
	# The engine's digits must read back to the same double, else do not pretend.
	if _decimal_to_bits(digits, n - k) != _bits_of(x):
		return null
	var s: String
	if k <= n and n <= 21:
		s = digits + "0".repeat(n - k)
	elif 0 < n and n <= 21:
		s = digits.substr(0, n) + "." + digits.substr(n)
	elif -6 < n and n <= 0:
		s = "0." + "0".repeat(-n) + digits
	else:
		var e := n - 1
		var es := ("+" if e >= 0 else "-") + str(absi(e))
		s = digits[0] + ("" if k == 1 else "." + digits.substr(1)) + "e" + es
	return sign + s


static func _bits_of(x: float) -> int:
	var b := PackedByteArray()
	b.resize(8)
	b.encode_double(0, x)
	return b.decode_u64(0)


static func _double_of(bits: int) -> float:
	var b := PackedByteArray()
	b.resize(8)
	b.encode_u64(0, bits)
	return b.decode_double(0)


## The binary64 nearest the decimal `digits * 10^e10` (round half to even), as a double; NAN when
## it overflows (the value is at least half an ulp above the largest double). `digits` is
## non-empty ASCII digits without a leading zero.
static func parse_decimal(digits: String, e10: int) -> float:
	var bits := _decimal_to_bits(digits, e10)
	if bits < 0 or bits >= _INF_BITS:
		return NAN
	return _double_of(bits)


## The bit pattern of the correctly rounded double (>= 0), -1 on overflow, -2 when it did not
## settle. Starts from the engine's estimate and moves it one ulp at a time against exact
## big-integer comparisons with the midpoints, so no engine rounding error survives.
static func _decimal_to_bits(digits: String, e10: int) -> int:
	var mag := digits.length() + e10  # 10^(mag-1) <= value < 10^mag
	if mag > 310:
		return -1
	if mag < -330:
		return 0
	# The engine's reading is only a starting point (it may be 0 or far off in the denormal range),
	# so a small value is read scaled up into the normal range and scaled back down.
	var est := (digits + "e" + str(e10)).to_float()
	if mag < -300:
		est = (digits + "e" + str(e10 + 100)).to_float() * 1e-100
	var bits := 0x7FEFFFFFFFFFFFFF if is_inf(est) else _bits_of(absf(est))
	var big := _bn_of_digits(digits)
	var settled := false
	for _i in 400:
		var up := _cmp_mid(big, e10, bits)
		if up > 0:
			bits += 1
			continue
		if up == 0:
			if bits & 1 == 1:
				bits += 1
			settled = true
			break
		if bits == 0:
			settled = true
			break
		var lo := _cmp_mid(big, e10, bits - 1)
		if lo < 0:
			bits -= 1
			continue
		if lo == 0 and bits & 1 == 1:
			bits -= 1
		settled = true
		break
	if not settled:
		return -2
	return -1 if bits >= _INF_BITS else bits


## Compares `big * 10^e10` with the midpoint of the doubles `bits` and `bits + 1`.
static func _cmp_mid(big: PackedInt64Array, e10: int, bits: int) -> int:
	var ex := (bits >> 52) & 0x7FF
	var frac := bits & 0xFFFFFFFFFFFFF
	var m := frac
	var q := -1074
	if ex != 0:
		m = frac | 0x10000000000000
		q = ex - 1075
	var p := q - 1  # midpoint = (2m + 1) * 2^p
	var left := big.duplicate()
	var right := _bn_of_int(2 * m + 1)
	if e10 > 0:
		_bn_mul_pow10(left, e10)
	else:
		_bn_mul_pow10(right, -e10)
	if p > 0:
		_bn_shl(right, p)
	else:
		_bn_shl(left, -p)
	return _bn_cmp(left, right)


# Big integers: little-endian base 2^32 limbs in a PackedInt64Array.


static func _bn_of_int(v: int) -> PackedInt64Array:
	var a := PackedInt64Array()
	while v > 0:
		a.append(v & 0xFFFFFFFF)
		v >>= 32
	return a


static func _bn_of_digits(digits: String) -> PackedInt64Array:
	var a := PackedInt64Array()
	var i := 0
	var n := digits.length()
	while i < n:
		var len := mini(9, n - i)
		_bn_mul_small(a, int(10 ** len))
		_bn_add_small(a, int(digits.substr(i, len)))
		i += len
	return a


## `a *= s` for 0 <= s < 2^30.
static func _bn_mul_small(a: PackedInt64Array, s: int) -> void:
	var carry := 0
	for i in a.size():
		var t := a[i] * s + carry
		a[i] = t & 0xFFFFFFFF
		carry = t >> 32
	if carry > 0:
		a.append(carry)


static func _bn_add_small(a: PackedInt64Array, s: int) -> void:
	var carry := s
	var i := 0
	while carry > 0:
		if i == a.size():
			a.append(0)
		var t := a[i] + carry
		a[i] = t & 0xFFFFFFFF
		carry = t >> 32
		i += 1


static func _bn_mul_pow10(a: PackedInt64Array, e: int) -> void:
	while e >= 9:
		_bn_mul_small(a, 1000000000)
		e -= 9
	if e > 0:
		_bn_mul_small(a, int(10 ** e))


static func _bn_shl(a: PackedInt64Array, k: int) -> void:
	while k >= 30:
		_bn_mul_small(a, 1 << 30)
		k -= 30
	if k > 0:
		_bn_mul_small(a, 1 << k)


static func _bn_cmp(a: PackedInt64Array, b: PackedInt64Array) -> int:
	var na := a.size()
	while na > 0 and a[na - 1] == 0:
		na -= 1
	var nb := b.size()
	while nb > 0 and b[nb - 1] == 0:
		nb -= 1
	if na != nb:
		return -1 if na < nb else 1
	for i in range(na - 1, -1, -1):
		if a[i] != b[i]:
			return -1 if a[i] < b[i] else 1
	return 0


# ── The strict text parser ─────────────────────────────────────────────────────────────────────


class _Parser:
	extends RefCounted
	var text := ""
	var n := 0
	var pos := 0
	var err := ""

	func parse_document() -> Variant:
		var out: Variant = _value(1)
		if out == null:
			return null
		_ws()
		if pos != n:
			return _fail("trailing characters at %d" % pos)
		return out

	func _fail(why: String) -> Variant:
		if err == "":
			err = why
		return null

	func _ws() -> void:
		while pos < n:
			var c := text.unicode_at(pos)
			if c == 32 or c == 9 or c == 10 or c == 13:
				pos += 1
			else:
				return

	func _value(depth: int) -> Variant:
		if depth > PKeySyncCanonicalJson.MAX_DEPTH:
			return _fail("nesting too deep")
		_ws()
		if pos >= n:
			return _fail("unexpected end")
		var c := text.unicode_at(pos)
		if c == 123:
			return _object(depth)
		if c == 91:
			return _array(depth)
		if c == 34:
			var u: Variant = _string_units()
			if u == null:
				return null
			var q: Variant = PKeySyncCanonicalJson.quote_units(u)
			if q == null:
				return _fail("lone surrogate")
			return q
		if c == 45 or (c >= 48 and c <= 57):
			return _number()
		for lit in ["true", "false", "null"]:
			if text.substr(pos, lit.length()) == lit:
				pos += lit.length()
				return lit.to_utf8_buffer()
		return _fail("unexpected character at %d" % pos)

	func _array(depth: int) -> Variant:
		pos += 1
		var out := PackedByteArray([91])
		_ws()
		if pos < n and text.unicode_at(pos) == 93:
			pos += 1
			out.append(93)
			return out
		while true:
			var v: Variant = _value(depth + 1)
			if v == null:
				return null
			out.append_array(v)
			_ws()
			if pos >= n:
				return _fail("unterminated array")
			var c := text.unicode_at(pos)
			pos += 1
			if c == 93:
				out.append(93)
				return out
			if c != 44:
				return _fail("expected , or ] at %d" % (pos - 1))
			out.append(44)
		return null

	func _object(depth: int) -> Variant:
		pos += 1
		var members: Array = []
		_ws()
		if pos < n and text.unicode_at(pos) == 125:
			pos += 1
			return PackedByteArray([123, 125])
		while true:
			_ws()
			if pos >= n or text.unicode_at(pos) != 34:
				return _fail("expected a member name at %d" % pos)
			var ku: Variant = _string_units()
			if ku == null:
				return null
			_ws()
			if pos >= n or text.unicode_at(pos) != 58:
				return _fail("expected : at %d" % pos)
			pos += 1
			var v: Variant = _value(depth + 1)
			if v == null:
				return null
			members.append([ku, v])
			_ws()
			if pos >= n:
				return _fail("unterminated object")
			var c := text.unicode_at(pos)
			pos += 1
			if c == 125:
				break
			if c != 44:
				return _fail("expected , or } at %d" % (pos - 1))
		var e := [""]
		var out: Variant = PKeySyncCanonicalJson._object_bytes(members, e)
		if out == null:
			return _fail(e[0])
		return out

	## A string token as UTF-16 code units (escapes give code units directly), or null.
	func _string_units() -> Variant:
		pos += 1
		var u := PackedInt32Array()
		while pos < n:
			var c := text.unicode_at(pos)
			pos += 1
			if c == 34:
				return u
			if c < 0x20:
				return _fail("raw control character at %d" % (pos - 1))
			if c == 92:
				if pos >= n:
					break
				var e := text.unicode_at(pos)
				pos += 1
				match e:
					34: u.append(34)
					92: u.append(92)
					47: u.append(47)
					98: u.append(8)
					102: u.append(12)
					110: u.append(10)
					114: u.append(13)
					116: u.append(9)
					117:
						if pos + 4 > n:
							return _fail("bad \\u escape")
						var hex := text.substr(pos, 4)
						if not hex.is_valid_hex_number():
							return _fail("bad \\u escape")
						u.append(hex.hex_to_int())
						pos += 4
					_:
						return _fail("bad escape at %d" % (pos - 1))
			elif c > 0xFFFF:
				c -= 0x10000
				u.append(0xD800 + (c >> 10))
				u.append(0xDC00 + (c & 0x3FF))
			else:
				u.append(c)
		return _fail("unterminated string")

	func _is_digit(c: int) -> bool:
		return c >= 48 and c <= 57

	func _number() -> Variant:
		var start := pos
		var neg := false
		if text.unicode_at(pos) == 45:
			neg = true
			pos += 1
		if pos >= n or not _is_digit(text.unicode_at(pos)):
			return _fail("bad number at %d" % start)
		var int_start := pos
		if text.unicode_at(pos) == 48:
			pos += 1
		else:
			while pos < n and _is_digit(text.unicode_at(pos)):
				pos += 1
		var digits := text.substr(int_start, pos - int_start)
		var frac := ""
		if pos < n and text.unicode_at(pos) == 46:
			pos += 1
			var fs := pos
			while pos < n and _is_digit(text.unicode_at(pos)):
				pos += 1
			if pos == fs:
				return _fail("bad number at %d" % start)
			frac = text.substr(fs, pos - fs)
		var exp := 0
		var huge := false
		if pos < n and (text.unicode_at(pos) == 101 or text.unicode_at(pos) == 69):
			pos += 1
			var eneg := false
			if pos < n and (text.unicode_at(pos) == 43 or text.unicode_at(pos) == 45):
				eneg = text.unicode_at(pos) == 45
				pos += 1
			var es := pos
			while pos < n and _is_digit(text.unicode_at(pos)):
				pos += 1
			if pos == es:
				return _fail("bad number at %d" % start)
			var estr := text.substr(es, pos - es).lstrip("0")
			if estr.length() > 9:
				huge = true
				exp = 1000000000
			elif estr != "":
				exp = int(estr)
			if eneg:
				exp = -exp
		var all := (digits + frac).lstrip("0")
		var e10 := exp - frac.length()
		if all == "":
			return "0".to_utf8_buffer()
		var end := all.length()
		while end > 1 and all[end - 1] == "0":
			end -= 1
		e10 += all.length() - end
		all = all.substr(0, end)
		if all.length() > PKeySyncCanonicalJson._MAX_DIGITS:
			return _fail("number has too many digits")
		var x: float
		if huge:
			if e10 > 0:
				return _fail("number is not finite")
			return "0".to_utf8_buffer()
		x = PKeySyncCanonicalJson.parse_decimal(all, e10)
		if is_nan(x):
			return _fail("number is not finite")
		if neg:
			x = -x
		var s: Variant = PKeySyncCanonicalJson.format_number(x)
		if s == null:
			return _fail("number could not be spelled")
		return String(s).to_utf8_buffer()
