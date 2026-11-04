@tool
class_name PKeyCloudNearby
extends RefCounted
## Nearby approval for an app (CC-15b.G2c; WIRE-CONTRACT-V5 section 15.6.1): `PolarisKey.cloud_connect.nearby`.
## Ported from sdk-node's `CloudNearby` (references: Python `connect/nearby.py`, Kotlin `CloudNearby.kt`).
##
##   request(options)            D, the device with no sign-in: browse for approvers nearby and list them for the
##                               person to tap (`choose`). ok with a PKeyNearbyRequest. `options.request` is
##                               the handle `nearby/start` answered; `label`, `expires_in` (at most 300)
##   on_request(handler, opts)   M, a signed-in device: advertise while the person has "Approve a nearby
##                               device" open (`prompt`, the default) or has allowed background approval
##                               (`background`) and hand each session that reaches the code to `handler`
##                               (Callable taking one PKeyPeerNearbyApprover.Approval). ok with the running
##                               PKeyPeerNearbyApprover: `stop`, `pause`, `resume`, `set_prompt`, `reopen`,
##                               `status` and the signals `notice` and `stopped`
##
## Deciding handlers are methods (`on_request`'s handler, the approval's `pick` and `finish`); observers are
## signals (`approvers_changed`, `result`, `record`, `closed`).
##
## Rules this file keeps:
##  - nearby is gated by the Identity service's discovery (`nearby` and its endpoints), never by Connect: it
##    works with Connect stopped, and shares the process's one discovery lane with the LAN service. A
##    product that does not serve it answers `service-unavailable` (reason `product`);
##  - it carries the vouch over the LAN and calls no route: the host calls `nearby/start`, `poll` and
##    `approve` and gives the answers to the handles;
##  - a runtime that cannot browse answers `nearby-unsupported`: web, a mobile build with no native lane (below
##    Android 14), an older native binding, and M on a lane that cannot be found (querier only). A refused
##    local-network permission answers `nearby-permission-denied` (the lane's own failure, passed on);
##  - `on_request` answers `account_required` while the device is signed out;
##  - a sign-out stops it: `stop_all()` ends every advert and request (after `cloud_connect.stop()`, before
##    the device leaves Connect), and a start that a sign-out overtook ends what it made: the epoch is read
##    before and after each start and after the sign-in read, and a handle joins the set the sign-out stops
##    only while the epoch still matches. `force_stop()` drops every socket with no goodbye.

const IDENTITY := "identity"
const START := "nearbyStart"
const POLL := "nearbyPoll"
const APPROVE := "nearbyApprove"

var _core_ref: WeakRef
var _client: PKeyConnectClient
var _o: Dictionary
var _tree: SceneTree
var _pump: PKeyPeerPump = null
var _lane: Object = null
var _approvers: Array = []
var _requests: Array = []
## Bumped by every sign-out stop: a start that began before it must not outlive it.
var _epoch := 0


## `core` and `client` are the SDK's own. `options` (test seams and wiring): `tree`, `lane` (Callable(options) ->
## the process's shared discovery lane, or null when this build has none; Cloud Connect sets it), `pump`,
## `signer` (Callable() -> a coroutine answering a PKeyResult holding {port, device_id}), `signed_in`
## (Callable() -> bool), `discover` (Callable() -> a coroutine: load discovery again), `now`, `has_feature`.
func _init(core: PKeyCore, client: PKeyConnectClient, options := {}) -> void:
	_core_ref = weakref(core)
	_client = client
	_o = options
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree


func _to_string() -> String:
	return "PKeyCloudNearby()"


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


# -- D ------------------------------------------------------------------------------------------


## D, the device with no sign-in. ok with a PKeyNearbyRequest, or the typed failure: `service-unavailable` for
## a product that serves no nearby approval, `nearby-unsupported`, `nearby-permission-denied`,
## `invalid-options` for a bad `request`, `label` or `expires_in`, and a closed failure when a sign-out landed
## while it was starting. A coroutine.
func request(options := {}) -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyConstants.ErrorCode.NOT_CONFIGURED, "Call configure() and start() first.")
	var epoch := _epoch
	var lane := await _gated([START, POLL], options)
	if not lane.ok:
		return lane
	_prune()
	if epoch != _epoch:
		return _stopped_failure()
	var o := options.duplicate()
	o["mdns"] = lane.detail
	o["pump"] = _shared_pump()
	o["tree"] = _tree
	var source := {"slug": core.product, "now": _now_callable(), "signer": _signer_callable()}
	var made: PKeyResult = await PKeyPeerNearbyRequester.start(source, o)
	if not made.ok:
		return _wrapped(made)
	var r: PKeyPeerNearbyRequester = made.detail
	if epoch != _epoch:
		r.close()
		return _stopped_failure()
	_requests.append(r)
	return PKeyResult.success(PKeyNearbyRequest.new(r))


