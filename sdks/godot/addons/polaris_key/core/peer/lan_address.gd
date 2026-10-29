@tool
class_name PKeyLanAddress
extends RefCounted
## WIRE-CONTRACT-V5 section 15.4.1: which peer address a device may dial or accept on the local
## network, and the keys of the per-address and per-group connection counts. A literal-only port of
## client-core's `lanAddress.ts` (`lanVerdict`, `lanGroupKey`): text in, a verdict out, no socket
## and no clock. The caller applies the verdict before the first byte on a dial and before a slot
## and before any read on an accept.
##
## - Spelling: a zone is `%` and 1 to 15 characters of U+0021 to U+007E other than `%`; any other
##   zone, a second `%`, a zone on IPv4 and a zone on an IPv4-mapped address are malformed. The
##   verdict ignores a zone; the key of a link-local address keeps it.
## - An IPv4-mapped address (::ffff:0:0/96) is judged as its IPv4 address.
## - IPv4: 10/8, 172.16/12 and 192.168/16; 127/8 only with `allow_loopback`.
## - IPv6: fe80::/10; fc00::/7 (when `local` is known it must be IPv6 in the same /64); ::1 only
##   with `allow_loopback`; an address in 2000::/3 outside 2001::/32 (Teredo) and 2002::/16 (6to4)
##   only when the local address is IPv6 in the same /64.
## - Everything else is refused, including text that is not an address.
##
## Godot sockets expose no local address and no zone, so a caller on this lane passes `local = null`
## (a global IPv6 address is then refused, and a ULA address is judged on its own).
## `CANDIDATES` targets are not read on this lane, so there is no `candidate_target`.


## Judge a peer address. `remote` is the socket's remote address, with or without a zone; `local`
## its own local address as text, or null when unknown. `allow_loopback` accepts 127/8 and ::1 (tests
## and same-host peers only: production code never sets it). Answers {dial = bool, key = String or
## null}: `key` is dotted IPv4, or RFC 5952 lower-case IPv6 text (a link-local key keeps its zone,
## any other drops it), and is the full address, never the /64. `key` is null when `dial` is false.
static func verdict(remote: String, local: Variant, allow_loopback: bool) -> Dictionary:
	var refuse := {"dial": false, "key": null}
	var p := _parse(remote)
	if p.is_empty():
		return refuse
	if p["v4"]:
		var o: Array = p["g"]
		if _allowed4(o, allow_loopback):
			return {"dial": true, "key": _dotted(o)}
		return refuse
	var g: Array = p["g"]
	var accept := {"dial": true, "key": _text6(g)}
	var g0: int = g[0]
	if _zero_to(g, 7) and g[7] == 1:
		return accept if allow_loopback else refuse  # ::1
	if (g0 & 0xffc0) == 0xfe80:  # fe80::/10
		var zone: Variant = p["zone"]
		return {"dial": true, "key": _text6(g) if zone == null else "%s%%%s" % [_text6(g), zone]}
	if (g0 & 0xfe00) == 0xfc00:
		# fc00::/7 is routed, so it is on-link only when the local address says so.
		if local == null:
			return accept
		return accept if _same_slash64(g, local) else refuse
	if (g0 & 0xe000) != 0x2000:  # not 2000::/3
		return refuse
	if g0 == 0x2001 and g[1] == 0:  # Teredo 2001::/32
		return refuse
	if g0 == 0x2002:  # 6to4 2002::/16
		return refuse
	if local == null:
		return refuse
	return accept if _same_slash64(g, local) else refuse


## The key of the per-group count for a verdict `key`: `fe80::/10%zone` for a link-local address
## (`fe80::/10` when the key has no zone), `a.b.c.0/24` for IPv4, the /64 (`2001:db8:1:2::/64`) for
## any other IPv6 address; null for no key. One neighbour cannot rotate out of its link, its /24 or
## its /64 by changing source address.
static func group_key(key: Variant) -> Variant:
	if not (key is String):
		return null
	var p := _parse(key)
	if p.is_empty():
		return null
	var g: Array = p["g"]
	if p["v4"]:
		return "%d.%d.%d.0/24" % [g[0], g[1], g[2]]
	if (int(g[0]) & 0xffc0) == 0xfe80:
		var zone: Variant = p["zone"]
		return "fe80::/10" if zone == null else "fe80::/10%%%s" % zone
	return "%s/64" % _text6([g[0], g[1], g[2], g[3], 0, 0, 0, 0])


# ── parsing ──────────────────────────────────────────────────────────────────────────────

## {v4 = bool, g = groups (four octets, or eight 16-bit groups), zone = String or null}, or {} when
## `text` is not an address.
static func _parse(text: String) -> Dictionary:
	var s := text
	var zone: Variant = null
	var pct := s.find("%")
	if pct >= 0:
		var z := s.substr(pct + 1)
		if not _zone_ok(z):
			return {}  # empty, a second `%`, a control, a space, too long
		zone = z
		s = s.substr(0, pct)
		if not s.contains(":"):
			return {}  # only IPv6 carries a zone
	if s.contains(":"):
		var g = _parse_v6(s)
		if g == null:
			return {}
		var gs: Array = g
		var head_zero := true
		for i in 5:
			if gs[i] != 0:
				head_zero = false
		if head_zero and gs[5] == 0xffff:
			if zone != null:
				return {}  # a zone on a mapped address is ambiguous
			return {"v4": true, "g": [int(gs[6]) >> 8, int(gs[6]) & 255, int(gs[7]) >> 8, int(gs[7]) & 255], "zone": null}
		return {"v4": false, "g": gs, "zone": zone}
	var o := _parse_v4(s)
	if o.is_empty():
		return {}
	return {"v4": true, "g": o, "zone": null}


