@tool
class_name PKeyPeerLocalGate
extends RefCounted
## WIRE-CONTRACT-V5 section 15.12, "Gates": the SDK's enforcement of the operator gate from the discovery
## document it cached, ported from `LocalPairingGate` in `packages/client-core/src/peer/local.ts`. No cached
## document is off, and offline a cached `true` keeps working. A successful read replaces the answer, a
## not-found clears it, an error changes nothing; a read that leaves a cached `true` behind answers the effects
## the host must carry out.

## What a read that left a cached `true` behind makes the host do.
const EFFECTS := ["close-windows", "withdraw-adverts", "end-sessions"]
## The calls the gate holds back; managing links (list, rename, remove, set-reachable) is never gated.
const GATED_CALLS := ["pair", "join", "advertise-q", "advertise-l", "browse-q", "browse-l", "dial-l", "answer-l"]

var _cached: String


## `start` is "on", "off" or "none".
func _init(start := "none") -> void:
	_cached = start


func _to_string() -> String:
	return "PKeyPeerLocalGate(%s)" % _cached


func state() -> String:
	return _cached


func allowed() -> bool:
	return _cached == "on"


## `services.connect.localPairing` of a discovery body: true only as the boolean `true` while
## `services.connect.enabled` is the boolean `true`. A body of any other shape, a disabled service and an absent
## member all read as false.
static func local_pairing_of(body: Variant) -> bool:
	var services: Variant = body.get("services") if body is Dictionary else null
	var connect: Variant = services.get("connect") if services is Dictionary else null
	if not connect is Dictionary:
		return false
	return (connect as Dictionary).get("enabled") is bool and (connect as Dictionary)["enabled"] == true \
			and (connect as Dictionary).get("localPairing") is bool and (connect as Dictionary)["localPairing"] == true


## A successful discovery read.
func read_ok(body: Variant) -> Array:
	return _swap("on" if local_pairing_of(body) else "off")


## A not-found discovery read: the cached answer is cleared.
func read_not_found() -> Array:
	return _swap("none")


## A failed read (offline, an error status): nothing changes.
func read_error() -> Array:
	return []


func _swap(next: String) -> Array:
	var was := _cached
	_cached = next
	return EFFECTS.duplicate() if was == "on" and next != "on" else []


## "local-pairing-off" for a gated call while the gate is not on, else "ok".
func check() -> String:
	return "ok" if allowed() else "local-pairing-off"
