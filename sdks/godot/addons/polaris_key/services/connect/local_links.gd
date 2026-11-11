@tool
class_name PKeyCloudLocalLinks
extends RefCounted
## Local links for an app, with no account (CC-29b.G3; WIRE-CONTRACT-V5 section 15.12): `PolarisKey.cloud_connect.local_links`.
## Two devices of one app on one LAN pair by an 8-digit code or a QR. One device shows (`pair`, the responder:
## `local_shower.gd`), the other types or scans (`join`, the initiator: `local_joiner.gd`). CPace turns the code into a
## key, mode `q` runs Noise over it, both people confirm, and each side stores a link in `pkey.connect.local.v1`
## (`local_state.gd`). Ported from sdk-node `connect/localLinks.ts` (references: Python `connect/local_links.py`, Kotlin
## `ConnectLocalLinks`).
##
##   pair(options)              show a code and a QR and wait for the other device. `options`: `categories`,
##                              `on_confirm` (Callable taking one PKeyConnectLocalCommon.Offer; it decides), `on_code`
##                              (Callable taking each code: {code, qr, nameplate, reason, expires_at, failures}),
##                              `label`, `seconds` (at most 300), `on_linked`, `on_failed`, `on_interrupted` (n; at
##                              most one call a second) and `on_end` ({reason}: expired, too-many-tries, stored,
##                              person, off). ok with the window (`Handle`: `renew()`, `stop()`, `code()`,
##                              `is_open()`). A coroutine
##   join(options)              type or scan the other device's code. `options`: `code` or `qr` (exactly one),
##                              `categories`, `on_confirm`, `label`, `browse_seconds`. ok with {id, label,
##                              categories}, or `pairing-code-failed` (reason invalid, other-app, spent, wrong),
##                              `pairing-not-found`, `peer-closed` (reason declined, timeout, closed, cancelled,
##                              cooldown), `local-links-full` (cap stored, reachable) or `local-pairing-off`. A
##                              coroutine
##   cancel_join()              cancel every join in flight: it closes the dial, wipes y, g, ISK and PSK and
##                              refunds no dial
##   dials_left(text)           2, 1 or 0 from the first two digits alone; null until the text starts with two digits
##   list()                     the links this device holds: [{id, label, categories, created_at, last_seen,
##                              reachable, platform}]. No key, no secret
##   rename(id, label)          change the label on this device only; it is never sent
##   remove(id)                 forget a link: its keys and secret leave the record before this answers
##   set_reachable(id, bool)    advertise the link's `m=l` name on the LAN (at most 8), or stop
##   on_change(fn)              called after a pairing is stored, a rename, a remove, a set_reachable, a sighting and
##                              when the gate flips. Returns the Callable that unsubscribes
##   local_pairing()            the cached discovery answer; false before discovery. Never fetches
##
## Rules this file keeps:
##  - `pair` and `join` need the cached discovery answer `localPairing: true` (section 15.12, "Gates"); without it they
##    answer `local-pairing-off`, and a read that clears it closes the window and every join. Managing links (`list`,
##    `rename`, `remove`, `set_reachable`) is never gated;
##  - one window per device and product, and a device that holds 32 links answers `local-links-full` before anything is
##    advertised or dialled;
##  - the joiner's dials are counted per typed nameplate across joins, the nameplates the windows closed with in the last
##    300 s are remembered (a renewed window skips them) and the renewal floor (30 s after a hard end) is kept, each per
##    product for the life of the process, in memory;
##  - web has no LAN and no pairing: `pair` and `join` answer `connect-unavailable` (reason `runtime`), `list` is empty.
## Words for the person: "pair" and "Paired".

## A pairing was stored, a link was renamed, forgotten, re-marked or seen, or the gate flipped. Read `list()` and
## `local_pairing()` again; it carries no data.
signal changed

## The gate is read again this often while it is on: between these two spans, in seconds.
const REREAD_MIN_SECONDS := 3600.0
const REREAD_SPAN_SECONDS := 10800.0

## One per product for the life of the process, so a client made per screen meets the same budget.
static var _budgets: Dictionary = {}
static var _memories: Dictionary = {}
static var _floors: Dictionary = {}

## Links were forgotten: Callable(peer_keys: Array of PackedByteArray), so Direct Transfer can purge what the peers sent.
var removed: Callable