## Whether this runtime has a discovery lane to browse with: ok, or the typed `nearby-unsupported`. No request, no
## socket. Nearby sign-in asks before it calls `nearby/start`.
func lane_check(options := {}) -> PKeyResult:
	return _lane_for(options)


# -- M ------------------------------------------------------------------------------------------


## M, a signed-in device. ok with the running PKeyPeerNearbyApprover, or the typed failure: `account_required`
## while signed out (also when a sign-out landed while this was starting), `service-unavailable`,
## `nearby-unsupported`, `nearby-permission-denied`, `invalid-options`. `options`: `prompt` (default true),
## `background`, `label` and the approver's own (see PKeyPeerNearbyApprover). A coroutine.
func on_request(handler: Callable, options := {}) -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyConstants.ErrorCode.NOT_CONFIGURED, "Call configure() and start() first.")
	var epoch := _epoch
	var lane := await _gated([APPROVE], options)
	if not lane.ok:
		return lane
	if not _signed_in() or epoch != _epoch:
		return _signed_out()
	var source := PKeyPeerNearbyApprover.Source.new()
	source.slug = core.product
	source.now = _now_callable()
	source.signed_in = Callable(self, "_signed_in")
	source.nearby_served = Callable(self, "_approve_served")
	var o := options.duplicate()
	if not o.has("prompt"):
		o["prompt"] = true
	o["mdns"] = lane.detail
	o["pump"] = _shared_pump()
	o["tree"] = _tree
	var made := PKeyPeerNearbyApprover.start(source, handler, o)
	if not made.ok:
		return _wrapped(made)
	var app: PKeyPeerNearbyApprover = made.detail
	# A sign-out may have landed while the advert started; the handle joins the set only if none did.
	if not _signed_in() or epoch != _epoch:
		app.stop()
		return _signed_out()
	_prune()
	_approvers.append(app)
	return made


# -- the sign-out step ----------------------------------------------------------------------------


## Stop every advert and close every request. The sign-out step (after `cloud_connect.stop()`, before the
## device leaves Connect). Nothing here waits on the host, so there is no bound to run past. Safe to call twice
## and before any nearby call.
func stop_all() -> void:
	_epoch += 1
	var hs := _approvers.duplicate()
	var rs := _requests.duplicate()
	_approvers = []
	_requests = []
	for h: PKeyPeerNearbyApprover in hs:
		h.stop()
	for r: PKeyPeerNearbyRequester in rs:
		r.close()


## Drop every socket and listener now, with no goodbye (the force path of a sign-out).
func force_stop() -> void:
	_epoch += 1
	var hs := _approvers.duplicate()
	var rs := _requests.duplicate()
	_approvers = []
	_requests = []
	for h: PKeyPeerNearbyApprover in hs:
		h.destroy()
	for r: PKeyPeerNearbyRequester in rs:
		r.destroy()


## How many adverts and requests are live (a stopped or closed one is not counted).
func live_count() -> int:
	_prune()
	return _approvers.size() + _requests.size()


# -- reads ----------------------------------------------------------------------------------------


func _prune() -> void:
	_approvers = _approvers.filter(func(a: PKeyPeerNearbyApprover) -> bool: return a.status()["state"] != "stopped")
	_requests = _requests.filter(func(r: PKeyPeerNearbyRequester) -> bool: return not r.is_closed())


func _now_callable() -> Callable:
	var n: Variant = _o.get("now")
	return n if n is Callable and (n as Callable).is_valid() else Callable(PKeyClaims, "system_now")


func _signer_callable() -> Callable:
	var s: Variant = _o.get("signer")
	return s if s is Callable and (s as Callable).is_valid() else Callable(_client, "nearby_signer")


## Signed in: a token and the subject it was issued to.
func _signed_in() -> bool:
	var s: Variant = _o.get("signed_in")
	if s is Callable and (s as Callable).is_valid():
		return bool((s as Callable).call())
	var core := _core()
	return core != null and core.tokens != null and core.tokens.has_token() and core.cache != null and core.cache.subject != ""


