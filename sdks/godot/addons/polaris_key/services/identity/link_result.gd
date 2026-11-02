class_name PKeyLinkResult
extends PKeyResult
## What an `identity.link.*` call answered (WIRE-CONTRACT-V5 section 12.11.4). Branch on `kind`:
##
##   offer          `offer()` worked: `kinds`, an Array of {kind, reach} (`reach` is "global",
##                  "developer" or null until a link is made).
##   linked         `accept()` worked: `linked_kind` and `reach`.
##   refused        the Worker said no (`ok` false): `code` is `step_up_required` (sign in again, then ask
##                  again), `link_conflict`, `invalid_grant` or `not_found`; `http_status` is its status.
##   unavailable    no offer here (`ok` false): the product, the gate or the sign-in has none, or the person
##                  declined it on this device. Nothing was sent.
##   failed         no answer, a 5xx or a malformed answer (`ok` false).
##
## The link handle, the provider token and the proof never appear in `message`, `detail` or `str()`.

const KIND_OFFER := &"offer"
const KIND_LINKED := &"linked"
const KIND_REFUSED := &"refused"
const KIND_UNAVAILABLE := &"unavailable"
const KIND_FAILED := &"failed"

var kind: StringName = KIND_FAILED
var http_status := 0
var kinds: Array = []
var linked_kind := ""
var reach: Variant = null


static func offer_of(p_kinds: Array) -> PKeyLinkResult:
	var r := PKeyLinkResult.new(true)
	r.kind = KIND_OFFER
	r.http_status = 200
	r.kinds = p_kinds
	return r


static func linked(p_kind: String, p_reach: Variant) -> PKeyLinkResult:
	var r := PKeyLinkResult.new(true)
	r.kind = KIND_LINKED
	r.http_status = 200
	r.linked_kind = p_kind
	r.reach = p_reach
	return r


static func refused(p_code: StringName, p_status: int) -> PKeyLinkResult:
	var r := PKeyLinkResult.new(false, p_code, "The link was refused (%s, status %d)." % [p_code, p_status])
	r.kind = KIND_REFUSED
	r.http_status = p_status
	return r


static func unavailable(p_message := "There is no link offer here.") -> PKeyLinkResult:
	var r := PKeyLinkResult.new(false, PKeyConstants.ErrorCode.SERVICE_UNAVAILABLE, p_message)
	r.kind = KIND_UNAVAILABLE
	return r


static func failed(p_code: StringName, p_message: String, p_status := 0) -> PKeyLinkResult:
	var r := PKeyLinkResult.new(false, p_code, p_message)
	r.kind = KIND_FAILED
	r.http_status = p_status
	return r


func _to_string() -> String:
	if ok:
		return "PKeyLinkResult(%s)" % kind
	return "PKeyLinkResult(%s, %s)" % [kind, code]