var _core_ref: WeakRef
var _client: PKeyConnectClient
var _o: Dictionary
var _tree: SceneTree
var _src: PKeyConnectLocalCommon.Source
var _shower: PKeyConnectLocalShower = null
var _starting := false
var _epoch := 0
var _joins: Array = []
var _was_on := false
var _reread_gen := 0
var _own_pump: PKeyPeerPump = null


## `core` and `client` are the SDK's own. `options` (wiring and test seams): `tree`, `lane` (Callable() -> the process's
## shared discovery lane, or null), `pump` (Callable() -> the shared PKeyPeerPump, or null), `web` (Callable() -> bool),
## `mono` (Callable() -> monotonic seconds), `now` (Callable() -> epoch seconds), `timer` (Callable(seconds, fn)).
func _init(core: PKeyCore, client: PKeyConnectClient, options := {}) -> void:
	_core_ref = weakref(core)
	_client = client
	_o = options
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	_src = PKeyConnectLocalCommon.Source.new()
	_src.slug = core.product
	_src.now = options.get("now", Callable(PKeyClaims, "system_now"))
	_src.mono = Callable(self, "_mono")
	_src.allowed = Callable(self, "local_pairing")
	_src.store = client.contacts().local_state()
	_src.notify = Callable(self, "_notify")
	_src.tree = _tree
	_was_on = local_pairing()
	core.discovery_changed.connect(_on_discovery)
	_arm_reread()


func _to_string() -> String:
	return "PKeyCloudLocalLinks()"


# -- the gate ---------------------------------------------------------------------------------


## The cached discovery answer `services.connect.localPairing` (section 15.9, 15.12): true only while the service and the
## setting are on and the answer still counts. False before discovery. Never fetches.
func local_pairing() -> bool:
	var core := _core_ref.get_ref() as PKeyCore
	return (
		core != null
		and core.discovery_fresh()
		and PKeyPeerLocalGate.local_pairing_of(core.discovery_manifest)
	)


## The gate before a gated call: one discovery read when nothing counts yet, then the cached answer.
func _gate(what: String) -> PKeyResult:
	if _on_web():
		return _runtime(what)
	var core := _core_ref.get_ref() as PKeyCore
	if core != null and not local_pairing() and not core.discovery_fresh():
		await core.discover()
	return (
		null
		if local_pairing()
		else PKeyConnectLocalCommon.off("Pairing with a code is off for this product (%s)." % what)
	)


## A discovery read moved the answer: a closed gate closes the window and every join; the host hears of a flip.
func _on_discovery() -> void:
	var on := local_pairing()
	if _was_on and not on:
		close_all()
	if on != _was_on:
		_was_on = on
		changed.emit()
	_arm_reread()


## While the gate is on it is read again every 1 to 4 hours (a spread, so a fleet does not read together).
func _arm_reread() -> void:
	_reread_gen += 1
	if not local_pairing():
		return
	var seconds := REREAD_MIN_SECONDS + REREAD_SPAN_SECONDS * float(_random01())
	var fn := _reread.bind(_reread_gen)
	var timer: Variant = _o.get("timer")
	if timer is Callable and (timer as Callable).is_valid():
		(timer as Callable).call(seconds, fn)
	elif _tree != null:
		_tree.create_timer(seconds, true, false, true).timeout.connect(fn)


func _reread(gen: int) -> void:
	var core := _core_ref.get_ref() as PKeyCore
	if gen != _reread_gen or core == null:
		return
	var r: PKeyResult = await core.discover()
	# A failed read changes nothing and is tried again soon; a good one armed the next timer through `_on_discovery`.
	if gen == _reread_gen and not r.ok:
		_arm_reread()


func _random01() -> float:
	var r: Variant = _o.get("random")
	if r is Callable and (r as Callable).is_valid():
		return float((r as Callable).call())
	return randf()


# -- the API ----------------------------------------------------------------------------------


## How many dials a join of the code typed so far may still make: 2, 1 or 0, from the first two digits alone; null until
## the text (spaces and hyphens ignored) starts with two digits. Keeps nothing and spends nothing.
func dials_left(text: String) -> Variant:
	var n := PKeyPeerLocalJoin.dials_left(_budget(), text, _mono())
	return null if n < 0 else n


## The local links this device holds, with no key and no secret. Not gated.
func list() -> PKeyResult:
	if _on_web():
		return PKeyResult.success([])
	return _src.store.info()


