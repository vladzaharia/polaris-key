class_name PKeyChoiceResult
extends PKeyResult
## What an `identity.choice.*` call answered. Branch on `kind`:
##
##   ok        the call worked. `licenses()` and `devices()` carry the Worker's `view`;
##             `complete()` the signed-in facts below; `cancel()` nothing more.
##   refused   the Worker said no (4xx). `ok` is false and `code` is its wire code
##             (`invalid_grant`, `license_choice_required`, `not_found`, `device_limit`,
##             `rate_limited`, `license_owned`, `key_entry_limit`, `not_entitled`, ...). Only the
##             members its answer carried are set. A refused `complete` keeps the device token, the
##             cache and the stored identity.
##   failed    no answer, a 5xx, a malformed answer, or Identity's choice endpoints are not served
##             (`service-unavailable`, detail {feature, reason, detail}). The grant stays spendable.
##
## The grant is the credential: it never appears in `message`, `detail` or `str()`.

const KIND_OK := &"ok"
const KIND_REFUSED := &"refused"
const KIND_FAILED := &"failed"

var kind: StringName = KIND_FAILED
var http_status := 0
## `licenses()` and `devices()`: the Worker's view as served (`licenses`: {state, choices, keep,
## preselected, create, getLicense}; `devices`: {licenseId, devices}). On `device_limit` and
## `license_choice_required`: the fresh licence view to choose from again. {} when none.
var view: Dictionary = {}
## `rate_limited`: seconds to wait; 0 when the answer named none.
var retry_after_seconds := 0
## `device_limit`, `key_entry_limit`: the portal link that frees a seat or an entry; "" when none.
var manage_url := ""
## `license_owned`: where to sign in to the account that owns the licence; "" when none.
var sign_in_url := ""
## `key_entry_limit`, and `complete()` after a key: {used, limit}; {} when none.
var key_entries: Dictionary = {}
## `complete()` ok: the licence the device now runs on; "" on a device with none.
var license_id := ""
## `complete()` ok: the pairwise account subject (`ps_...`).
var subject := ""
## `complete()` ok: the granted scope.
var scope := ""
## `complete()` ok after `keep`: the device kept a licence outside the account, so `attach()` may
## follow. False otherwise.
var attachable := false
## `complete()` ok: false when the store could not write the token (it is held for this session).
var stored := false


static func made_ok(p_status := 200) -> PKeyChoiceResult:
	var r := PKeyChoiceResult.new(true)
	r.kind = KIND_OK
	r.http_status = p_status
	return r


static func refused(p_code: StringName, p_status: int) -> PKeyChoiceResult:
	var r := PKeyChoiceResult.new(false, p_code, "The licence choice was refused (%s, status %d)." % [p_code, p_status])
	r.kind = KIND_REFUSED
	r.http_status = p_status
	return r


static func failed(p_code: StringName, p_message: String, p_detail: Variant = null) -> PKeyChoiceResult:
	var r := PKeyChoiceResult.new(false, p_code, p_message, p_detail)
	r.kind = KIND_FAILED
	return r


func _to_string() -> String:
	if ok:
		return "PKeyChoiceResult(ok)"
	return "PKeyChoiceResult(%s, %s)" % [kind, code]
