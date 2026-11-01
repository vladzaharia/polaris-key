@tool
class_name PKeyCloudLinks
extends RefCounted
## Inter-account links for an app (CC-19b.G4; WIRE-CONTRACT-V5 section 15.10): `PolarisKey.cloud_connect.links`.
## Pair two devices of two accounts once, in person, and open sessions to the other person's device later without
## a new pairing, on the LAN first and then through the contact relay. Ported from sdk-node `connect/links.ts`
## (references: Python `connect/links.py`, Kotlin `CloudLinks`).
##
##   pair(options)              open the pairing window: show each code, `confirm()` or `decline()` on the
##                              offer, and a link is stored on both devices. LAN only (mode p). `options`:
##                              `categories`, `on_offer` (Callable taking one PKeyConnectPairing.Offer; it
##                              decides), `label`, `seconds` (at most 300). ok with the open window
##                              (PKeyConnectPairing: `stop`, signals `linked`, `failed`, `window_closed`). A
##                              coroutine
##   list()                     the links this device holds: ok with [{id, label, categories, created_at,
##                              reachable, re_pair_pending}]
##   remove(id)                 delete a link: its secret is gone from the record before this answers, its open
##                              sessions end `peer_revoked`, and what the peer sent and was not finished is
##                              purged. `link-unknown` for no such link
##   set_reachable(id, bool)    advertise a link on the LAN and keep a relay room for it (at most 8), or stop
##   open(id, options)          a session to the other device: the LAN first (4 s), then the contact relay.
##                              `options`: `relay` (false: LAN only), `lan_attempt_seconds`. ok with a
##                              PKeyConnectSession whose `contact` names the link. A coroutine
##   inter_account()            the cached discovery answer; false before discovery
##   signal link(session)       a session another person's device opened to this one, on either path. With
##                              nothing connected to the signal the session is closed (G9)
##
## Rules this file keeps:
##  - links are the developer's opt-in on every transport: `pair` and `open` need the cached discovery
##    `interAccount` to be true and answer `connect_links_disabled` otherwise; nothing is advertised and no
##    mode `c` is answered then. When a discovery fetch says false the adverts and rooms are withdrawn, the
##    pairing windows close and the open link sessions end `peer_bye`;
##  - a link is a secret and a key on this device only. A listed link carries neither;
##  - web has no LAN and no pairing: `pair` answers `connect-unavailable` (reason `runtime`), `list` is empty and
##    `open` answers `link-unknown`;
##  - the order is LAN, then the contact relay, as for the person's own devices (cloud_connect.gd).
## Words for the person: "pair" and "Paired".

## A session another person's device opened to this one.
signal link(session: PKeyConnectSession)

const LAN_ATTEMPT_SECONDS := 4.0

## Direct Transfer takes each session the links open or accept: Callable(session). Set by CC-20b.
var adopt: Callable
## Links were deleted: Callable(agree_keys: Array of PackedByteArray), so a transfer can purge what the peer
## sent and did not finish. Set by CC-20b.
var removed: Callable

var _core_ref: WeakRef
var _client: PKeyConnectClient
var _o: Dictionary
var _tree: SceneTree
var _lan: PKeyConnectLan = null
var _relay: PKeyConnectContactRelay = null
var _relay_on := false
var _lan_attempt := LAN_ATTEMPT_SECONDS
var _sessions: Dictionary = {}
var _pairing: Dictionary = {}
var _attached := false
var _reread_gen := 0


## `core` and `client` are the SDK's own. `options` (wiring and test seams): `tree`, `lane` (Callable() -> the
## process's shared discovery lane, or null where this build has none), `pump` (Callable() -> the shared
## PKeyPeerPump, or null), `web` (Callable() -> bool), `mono` (Callable() -> monotonic seconds).
func _init(core: PKeyCore, client: PKeyConnectClient, options := {}) -> void:
	_core_ref = weakref(core)
	_client = client
	_o = options
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	# A discovery fetch may have moved the gate: every reader looks again.
	if not core.discovery_changed.is_connected(_client.notify_contacts):
		core.discovery_changed.connect(_client.notify_contacts)
	_client.contacts_changed.connect(_reconcile)
	# The cached `interAccount` answer lapses after a day: read discovery again before it does.
	core.discovery_changed.connect(_arm_reread)
	_arm_reread()