## Change a link's label on this device only; it is never sent. ok, `link-unknown`, or `invalid-options` for a label
## that is empty once cleaned or longer than 64. Not gated.
func rename(id: String, label: String) -> PKeyResult:
	var clean := PKeyPeerPayload.clean_label(label)
	if clean == "" or label.length() > PKeyConnectLocalCommon.LABEL_MAX:
		return PKeyConnectLocalCommon.bad_input("The label is not valid.")
	return _changed(_src.store.rename(id, clean))


## Advertise a link's `m=l` name on the LAN (at most 8 at once), or stop. ok, `link-unknown`, or `local-links-full` (cap
## `reachable`) for a ninth. The choice is kept whatever the gate says. Not gated.
func set_reachable(id: String, reachable: bool) -> PKeyResult:
	return _changed(_src.store.set_reachable(id, reachable))


## Forget a link: its keys and secret leave the record before this answers (the last one clears the record and its key).
## ok, or `link-unknown`. Not gated.
func remove(id: String) -> PKeyResult:
	var r := _src.store.remove(id)
	if not r.ok:
		return r
	_notify()
	if removed.is_valid():
		removed.call([r.detail])
	return PKeyResult.success()


func _changed(r: PKeyResult) -> PKeyResult:
	if not r.ok:
		return r
	if r.detail == true:
		_notify()
		return PKeyResult.success()
	return PKeyResult.failure(PKeyConstants.ErrorCode.LINK_UNKNOWN, "No such link.")


## Subscribe to `changed`. Returns the Callable that unsubscribes.
func on_change(fn: Callable) -> Callable:
	if not changed.is_connected(fn):
		changed.connect(fn)
	return Callable(self, "_unsubscribe").bind(fn)


func _unsubscribe(fn: Callable) -> void:
	if changed.is_connected(fn):
		changed.disconnect(fn)


func _notify() -> void:
	changed.emit()


## Show a code and a QR and wait for the other device (the responder). See the header for the options and the failures.
## The window closes by itself after `seconds` (at most 300), after the fifth failed guess, once a link is made and when
## the gate goes off, and `on_end` says which. A coroutine.
func pair(options: Dictionary) -> PKeyResult:
	var refused: PKeyResult = await _gate("pair")
	var bad: Variant = refused if refused != null else _pair_problem(options)
	var o: Variant = bad if bad != null else _resolve(options)
	if o is PKeyResult:
		return o
	var first: PKeyResult = await _window(o, null)
	if not first.ok:
		return first
	var shower: PKeyConnectLocalShower = first.detail
	shower.reveal()
	return PKeyResult.success(Handle.new(shower, Callable(self, "_again").bind(o)))


## What is wrong with the options of `pair`, else null.
static func _pair_problem(options: Dictionary) -> Variant:
	var bad: Variant = PKeyConnectLocalCommon.check_options(options)
	if bad != null:
		return bad
	if not options.get("on_code") is Callable or not (options["on_code"] as Callable).is_valid():
		return PKeyConnectLocalCommon.bad_input("on_code is required.")
	return _seconds_problem(options.get("seconds"), "seconds")


static func _seconds_problem(v: Variant, name: String) -> Variant:
	if v != null and (not (v is int or v is float) or not float(v) > 0.0 or is_inf(float(v))):
		return PKeyConnectLocalCommon.bad_input("%s must be above 0." % name)
	return null


func _again(cur: PKeyConnectLocalShower, o: Dictionary) -> PKeyResult:
	return await _window(o, cur)


## Open a window; `replacing` is the one a renewal closes first (it makes no `on_end`). The slot is taken before the first
## await and kept across the replacement.
func _window(o: Dictionary, replacing: PKeyConnectLocalShower) -> PKeyResult:
	var refused: PKeyResult = await _gate("pair")
	if refused != null:
		return refused
	if _starting or (_shower != null and _shower.is_open() and _shower != replacing):
		return PKeyConnectLocalCommon.bad_input("A pairing window is already open.")
	_starting = true
	var epoch := _epoch
	var made := await _start_window(o, replacing, epoch)
	_starting = false
	return made


