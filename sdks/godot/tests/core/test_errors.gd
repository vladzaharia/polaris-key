extends RefCounted
# @pkey-feature core.errors
# Every code the SDK raises is in the generated registry (conformance/parity/errors.json, via
# PKeyConstants): PKeyErrors holds every code PKeyResult.failure is called with (the wire codes
# a server body carries pass through unchanged), so each of its constants must be a registered
# value, wire codes as `wire` and client codes as `client`.


func run(t: PKeyTestContext) -> void:
	var consts: Dictionary = (PKeyErrors as Script).get_script_constant_map()
	var checked := 0
	var missing := []
	for name in consts:
		var v = consts[name]
		if not (v is StringName or v is String):
			continue
		checked += 1
		if not PKeyConstants.ERROR_CODE_VALUES.has(String(v)):
			missing.append(String(v))
	t.check("errors: every PKeyErrors code is in the generated registry", missing.is_empty(), str(missing))
	t.check("errors: a wire code is registered as wire", PKeyConstants.ERROR_CODE_KINDS.get(String(PKeyErrors.DEVICE_LIMIT)) == "wire", str(PKeyConstants.ERROR_CODE_KINDS.get(String(PKeyErrors.DEVICE_LIMIT))))
	t.check("errors: a client code is registered as client", PKeyConstants.ERROR_CODE_KINDS.get(String(PKeyErrors.RESPONSE_TOO_LARGE)) == "client")
	t.check("errors: the generated constant matches", PKeyConstants.ErrorCode.TOO_MANY_REDIRECTS == String(PKeyErrors.TOO_MANY_REDIRECTS))
	t.check("errors: coverage", checked >= 30, "%d codes checked" % checked)
