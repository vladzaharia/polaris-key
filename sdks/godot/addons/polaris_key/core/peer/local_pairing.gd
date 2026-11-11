@tool
class_name PKeyPeerLocalPairing
extends RefCounted
## WIRE-CONTRACT-V5 section 15.12, mode `q`: what a pairing session holds beside the Noise machine, ported from
## the `pair` option of `packages/client-core/src/peer/session.ts`. The CPace outputs (PSK and ISK, key material),
## the seconds already spent on C1 and C2, the shower's permit to try the tag, and the consent and LOCAL_LINK
## order guard (`PKeyPeerLocalExchange`). The session drives it and sends what `step` says.
##
## Options (`pair`): {psk (32 bytes), isk (64), held (int >= 0, the local links the device holds), cats (Array),
## label? (String), elapsed (seconds >= 0), permit (Callable() -> bool; a responder only: it counts the guess
## before the tag is tried)}.

## From the first byte to the transport (the session's own limit), and to both CONFIRMs.
const TRANSPORT_SECONDS := 30.0
const CONFIRM_SECONDS := 120.0

var psk: PackedByteArray
var isk: PackedByteArray
var elapsed: float
var own_pub := PackedByteArray()
var exchange: PKeyPeerLocalExchange
var timer_started := false
var _permit: Callable
var _cats: Array
var _label: String


func _init(o: Dictionary) -> void:
	psk = (o["psk"] as PackedByteArray).duplicate()
	isk = (o["isk"] as PackedByteArray).duplicate()
	elapsed = float(o["elapsed"])
	_permit = o.get("permit", Callable())
	_cats = (o["cats"] as Array).duplicate()
	_label = String(o.get("label", ""))
	exchange = PKeyPeerLocalExchange.new(int(o["held"]), _cats)


func _to_string() -> String:
	return "PKeyPeerLocalPairing()"


## What is wrong with the `pair` option of a session, or "".
static func problem(mode: String, role: String, pair: Variant) -> String:
	if mode != "q":
		return "pair is for mode q" if pair != null else ""
	if not pair is Dictionary:
		return "pair"
	var d: Dictionary = pair
	var ok := d.get("psk") is PackedByteArray and (d["psk"] as PackedByteArray).size() == 32
	ok = ok and d.get("isk") is PackedByteArray and (d["isk"] as PackedByteArray).size() == 64
	ok = ok and d.get("held") is int and d["held"] >= 0 and (d.get("elapsed") is float or d.get("elapsed") is int) and d["elapsed"] >= 0
	ok = ok and d.get("cats") is Array and PKeyPeerContact.valid_cats(d["cats"]) and d.get("label", "") is String
	if role == "responder":
		ok = ok and d.get("permit") is Callable and (d["permit"] as Callable).is_valid()
	return "" if ok else "pair"


## The attempt is past its 30 seconds: no handshake starts and no tag is tried.
func spent() -> bool:
	return elapsed >= TRANSPORT_SECONDS


## The shower's permit for one tag (it counts the guess); false when there is none.
func permit() -> bool:
	return _permit.is_valid() and bool(_permit.call())


## The reflected handshake check: false when the peer's static key is this side's own link key.
func remote_ok(static_key: Variant, crypto: PKeyPeerCrypto, remote: PackedByteArray) -> bool:
	if static_key is PackedByteArray:
		own_pub = crypto.x25519_public(static_key)
	elif static_key is Object:
		own_pub = (static_key as Object).call("public_key")
	return not own_pub.is_empty() and PKeyPeerLocal.pairing_remote_ok(own_pub, remote)


## One event through the exchange. Answers {sends: Array of [record type, body], close: StringName or &"", link:
## Dictionary (the `local_link` event) or empty}. `h` is the handshake hash and `peer` the peer's link key.
func step(e: Dictionary, h: PackedByteArray, peer: PackedByteArray) -> Dictionary:
	var r := exchange.step(e)
	var out := {"sends": [], "close": &"", "link": {}}
	if (r["sends"] as Array).has("CONFIRM"):
		out["sends"].append([PKeyPeerRecord.CONFIRM, "{}".to_utf8_buffer()])
	if (r["sends"] as Array).has("LOCAL_LINK"):
		var body := PKeyPeerLocal.build_local_link({"label": _label, "cats": _cats})
		if not body.ok:
			out["close"] = PKeyPeerRecord.CLOSE_BAD_FRAME
			return out
		out["sends"].append([PKeyPeerRecord.LOCAL_LINK, body.detail])
	if r.has("stored"):
		var secret := PKeyPeerLocal.local_link_secret(h, isk, own_pub, peer)
		var link := {"type": &"local_link", "secret": secret, "own_key": own_pub.duplicate(), "peer_key": peer.duplicate(), "cats": r["stored"]["cats"]}
		if r["stored"].has("label"):
			link["label"] = r["stored"]["label"]
		out["link"] = link
	if r.has("close"):
		out["close"] = StringName(r["close"])
	return out


## Both CONFIRMs are done and the exchange still runs.
func confirmed() -> bool:
	return exchange.both_confirmed()


## The PSK is spent once the handshake is done.
func wipe_psk() -> void:
	psk.fill(0)


func wipe() -> void:
	psk.fill(0)
	isk.fill(0)
