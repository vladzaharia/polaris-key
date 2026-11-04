class_name PKeyIdentityNearby
extends RefCounted
## `PolarisKey.identity.nearby` (WIRE-CONTRACT-V5 sections 12.11.5 and 15.6.1): nearby approval on the approving
## device M, the signed-in device that lets a new device sign in. The new device's side is
## `identity.sign_in.start_nearby`. Ported from Swift `NearbyApprove.swift` (reference: sdk-node
## `identity/nearbyApprover.ts`).
##
##   on_request(handler, options)   advertise while the person has "Approve a nearby device" open (`prompt`, the
##                                  default) or has allowed background approval (`background`), and hand each
##                                  session that reaches the code to `handler` (a Callable taking one
##                                  PKeyNearbyAsk). ok with the running PKeyPeerNearbyApprover (`stop`, `pause`,
##                                  `resume`, `set_prompt`, `reopen`, `status`, the signals `notice` and `stopped`),
##                                  or the typed failure: `account_required` while signed out, `nearby-unsupported`
##                                  when this runtime cannot advertise, the typed N/A when nearby approval is not
##                                  served. Signing out stops it. A coroutine
##   PolarisKey.identity.nearby_available("approver")   whether this device can take part as M
##
## The rules of the approver: `nearby/approve` is reached only from a `pick` that matched on that session and whose
## request verified (PKeyNearbyAsk); `deny` after a matched code goes out only from the licence choice; leaving the
## codes or the choice answers Deny; the wrap is sealed, sent over the LAN and only then stored (PKeyNearbyDecision).

var _identity_ref: WeakRef = null


func _init(identity: PKeyIdentity) -> void:
	_identity_ref = weakref(identity)


func _to_string() -> String:
	return "PKeyIdentityNearby()"


func on_request(handler: Callable, options := {}) -> PKeyResult:
	var identity := _identity_ref.get_ref() as PKeyIdentity if _identity_ref != null else null
	var core := identity._core() if identity != null else null
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() before nearby.on_request().")
	if not handler.is_valid():
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "on_request needs a handler.")
	var lan := identity._nearby_lan()
	if lan == null or not lan.has_method("on_request"):
		return PKeyResult.failure(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "Nearby approval is not available here.", {
			"feature": PKeyConstants.Feature.IDENTITY_NEARBY, "reason": PKeyConstants.UnsupportedReason.RUNTIME,
			"detail": "This runtime cannot advertise to nearby devices.",
		})
	var o := options.duplicate()
	# This device's name in the other device's list (section 12.7.1); never an account identifier.
	if not o.has("label"):
		var label := PKeyDeviceLabel.resolve("", core.options)
		if label != "":
			o["label"] = label
	var routes := identity.nearby_routes
	var ring := identity._nearby_keyring()
	var wrapped := func(approval: PKeyPeerNearbyApprover.Approval) -> void:
		handler.call(PKeyNearbyAsk.new(routes, approval, ring))
	return await lan.on_request(wrapped, o)