func _approve_served() -> bool:
	var r := await _fragment(true, [APPROVE])
	return r.ok


func _shared_pump() -> PKeyPeerPump:
	var p: Variant = _o.get("pump")
	if p is PKeyPeerPump:
		return p
	if _pump == null:
		_pump = PKeyPeerPump.new(_tree)
	return _pump


func _on_web() -> bool:
	var f: Variant = _o.get("has_feature")
	return bool((f as Callable).call("web")) if f is Callable and (f as Callable).is_valid() else OS.has_feature("web")


# -- gate and lane --------------------------------------------------------------------------------


static func _unsupported(code: String, reason: String, detail: String) -> PKeyResult:
	return PKeyResult.failure(code, "Nearby approval is not available here.", {
		"feature": PKeyConstants.Feature.IDENTITY_NEARBY, "reason": reason, "detail": detail,
	})


func _signed_out() -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.ACCOUNT_REQUIRED, "Sign in before approving a nearby device.")


func _stopped_failure() -> PKeyResult:
	return PKeyConnectErrors.lan("closed", "Nearby approval was stopped.")


## Discovery (read again) names nearby approval and this runtime has a lane: ok with the lane, else the typed N/A.
func _gated(endpoints: Array, options: Dictionary) -> PKeyResult:
	var served := await _fragment(true, endpoints)
	if not served.ok:
		return served
	return _lane_for(options)


## Discovery names `nearby` and each of `endpoints` on the Identity fragment, else the typed N/A. Discovery is
## read again first when `fresh`; an unreachable Worker is not "nearby is off", so what it last said stands.
func _fragment(fresh: bool, endpoints: Array) -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyConstants.ErrorCode.NOT_CONFIGURED, "Call configure() and start() first.")
	if fresh or core.discovery_manifest == null:
		var d: Variant = _o.get("discover")
		if d is Callable and (d as Callable).is_valid():
			await (d as Callable).call()
		else:
			await core.discover()
	var services: Variant = (core.discovery_manifest as Dictionary).get("services") if core.discovery_manifest is Dictionary else null
	var f: Variant = (services as Dictionary).get(IDENTITY) if services is Dictionary else null
	var ep: Variant = (f as Dictionary).get("endpoints") if f is Dictionary else null
	var named: bool = f is Dictionary and PKeyClaims.is_true((f as Dictionary).get("enabled")) \
			and (f as Dictionary).get("nearby") == true and ep is Dictionary
	if named:
		for k: String in endpoints:
			var url: Variant = (ep as Dictionary).get(k)
			if not (url is String and url != ""):
				named = false
	if not named:
		return _unsupported(PKeyConstants.ErrorCode.SERVICE_UNAVAILABLE, PKeyConstants.UnsupportedReason.PRODUCT, "This product's discovery does not name nearby approval.")
	return PKeyResult.success()


## The discovery lane: the host's `mdns`, else the process's shared one. Null in the shared case is a runtime
## with no way to browse (web; a mobile build with no native lane).
func _lane_for(options: Dictionary) -> PKeyResult:
	var given: Variant = options.get("mdns")
	if given is Object and given != null:
		return PKeyResult.success(given)
	if _on_web():
		return _unsupported(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, PKeyConstants.UnsupportedReason.RUNTIME, "Nearby approval is not available on the web.")
	var provider: Variant = _o.get("lane")
	var lane: Object = null
	if provider is Callable and (provider as Callable).is_valid():
		lane = (provider as Callable).call(options) as Object
	else:
		if _lane == null:
			_lane = PKeyMdns.new({"allow_loopback": bool(options.get("allow_loopback", false)), "only": options.get("interfaces", []), "tree": _tree})
		lane = _lane
	if lane == null:
		return _unsupported(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, PKeyConstants.UnsupportedReason.RUNTIME, "This runtime has no local-network discovery lane.")
	return PKeyResult.success(lane)


## A lane that cannot start (no socket on 5353) is the typed N/A, not a failure of Connect.
static func _wrapped(r: PKeyResult) -> PKeyResult:
	if r.ok:
		return r
	if r.code == PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE and r.detail is Dictionary and str((r.detail as Dictionary).get("reason", "")) == PKeyMdns.REASON_UNAVAILABLE:
		return _unsupported(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, PKeyConstants.UnsupportedReason.DEPENDENCY, r.message)
	return r
