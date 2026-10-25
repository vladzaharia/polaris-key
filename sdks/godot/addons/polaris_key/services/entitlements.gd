class_name PKeyEntitlements
extends RefCounted
## `PolarisKey.entitlements`: the licence's grants, as a thin view over the licence gate (SP-35 L9).
## Present before `configure()`; until then (and while no licence verifies) `has` is false,
## `value` is null and `all` is {}.
##
##   has(name)     true only when the grant's value is the boolean true AND the gate is usable
##                 (ok, grace, not-applicable). A revoked, expired or blocked licence answers false
##                 even though its last verified document still lists the grant (S-19 G11).
##   value(name)   the grant's value (any JSON type), or null when the gate is not usable or the
##                 grant is absent
##   all()         {name: value} off the verified licence document, ungated, for diagnostics

var _license: PKeyLicense = null


## Called by `configure()` once the licence surface exists.
func attach(license: PKeyLicense) -> void:
	_license = license


func has(name: String) -> bool:
	var e = _grant(name)
	return e is Dictionary and PKeyClaims.is_true(e.get("value"))


func value(name: String) -> Variant:
	var e = _grant(name)
	return e.get("value") if e is Dictionary else null


func all() -> Dictionary:
	var out := {}
	if _license == null:
		return out
	var ents := _license._entitlements()
	for k in ents:
		if ents[k] is Dictionary:
			out[k] = ents[k].get("value")
	return out


func _grant(name: String) -> Variant:
	if _license == null or not _license.is_licensed():
		return null
	return _license._entitlements().get(name)
