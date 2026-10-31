class_name PKeyAutoSignInResult
extends PKeyResult
## What `PolarisKey.identity.auto_sign_in()` answered (CC-01-auto-sign-in §1). Branch on `kind`:
##
##   signed_in      the device holds a session: `via` is `stored` (rung 1, no network) or
##                  `platform` (rung 3 or 4), with `subject`, `provider` and `license_id` when known.
##   confirm        the platform account is linked but the person has not consented to this app:
##                  `pending` {grant, expires_in, expires_at, consent}. Show it, then
##                  `identity.choice.complete(pending.grant, null, {claims = [...]})`.
##   choose         a licence choice is due: `pending` {grant, expires_in, expires_at, view}.
##                  `identity.choice.*` finishes it.
##   needs_sign_in  no session and none to be had silently: `reason` is `no_link` (sign in, then
##                  offer the link; `link_handle` feeds it), `terms`, `signed_out` (the person
##                  signed out on this device), `no_credential` (the platform offered nothing) or
##                  `cancelled` (the person dismissed the platform's sheet on a `row` sign-in).
##   device_limit   every seat is taken: `view` (the choice view, when sent) and `manage_url`.
##   unavailable    no exchange here, or the Worker refused: `code` is its wire code or
##                  `platform-identity-unavailable`. Show the regular form.
##
## `ok` is true for signed_in, confirm, choose and needs_sign_in (answers the app continues
## with) and false for device_limit and unavailable. `sync_key` is `present` or `needed` from
## `PolarisKey.keyring` when a ring is configured, else null. The grant, the handle and the
## token never appear in `message`, `detail` or `str()`.

const KIND_SIGNED_IN := &"signed_in"
const KIND_CONFIRM := &"confirm"
const KIND_CHOOSE := &"choose"
const KIND_NEEDS_SIGN_IN := &"needs_sign_in"
const KIND_DEVICE_LIMIT := &"device_limit"
const KIND_UNAVAILABLE := &"unavailable"

const REASON_NO_LINK := "no_link"
const REASON_TERMS := "terms"
const REASON_SIGNED_OUT := "signed_out"
const REASON_NO_CREDENTIAL := "no_credential"
## The person dismissed the platform's own sheet (a `row` sign-in).
const REASON_CANCELLED := "cancelled"

var kind: StringName = KIND_UNAVAILABLE
## signed_in: `stored` or `platform`.
var via := ""
## confirm and choose: {grant, expires_in, expires_at, consent | view}. The grant is a secret.
var pending: Dictionary = {}
## needs_sign_in: see the class doc. The handle is a secret; "" when none.
var link_handle := ""
var reason := ""
## The exchange kind of the provider that produced the answer ("" for rung 1).
var provider := ""
var subject := ""
var license_id := ""
var view: Dictionary = {}
var manage_url := ""
## `present`, `needed` or null.
var sync_key: Variant = null


static func signed_in(p_via: String, p_subject := "", p_license_id := "", p_provider := "") -> PKeyAutoSignInResult:
	var r := PKeyAutoSignInResult.new(true)
	r.kind = KIND_SIGNED_IN
	r.via = p_via
	r.subject = p_subject
	r.license_id = p_license_id
	r.provider = p_provider
	return r


static func needs_sign_in(p_reason: String, p_link_handle := "", p_provider := "") -> PKeyAutoSignInResult:
	var r := PKeyAutoSignInResult.new(true)
	r.kind = KIND_NEEDS_SIGN_IN
	r.reason = p_reason
	r.link_handle = p_link_handle
	r.provider = p_provider
	return r


static func pending_answer(p_kind: StringName, p_pending: Dictionary, p_provider := "") -> PKeyAutoSignInResult:
	var r := PKeyAutoSignInResult.new(true)
	r.kind = p_kind
	r.pending = p_pending
	r.provider = p_provider
	return r


static func device_limit(p_view: Dictionary, p_manage_url: String, p_provider := "") -> PKeyAutoSignInResult:
	var r := PKeyAutoSignInResult.new(false, PKeyConstants.ErrorCode.DEVICE_LIMIT, "Every seat is taken.")
	r.kind = KIND_DEVICE_LIMIT
	r.view = p_view
	r.manage_url = p_manage_url
	r.provider = p_provider
	return r


static func unavailable(p_code: StringName, p_message := "", p_provider := "") -> PKeyAutoSignInResult:
	var r := PKeyAutoSignInResult.new(false, p_code, p_message if p_message != "" else "No automatic sign-in here (%s)." % p_code)
	r.kind = KIND_UNAVAILABLE
	r.provider = p_provider
	return r


func _to_string() -> String:
	if kind == KIND_NEEDS_SIGN_IN:
		return "PKeyAutoSignInResult(needs_sign_in, %s)" % reason
	if ok:
		return "PKeyAutoSignInResult(%s)" % kind
	return "PKeyAutoSignInResult(%s, %s)" % [kind, code]
