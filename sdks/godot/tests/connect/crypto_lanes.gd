extends RefCounted
# @pkey-feature connect.noise
# Lane selection for the peer crypto port (CC-14b.1, D-3): a native lane is chosen only after the
# known answers (RFC 7748 section 5.2 and 6.1, NIST AES-256-GCM case 16, refusals); one that is
# absent, answers wrongly, accepts a forged tag or a low-order point, or whose native side lacks a
# method, falls back to the GDScript lane. The device key store reaches X25519 through the same
# port: the agreement key stays in process and a refused or malformed answer is "no secret".

const K := "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"
const U := "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"


## A correct "native" lane (it delegates to the GDScript code) that counts its calls.
class Good extends PKeyPeerCrypto:
	var calls := 0
	var dh_calls := 0
	var up := true

	func lane_name() -> String:
		return "fake"

	func available() -> bool:
		return up

	func x25519_public(k: PackedByteArray) -> PackedByteArray:
		calls += 1
		return super.x25519_public(k)

	func x25519(k: PackedByteArray, p: PackedByteArray) -> Variant:
		calls += 1
		dh_calls += 1
		return super.x25519(k, p)

	func aes_gcm_seal(k: PackedByteArray, n: PackedByteArray, a: PackedByteArray, p: PackedByteArray) -> PackedByteArray:
		calls += 1
		return super.aes_gcm_seal(k, n, a, p)

	func aes_gcm_open(k: PackedByteArray, n: PackedByteArray, a: PackedByteArray, s: PackedByteArray) -> Variant:
		calls += 1
		return super.aes_gcm_open(k, n, a, s)


## A lane wrong in exactly one way; `fault` names it.
class Wrong extends Good:
	var fault := ""

	func x25519(k: PackedByteArray, p: PackedByteArray) -> Variant:
		var r = super.x25519(k, p)
		if fault == "dh" and r is PackedByteArray:
			r[0] ^= 1
		if fault == "low_order" and r == null:
			return PackedByteArray([1]) + PackedByteArray(range(31))
		if fault == "dh_type":
			return "not bytes"
		if fault == "dh_short" and r is PackedByteArray:
			return r.slice(0, 31)
		return r

	func x25519_public(k: PackedByteArray) -> PackedByteArray:
		var r := super.x25519_public(k)
		if fault == "public" and r.size() == 32:
			r[31] ^= 1
		if fault == "public_short":
			return r.slice(0, 31)
		return r

	func aes_gcm_seal(k: PackedByteArray, n: PackedByteArray, a: PackedByteArray, p: PackedByteArray) -> PackedByteArray:
		var r := super.aes_gcm_seal(k, n, a, p)
		if fault == "seal" and r.size() > 0:
			r[0] ^= 1
		if fault == "seal_empty":
			return PackedByteArray()
		return r

	func aes_gcm_open(k: PackedByteArray, n: PackedByteArray, a: PackedByteArray, s: PackedByteArray) -> Variant:
		var r = super.aes_gcm_open(k, n, a, s)
		if fault == "open_forgery" and r == null:
			return PackedByteArray()  # accepts a forged tag
		if fault == "open_null":
			return null
		return r


## An adapter over a native object, like the Apple and Android ones: a method the native side lacks
## makes it unavailable, and a call that answers nothing is a refusal.
class Backed extends PKeyPeerCrypto:
	var native: Object

	func _init(p_native: Object) -> void:
		native = p_native

	func available() -> bool:
		return native != null and native.has_method("dh") and native.has_method("pub") and native.has_method("seal") and native.has_method("open")

	func x25519(k: PackedByteArray, p: PackedByteArray) -> Variant:
		return native.call("dh", k, p)

	func x25519_public(k: PackedByteArray) -> PackedByteArray:
		var r = native.call("pub", k)
		return r if r is PackedByteArray else PackedByteArray()

	func aes_gcm_seal(k: PackedByteArray, n: PackedByteArray, a: PackedByteArray, p: PackedByteArray) -> PackedByteArray:
		var r = native.call("seal", k, n, a, p)
		return r if r is PackedByteArray else PackedByteArray()

	func aes_gcm_open(k: PackedByteArray, n: PackedByteArray, a: PackedByteArray, s: PackedByteArray) -> Variant:
		return native.call("open", k, n, a, s)


## A native side that answers like the GDScript code (`broken` makes it answer nothing at all).
class NativeFake extends RefCounted:
	var base := PKeyPeerCrypto.new()
	var broken := false

	func dh(k: PackedByteArray, p: PackedByteArray) -> Variant:
		return null if broken else base.x25519(k, p)

	func pub(k: PackedByteArray) -> Variant:
		return null if broken else base.x25519_public(k)

	func seal(k: PackedByteArray, n: PackedByteArray, a: PackedByteArray, p: PackedByteArray) -> Variant:
		return null if broken else base.aes_gcm_seal(k, n, a, p)

	func open(k: PackedByteArray, n: PackedByteArray, a: PackedByteArray, s: PackedByteArray) -> Variant:
		return null if broken else base.aes_gcm_open(k, n, a, s)


class NativeNoOpen extends RefCounted:
	func dh(_k: PackedByteArray, _p: PackedByteArray) -> Variant:
		return null

	func pub(_k: PackedByteArray) -> Variant:
		return null

	func seal(_k: PackedByteArray, _n: PackedByteArray, _a: PackedByteArray, _p: PackedByteArray) -> Variant:
		return null


