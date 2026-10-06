extends RefCounted
# @pkey-feature core.copy
# The core copy API (PKeyCopy, SDK-PARITY-PASS §3.2) over the generated English tables
# (PKeyCoreCopy, from conformance/parity/copy.en.json): every entry of every table, the fallback,
# placeholder fill, the activation-versus-code split, the host override layer, and the UI kit's
# PKeyUiCopy reading it. The rule is React's packages/sdk-react/src/core/copy.ts.


func run(t: PKeyTestContext) -> void:
	var copy := PKeyCopy.new()
	_tables(t, copy)
	_fallback(t, copy)
	_placeholders(t, copy)
	_split(t, copy)
	_overrides(t)
	_kit(t)


## Every entry of the three tables reads through message()/title() as generated, with `{code}`
## filled and no raw placeholder left.
func _tables(t: PKeyTestContext, copy: PKeyCopy) -> void:
	var bad := []
	var raw := RegEx.create_from_string("\\{\\w+\\}")
	for code in PKeyCoreCopy.COPY_CODES:
		var e: Dictionary = PKeyCoreCopy.COPY_CODES[code]
		var m := copy.message(code)
		if m != PKeyCopy.fill(e["message"], code) or copy.title(code) != e["title"] or raw.search(m) != null or not copy.has(code):
			bad.append(code)
	t.check("copy: every error code reads its generated entry", bad.is_empty(), str(bad))
	t.check("copy: the code table covers every registered error code", PKeyConstants.ERROR_CODE_VALUES.all(func(c): return PKeyCoreCopy.COPY_CODES.has(c)))
	bad = []
	for status in PKeyCoreCopy.COPY_GATE:
		var e: Dictionary = PKeyCoreCopy.COPY_GATE[status]
		# A gate status that is also an error code (none today) reads the code table first.
		var want: Dictionary = PKeyCoreCopy.COPY_CODES.get(status, e)
		if copy.message(status) != want["message"] or copy.title(status) != want["title"]:
			bad.append(status)
	t.check("copy: every gate status reads its generated entry", bad.is_empty(), str(bad))
	bad = []
	for result in PKeyCoreCopy.COPY_ACTIVATION:
		var e: Dictionary = PKeyCoreCopy.COPY_ACTIVATION[result]
		if copy.activation_message(result, "x") != PKeyCopy.fill(e["message"], "x") or copy.activation_title(result) != e["title"]:
			bad.append(result)
	t.check("copy: every activation result reads its generated entry", bad.is_empty(), str(bad))
	t.check("copy: table sizes", PKeyCoreCopy.COPY_CODES.size() >= 100 and PKeyCoreCopy.COPY_GATE.size() == 9 and PKeyCoreCopy.COPY_ACTIVATION.size() == 14, "%d/%d/%d" % [PKeyCoreCopy.COPY_CODES.size(), PKeyCoreCopy.COPY_GATE.size(), PKeyCoreCopy.COPY_ACTIVATION.size()])
	t.check("copy: PolarisKey core exposes the shared copy", PKeyCore.new().copy == PKeyCopy.shared())


## A code with no entry reads COPY_FALLBACK naming the code, never a raw body.
func _fallback(t: PKeyTestContext, copy: PKeyCopy) -> void:
	var m := copy.message("brand_new_code")
	t.check("copy: an unknown code reads the fallback naming it", m == "Something went wrong (brand_new_code). Try again.", m)
	t.check("copy: an unknown code reads the fallback title", copy.title("brand_new_code") == PKeyCoreCopy.COPY_FALLBACK["title"])
	t.check("copy: an unknown code has no copy", not copy.has("brand_new_code") and not copy.has(null) and not copy.has(""))
	t.check("copy: a null code reads the fallback", copy.message(null) == "Something went wrong (). Try again.")
	t.check("copy: detail is appended in parentheses", copy.message("forbidden", {}, "bound_elsewhere") == "You don't have permission to do that. (bound_elsewhere)")
	t.check("copy: an unknown activation kind reads message()", copy.activation_message("unsupported") == copy.message("unsupported"))


