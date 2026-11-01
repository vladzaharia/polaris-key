@tool
class_name PKeyCloudConnect
extends RefCounted
## The Cloud Connect API an app calls (CC-14.15; WIRE-CONTRACT-V5 section 15): `PolarisKey.cloud_connect`.
## A facade over the identity client (`PKeyConnectClient`, `PolarisKey.connect_client`), the LAN service,
## the relay and the sessions they open. Ported from sdk-node `connect/cloudConnect.ts` and the Python
## `connect/cloud_connect.py`.
##
##   start(options)      get the identity (making and registering the device keys on first use), listen and
##                       browse on the LAN, then connect to the relay unless the host or the product turned
##                       it off. ok, or the first failure. A coroutine
##   stop()              close the sessions, the relay and the LAN service; safe to call twice and before
##                       `start`
##   peers()             the person's other devices that can be reached now: [{device_id, lan, relay}]
##   refresh_peers()     ask the relay room who is online now, then `peers()`. A coroutine
##   devices()           the person's devices as the Worker lists them (display data). A coroutine
##   open(device_id)     a session to one device: LAN first (bounded, 4 s), the relay after. ok with a
##                       PKeyConnectSession (`session.path` says which), or a typed failure. A coroutine
##   links               the inter-account links (`cloud_connect.links`, services/connect/links.gd): `pair`, `list`,
##                       `remove`, `set_reachable`, `open` and the signal `link(session)`
##   status()            {running, lan, lan_reason, lan_error, relay, relay_error, relay_reason}
##   signals             `channel(session)`: a session another device opened to this one, on either path;
##                       `notice(n)`: a roster or trust manifest a peer pushed was stored, applied or refused
##
## Rules this file keeps:
##  - Connect is gated by the operator's `launch.connect`: when discovery says it is off, `start` fails
##    `connect-unavailable` before anything is asked of the Worker;
##  - the order is LAN, then relay. A device not seen on the LAN goes straight to the relay;
##  - the relay stays `off`, with no socket and no ticket asked for, when the host turned it off (`relay =
##    false`) and when discovery says so: `services.connect.relay` is false, or the ticket endpoint is null
##    (G21). `status().relay_reason` says which (`host`, `product`, `no_ticket`);
##  - the LAN is `off` on web (reason `unsupported`) and on mobile builds without a native discovery lane
##    (GDScript UDP needs the iOS multicast entitlement and an Android MulticastLock; the lanes are Bonjour on
##    iOS and macOS and NsdManager on Android, CC-14b), and when the host turned it off (`host`). On a desktop that cannot bind port 5353 it is `querier_only`: it finds others and others
##    do not find it. `status().lan` is `on`, `querier_only`, `off` or `failed`;
##  - one `Budget` holds the unread bytes of the LAN and the relay sessions together (G10), and one pump
##    drives both;
##  - the relay carries mode `a` only; modes `v` and `p` are not reachable through this API (G16);
##  - an inbound session with nobody connected to `channel` is closed (G9);
##  - sign-out runs `stop()` and then `leave()` and fails closed (G18): the Connect state record is gone, or
##    the sign-out stops with the failure;
##  - nothing here puts a key, ticket or certificate in a `str()`, a notice or a result (G13, G19).

## A session another device opened to this one.
signal channel(session: PKeyConnectSession)
## A pushed roster or trust manifest, once stored, applied or refused.
signal notice(n: Dictionary)

const LAN_ATTEMPT_SECONDS := 4.0

## Inter-account links (`cloud_connect.links`): pair, list, remove, open and the `link` signal. Gated by
## discovery's `interAccount`; the adverts and rooms run only while Cloud Connect does.
var links: PKeyCloudLinks = null

## Nearby approval (`cloud_connect.nearby`): gated by Identity's discovery, it works with Connect stopped.
var nearby: PKeyCloudNearby = null

var _core_ref: WeakRef
var _client: PKeyConnectClient
var _tree: SceneTree
var _budget := PKeyConnectSession.Budget.new()
var _pump: PKeyPeerPump
var _lan: PKeyConnectLan = null
var _relay: PKeyConnectRelay = null
var _contact_relay: PKeyConnectContactRelay = null
var _lan_reason := ""
var _lan_error: PKeyResult = null
var _relay_reason := ""
var _running := false
var _starting := false
var _gen := 0
var _self := ""
var _lan_attempt := LAN_ATTEMPT_SECONDS
var _mono: Callable
var _sessions: Dictionary = {}
var _has_feature: Callable
## The process's one discovery lane when nearby approval made it before the LAN service did.
var _lane_shared: Object = null