func run(t: PKeyTestContext) -> void:
	_gdscript(t)
	_selection(t)
	_faults(t)
	_backed(t)
	_store(t)


func _gdscript(t: PKeyTestContext) -> void:
	var g := PKeyPeerCrypto.new()
	t.check("lanes: the GDScript lane passes its own known answers", g.known_answers_ok() and g.available() and g.lane_name() == "gdscript")
	PKeyPeerCrypto.reset_for_tests()
	var a := PKeyPeerCrypto.for_platform()
	t.check("lanes: with no native adapter in the build the port is GDScript", a.lane_name() == "gdscript")
	t.check("lanes: for_platform answers the one chosen lane", PKeyPeerCrypto.for_platform() == a)
	PKeyPeerCrypto.reset_for_tests()


func _selection(t: PKeyTestContext) -> void:
	var good := Good.new()
	t.check("select: a correct lane passes the known answers", good.known_answers_ok())
	t.check("select: a correct native lane is chosen", PKeyPeerCrypto.select([good]) == good)
	t.check("select: the known answers called the lane", good.calls > 0)
	var down := Good.new()
	down.up = false
	t.check("select: an unavailable lane is never called", PKeyPeerCrypto.select([down]).lane_name() == "gdscript" and down.calls == 0)
	t.check("select: nulls are skipped, and an empty list is GDScript", PKeyPeerCrypto.select([null, null]).lane_name() == "gdscript" and PKeyPeerCrypto.select([]).lane_name() == "gdscript")
	t.check("select: non-lanes in the list are skipped", PKeyPeerCrypto.select(["x", 3, RefCounted.new()]).lane_name() == "gdscript")
	var bad := Wrong.new()
	bad.fault = "dh"
	var next := Good.new()
	t.check("select: a wrong lane is passed over for the next correct one", PKeyPeerCrypto.select([bad, next]) == next)
	t.check("select: the first correct lane wins", PKeyPeerCrypto.select([Good.new(), next]) != next)


func _faults(t: PKeyTestContext) -> void:
	for fault in ["dh", "low_order", "dh_type", "dh_short", "public", "public_short", "seal", "seal_empty", "open_forgery", "open_null"]:
		var w := Wrong.new()
		w.fault = fault
		var chosen := PKeyPeerCrypto.select([w])
		t.check("faults: %s answers are never chosen" % fault, chosen != w and chosen.lane_name() == "gdscript" and not w.known_answers_ok())


func _backed(t: PKeyTestContext) -> void:
	var ok := NativeFake.new()
	var lane := Backed.new(ok)
	t.check("backed: a native object that answers correctly is chosen", PKeyPeerCrypto.select([lane]) == lane)
	var broken := NativeFake.new()
	broken.broken = true
	t.check("backed: a native side that answers nothing falls back", PKeyPeerCrypto.select([Backed.new(broken)]).lane_name() == "gdscript")
	var missing := Backed.new(NativeNoOpen.new())
	t.check("backed: a missing native method is unavailable, never called", not missing.available() and PKeyPeerCrypto.select([missing]).lane_name() == "gdscript")
	t.check("backed: no native object is unavailable", not Backed.new(null).available() and PKeyPeerCrypto.select([Backed.new(null)]).lane_name() == "gdscript")
	# The kill switch needs no environment here: the list it empties is the one for_platform builds.
	t.check("backed: ENV_LANE is the documented switch", PKeyPeerCrypto.ENV_LANE == "PKEY_PEER_CRYPTO")


func _store(t: PKeyTestContext) -> void:
	var port := Good.new()
	var s := PKeyDeviceKeyStore.new("memory", "user://pkey", true)
	s.crypto = port
	var made := s.ensure()
	t.check("store: ensure makes keys through the port", made.ok and made.detail != null and port.calls > 0)
	var peer := PKeyPeerCrypto.new().x25519_public(PackedByteArray(range(32)))
	var before := port.dh_calls
	var r := s.dh(peer)
	t.check("store: dh goes through the port and returns the shared secret", r.ok and r.detail is PackedByteArray and r.detail.size() == 32 and port.dh_calls == before + 1)
	var again := s.dh(peer)
	t.check("store: dh is stable for one peer", again.ok and again.detail == r.detail)
	var zero := s.dh(PackedByteArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
	t.check("store: a low-order peer is refused before the port is called", zero.ok and zero.detail == null and port.dh_calls == before + 2)
	# A lane that answers the wrong thing is "no secret", never a value.
	for fault in ["dh_type", "dh_short"]:
		var w := Wrong.new()
		w.fault = fault
		var s2 := PKeyDeviceKeyStore.new("memory", "user://pkey", true)
		s2.crypto = w
		s2.ensure()
		var bad := s2.dh(peer)
		t.check("store: a %s answer is no secret" % fault, bad.ok and bad.detail == null)
	var cmp := PKeyDeviceKeyStore.new("memory", "user://pkey", true)
	cmp.ensure()
	t.check("store: the default port is the chosen lane", cmp._port() == PKeyPeerCrypto.for_platform())
	PKeyPeerCrypto.reset_for_tests()
