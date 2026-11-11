@tool
class_name PKeyConnectLocalCommon
extends RefCounted
## Pairing with a code, with no account: the types and the pieces the shower, the joiner and the facade share
## (CC-29b.G3; WIRE-CONTRACT-V5 section 15.12), ported from sdk-node `connect/localCommon.ts`. A password, a QR
## secret and a link secret are key material: nothing here logs one, prints one or puts one in a result.

const LABEL_MAX := 64
const B32 := "abcdefghijklmnopqrstuvwxyz234567"

static var _cat_re: RegEx


static func _static_init() -> void:
	_cat_re = PKeyClaims.whole("[a-z0-9-]{1,32}")


## The 10 bytes behind a `p1-` instance name (the window's CPace `sid`); null for a name that is not 16 base32 characters.
static func sid_of(instance: String) -> Variant:
	if not PKeyPeerAdvert.is_instance_name(instance) or instance.length() != 19:
		return null
	var out := PackedByteArray()
	var acc := 0
	var bits := 0
	for c in instance.substr(3):
		var v := B32.find(c)
		if v < 0:
			return null
		acc = (acc << 5) | v
		bits += 5
		if bits >= 8:
			out.append((acc >> (bits - 8)) & 0xff)
			bits -= 8
			acc &= (1 << bits) - 1
	return out if out.size() == 10 else null


## The peer's platform as the store keeps it: only an `X-PKey-Platform` spelling, else "".
static func platform_of(p: Variant) -> String:
	return p if p is String and PKeyConstants.PLATFORM_VALUES.has(p) else ""


# -- the typed failures ----------------------------------------------------------------------


static func off(detail: String) -> PKeyResult:
	return (
		PKeyResult
		. failure(
			PKeyConstants.ErrorCode.LOCAL_PAIRING_OFF,
			"Pairing with a code is off for this product.",
			{
				"feature": PKeyConstants.Feature.CONNECT_LOCAL,
				"reason": PKeyConstants.UnsupportedReason.PRODUCT,
				"detail": detail,
			}
		)
	)


static func full() -> PKeyResult:
	return PKeyResult.failure(
		PKeyConstants.ErrorCode.LOCAL_LINKS_FULL,
		"This device holds the most local links it can for this app.",
		{"cap": "stored"}
	)


## Eight links are reachable already: turn one off before another is advertised.
static func reachable_full() -> PKeyResult:
	return PKeyResult.failure(
		PKeyConstants.ErrorCode.LOCAL_LINKS_FULL,
		"Eight local links are already reachable on this network; turn one off first.",
		{"cap": "reachable"}
	)


## `peer-closed` with its reason: `declined`, `timeout`, `closed`, `cancelled` or `cooldown`.
static func peer_closed(
	reason: String, message := "The pairing ended before it finished."
) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.PEER_CLOSED, message, {"reason": reason})


static func cancelled() -> PKeyResult:
	return peer_closed("cancelled", "The pairing was cancelled.")


static func cooldown(retry_in: int) -> PKeyResult:
	return peer_closed(
		"cooldown", "Too many failed tries. Wait %d s before opening another window." % retry_in
	)


## `pairing-code-failed` with its reason: `invalid`, `other-app`, `spent` or `wrong`.
static func code_failed(reason: String) -> PKeyResult:
	var message := "That code did not work."
	if reason == "other-app":
		message = "This code is for another app."
	elif reason == "spent":
		message = "That code did not work. Wait a few minutes, or ask the other device for a new code."
	return PKeyResult.failure(
		PKeyConstants.ErrorCode.PAIRING_CODE_FAILED, message, {"reason": reason}
	)


static func not_found() -> PKeyResult:
	return PKeyResult.failure(
		PKeyConstants.ErrorCode.PAIRING_NOT_FOUND, "The other device was not found on this network."
	)


static func bad_input(message: String) -> PKeyResult:
	return PKeyResult.failure(
		PKeyConstants.ErrorCode.INVALID_OPTIONS, message, {"reason": "bad_input"}
	)


## The options of `pair` and `join` that break a rule, else null.
static func check_options(o: Dictionary) -> Variant:
	if not o.get("on_confirm") is Callable or not (o["on_confirm"] as Callable).is_valid():
		return bad_input("on_confirm is required.")
	var cats: Variant = o.get("categories")
	var seen := {}
	var ok := cats is Array and (cats as Array).size() <= PKeyPeerContact.MAX_CONTACT_CATS
	if ok:
		for c in cats:
			if not c is String or not PKeyClaims.matches_whole_re(_cat_re, c) or seen.has(c):
				ok = false
				break
			seen[c] = true
	if not ok:
		return bad_input(
			"categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters)."
		)
	var label: Variant = o.get("label")
	if label != null and (not label is String or (label as String).length() > LABEL_MAX):
		return bad_input("The label is not valid.")
	return null


