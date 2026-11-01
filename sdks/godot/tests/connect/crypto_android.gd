extends RefCounted
# @pkey-feature connect.noise
# PKeyAndroidCrypto (CC-14b.8) with the plugin mocked: the adapter's byte protocol (status byte then
# result), the refusals, the API-below-33 X25519 fallback to the GDScript ladder, and a missing
# plugin or method (null, so the selector keeps the GDScript lane). The JCA itself is proved by
# :platform's PlatformCryptoTest (RFC 7748 and GCM known answers); a device run is CI ci:android.

const VECTORS := "res://tests/corpus/v2/noise-vectors.json"


## Stands in for the plugin: answers through the GDScript port, in the plugin's reply format.
class FakeNative extends RefCounted:
	var port := PKeyPeerCrypto.new()
	var x25519_ok := true
	var calls: Array[String] = []
	var wrong := false

	# gdlint:ignore=function-name
	func cxSeal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
		calls.append("cxSeal")
		return _ok(port.aes_gcm_seal(key, nonce, aad, plain))

	# gdlint:ignore=function-name
	func cxOpen(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> PackedByteArray:
		calls.append("cxOpen")
		var r = port.aes_gcm_open(key, nonce, aad, sealed)
		return PackedByteArray([0]) if r == null else _ok(r)

	# gdlint:ignore=function-name
	func cxX25519(priv: PackedByteArray, pub: PackedByteArray) -> PackedByteArray:
		calls.append("cxX25519")
		if not x25519_ok:
			return PackedByteArray([2])
		var r = port.x25519(priv, pub)
		return PackedByteArray([0]) if r == null else _ok(r)

	# gdlint:ignore=function-name
	func cxX25519Pub(priv: PackedByteArray) -> PackedByteArray:
		calls.append("cxX25519Pub")
		if not x25519_ok:
			return PackedByteArray([2])
		return _ok(port.x25519_public(priv))

	func _ok(body: PackedByteArray) -> PackedByteArray:
		var out := PackedByteArray([1])
		out.append_array(body)
		return out


class Bare extends RefCounted:
	# gdlint:ignore=function-name
	func cxSeal(_a, _b, _c, _d) -> PackedByteArray:
		return PackedByteArray()


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("noise-vectors.json parses", j.parse(FileAccess.get_file_as_string(VECTORS)) == OK and j.data is Dictionary):
		return
	var v: Dictionary = j.data
	t.check("a missing method is no lane", PKeyAndroidCrypto.create(Bare.new()) == null)
	t.check("no singleton is no lane", PKeyAndroidCrypto.create(null) == null or Engine.has_singleton(PKeyAndroidCrypto.SINGLETON))
	var fake := FakeNative.new()
	var a := PKeyAndroidCrypto.create(fake)
	if not t.check("the adapter is created over a full plugin", a != null):
		return
	_x25519(t, a, fake, v["x25519"])
	_gcm(t, a, fake, v["aesGcm"])
	_refusals(t, a, v)
	_fallback(t, v["x25519"])
	_replies(t)


func _x25519(t: PKeyTestContext, a: PKeyAndroidCrypto, fake: FakeNative, x: Dictionary) -> void:
	for row in x["scalarMult"]:
		var r = a.x25519(String(row["scalar"]).hex_decode(), String(row["u"]).hex_decode())
		t.check("x25519 %s" % row["id"], r != null and (r as PackedByteArray).hex_encode() == row["expect"])
	var ag: Dictionary = x["agreement"][0]
	t.check("public key of alice", a.x25519_public(String(ag["alicePrivate"]).hex_decode()).hex_encode() == ag["alicePublic"])
	var s = a.x25519(String(ag["bobPrivate"]).hex_decode(), String(ag["alicePublic"]).hex_decode())
	t.check("agreement", s != null and (s as PackedByteArray).hex_encode() == ag["shared"])
	t.check("x25519 went native", fake.calls.has("cxX25519") and fake.calls.has("cxX25519Pub") and a.x25519_native())


func _gcm(t: PKeyTestContext, a: PKeyAndroidCrypto, fake: FakeNative, rows: Array) -> void:
	for row in rows:
		var key := String(row["key"]).hex_decode()
		var nonce := String(row["nonce"]).hex_decode()
		var aad := String(row["aad"]).hex_decode()
		var plain := String(row["plaintext"]).hex_decode()
		var sealed := a.aes_gcm_seal(key, nonce, aad, plain)
		t.check("gcm seal %s" % row["id"], sealed.hex_encode() == String(row["ciphertext"]) + String(row["tag"]))
		var opened = a.aes_gcm_open(key, nonce, aad, sealed)
		t.check("gcm open %s" % row["id"], opened != null and (opened as PackedByteArray) == plain)
	t.check("gcm went native", fake.calls.has("cxSeal") and fake.calls.has("cxOpen"))


func _refusals(t: PKeyTestContext, a: PKeyAndroidCrypto, v: Dictionary) -> void:
	var key := PackedByteArray()
	key.resize(32)
	var nonce := PackedByteArray()
	nonce.resize(12)
	var sealed := a.aes_gcm_seal(key, nonce, PackedByteArray(), PackedByteArray([1, 2, 3]))
	var bad := sealed.duplicate()
	bad[0] ^= 1
	t.check("a bad tag opens to null", a.aes_gcm_open(key, nonce, PackedByteArray(), bad) == null)
	t.check("an empty message opens to empty, not null", a.aes_gcm_open(key, nonce, PackedByteArray(), a.aes_gcm_seal(key, nonce, PackedByteArray(), PackedByteArray())) is PackedByteArray)
	t.check("short key refused", a.aes_gcm_seal(PackedByteArray([1]), nonce, PackedByteArray(), PackedByteArray()).is_empty())
	t.check("short nonce refused", a.aes_gcm_open(key, PackedByteArray([1]), PackedByteArray(), sealed) == null)
	t.check("over a Noise message refused", a.aes_gcm_seal(key, nonce, PackedByteArray(), _zeros(PKeyPeerCrypto.MAX_AEAD_BYTES)).is_empty())
	var low: Dictionary = v["lowOrder"]
	var sk := String(low["scalar"]).hex_decode()
	for row in low["rows"]:
		if not row["lowOrder"]:
			continue
		t.check("low-order %s is dh_zero (null)" % row["id"], a.x25519(sk, String(row["u"]).hex_decode()) == null)
	t.check("x25519 length checked", a.x25519(PackedByteArray([1]), key) == null and a.x25519(key, PackedByteArray([1])) == null)
	t.check("public length checked", a.x25519_public(PackedByteArray([1])).is_empty())


## Below API 33 the plugin answers "unsupported" and X25519 runs on the GDScript ladder (D-3, D-14).
func _fallback(t: PKeyTestContext, x: Dictionary) -> void:
	var fake := FakeNative.new()
	fake.x25519_ok = false
	var a := PKeyAndroidCrypto.create(fake)
	var row: Dictionary = x["scalarMult"][0]
	var r = a.x25519(String(row["scalar"]).hex_decode(), String(row["u"]).hex_decode())
	t.check("unsupported x25519 falls back to the ladder", r != null and (r as PackedByteArray).hex_encode() == row["expect"])
	t.check("and is remembered", not a.x25519_native())
	var n := fake.calls.size()
	a.x25519_public(String(row["scalar"]).hex_decode())
	t.check("no further native x25519 calls", fake.calls.size() == n)
	t.check("AES-GCM stays native", not a.aes_gcm_seal(_zeros(32), _zeros(12), PackedByteArray(), PackedByteArray()).is_empty() and fake.calls.has("cxSeal"))


## Anything but a non-empty PackedByteArray with status 1 is a refusal.
func _replies(t: PKeyTestContext) -> void:
	t.check("null reply", PKeyAndroidCrypto._body(null).is_empty() and PKeyAndroidCrypto._status(null) == -1)
	t.check("empty reply", PKeyAndroidCrypto._status(PackedByteArray()) == -1)
	t.check("a string reply", PKeyAndroidCrypto._body("x").is_empty())
	t.check("status 3", PKeyAndroidCrypto._body(PackedByteArray([3, 9, 9])).is_empty())
	t.check("status 1", PKeyAndroidCrypto._body(PackedByteArray([1, 9, 8])) == PackedByteArray([9, 8]))


static func _zeros(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	return b