func _start_window(o: Dictionary, replacing: PKeyConnectLocalShower, epoch: int) -> PKeyResult:
	var held := _src.store.count()
	if not held.ok:
		return held
	if int(held.detail) >= PKeyPeerLocal.MAX_LOCAL_LINKS:
		return PKeyConnectLocalCommon.full()
	if replacing != null:
		replacing.close("")
	# The SDK's floor under new windows (after a hard end, 30 s), checked once the window a renewal replaces has ended
	# and been counted.
	var floor_check := _floor().check(_mono())
	if not floor_check["allowed"]:
		return PKeyConnectLocalCommon.cooldown(int(floor_check["retry_in"]))
	var r: PKeyResult = await PKeyConnectLocalShower.start(
		_src, o, _memory(), Callable(self, "_window_ended")
	)
	if not r.ok:
		return r
	var mine: PKeyConnectLocalShower = r.detail
	_shower = mine
	# The gate was cleared while the window was opening: it closes before anyone sees a code.
	if epoch != _epoch or not local_pairing():
		mine.close("off")
		return PKeyConnectLocalCommon.off("Pairing with a code was turned off (pair).")
	return PKeyResult.success(mine)


func _window_ended(end: String, t: float) -> void:
	if _shower != null and not _shower.is_open():
		_shower = null
	if end != "":
		_floor().ended(end, t)


## Type or scan the other device's code (the initiator). See the header for the failures. The typed `local-pairing-off`
## and `local-links-full` (cap `stored`) come before anything is browsed. A cancel refunds no dial. A coroutine.
func join(options: Dictionary) -> PKeyResult:
	var refused: PKeyResult = await _gate("join")
	var bad: Variant = refused if refused != null else _join_problem(options)
	var o: Variant = bad if bad != null else _resolve(options)
	if o is PKeyResult:
		return o
	var j := PKeyConnectLocalJoiner.new(_src, _budget(), o)
	_joins.append(j)
	var r: PKeyResult = await j.run()
	_joins.erase(j)
	return r


## What stops a join before anything is browsed, else null: the options, the cap of links and the gate.
func _join_problem(options: Dictionary) -> Variant:
	var bad: Variant = PKeyConnectLocalCommon.check_options(options)
	if bad == null and options.has("code") == options.has("qr"):
		bad = PKeyConnectLocalCommon.bad_input("Give exactly one of code and qr.")
	if bad == null:
		bad = _seconds_problem(options.get("browse_seconds"), "browse_seconds")
	if bad != null:
		return bad
	var held := _src.store.count()
	if not held.ok:
		return held
	if int(held.detail) >= PKeyPeerLocal.MAX_LOCAL_LINKS:
		return PKeyConnectLocalCommon.full()
	return (
		null
		if local_pairing()
		else PKeyConnectLocalCommon.off("Pairing with a code was turned off (join).")
	)


## Cancel every join in flight: each answers `peer-closed` with reason `cancelled`. It closes the dial, wipes y, g, ISK and
## PSK and refunds no dial.
func cancel_join() -> void:
	for j: PKeyConnectLocalJoiner in _joins.duplicate():
		j.cancel("cancelled")


## The gate was cleared: close the window and every join (section 15.12, "Gates").
func close_all() -> void:
	_epoch += 1
	for j: PKeyConnectLocalJoiner in _joins.duplicate():
		j.cancel("closed")
	if _shower != null:
		_shower.close("off")


## End the window and the joins (a sign-out or a stop of the host).
func stop_all() -> void:
	close_all()


## The options with the discovery lane and the pump a window or a join needs, or a failure when this build has no lane.
func _resolve(options: Dictionary) -> Variant:
	var o := options.duplicate()
	if not o.get("mdns") is Object:
		var lane := _lane()
		if lane == null:
			return (
				PKeyResult
				. failure(
					PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED,
					"Pairing is not available here.",
					{
						"feature": PKeyConstants.Feature.CONNECT_LOCAL,
						"reason": PKeyConstants.UnsupportedReason.RUNTIME,
						"detail": "This runtime has no local-network discovery lane.",
					}
				)
			)
		o["mdns"] = lane
	if _src.pump == null:
		_src.pump = _pump()
	return o