## `core` and `client` are the SDK's own; `tree` and `mono` (Callable() -> monotonic seconds) and
## `has_feature` (Callable(String) -> bool, the engine's `OS.has_feature`) are test seams.
func _init(core: PKeyCore, client: PKeyConnectClient, options := {}) -> void:
	_core_ref = weakref(core)
	_client = client
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	_mono = options.get("mono", Callable())
	_has_feature = options.get("has_feature", Callable())
	_client.on_stored = Callable(self, "_recheck_sessions")
	var near := {"tree": _tree, "lane": Callable(self, "_shared_lane")}
	for k in ["has_feature", "now", "signer", "signed_in", "discover", "pump"]:
		if options.has("nearby_" + k):
			near[k] = options["nearby_" + k]
	nearby = PKeyCloudNearby.new(core, client, near)
	links = PKeyCloudLinks.new(core, client, {
		"tree": _tree, "lane": Callable(self, "_links_lane"), "pump": Callable(self, "_links_pump"), "web": Callable(self, "_on_web"),
	})


func _to_string() -> String:
	return "PKeyCloudConnect(running=%s)" % _running


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


# ── the API ──────────────────────────────────────────────────────────────────────────────────


## {running, lan, lan_reason, lan_error, relay, relay_error, relay_reason}. `lan` is `on`, `querier_only`
## (the device hears others, others do not hear it), `off` (`lan_reason` says why: `unsupported`, `host`, or
## `not_started`) or `failed` (`lan_error`). `relay` is `off` or the relay's state: `connecting`, `open`,
## `backoff`, `unavailable`, `blocked`, `stopped`; `relay_reason` is why it is off (`host`, `product`,
## `no_ticket`) else "".
func status() -> Dictionary:
	var lan := "off"
	var reason := _lan_reason if _lan_reason != "" else "not_started"
	if _lan != null:
		var mdns: Variant = (_lan.status() as Dictionary).get("mdns")
		var why := str((mdns as Dictionary).get("reason", "")) if mdns is Dictionary else ""
		lan = why if why != "" else "on"
		reason = why
	elif _lan_error != null:
		lan = "failed"
		reason = PKeyConnectErrors.reason_of(_lan_error)
	var rs: Dictionary = _relay.status() if _relay != null else {}
	return {
		"running": _running,
		"lan": lan,
		"lan_reason": reason if lan != "on" else "",
		"lan_error": _lan_error,
		"relay": str(rs.get("state", "off")),
		"relay_error": rs.get("error"),
		"relay_reason": str(rs.get("reason", "")) if _relay != null else _relay_reason,
	}


## Get the identity and bring the transports up. `options`: `lan` (false, or a Dictionary of the LAN
## service's options such as `interfaces`), `relay` (false, or a Dictionary of the relay's options),
## `lan_attempt_seconds`, `label` (shown to the peer; none by default), `caps` and `source` (a test seam). Fails with what
## `PolarisKey.connect_client.identity()` fails with (`connect-unavailable`, `no-token`,
## `invalid-options`...). A LAN service that cannot start is not fatal while the relay is on
## (`status().lan_error` says why); with the relay off the LAN failure is returned. A coroutine.
func start(options := {}) -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	if _running or _starting:
		return PKeyResult.success()
	var off := PKeyConnectClient._unavailable_text(core.discovery_manifest)
	if off != "":
		return PKeyResult.failure(PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE, off, {
			"feature": PKeyConstants.Feature.CONNECT_APP,
			"reason": PKeyConstants.UnsupportedReason.PRODUCT,
			"detail": off,
		})
	_starting = true
	var gen := _gen
	var r := await _start(core, options, gen)
	_starting = false
	return r


