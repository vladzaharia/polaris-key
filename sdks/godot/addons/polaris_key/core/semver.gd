class_name PKeySemver
extends RefCounted
## Client-side semver and channel helpers: a port of `client-core/src/semver.ts`, which mirrors
## the Worker's gate and is pinned by the corpus. Used to refuse a non-semver version at
## `configure` (here) and by the licence gate (P1-03) and the update check (P1-08).
##
## Numbers compare as float64, like JS `Number`, so an oversized component behaves the same.

static var _re: RegEx
static var _digits: RegEx
static var _pr: RegEx


static func _static_init() -> void:
	_re = RegEx.create_from_string("\\A([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:-([0-9A-Za-z\\-.]+))?(?:\\+[0-9A-Za-z\\-.]+)?\\z")
	_digits = RegEx.create_from_string("\\A[0-9]+\\z")
	_pr = RegEx.create_from_string("\\A0\\.0\\.0-pr-?[0-9]+")


## {major, minor, patch, prerelease: PackedStringArray}, or null when `v` is not semver.
static func parse(v: String) -> Variant:
	var m := _re.search(v)
	if m == null:
		return null
	var pre := m.get_string(4)
	return {
		"major": m.get_string(1).to_float(),
		"minor": m.get_string(2).to_float(),
		"patch": m.get_string(3).to_float(),
		"prerelease": pre.split(".") if pre != "" else PackedStringArray(),
	}


static func is_valid(v: String) -> bool:
	return parse(v) != null


## -1, 0 or 1. Either side unparseable compares as 0, as in client-core.
static func compare(a: String, b: String) -> int:
	var pa = parse(a)
	var pb = parse(b)
	if pa == null or pb == null:
		return 0
	for k in ["major", "minor", "patch"]:
		if pa[k] != pb[k]:
			return -1 if pa[k] < pb[k] else 1
	var xa: PackedStringArray = pa["prerelease"]
	var xb: PackedStringArray = pb["prerelease"]
	if xa.is_empty() and not xb.is_empty():
		return 1
	if not xa.is_empty() and xb.is_empty():
		return -1
	for i in maxi(xa.size(), xb.size()):
		if i >= xa.size():
			return -1
		if i >= xb.size():
			return 1
		var x := xa[i]
		var y := xb[i]
		if _digits.search(x) != null and _digits.search(y) != null:
			var d := x.to_float() - y.to_float()
			if d != 0:
				return -1 if d < 0 else 1
		elif x != y:
			return -1 if x < y else 1
	return 0


## "stable" | "staging" | "pr" | "dev", from a version string.
static func channel_for_version(version: String) -> String:
	if version.begins_with("0.0.0-dev"):
		return "dev"
	if version.begins_with("0.0.0-staging"):
		return "staging"
	if _pr.search(version) != null:
		return "pr"
	return "stable"


static func is_dev_build(version: String) -> bool:
	return version.begins_with("0.0.0-dev")