func _to_string() -> String:
	return "PKeyCloudLinks()"


func _arm_reread() -> void:
	_reread_gen += 1
	if _tree != null:
		_tree.create_timer(PKeyCore.DISCOVERY_TTL_SECONDS).timeout.connect(_reread.bind(_reread_gen))


func _reread(gen: int) -> void:
	var core := _core_ref.get_ref() as PKeyCore
	if gen == _reread_gen and core != null:
		await core.discover()


# ── the API ──────────────────────────────────────────────────────────────────────────────────


## The cached discovery answer `services.connect.interAccount` (section 15.9): true only while the product's
## setting, the operator's gate and the service are on. False before discovery. Never fetches.
func inter_account() -> bool:
	return _client.inter_account()


## The links this device holds: ok with [{id, label, categories, created_at, reachable, re_pair_pending}]. A
## device with no Cloud Connect identity holds none.
func list() -> PKeyResult:
	if _on_web():
		return PKeyResult.success([])
	var r := _client.contacts().list()
	if not r.ok and r.code == PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE:
		return PKeyResult.success([])
	return r


## Delete a link and a re-pair waiting on it. The secret is dropped from the record before this answers; an open
## session with the link ends `peer_revoked`. ok, or `link-unknown` when `id` names no link.
func remove(id: String) -> PKeyResult:
	if _on_web():
		return _unknown()
	var store := _client.contacts()
	var gone: Array = []
	var held := store.live(id)
	if held.ok:
		var key: Variant = PKeyB64Url.decode_strict(str((held.detail as Dictionary)["agree_key"]))
		if key is PackedByteArray:
			gone.append(key)
		PKeyConnectContacts.wipe_live([held.detail])
	var r := store.remove(id)
	if not r.ok:
		return r
	_end_sessions_of(id)
	if _relay != null:
		_relay.drop_link(id)
	_client.notify_contacts()
	# What the peer sent and did not finish is not kept for a link that is gone.
	if removed.is_valid() and not gone.is_empty():
		removed.call(gone)
	return PKeyResult.success()


## Advertise a link on the LAN and keep a relay room for it (at most 8 at once), or stop. ok, or `link-unknown`.
func set_reachable(id: String, reachable: bool) -> PKeyResult:
	if _on_web():
		return _unknown()
	var r := _client.contacts().set_reachable(id, reachable)
	if r.ok:
		_client.notify_contacts()
	return r


## Open the pairing window. Both people do it; each device advertises, finds the other and runs the code. Fails
## `connect_links_disabled` while links are off, `connect-unavailable` on web, `nearby-unsupported` where this
## build has no way to advertise and browse, and with what `identity()` fails with. A coroutine.
func pair(options := {}) -> PKeyResult:
	if _on_web():
		return _runtime("pair")
	if not inter_account():
		return _disabled("pair")
	var idr: PKeyResult = await _client.identity()
	if not idr.ok:
		return idr
	if not inter_account():
		return _disabled("pair")
	var o := options.duplicate()
	if not o.get("mdns") is Object:
		var lane := _lane()
		if lane == null:
			return PKeyResult.failure(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "Pairing is not available here.", {
				"feature": PKeyConstants.Feature.CONNECT_LINKS, "reason": PKeyConstants.UnsupportedReason.RUNTIME,
				"detail": "This runtime has no local-network discovery lane.",
			})
		o["mdns"] = lane
	var pump := _pump()
	if pump != null and not o.has("pump"):
		o["pump"] = pump
	if not o.has("tree"):
		o["tree"] = _tree
	if _lan != null and not o.has("lan"):
		o["lan"] = _lan
	var made := PKeyConnectPairing.start(_client.pair_source(), o)
	if made.ok:
		var window: PKeyConnectPairing = made.detail
		_pairing[window.get_instance_id()] = window
		window.window_closed.connect(_on_window_closed.bind(window.get_instance_id()))
	return made