func _start(core: PKeyCore, opts: Dictionary, gen: int) -> PKeyResult:
	var idr: PKeyResult = await _client.identity()
	if gen != _gen:
		return PKeyConnectErrors.relay("stopped", "Cloud Connect was stopped.")
	if not idr.ok:
		return idr
	_self = str((idr.detail as Dictionary).get("device_id", ""))
	_lan_attempt = float(opts.get("lan_attempt_seconds", LAN_ATTEMPT_SECONDS))
	_lan_error = null
	_lan_reason = ""
	_relay_reason = ""
	_pump = PKeyPeerPump.new(_tree)
	var relay_opt: Variant = opts.get("relay", true)
	var relay_reason := "host" if relay_opt is bool and not relay_opt else _relay_wanted(core.discovery_manifest)
	var relay_on := relay_reason == ""
	# `source` is a test seam (a PKeyConnectLan.Source over a fixed clock and identity).
	var src: PKeyConnectLan.Source = opts.get("source") as PKeyConnectLan.Source
	if src == null:
		src = PKeyConnectLan.source_of(_client, Callable(self, "_apply_trust"))
	var shared := {"budget": _budget, "pump": _pump, "tree": _tree}
	for k in ["label", "caps"]:
		if opts.has(k):
			shared[k] = opts[k]
	var lan_opt: Variant = opts.get("lan", true)
	var unsupported := _lan_unsupported(_has_feature)
	# The OS's own discovery (Bonjour on iOS and macOS, NsdManager on Android) where the build has it.
	# A host-supplied `lan.mdns` wins; the lane is never made on web.
	var host_mdns: bool = lan_opt is Dictionary and (lan_opt as Dictionary).has("mdns")
	var web := _on_web()
	var lane: Object = null if host_mdns or web else (_lane_shared if _lane_shared != null else _native_lane())
	if lan_opt is bool and not lan_opt:
		_lan_reason = "host"
	elif unsupported != "" and (web or (lane == null and not host_mdns)):
		_lan_reason = unsupported
	else:
		var lo := shared.duplicate()
		if lane != null:
			lo["mdns"] = lane
		lo.merge(lan_opt if lan_opt is Dictionary else {}, true)
		var made := PKeyConnectLan.start(src, lo)
		if made.ok:
			_lan = made.detail
			_lan.session_opened.connect(_inbound)
			_lan.notice.connect(_notice)
		else:
			_lan_error = made
			if not relay_on:
				_pump = null
				return made
	if relay_on:
		var ro := shared.duplicate()
		ro.merge(relay_opt if relay_opt is Dictionary else {}, true)
		_relay = PKeyConnectRelay.new(src, Callable(_client, "relay_ticket"), ro)
		_relay.session_opened.connect(_inbound)
		_relay.notice.connect(_notice)
		_relay.start()
		# The contact rooms (section 15.7): none on web, where links are N/A; a room exists only for a link
		# marked reachable while the gate is open, and a one-dial room is made by `links.open`.
		if not web:
			_contact_relay = PKeyConnectContactRelay.new(src, Callable(self, "_contact_ticket"), ro)
			_contact_relay.start()
	else:
		_relay_reason = relay_reason
	links.attach(_lan, _contact_relay, {"lan_attempt_seconds": _lan_attempt, "relay_on": _contact_relay != null})
	_running = true
	return PKeyResult.success()


## Close the sessions, the relay socket and the LAN service. Safe to call more than once, and before
## `start`.
func stop() -> void:
	_gen += 1
	_starting = false
	_running = false
	var lan := _lan
	var relay := _relay
	var contact_relay := _contact_relay
	_lan = null
	_relay = null
	_contact_relay = null
	links.detach()
	for s: PKeyConnectSession in _sessions.values():
		s.close()
	_sessions = {}
	if lan != null:
		lan.stop()
	if relay != null:
		relay.stop()
	if contact_relay != null:
		contact_relay.stop()
	_pump = null


## The sign-out step (G18): `stop()`, then nearby approval stops (adverts and requests), then forget the
## Connect state record. Fails closed: when the record
## cannot be removed the failure is returned and the sign-out stops. ok when nothing is held.
func _sign_out_step() -> PKeyResult:
	stop()
	nearby.stop_all()
	return _client.leave()


