class_name PKeyExchangeResult
extends PKeyResult
## What an `identity.exchange.*` call answered (WIRE-CONTRACT-V5 §12.11). Branch on `kind`:
##
##   nonce          `nonce()` worked: `nonce` (what the platform signs into its token) and `expires_in`.
##   signed_in      the device token is stored and the forced sync has run: `subject`, `scope`,
##                  `license_id`, `stored`.
##   confirm        the link exists but the person has not consented to this app: `grant`,
##                  `expires_in` and `consent` (the ExchangeConsentView as served). Show it, then
##                  `identity.choice.complete(grant, choice, {claims = [...]})`.
##   choose         a licence choice is due: `grant`, `expires_in`, `view` (as a redirect's
##                  `choices`). `identity.choice.*` finishes it.
##   needs_sign_in  no account to sign in (`403 interstitial_required`): `reason` (`no_link`,
##                  `terms`, or `signed_out` for an automatic sign-in a sign-out overtook), `url` (the sign-in card) and, for `no_link`, `link_handle` and `expires_in`.
##   unavailable    no exchange here (`ok` false): `code` is `not_found` for a 404, else
##                  `platform-identity-unavailable`. Fall to the next rung; nothing changed.
##   refused        the Worker said no (4xx, `ok` false): `code` is its wire code. Only the members
##                  its answer carried are set. Nothing local changed.
##   failed         no answer, a 5xx or a malformed answer (`ok` false).
##
## The token, the nonce, the grant and the link handle never appear in `message`, `detail` or `str()`.

const KIND_NONCE := &"nonce"
const KIND_SIGNED_IN := &"signed_in"
const KIND_CONFIRM := &"confirm"
const KIND_CHOOSE := &"choose"
const KIND_NEEDS_SIGN_IN := &"needs_sign_in"
const KIND_UNAVAILABLE := &"unavailable"
const KIND_REFUSED := &"refused"
const KIND_FAILED := &"failed"

var kind: StringName = KIND_FAILED
var http_status := 0
var nonce := ""
var grant := ""
var link_handle := ""
var expires_in := 0
## When the nonce, grant or handle lapses, on the SDK's clock (epoch seconds); 0 when none.
var expires_at := 0
var consent: Dictionary = {}
## `choose`, and a refusal that carries a fresh licence view (`device_limit`, `license_choice_required`).
var view: Dictionary = {}
var reason := ""
var url := ""
var retry_after_seconds := 0
var manage_url := ""
var subject := ""
var scope := ""
var license_id := ""
var stored := false


static func made(p_kind: StringName, p_status := 200) -> PKeyExchangeResult:
	var r := PKeyExchangeResult.new(true)
	r.kind = p_kind
	r.http_status = p_status
	return r


## The person signed out while an automatic sign-in was in flight: nothing was stored.
static func signed_out() -> PKeyExchangeResult:
	var r := made(KIND_NEEDS_SIGN_IN, 0)
	r.reason = "signed_out"
	return r


static func unavailable(p_code: StringName, p_message: String) -> PKeyExchangeResult:
	var r := PKeyExchangeResult.new(false, p_code, p_message)
	r.kind = KIND_UNAVAILABLE
	return r


static func refused(p_code: StringName, p_status: int) -> PKeyExchangeResult:
	var r := PKeyExchangeResult.new(false, p_code, "The exchange was refused (%s, status %d)." % [p_code, p_status])
	r.kind = KIND_REFUSED
	r.http_status = p_status
	return r


static func failed(p_code: StringName, p_message: String, p_detail: Variant = null) -> PKeyExchangeResult:
	var r := PKeyExchangeResult.new(false, p_code, p_message, p_detail)
	r.kind = KIND_FAILED
	return r


func _to_string() -> String:
	if ok:
		return "PKeyExchangeResult(%s)" % kind
	return "PKeyExchangeResult(%s, %s)" % [kind, code]