## A session to a link: the LAN first when the other device was seen on the network, the contact relay after a
## failed or timed-out LAN attempt (unless `relay` is false). A pending link (a re-pair) is tried before the held
## one. ok with a PKeyConnectSession, or a typed failure: `link-unknown`, `connect_links_disabled`, the LAN or
## relay failure of the last path tried. A coroutine.
func open(id: String, options := {}) -> PKeyResult:
	var refused := _open_refusal(id)
	if refused != null:
		return refused
	# The newest secret first: the pending one of a re-pair, then the held one.
	var order: Array = [true, false] if _re_pair_pending(id) else [false]
	var lan := _lan
	var relay := _relay
	var relay_opt: Variant = options.get("relay", true)
	var relay_ok: bool = relay != null and _relay_on and not (relay_opt is bool and not relay_opt)
	var last: PKeyResult = PKeyConnectErrors.lan("unknown_peer", "That link was not found on this network, and the relay is off.")
	for pending: bool in order:
		if lan != null and _seen_on_lan(lan, id, pending):
			var tried := await _bounded(lan, id, pending, float(options.get("lan_attempt_seconds", _lan_attempt)))
			if tried.ok:
				return _track_held(tried.detail)
			last = tried
		if relay_ok:
			var dialled: PKeyResult = await relay.dial(id, pending)
			if dialled.ok:
				return _track_held(dialled.detail)
			last = dialled
	return last


## Why `open` cannot start, else null: web, the gate, Cloud Connect not started, or no such link.
func _open_refusal(id: String) -> PKeyResult:
	if _on_web():
		return _unknown()
	if not inter_account():
		return _disabled("open")
	if _lan == null and _relay == null:
		return PKeyConnectErrors.lan("not_started", "Cloud Connect is not started.")
	var listed := _client.contacts().list()
	if listed.ok:
		for r: Dictionary in listed.detail:
			if r["id"] == id:
				return null
	return _unknown()


func _re_pair_pending(id: String) -> bool:
	var listed := _client.contacts().list()
	if listed.ok:
		for r: Dictionary in listed.detail:
			if r["id"] == id:
				return bool(r["re_pair_pending"])
	return false


## The same as `open`, for Direct Transfer's `{link: id}` target.
func open_link(id: String, options := {}) -> PKeyResult:
	return await open(id, options)


# ── wiring (Cloud Connect's start and stop) ──────────────────────────────────────────────────


## Cloud Connect started: follow the LAN service and the contact relay (either may be null).
func attach(lan: PKeyConnectLan, relay: PKeyConnectContactRelay, options := {}) -> void:
	detach()
	_lan = lan
	_relay = relay
	_lan_attempt = float(options.get("lan_attempt_seconds", LAN_ATTEMPT_SECONDS))
	_relay_on = bool(options.get("relay_on", relay != null))
	_attached = true
	if lan != null:
		lan.contact_session_opened.connect(_inbound)
	if relay != null:
		relay.session_opened.connect(_inbound)


## Cloud Connect stopped: the pairing windows and the link sessions end; the transports are Cloud Connect's.
func detach() -> void:
	if _attached:
		if _lan != null and _lan.contact_session_opened.is_connected(_inbound):
			_lan.contact_session_opened.disconnect(_inbound)
		if _relay != null and _relay.session_opened.is_connected(_inbound):
			_relay.session_opened.disconnect(_inbound)
	_attached = false
	_lan = null
	_relay = null
	stop_all()


## End every pairing window and every link session (sign-out and stop).
func stop_all() -> void:
	close_pairings()
	var held := _sessions.values()
	_sessions = {}
	for s: PKeyConnectSession in held:
		if is_instance_valid(s):
			s.close()


func close_pairings() -> void:
	var held := _pairing.values()
	_pairing = {}
	for p: PKeyConnectPairing in held:
		if is_instance_valid(p):
			p.stop()


# ── on the main thread ───────────────────────────────────────────────────────────────────────


## The list or the gate moved: the LAN service and the contact relay read the links again; a closed gate ends the
## link sessions (`peer_bye`) and the pairing windows, and a session whose link was deleted ends `peer_revoked`.
func _reconcile() -> void:
	if _lan != null:
		_lan.refresh_contacts()
	if _relay != null:
		_relay.sync()
	if not inter_account():
		for s: PKeyConnectSession in _sessions.values():
			if is_instance_valid(s):
				s.close(PKeyPeerSession.PEER_BYE)
		close_pairings()
		return
	if _sessions.is_empty():
		return
	var have := {}
	var listed := _client.contacts().list()
	if listed.ok:
		for r: Dictionary in listed.detail:
			have[str(r["id"])] = true
	for s: PKeyConnectSession in _sessions.values():
		if is_instance_valid(s) and not s.contact.is_empty() and not have.has(str(s.contact["id"])):
			s.close(PKeyPeerSession.PEER_REVOKED)