## A window the host holds: follows the window that is current, so `renew()` can replace it. It holds no secret of its own.
class Handle:
	extends RefCounted
	var _cur: PKeyConnectLocalShower
	var _again: Callable
	var _renewing := false
	var _stop_renewal := false
	var _renewed: PKeyResult = null

	func _init(first: PKeyConnectLocalShower, again: Callable) -> void:
		_cur = first
		_again = again

	func _to_string() -> String:
		return "PKeyCloudLocalLinks.Handle(%s)" % ("open" if is_open() else "closed")

	## The window is still open.
	func is_open() -> bool:
		return _cur.is_open()

	## The code on show now: {code, qr, nameplate, reason, expires_at, failures}; empty once the window has closed.
	func code() -> Dictionary:
		return _cur.code()

	## Close the window. A renewal in flight is told to stop: the window it opens is closed before anyone sees a code, and
	## the renewal answers `peer-closed`.
	func stop() -> void:
		if _renewing:
			_stop_renewal = true
		else:
			_cur.close("person")

	## Close the window and open a new one with the same options: a new nameplate (never one a window of this app closed
	## with in the last 300 s while another is free), a new code and QR, 300 s and no failures. The old window ends with
	## no `on_end`. Works on a closed handle; refuses what `pair` refuses (the gate, the cap, another window) and, for 30 s
	## after a window ended `too-many-tries` or after the second window within 10 minutes that ended after a failed
	## guess, `peer-closed` with reason `cooldown`. Two calls at once share one new window. Answers the first code of the
	## new window. A coroutine.
	func renew() -> PKeyResult:
		if _renewing:
			while _renewing:
				await Engine.get_main_loop().process_frame
			return _renewed
		_renewing = true
		_stop_renewal = false
		var r: PKeyResult = await _again.call(_cur)
		if r.ok:
			_cur = r.detail
			if _stop_renewal:
				_cur.close("person")
				r = PKeyConnectLocalCommon.peer_closed("closed", "The window closed.")
			else:
				_cur.reveal()
				var c := _cur.code()
				r = (
					PKeyResult.success(c)
					if not c.is_empty()
					else PKeyConnectLocalCommon.peer_closed("closed", "The window closed.")
				)
		_renewed = r
		_renewing = false
		return r


# -- products' memory -----------------------------------------------------------------------------


func _budget() -> PKeyPeerLocalJoin.DialBudget:
	if not _budgets.has(_src.slug):
		_budgets[_src.slug] = PKeyPeerLocalJoin.DialBudget.new()
	return _budgets[_src.slug]


func _memory() -> PKeyPeerLocalMemory:
	if not _memories.has(_src.slug):
		_memories[_src.slug] = PKeyPeerLocalMemory.new()
	return _memories[_src.slug]


func _floor() -> PKeyPeerLocalMemory.RenewFloor:
	if not _floors.has(_src.slug):
		_floors[_src.slug] = PKeyPeerLocalMemory.RenewFloor.new()
	return _floors[_src.slug]


## Forget every dial budget, remembered nameplate and renewal floor. For tests.
static func reset_budgets() -> void:
	_budgets = {}
	_memories = {}
	_floors = {}


# -- wiring -----------------------------------------------------------------------------------


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return (
		float((clock as Callable).call())
		if clock is Callable and (clock as Callable).is_valid()
		else float(Time.get_ticks_msec()) / 1000.0
	)


func _lane() -> Object:
	var provider: Variant = _o.get("lane")
	return (
		(provider as Callable).call() as Object
		if provider is Callable and (provider as Callable).is_valid()
		else null
	)


func _pump() -> PKeyPeerPump:
	var provider: Variant = _o.get("pump")
	var shared: PKeyPeerPump = (
		(provider as Callable).call() as PKeyPeerPump
		if provider is Callable and (provider as Callable).is_valid()
		else null
	)
	if shared != null:
		return shared
	if _own_pump == null:
		_own_pump = PKeyPeerPump.new(_tree)
	return _own_pump


func _on_web() -> bool:
	var web: Variant = _o.get("web")
	return (
		bool((web as Callable).call())
		if web is Callable and (web as Callable).is_valid()
		else OS.has_feature("web")
	)


static func _runtime(what: String) -> PKeyResult:
	return (
		PKeyResult
		. failure(
			PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE,
			"Pairing with a code is not available on the web.",
			{
				"feature": PKeyConstants.Feature.CONNECT_LOCAL,
				"reason": PKeyConstants.UnsupportedReason.RUNTIME,
				"detail": "Pairing with a code is not available on the web (%s)." % what,
			}
		)
	)