## `{name}` placeholders: params by camelCase or snake_case, `{code}` by default, whole floats
## without ".0", an unfilled placeholder dropped with the space before it.
func _placeholders(t: PKeyTestContext, copy: PKeyCopy) -> void:
	var owned := copy.message("license_owned", {"product": "Diceroll"})
	t.check("copy: {product} is filled", owned == "This Diceroll license is already in another Polaris Key account. A license never moves by its key.", owned)
	var dropped := copy.message("license_owned")
	t.check("copy: an unfilled placeholder is dropped with its space", dropped == "This license is already in another Polaris Key account. A license never moves by its key.", dropped)
	t.check("copy: {code} defaults to the code", copy.activation_message("refused", "registration_closed") == "Activation was refused (registration_closed).")
	t.check("copy: a {code} param wins", PKeyCopy.fill("({code})", "a", {"code": "b"}) == "(b)")
	t.check("copy: a camelCase placeholder takes a snake_case param", PKeyCopy.fill("{deviceCount} of {limit}", "x", {"device_count": 2.0, "limit": 3}) == "2 of 3")
	t.check("copy: a fractional number keeps its fraction", PKeyCopy.fill("{retryAfterSeconds}s", "x", {"retryAfterSeconds": 1.5}) == "1.5s")
	t.check("copy: text without placeholders is unchanged", PKeyCopy.fill("Plain {", "x") == "Plain {")
	t.check("copy: every placeholder is in COPY_PLACEHOLDERS", _placeholders_known())


func _placeholders_known() -> bool:
	var re := RegEx.create_from_string("\\{(\\w+)\\}")
	for table in [PKeyCoreCopy.COPY_CODES, PKeyCoreCopy.COPY_GATE, PKeyCoreCopy.COPY_ACTIVATION, {"fallback": PKeyCoreCopy.COPY_FALLBACK}]:
		for k in table:
			for field in ["title", "message"]:
				for m in re.search_all(String(table[k][field])):
					if not PKeyCoreCopy.COPY_PLACEHOLDERS.has(m.get_string(1)):
						return false
	return true


## The error code and the activation result of the same name read differently; message(code)
## reaches the activation table only when no code or gate entry exists; any kind spelling works.
func _split(t: PKeyTestContext, copy: PKeyCopy) -> void:
	t.check("copy: error code unauthorized reads the code table", copy.title("unauthorized") == "Not signed in" and copy.message("unauthorized") == PKeyCoreCopy.COPY_CODES["unauthorized"]["message"])
	t.check("copy: activation unauthorized reads the activation table", copy.activation_title("unauthorized") == "Key not accepted" and copy.activation_message("unauthorized") == PKeyCoreCopy.COPY_ACTIVATION["unauthorized"]["message"])
	t.check("copy: message(refused) falls through to the activation table", copy.title("refused") == "Activation refused" and copy.message("refused") == "Activation was refused (refused).")
	t.check("copy: error code attestation_required differs from its activation result", copy.message("attestation_required") != copy.activation_message("attestation_required"))
	t.check("copy: gate ok differs from activation ok", copy.message("ok") == "Your license is active." and copy.activation_message("ok") == "Your license is active on this device.")
	t.check("copy: kind spellings", PKeyCopy.activation_result("deviceLimit") == "device-limit" and PKeyCopy.activation_result("device_limit") == "device-limit" and PKeyCopy.activation_result("device-limit") == "device-limit")
	t.check("copy: a typed activation kind reads its title", copy.activation_title(PKeyActivationResult.KIND_DEVICE_LIMIT) == "Device limit reached" and copy.activation_title("deviceLimit") == "Device limit reached")
	t.check("copy: a camelCase kind reaches the activation table through message()", copy.title("enrollClaimed") == "Sign in to continue")