## The person's other devices that can be reached now: [{device_id, lan, relay}].
func peers() -> Array:
	var seen := {}
	if _lan != null:
		for p: Dictionary in _lan.peers():
			seen[str(p["device_id"])] = [true, false]
	if _relay != null:
		for d: String in _relay.members():
			if d != _self:
				if not seen.has(d):
					seen[d] = [false, false]
				seen[d][1] = true
	var out: Array = []
	for d: String in seen:
		out.append({"device_id": d, "lan": seen[d][0], "relay": seen[d][1]})
	return out


## Ask the relay room who is online now, so `peers()` includes devices that joined since. A no-op without
## the relay. A coroutine.
func refresh_peers() -> Array:
	var relay := _relay
	if relay != null:
		await relay.refresh_members()
	return peers()


## `GET /<p>/connect/devices`: the person's devices, display data only. A coroutine.
func devices() -> PKeyResult:
	return await _client.list_devices()


## A session to one of the person's devices: LAN first when the device was seen on the network, the relay
## after a failed or timed-out LAN attempt. `options`: `relay` (false: LAN only), `lan_attempt_seconds`.
## ok with a PKeyConnectSession (`path` is `lan` or `relay`), or a typed failure: the LAN one when the relay
## is off, else the relay's. A coroutine.
func open(device_id: String, options := {}) -> PKeyResult:
	if not _running:
		return PKeyConnectErrors.lan("not_started", "Cloud Connect is not started.")
	var lan := _lan
	var relay := _relay
	var relay_opt: Variant = options.get("relay", true)
	var relay_ok: bool = relay != null and not (relay_opt is bool and not relay_opt)
	var lan_error: PKeyResult = null
	var peer: Variant = null
	if lan != null:
		for p: Dictionary in lan.peers():
			if p["device_id"] == device_id:
				peer = p
	if peer != null:
		var tried := await _bounded(lan, peer, float(options.get("lan_attempt_seconds", _lan_attempt)))
		if tried.ok:
			return _track(tried.detail)
		lan_error = tried
	if not relay_ok:
		return _no_path(lan_error, relay, relay_opt is bool and not relay_opt)
	var dialled: PKeyResult = await relay.dial(device_id)
	return _track(dialled.detail) if dialled.ok else dialled


## The failure of an open() with no relay to fall back on: the LAN attempt's own, else why there is no path.
func _no_path(lan_error: PKeyResult, relay: PKeyConnectRelay, off_by_call: bool) -> PKeyResult:
	if lan_error != null:
		return lan_error
	if relay == null or off_by_call:
		return PKeyConnectErrors.lan("unknown_peer", "That device was not found on this network, and the relay is off.")
	return PKeyConnectErrors.relay("not_connected", "The relay is not connected.")


## The process's one discovery lane, shared by the LAN service and nearby approval (two lanes on one OS
## binding would take each other's accepts and tags). The running LAN service's own, else the one made here:
## the native lane where the build has one, else the GDScript lane. Null where there is none (web, and mobile
## builds without a native lane). `options` may carry `allow_loopback` and `interfaces` for the GDScript lane.
func _shared_lane(options := {}) -> Object:
	if _lan != null:
		return _lan.lane()
	if _lane_shared != null:
		return _lane_shared
	if _on_web():
		return null
	var lane: Object = _native_lane()
	if lane == null:
		if _lan_unsupported(_has_feature) != "":
			return null
		lane = PKeyMdns.new({"allow_loopback": bool(options.get("allow_loopback", false)), "only": options.get("interfaces", []), "tree": _tree})
	_lane_shared = lane
	return lane


## A ticket for one contact room (the contact relay's `ticket`).
func _contact_ticket(rid: String) -> PKeyResult:
	return await _client.relay_ticket({"room": "c", "rid": rid})


func _links_lane() -> Object:
	return _shared_lane({})


func _links_pump() -> PKeyPeerPump:
	return _pump


# ── discovery's word on the relay (G21) ──────────────────────────────────────────────────────