## The id of a link on this device: SHA-256("pkey-local/1" 0x00 peer key)[0..12] in base64url, 16 characters.
static func link_id(peer_key: PackedByteArray) -> String:
	var data := "pkey-local/1".to_utf8_buffer()
	data.append(0)
	data.append_array(peer_key)
	return PKeyB64Url.encode(PKeySyncHkdf.sha256(data).slice(0, 12))


## A one-way tag of a link secret: tells two secrets apart without holding either.
static func link_tag(secret: PackedByteArray) -> String:
	var data := "pkey-local-tag/1".to_utf8_buffer()
	data.append(0)
	data.append_array(secret)
	return PKeyB64Url.encode(PKeySyncHkdf.sha256(data).slice(0, 12))


## The HELLO of a pairing session.
static func hello(slug: String, label: String) -> Dictionary:
	var platform := PKeyHeaders.platform()
	return {"label": label, "platform": platform if platform != "" else "unknown", "app": slug}


## What local pairing reads of the client. `slug`, `now` () -> epoch seconds, `mono` () -> monotonic seconds, `allowed`
## () -> bool (the cached discovery `localPairing`), `store` (PKeyConnectLocalState), `notify` (), `pump`, `tree`.
class Source:
	extends RefCounted
	var slug := ""
	var now: Callable
	var mono: Callable
	var allowed: Callable
	var store: PKeyConnectLocalState
	var notify: Callable
	var pump: PKeyPeerPump
	var tree: SceneTree

	func _to_string() -> String:
		return "PKeyConnectLocalCommon.Source()"


## One connection of a pairing, on either side.
class Attempt:
	extends RefCounted
	signal ended(code: StringName, by_peer: bool)

	var id := -1
	var pipe: PKeyPeerPipe
	var slot: PKeyPeerLanGate.Slot
	var link: PKeyPeerLink
	var reader := PKeyPeerFrame.Reader.new()
	var hello: Dictionary = {}
	## "c1" (waiting for the first frame), "link" (a session runs) or "done".
	var state := "c1"
	## "c1", "session" or "done": where the window's accounting stands.
	var phase := "c1"
	var at := 0.0
	var shown := false
	var linked := false
	var declined := false
	var failure := ""
	## The shower's permit for this attempt's guess was given: a close without a verdict is a failed guess.
	var permitted := false
	var closed := false
	var closed_code: StringName = &""
	var closed_by_peer := false
	var storing := false
	## The session reached the transport.
	var up := false
	## This attempt's link private key: kept only when the attempt stores a link.
	var link_key := PackedByteArray()

	func _to_string() -> String:
		return "PKeyConnectLocalCommon.Attempt()"

	func wipe() -> void:
		link_key.fill(0)


## The other device at the consent step, as the host's `on_confirm` sees it.
class Offer:
	extends RefCounted
	## The session ended (once).
	signal closed(code: StringName, by_peer: bool)

	## What the other device sent as its label ("" for none). Unauthenticated: show it as "reported by the device".
	var label := ""
	var platform := ""
	## The categories this app asked for: list them before the person agrees.
	var categories: Array = []

	var _a: Attempt

	func _init(a: Attempt, p_cats: Array) -> void:
		_a = a
		label = str(a.hello.get("label", ""))
		platform = str(a.hello.get("platform", ""))
		categories = p_cats.duplicate()
		a.ended.connect(_on_ended)

	func _to_string() -> String:
		return "PKeyConnectLocalCommon.Offer()"

	func _on_ended(code: StringName, by_peer: bool) -> void:
		closed.emit(code, by_peer)

	func is_closed() -> bool:
		return _a.closed

	## Agree to the pairing. The link exists once the other person agrees too.
	func confirm() -> void:
		if _a.link != null and not _a.closed and not _a.linked:
			_a.link.session.confirm_pairing()

	## Say no: the session closes and this side stores nothing.
	func decline() -> void:
		if _a.link != null and not _a.closed:
			_a.declined = true
			_a.failure = "declined"
			_a.link.session.decline_pairing()


## Store the link a session produced (`e` is the session's `local_link` event). ok with {id, label, categories}, or a
## failure: `local-links-full` at the cap, `peer-closed` when the gate went off. The secret is wiped either way.
static func store_link(src: Source, a: Attempt, e: Dictionary) -> PKeyResult:
	var r := (
		src
		. store
		. add(
			{
				"own_key": a.link_key,
				"own_public": e["own_key"],
				"peer_key": e["peer_key"],
				"secret": e["secret"],
				"label": e.get("label"),
				"platform": platform_of(a.hello.get("platform")),
				"cats": e["cats"],
				"now": int(src.now.call()),
				"allowed": src.allowed,
			}
		)
	)
	(e["secret"] as PackedByteArray).fill(0)
	if not r.ok:
		a.failure = "closed"
		return r
	var d: Dictionary = r.detail
	if not d["stored"]:
		a.failure = "closed" if d.get("off", false) else "full"
		return peer_closed("closed") if d.get("off", false) else full()
	a.linked = true
	if src.notify.is_valid():
		src.notify.call()
	return PKeyResult.success(
		{"id": d["id"], "label": e.get("label"), "categories": (e["cats"] as Array).duplicate()}
	)