## The host override layer wins per key and starts empty; clearing restores the generated text.
func _overrides(t: PKeyTestContext) -> void:
	var copy := PKeyCopy.new()
	copy.set_overrides({"device_limit": "All {product} seats are taken.", "activation:unauthorized": "Nope ({code})."}, {"device_limit": "Full"}, "Oops ({code}).")
	t.check("copy: a host message override wins and is filled", copy.message("device_limit", {"product": "Diceroll"}) == "All Diceroll seats are taken.")
	t.check("copy: a host title override wins", copy.title("device_limit") == "Full")
	t.check("copy: other keys keep the generated text", copy.message("forbidden") == PKeyCoreCopy.COPY_CODES["forbidden"]["message"])
	t.check("copy: an activation override does not touch the error code", copy.activation_message("unauthorized", "k") == "Nope (k)." and copy.title("unauthorized") == "Not signed in")
	t.check("copy: a host fallback names the code", copy.message("zzz") == "Oops (zzz).")
	t.check("copy: an override gives a code copy", copy.has_override("device_limit") and not copy.has_override("forbidden"))
	copy.set_overrides({"brand_new": "New."})
	t.check("copy: an override adds a code", copy.has("brand_new") and copy.message("brand_new") == "New." and copy.message("device_limit", {"product": "D"}) == "All D seats are taken.")
	copy.clear_overrides()
	t.check("copy: clearing restores the generated text", copy.message("device_limit") == PKeyCoreCopy.COPY_CODES["device_limit"]["message"] and copy.message("zzz") == "Something went wrong (zzz). Try again.")


## PKeyUiCopy reads the core copy for `error_<code>` in English, keeps its own overrides first,
## takes a core host override, and keeps its generic line for an unknown code.
func _kit(t: PKeyTestContext) -> void:
	var locale := TranslationServer.get_locale()
	TranslationServer.set_locale("en")
	var ui := PKeyUiCopy.new()
	var core := PKeyCopy.shared()
	t.check("kit: an error code reads the core copy", ui.for_code("device_limit") == PKeyCoreCopy.COPY_CODES["device_limit"]["message"], ui.for_code("device_limit"))
	t.check("kit: a code only the core knows reads it", PKeyUiCopy.code_key("feed-rollback")[0] == "error_feed-rollback" and ui.for_code("feed-rollback") == PKeyCoreCopy.COPY_CODES["feed-rollback"]["message"])
	t.check("kit: an unknown code keeps the generic line", ui.for_code("brand_new_code") == ui.text("error_generic", "brand_new_code"))
	t.check("kit: a commerce reason still wins", ui.for_code("forbidden", "bound_elsewhere") == PKeyUiCopy.DEFAULTS["reason_bound_elsewhere"])
	t.check("kit: core placeholders are filled, never shown raw", not ui.for_code("license_owned").contains("{"))
	core.set_overrides({"forbidden": "Core says no."})
	t.check("kit: a core host override reaches the kit", ui.for_code("forbidden") == "Core says no.")
	ui.overrides = {"error_forbidden": "Kit says no."}
	t.check("kit: the kit's own override wins over the core", ui.for_code("forbidden") == "Kit says no.")
	core.clear_overrides()
	# A locale that translates the kit's own line keeps it until the core copy is translated.
	var xl := Translation.new()
	xl.locale = "xx"
	xl.add_message(PKeyUiCopy.DEFAULTS["error_device_limit"], "XX device limit")
	TranslationServer.add_translation(xl)
	TranslationServer.set_locale("xx")
	t.check("kit: a translated kit line wins over the English core copy", PKeyUiCopy.new().for_code("device_limit") == "XX device limit")
	t.check("kit: an untranslated line reads the core copy", PKeyUiCopy.new().for_code("rate_limited") == PKeyCoreCopy.COPY_CODES["rate_limited"]["message"])
	TranslationServer.remove_translation(xl)
	TranslationServer.set_locale(locale)