## "" when discovery allows the relay, else why not: `product` (`services.connect.relay` is false) or
## `no_ticket` (the ticket endpoint is null). An unknown discovery allows it: the ticket route answers
## for itself.
static func _relay_wanted(manifest: Variant) -> String:
	var services: Variant = (manifest as Dictionary).get("services") if manifest is Dictionary else null
	var f: Variant = (services as Dictionary).get("connect") if services is Dictionary else null
	if not f is Dictionary:
		return ""
	if (f as Dictionary).get("relay") is bool and not (f as Dictionary)["relay"]:
		return "product"
	var endpoints: Variant = (f as Dictionary).get("endpoints")
	if endpoints is Dictionary and (endpoints as Dictionary).has("ticket") and (endpoints as Dictionary)["ticket"] == null:
		return "no_ticket"
	return ""


## The native discovery lane of this build, or null: PKeyAppleMdns (iOS, macOS; the binary entry and the
## Bonjour ops), else PKeyAndroidMdns (the plugin's `nsd_*` ops). Both answer null anywhere else.
static func _native_lane() -> Object:
	var apple: Object = PKeyAppleMdns.create()
	if apple != null:
		return apple
	return PKeyAndroidMdns.create()


func _on_web() -> bool:
	return bool(_has_feature.call("web")) if _has_feature.is_valid() else OS.has_feature("web")


## "unsupported" where the GDScript LAN lane cannot run (mobile and web), else "" (D-8). A native lane
## (CC-14b) replaces it on mobile; `start` asks for the lane first.
static func _lan_unsupported(has_feature := Callable()) -> String:
	for tag in ["mobile", "android", "ios", "web"]:
		var on: bool = bool(has_feature.call(tag)) if has_feature.is_valid() else OS.has_feature(tag)
		if on:
			return "unsupported"
	return ""


# ── on the main thread ───────────────────────────────────────────────────────────────────────


## One LAN attempt, abandoned after `seconds`; a late success is closed, the caller has moved on.
func _bounded(lan: PKeyConnectLan, peer: Dictionary, seconds: float) -> PKeyResult:
	var held := {"done": false, "r": null, "abandoned": false}
	var run := func() -> void:
		var r: PKeyResult = await lan.dial(peer)
		held["r"] = r
		held["done"] = true
		if held["abandoned"] and r.ok:
			(r.detail as PKeyConnectSession).close()
	run.call()
	var limit := _now() + seconds
	while not held["done"] and _now() < limit:
		await _tree.process_frame
	if held["done"]:
		return held["r"]
	held["abandoned"] = true
	return PKeyConnectErrors.lan("connect_failed", "The LAN attempt took too long; trying the relay.")


func _now() -> float:
	return float(_mono.call()) if _mono.is_valid() else float(Time.get_ticks_msec()) / 1000.0


func _track(session: PKeyConnectSession) -> PKeyResult:
	_sessions[session.get_instance_id()] = session
	session.closed.connect(_on_session_closed.bind(session.get_instance_id()))
	return PKeyResult.success(session)


## A roster was stored: every open session is judged against it again, and one with a device it no longer
## lists closes `peer_revoked`.
func _recheck_sessions() -> void:
	var held: Variant = _client.current()
	if not held is Dictionary:
		return
	var jws := str((held as Dictionary).get("ring", ""))
	if jws == "":
		return
	for s: PKeyConnectSession in _sessions.values():
		if is_instance_valid(s):
			s.recheck(jws)


func _on_session_closed(_code: StringName, _by_peer: bool, id: int) -> void:
	_sessions.erase(id)


## An inbound session: closed (G9) when nothing listens to `channel`.
func _inbound(session: PKeyConnectSession) -> void:
	if not _running or get_signal_connection_list("channel").is_empty():
		session.close()
		return
	_track(session)
	channel.emit(session)


func _notice(n: Dictionary) -> void:
	notice.emit(n)


## A trust manifest a connected peer pushed: verified and installed by the trust custodian, then persisted in
## the slices a sync writes. Refused when the host turned trust refresh off. A coroutine answering
## {applied} or {applied = false, reason}.
func _apply_trust(jws: String) -> Dictionary:
	var core := _core()
	if core == null or not core.trust_refresh:
		return {"applied": false, "reason": "trust_refresh_off"}
	var r: Dictionary = await core.trust.accept_peer(jws, core.product, core.clock)
	if not r.get("applied", false):
		return r
	var changes := {"trustJws": jws}
	var evidence := core.trust.pin_revocations()
	if not evidence.is_empty():
		changes["pinRevocations"] = evidence
	core.cache.flush(changes)
	return r
