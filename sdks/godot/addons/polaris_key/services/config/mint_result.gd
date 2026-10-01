class_name PKeyMintResult
extends PKeyResult
## What `PolarisKey.config.mint_token(recipe_id)` returns: a PKeyResult with the minted token.
##
## `token` is a live credential for someone else's API. It is held in memory only, and it never
## prints: `str(result)` and `print(result)` show `[redacted]` in its place (sdk-node
## `redactOnPrint`). Read the field itself when you need it.
##
## `kind` sorts every outcome into one of these, so a game can branch without knowing wire codes:
##   ok                    the token is in `token`, valid until `expires_at`
##   unauthorized          401 after the one re-acquire, or no device token held
##   not-found             404: no such recipe, or the operator has not approved it (P0-12)
##   rate-limited          429: the device spent its mint budget; try later
##   server-error          5xx (`misconfigured`: the recipe's signing key is missing or wrong)
##   refused               nothing was sent: Config is off (`service-unavailable`), discovery
##                         says no recipe is approved (`mint-unavailable`), or the recipe id
##                         fails the router's pattern (`bad_request`)
##   network               the request got no answer (`network-error`, `timeout`, `local-only`, …)
##   invalid-response      200 without a token and its expiry
##   error                 any other status

const KIND_OK := &"ok"
const KIND_UNAUTHORIZED := &"unauthorized"
const KIND_NOT_FOUND := &"not-found"
const KIND_RATE_LIMITED := &"rate-limited"
const KIND_SERVER_ERROR := &"server-error"
const KIND_REFUSED := &"refused"
const KIND_NETWORK := &"network"
const KIND_INVALID_RESPONSE := &"invalid-response"
const KIND_ERROR := &"error"

const REDACTED := "[redacted]"

var kind: StringName = KIND_ERROR
## The minted token ("" unless ok). Never printed.
var token := ""
## Epoch seconds the token stops being valid (0 unless ok).
var expires_at := 0
## The HTTP status of the last answer, or 0 when nothing was answered.
var status := 0
## Served from the in-memory cache, without a request.
var cached := false


static func minted(p_token: String, p_expires_at: int) -> PKeyMintResult:
	var r := PKeyMintResult.new(true)
	r.kind = KIND_OK
	r.token = p_token
	r.expires_at = p_expires_at
	r.status = 200
	return r


static func refused(p_kind: StringName, p_code: StringName, p_message: String, p_status := 0) -> PKeyMintResult:
	var r := PKeyMintResult.new(false, p_code, p_message)
	r.kind = p_kind
	r.status = p_status
	return r


## A copy marked as served from the cache.
func from_cache() -> PKeyMintResult:
	var r := PKeyMintResult.minted(token, expires_at)
	r.cached = true
	return r


func _to_string() -> String:
	if ok:
		return "PKeyMintResult(ok, token=%s, expires_at=%d%s)" % [REDACTED, expires_at, ", cached" if cached else ""]
	return "PKeyMintResult(%s, %s: %s)" % [kind, code, message]