## 1 to 15 characters of U+0021 to U+007E other than `%`. Judged on the UTF-8 bytes: any non-ASCII
## character has a byte above 0x7e.
static func _zone_ok(z: String) -> bool:
	var b := z.to_utf8_buffer()
	if b.size() < 1 or b.size() > 15:
		return false
	for c in b:
		if c < 0x21 or c > 0x7e or c == 0x25:
			return false
	return true


## Four octets, or empty. Decimal digits only (ASCII), no sign, no leading zero.
static func _parse_v4(s: String) -> Array[int]:
	var out: Array[int] = []
	var parts := s.split(".", true)
	if parts.size() != 4:
		return []
	for part in parts:
		var b := part.to_utf8_buffer()
		if b.size() < 1 or b.size() > 3 or (b.size() > 1 and b[0] == 0x30):
			return []
		var n := 0
		for c in b:
			if c < 0x30 or c > 0x39:
				return []
			n = n * 10 + (c - 0x30)
		if n > 255:
			return []
		out.append(n)
	return out


## `fe80::1`, `::ffff:1.2.3.4`, a full eight-group form: eight groups, or null.
static func _parse_v6(s: String) -> Variant:
	for c in s.to_utf8_buffer():
		if not (_is_hex(c) or c == 0x3a or c == 0x2e):
			return null
	var halves := s.split("::", true)
	if halves.size() > 2:
		return null
	if halves.size() == 1:
		var all = _groups(s, true)
		return all if all != null and (all as Array).size() == 8 else null
	var head = _groups(halves[0], false)
	var tail = _groups(halves[1], true)
	if head == null or tail == null:
		return null
	# `::` stands for one or more zero groups.
	var gap := 8 - (head as Array).size() - (tail as Array).size()
	if gap < 1:
		return null
	var out: Array[int] = []
	out.append_array(head)
	for i in gap:
		out.append(0)
	out.append_array(tail)
	return out


## The groups of one side of the address, or null. A dotted IPv4 closes the address (`last`) and
## stands for two groups.
static func _groups(part: String, last: bool) -> Variant:
	var out: Array[int] = []
	if part == "":
		return out
	var items := part.split(":", true)
	for i in items.size():
		var it: String = items[i]
		if it.contains("."):
			if not last or i != items.size() - 1:
				return null
			var o := _parse_v4(it)
			if o.is_empty():
				return null
			out.append(o[0] * 256 + o[1])
			out.append(o[2] * 256 + o[3])
		else:
			var b := it.to_utf8_buffer()
			if b.size() < 1 or b.size() > 4:
				return null
			var n := 0
			for c in b:
				if not _is_hex(c):
					return null
				n = n * 16 + _hex_value(c)
			out.append(n)
	return out


static func _is_hex(c: int) -> bool:
	return (c >= 0x30 and c <= 0x39) or (c >= 0x41 and c <= 0x46) or (c >= 0x61 and c <= 0x66)


static func _hex_value(c: int) -> int:
	if c <= 0x39:
		return c - 0x30
	if c <= 0x46:
		return c - 0x41 + 10
	return c - 0x61 + 10


# ── rules ────────────────────────────────────────────────────────────────────────────────

static func _allowed4(o: Array, allow_loopback: bool) -> bool:
	var a: int = o[0]
	var b: int = o[1]
	if a == 10:
		return true
	if a == 172 and b >= 16 and b <= 31:
		return true
	if a == 192 and b == 168:
		return true
	return a == 127 and allow_loopback


## The first `n` groups are all zero.
static func _zero_to(g: Array, n: int) -> bool:
	for i in n:
		if g[i] != 0:
			return false
	return true


## `local` is IPv6 (not mapped) and shares the first 64 bits with `g`.
static func _same_slash64(g: Array, local: Variant) -> bool:
	var l := _parse(local if local is String else "")
	if l.is_empty() or l["v4"]:
		return false
	var lg: Array = l["g"]
	for i in 4:
		if lg[i] != g[i]:
			return false
	return true


# ── text ─────────────────────────────────────────────────────────────────────────────────

static func _dotted(o: Array) -> String:
	return "%d.%d.%d.%d" % [o[0], o[1], o[2], o[3]]


## RFC 5952: lower case, no leading zeros, the first longest run of two or more zero groups is `::`.
static func _text6(g: Array) -> String:
	var at := -1
	var run := 0
	var i := 0
	while i < 8:
		if g[i] != 0:
			i += 1
			continue
		var j := i
		while j < 8 and g[j] == 0:
			j += 1
		if j - i > run:
			at = i
			run = j - i
		i = j
	if run < 2:
		return _join(g)
	return "%s::%s" % [_join(g.slice(0, at)), _join(g.slice(at + run))]


static func _join(xs: Array) -> String:
	var parts := PackedStringArray()
	for x in xs:
		parts.append("%x" % int(x))
	return ":".join(parts)
