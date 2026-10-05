class_name PKeyPurchaseResult
extends PKeyResult
## What `PolarisKey.commerce.purchase(flag)`, `restore()`, `claim_play()` and `claim_steam()`
## return (SDK parity §3.9's ClaimResult): a PKeyResult whose `kind` sorts every outcome, so a
## PKeyPurchaseButton (or the game) branches without knowing wire codes.
##
##   ok                    the store purchase was claimed and the licence synced: `flags` holds
##                         the flags now on the licence from this call
##   pending               the store holds the purchase (Ask to Buy, a slow payment); it arrives
##                         later through the store's updates and is claimed then
##   cancelled             the player cancelled in the store sheet
##   not-owned             the store says this account does not own it (restore found nothing,
##                         or the claim answered `not_owned`)
##   attestation-required  the product's trust policy wants an attested device and this one
##                         could not attest (§3.10 already tried once where it runs)
##   unsupported           no store this SDK can drive here (`detail` {feature, reason, detail}):
##                         `outlet` (a build not sold through a store), `dependency` (the store's
##                         plugin is not in this build), `runtime`
##   refused               the server refused with a code (`code`, `reason`)
##   error                 no answer, or an answer that could not be read

const KIND_OK := &"ok"
const KIND_PENDING := &"pending"
const KIND_CANCELLED := &"cancelled"
const KIND_NOT_OWNED := &"not-owned"
const KIND_ATTESTATION_REQUIRED := &"attestation-required"
const KIND_UNSUPPORTED := &"unsupported"
const KIND_REFUSED := &"refused"
const KIND_ERROR := &"error"

var kind: StringName = KIND_ERROR
## The store the call went through ("app-store", "play", "steam"), or "".
var store := ""
## ok: the flags this call put on the licence (restore: every flag it claimed).
var flags: Array = []
## refused: the server's `reason` (detail.error.reason), or "".
var reason := ""


static func of(p_kind: StringName, p_store := "", p_code: StringName = &"", p_message := "", p_detail: Variant = null) -> PKeyPurchaseResult:
	var r := PKeyPurchaseResult.new(p_kind == KIND_OK, p_code, p_message, p_detail)
	r.kind = p_kind
	r.store = p_store
	return r


## A failed PKeyResult (a claim, a binding, a plugin call) as a purchase result.
static func from_failure(f: PKeyResult, p_store := "") -> PKeyPurchaseResult:
	if f.code == PKeyErrors.UNSUPPORTED:
		return of(KIND_UNSUPPORTED, p_store, f.code, f.message, f.detail)
	var why := ""
	if f.detail is Dictionary:
		var e = f.detail.get("error")
		if e is Dictionary and e.get("reason") is String:
			why = e["reason"]
	var status := int(f.detail.get("status", 0)) if f.detail is Dictionary else 0
	var k := KIND_ERROR
	if String(f.code) == PKeyConstants.ErrorCode.ATTESTATION_REQUIRED:
		k = KIND_ATTESTATION_REQUIRED
	elif why == "not_owned":
		k = KIND_NOT_OWNED
	elif status >= 400 and status < 500:
		k = KIND_REFUSED
	var r := of(k, p_store, f.code, f.message, f.detail)
	r.reason = why
	return r


func _to_string() -> String:
	return "PKeyPurchaseResult(%s%s%s)" % [kind, (", " + store) if store != "" else "", (", " + String(code)) if code != &"" else ""]