func _end_sessions_of(id: String) -> void:
	for s: PKeyConnectSession in _sessions.values():
		if is_instance_valid(s) and str(s.contact.get("id", "")) == id:
			s.close(PKeyPeerSession.PEER_REVOKED)


## An inbound session: closed (G9) when nothing listens to `link`.
func _inbound(session: PKeyConnectSession) -> void:
	if get_signal_connection_list("link").is_empty():
		session.close()
		return
	# The handshake may have begun before the link was removed or links were switched off.
	if not _held(session):
		return
	_track(session)
	link.emit(session)


## Whether the link a session opened under is still held with the same secret and links are on; else the session
## is closed (`peer_revoked`, or `peer_bye` when links are off) and this is false.
func _held(session: PKeyConnectSession) -> bool:
	if session.contact.is_empty():
		return true
	var on := inter_account()
	if on and _client.holds_contact(str(session.contact["id"]), session.contact_tag):
		return true
	session.close(PKeyPeerSession.PEER_REVOKED if on else PKeyPeerSession.PEER_BYE)
	return false


func _track_held(session: PKeyConnectSession) -> PKeyResult:
	if not _held(session):
		return _unknown()
	return _track(session)


func _track(session: PKeyConnectSession) -> PKeyResult:
	if adopt.is_valid():
		adopt.call(session)
	_sessions[session.get_instance_id()] = session
	session.closed.connect(_on_session_closed.bind(session.get_instance_id()))
	return PKeyResult.success(session)


func _on_session_closed(_code: StringName, _by_peer: bool, sid: int) -> void:
	_sessions.erase(sid)


func _on_window_closed(wid: int) -> void:
	_pairing.erase(wid)


static func _seen_on_lan(lan: PKeyConnectLan, id: String, pending: bool) -> bool:
	for p: Dictionary in lan.contact_peers():
		if str(p.get("id", "")) == id and bool(p.get("pending", false)) == pending:
			return true
	return false


## One LAN attempt, abandoned after `seconds`; a late success is closed, the caller has moved on.
func _bounded(lan: PKeyConnectLan, id: String, pending: bool, seconds: float) -> PKeyResult:
	var held := {"done": false, "r": null, "abandoned": false}
	var run := func() -> void:
		var r: PKeyResult = await lan.connect_contact(id, pending)
		held["r"] = r
		held["done"] = true
		if held["abandoned"] and r.ok:
			(r.detail as PKeyConnectSession).close()
	run.call()
	var limit := _mono() + seconds
	while not held["done"] and _mono() < limit:
		await _tree.process_frame
	if held["done"]:
		return held["r"]
	held["abandoned"] = true
	return PKeyConnectErrors.lan("connect_failed", "The LAN attempt took too long; trying the relay.")


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return float((clock as Callable).call()) if clock is Callable and (clock as Callable).is_valid() else float(Time.get_ticks_msec()) / 1000.0


func _lane() -> Object:
	var provider: Variant = _o.get("lane")
	return (provider as Callable).call() as Object if provider is Callable and (provider as Callable).is_valid() else null


func _pump() -> PKeyPeerPump:
	var provider: Variant = _o.get("pump")
	return (provider as Callable).call() as PKeyPeerPump if provider is Callable and (provider as Callable).is_valid() else null


func _on_web() -> bool:
	var web: Variant = _o.get("web")
	return bool((web as Callable).call()) if web is Callable and (web as Callable).is_valid() else OS.has_feature("web")


static func _unknown() -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.LINK_UNKNOWN, "No such link.")


static func _disabled(what: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.CONNECT_LINKS_DISABLED, "Links between accounts are off for this product.", {
		"feature": PKeyConstants.Feature.CONNECT_LINKS, "reason": PKeyConstants.UnsupportedReason.PRODUCT,
		"detail": "Links between accounts are off for this product (%s)." % what,
	})


static func _runtime(what: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE, "Links between accounts are not available on the web.", {
		"feature": PKeyConstants.Feature.CONNECT_LINKS, "reason": PKeyConstants.UnsupportedReason.RUNTIME,
		"detail": "Links between accounts are not available on the web (%s)." % what,
	})
