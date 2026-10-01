class_name PKeyVersion
extends RefCounted
## Version ordering under a product's scheme (plans/P3-01.md §2.8 "Versions", WIRE-CONTRACT-V4
## §11): a port of client-core `version.ts`, pinned by `update-matrix.json#/versionCases`.
##
##   parse_version(scheme, v)       {scheme, core, prerelease, build} or null
##   compare_versions(scheme, a, b) -1, 0 or 1, or null when either side does not parse
##
## Every comparison is on ASCII digit strings ("unbounded integers": leading zeros removed, then
## length, then ASCII order), so nothing loses precision past 2^53 and no float is involved.
## Every grammar matches the WHOLE string with ASCII classes, through PKeyClaims' pattern helper,
## so `1.2.3\n` does not parse. The schemes are not an enum (`semver+build` and `4part` are not
## identifiers): SCHEMES is the hand-written list every runner asserts against
## `update-matrix.json#/vocabulary/schemes`.

## `semver`, `semver+build`, `4part`, in the vocabulary's order.
static var SCHEMES := PackedStringArray(["semver", "semver+build", "4part"])

## SemVer 2.0's own grammar with ASCII classes: no empty identifier, no leading zero in a
## numeric prerelease identifier.
const SEMVER_PATTERN := "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?"
## P2-04's `FOUR_PART_RE`.
const FOUR_PART_PATTERN := "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)"

static var _semver_re: RegEx
static var _four_re: RegEx
static var _digits_re: RegEx


static func _static_init() -> void:
	_semver_re = PKeyClaims.whole(SEMVER_PATTERN)
	_four_re = PKeyClaims.whole(FOUR_PART_PATTERN)
	_digits_re = PKeyClaims.whole("[0-9]+")


static func _re(which: int) -> RegEx:
	# A non-tool script's static vars are skipped in the editor; compile on first use there.
	if _semver_re == null:
		_static_init()
	return [_semver_re, _four_re, _digits_re][which]


## True when `v` is ASCII digits only.
static func is_digits(v: String) -> bool:
	return PKeyClaims.matches_whole_re(_re(2), v)


## `v` parsed under `scheme`, or null when it does not parse (or the scheme is unknown):
## {scheme, core: PackedStringArray, prerelease: PackedStringArray or null, build: String or null}.
static func parse_version(scheme: Variant, v: Variant) -> Variant:
	if not (scheme is String) or not (v is String):
		return null
	if scheme == "semver" or scheme == "semver+build":
		if not PKeyClaims.matches_whole_re(_re(0), v):
			return null
		var m := _re(0).search(v)
		var pre = null
		if m.get_start(4) != -1:
			pre = m.get_string(4).split(".", true)
		var build = null
		if m.get_start(5) != -1:
			build = m.get_string(5)
		return {
			"scheme": scheme,
			"core": PackedStringArray([m.get_string(1), m.get_string(2), m.get_string(3)]),
			"prerelease": pre,
			"build": build,
		}
	if scheme == "4part":
		if not PKeyClaims.matches_whole_re(_re(1), v):
			return null
		var m := _re(1).search(v)
		return {
			"scheme": scheme,
			"core": PackedStringArray([m.get_string(1), m.get_string(2), m.get_string(3), m.get_string(4)]),
			"prerelease": null,
			"build": null,
		}
	return null


## Two unbounded non-negative integers given as ASCII digit strings.
static func compare_digits(a: String, b: String) -> int:
	var x := _strip_zeros(a)
	var y := _strip_zeros(b)
	if x.length() != y.length():
		return -1 if x.length() < y.length() else 1
	return compare_ascii(x, y)


static func _strip_zeros(s: String) -> String:
	var k := 0
	while k < s.length() - 1 and s.unicode_at(k) == 0x30:
		k += 1
	return s.substr(k)


## Byte order over ASCII text (every identifier compared here is ASCII by its grammar).
static func compare_ascii(a: String, b: String) -> int:
	if a == b:
		return 0
	var n := mini(a.length(), b.length())
	for k in n:
		var x := a.unicode_at(k)
		var y := b.unicode_at(k)
		if x != y:
			return -1 if x < y else 1
	return -1 if a.length() < b.length() else 1


## SemVer 2.0 §11 precedence; build metadata is ignored.
static func _precedence(a: Dictionary, b: Dictionary) -> int:
	for k in 3:
		var c := compare_digits(a["core"][k], b["core"][k])
		if c != 0:
			return c
	var pa = a["prerelease"]
	var pb = b["prerelease"]
	if pa == null and pb == null:
		return 0
	if pa == null:
		return 1
	if pb == null:
		return -1
	var xa: PackedStringArray = pa
	var xb: PackedStringArray = pb
	for k in mini(xa.size(), xb.size()):
		var xn := is_digits(xa[k])
		var yn := is_digits(xb[k])
		var c: int
		if xn and yn:
			c = compare_digits(xa[k], xb[k])
		elif xn:
			c = -1
		elif yn:
			c = 1
		else:
			c = compare_ascii(xa[k], xb[k])
		if c != 0:
			return c
	# A shorter list that is a prefix of a longer one is lower.
	if xa.size() == xb.size():
		return 0
	return -1 if xa.size() < xb.size() else 1


## `cmp(a, b)` under `scheme`: -1, 0 or 1, or null when either side does not parse.
## `semver+build` breaks a precedence tie with build metadata that is ASCII digits only, compared
## as an unbounded integer; a version without such metadata is lower than one with it.
static func compare_versions(scheme: Variant, a: Variant, b: Variant) -> Variant:
	var pa = parse_version(scheme, a)
	var pb = parse_version(scheme, b)
	if pa == null or pb == null:
		return null
	if scheme == "4part":
		for k in 4:
			var c := compare_digits(pa["core"][k], pb["core"][k])
			if c != 0:
				return c
		return 0
	var c := _precedence(pa, pb)
	if c != 0 or scheme != "semver+build":
		return c
	var na = pa["build"] if pa["build"] != null and is_digits(pa["build"]) else null
	var nb = pb["build"] if pb["build"] != null and is_digits(pb["build"]) else null
	if na == null and nb == null:
		return 0
	if na == null:
		return -1
	if nb == null:
		return 1
	return compare_digits(na, nb)
