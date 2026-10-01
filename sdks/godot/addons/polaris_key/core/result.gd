class_name PKeyResult
extends RefCounted
## The one result type every coroutine in the SDK returns (settles PARITY §11 question 3).
##
##   ok       true on success
##   code     a wire code exactly as the server spells it (`unauthorized`, `rate_limited`, …) or
##            a client code (`insecure-base-url`, `local-only`, `service-unavailable`,
##            `timeout`, …); see PKeyErrors. Empty on success.
##   message  human text; never a credential
##   detail   anything else: an HTTP exchange's {status, headers, body}, a bundle's import, …
##
## An unsupported feature is `code == &"unsupported"` with `detail = {feature, reason}`.

var ok := false
var code: StringName = &""
var message := ""
var detail: Variant = null


func _init(p_ok := false, p_code: StringName = &"", p_message := "", p_detail: Variant = null) -> void:
	ok = p_ok
	code = p_code
	message = p_message
	detail = p_detail


static func success(p_detail: Variant = null) -> PKeyResult:
	return PKeyResult.new(true, &"", "", p_detail)


static func failure(p_code: StringName, p_message := "", p_detail: Variant = null) -> PKeyResult:
	return PKeyResult.new(false, p_code, p_message, p_detail)


static func unsupported(feature: String, reason: String) -> PKeyResult:
	return PKeyResult.new(false, &"unsupported", "%s is not supported here (%s)." % [feature, reason], {"feature": feature, "reason": reason})


func _to_string() -> String:
	return "PKeyResult(ok)" if ok else "PKeyResult(%s: %s)" % [code, message]
