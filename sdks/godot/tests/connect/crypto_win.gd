extends RefCounted
# @pkey-feature connect.noise
# PKeyWinCrypto (CC-14b.6) over the Windows crypto class. Two modes:
#
#   mocked  (always)  the class stands in as a fake that answers through the GDScript port in the
#                     native reply format: the adapter's byte protocol (status byte then result),
#                     its refusals, a DLL without the curve methods (X25519 on the GDScript
#                     ladder), and a missing class or method (null: the selector keeps the
#                     GDScript lane).
#   real    (PKEY_WIN_CRYPTO_REAL=1, the ci:windows `crypto` stage) the built pkey_win.dll through
#                     the same checks: the noise-vectors known answers, a tampered tag, ciphertext,
#                     AAD and nonce, wrong lengths, an empty message, the largest Noise message,
#                     and agreement with the GDScript port. It fails when the class is missing.

const VECTORS := "res://tests/corpus/v2/noise-vectors.json"


## Stands in for PKeyWinCryptoNative: answers through the GDScript port, in the native reply format.
class FakeNative extends RefCounted:
	var port := PKeyPeerCrypto.new()
	var x25519_ok := true
	var calls: Array[String] = []

	func aes_gcm_seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
		calls.append("aes_gcm_seal")
		return _ok(port.aes_gcm_seal(key, nonce, aad, plain))

	func aes_gcm_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> PackedByteArray:
		calls.append("aes_gcm_open")
		var r = port.aes_gcm_open(key, nonce, aad, sealed)
		return PackedByteArray([0]) if r == null else _ok(r)

	func x25519(priv: PackedByteArray, pub: PackedByteArray) -> PackedByteArray:
		calls.append("x25519")
		if not x25519_ok:
			return PackedByteArray([2])
		var r = port.x25519(priv, pub)
		return PackedByteArray([0]) if r == null else _ok(r)

	func x25519_public(priv: PackedByteArray) -> PackedByteArray:
		calls.append("x25519_public")
		if not x25519_ok:
			return PackedByteArray([2])
		return _ok(port.x25519_public(priv))

	func _ok(body: PackedByteArray) -> PackedByteArray:
		var out := PackedByteArray([1])
		out.append_array(body)
		return out


## Only the AES-GCM pair: a pkey_win.dll from before CC-14b.7.
class AeadOnly extends RefCounted:
	var port := PKeyPeerCrypto.new()

	func aes_gcm_seal(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, plain: PackedByteArray) -> PackedByteArray:
		var out := PackedByteArray([1])
		out.append_array(port.aes_gcm_seal(key, nonce, aad, plain))
		return out

	func aes_gcm_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> PackedByteArray:
		var r = port.aes_gcm_open(key, nonce, aad, sealed)
		var out := PackedByteArray([0 if r == null else 1])
		if r != null:
			out.append_array(r)
		return out


class Bare extends RefCounted:
	func aes_gcm_seal(_a, _b, _c, _d) -> PackedByteArray:
		return PackedByteArray()


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("noise-vectors.json parses", j.parse(FileAccess.get_file_as_string(VECTORS)) == OK and j.data is Dictionary):
		return
	var v: Dictionary = j.data
	t.check("a missing method is no lane", PKeyWinCrypto.create(Bare.new()) == null)
	t.check("no class is no lane", PKeyWinCrypto.create(null) == null or ClassDB.class_exists(PKeyWinCrypto.NATIVE_CLASS))
	var fake := FakeNative.new()
	var a := PKeyWinCrypto.create(fake)
	if t.check("the adapter is created over a full class", a != null):
		_x25519(t, a, v["x25519"])
		t.check("x25519 went native", fake.calls.has("x25519") and fake.calls.has("x25519_public") and a.x25519_native())
		_gcm(t, a, v["aesGcm"])
		t.check("gcm went native", fake.calls.has("aes_gcm_seal") and fake.calls.has("aes_gcm_open"))
		_refusals(t, a, v)
		_tamper(t, a)
	_aead_only(t, v)
	_unsupported(t, v["x25519"])
	_replies(t)
	if OS.get_environment("PKEY_WIN_CRYPTO_REAL") == "1":
		_real(t, v)


## The built DLL. Missing class, or a failing known answer, fails the run: nothing is skipped.
func _real(t: PKeyTestContext, v: Dictionary) -> void:
	if not t.check("PKeyWinCryptoNative is registered by pkey_win.dll", ClassDB.class_exists(PKeyWinCrypto.NATIVE_CLASS)):
		return
	var a := PKeyWinCrypto.create()
	if not t.check("the adapter is created over the DLL", a != null):
		return
	t.info("real: Windows CNG AES-256-GCM")
	_gcm(t, a, v["aesGcm"])
	_refusals_gcm(t, a)
	_tamper(t, a)
	_cross_check(t, a)
	if a.x25519_native():
		t.info("real: Monocypher X25519")
		_x25519(t, a, v["x25519"])
		_low_order(t, a, v["lowOrder"])
		_x25519_lengths(t, a)
	else:
		t.info("real: the DLL has no curve methods (older than CC-14b.7)")


func _x25519(t: PKeyTestContext, a: PKeyWinCrypto, x: Dictionary) -> void:
	for row in x["scalarMult"]:
		var r = a.x25519(String(row["scalar"]).hex_decode(), String(row["u"]).hex_decode())
		t.check("x25519 %s" % row["id"], r != null and (r as PackedByteArray).hex_encode() == row["expect"])
	var ag: Dictionary = x["agreement"][0]
	t.check("public key of alice", a.x25519_public(String(ag["alicePrivate"]).hex_decode()).hex_encode() == ag["alicePublic"])
	t.check("public key of bob", a.x25519_public(String(ag["bobPrivate"]).hex_decode()).hex_encode() == ag["bobPublic"])
	var s = a.x25519(String(ag["bobPrivate"]).hex_decode(), String(ag["alicePublic"]).hex_decode())
	t.check("agreement (bob)", s != null and (s as PackedByteArray).hex_encode() == ag["shared"])
	var s2 = a.x25519(String(ag["alicePrivate"]).hex_decode(), String(ag["bobPublic"]).hex_decode())
	t.check("agreement (alice)", s2 != null and (s2 as PackedByteArray).hex_encode() == ag["shared"])


func _gcm(t: PKeyTestContext, a: PKeyWinCrypto, rows: Array) -> void:
	for row in rows:
		var key := String(row["key"]).hex_decode()
		var nonce := String(row["nonce"]).hex_decode()
		var aad := String(row["aad"]).hex_decode()
		var plain := String(row["plaintext"]).hex_decode()
		var sealed := a.aes_gcm_seal(key, nonce, aad, plain)
		t.check("gcm seal %s" % row["id"], sealed.hex_encode() == String(row["ciphertext"]) + String(row["tag"]))
		var opened = a.aes_gcm_open(key, nonce, aad, String(row["ciphertext"] + row["tag"]).hex_decode())
		t.check("gcm open %s" % row["id"], opened != null and (opened as PackedByteArray) == plain)


func _low_order(t: PKeyTestContext, a: PKeyWinCrypto, low: Dictionary) -> void:
	var sk := String(low["scalar"]).hex_decode()
	for row in low["rows"]:
		var r = a.x25519(sk, String(row["u"]).hex_decode())
		if row["lowOrder"]:
			t.check("low-order %s is dh_zero (null)" % row["id"], r == null)
		else:
			t.check("%s is not refused" % row["id"], r != null and (r as PackedByteArray).hex_encode() == row["output"])


func _x25519_lengths(t: PKeyTestContext, a: PKeyWinCrypto) -> void:
	var key := _zeros(32)
	t.check("x25519 length checked", a.x25519(PackedByteArray([1]), key) == null and a.x25519(key, PackedByteArray([1])) == null)
	t.check("public length checked", a.x25519_public(PackedByteArray([1])).is_empty())


func _refusals(t: PKeyTestContext, a: PKeyWinCrypto, v: Dictionary) -> void:
	_refusals_gcm(t, a)
	_low_order(t, a, v["lowOrder"])
	_x25519_lengths(t, a)


func _refusals_gcm(t: PKeyTestContext, a: PKeyWinCrypto) -> void:
	var key := _zeros(32)
	var nonce := _zeros(12)
	var sealed := a.aes_gcm_seal(key, nonce, PackedByteArray(), PackedByteArray([1, 2, 3]))
	t.check("a sealed message is the text and a 16-byte tag", sealed.size() == 3 + 16)
	var empty = a.aes_gcm_open(key, nonce, PackedByteArray(), a.aes_gcm_seal(key, nonce, PackedByteArray(), PackedByteArray()))
	t.check("an empty message opens to empty, not null", empty is PackedByteArray and (empty as PackedByteArray).is_empty())
	t.check("short key refused", a.aes_gcm_seal(PackedByteArray([1]), nonce, PackedByteArray(), PackedByteArray()).is_empty())
	t.check("long key refused", a.aes_gcm_seal(_zeros(33), nonce, PackedByteArray(), PackedByteArray()).is_empty())
	t.check("short nonce refused", a.aes_gcm_open(key, PackedByteArray([1]), PackedByteArray(), sealed) == null)
	t.check("long nonce refused", a.aes_gcm_seal(key, _zeros(16), PackedByteArray(), PackedByteArray()).is_empty())
	t.check("shorter than a tag refused", a.aes_gcm_open(key, nonce, PackedByteArray(), _zeros(15)) == null)
	t.check("over a Noise message refused (seal)", a.aes_gcm_seal(key, nonce, PackedByteArray(), _zeros(PKeyPeerCrypto.MAX_AEAD_BYTES)).is_empty())
	t.check("over a Noise message refused (open)", a.aes_gcm_open(key, nonce, PackedByteArray(), _zeros(PKeyPeerCrypto.MAX_AEAD_BYTES + 1)) == null)


## Any change to the tag, the text, the AAD, the nonce or the key opens to null: no plaintext.
func _tamper(t: PKeyTestContext, a: PKeyWinCrypto) -> void:
	var key := _zeros(32)
	key[5] = 9
	var nonce := _zeros(12)
	nonce[11] = 1
	var aad := PackedByteArray([7, 7, 7])
	var plain := PackedByteArray([1, 2, 3, 4, 5, 6, 7, 8])
	var sealed := a.aes_gcm_seal(key, nonce, aad, plain)
	var ok = a.aes_gcm_open(key, nonce, aad, sealed)
	if not t.check("untampered opens", ok != null and (ok as PackedByteArray) == plain):
		return
	for i in sealed.size():
		var bad := sealed.duplicate()
		bad[i] ^= 0x80
		if a.aes_gcm_open(key, nonce, aad, bad) != null:
			t.check("tampered byte %d opens to null" % i, false)
			return
	t.check("every flipped byte of the text and tag opens to null", true)
	var bad_aad := aad.duplicate()
	bad_aad[0] ^= 1
	t.check("a different AAD opens to null", a.aes_gcm_open(key, nonce, bad_aad, sealed) == null)
	t.check("a missing AAD opens to null", a.aes_gcm_open(key, nonce, PackedByteArray(), sealed) == null)
	var bad_nonce := nonce.duplicate()
	bad_nonce[0] ^= 1
	t.check("a different nonce opens to null", a.aes_gcm_open(key, bad_nonce, aad, sealed) == null)
	var bad_key := key.duplicate()
	bad_key[0] ^= 1
	t.check("a different key opens to null", a.aes_gcm_open(bad_key, nonce, aad, sealed) == null)
	t.check("a truncated message opens to null", a.aes_gcm_open(key, nonce, aad, sealed.slice(0, sealed.size() - 1)) == null)


## The native lane and the GDScript port agree, on the largest message too.
func _cross_check(t: PKeyTestContext, a: PKeyWinCrypto) -> void:
	var port := PKeyPeerCrypto.new()
	var key := _zeros(32)
	for i in 32:
		key[i] = i * 7 + 1
	var nonce := _zeros(12)
	nonce[3] = 4
	var aad := PackedByteArray([1, 2, 3, 4, 5])
	for n in [1, 15, 16, 17, 255, 4096, PKeyPeerCrypto.MAX_AEAD_BYTES - 16]:
		var plain := _zeros(n)
		for i in n:
			plain[i] = (i * 31 + n) & 0xff
		var native := a.aes_gcm_seal(key, nonce, aad, plain)
		t.check("native seal equals the port at %d bytes" % n, native == port.aes_gcm_seal(key, nonce, aad, plain))
		var back = a.aes_gcm_open(key, nonce, aad, native)
		t.check("native open round-trips at %d bytes" % n, back != null and (back as PackedByteArray) == plain)


## A DLL with the AES-GCM pair only (before CC-14b.7): X25519 stays on the GDScript ladder.
func _aead_only(t: PKeyTestContext, v: Dictionary) -> void:
	var a := PKeyWinCrypto.create(AeadOnly.new())
	if not t.check("an AEAD-only class still makes an adapter", a != null):
		return
	t.check("and says its X25519 is not native", not a.x25519_native())
	_x25519(t, a, v["x25519"])
	_gcm(t, a, v["aesGcm"])


## The class answers "unsupported" for X25519: the ladder, remembered, with AES-GCM still native.
func _unsupported(t: PKeyTestContext, x: Dictionary) -> void:
	var fake := FakeNative.new()
	fake.x25519_ok = false
	var a := PKeyWinCrypto.create(fake)
	var row: Dictionary = x["scalarMult"][0]
	var r = a.x25519(String(row["scalar"]).hex_decode(), String(row["u"]).hex_decode())
	t.check("unsupported x25519 falls back to the ladder", r != null and (r as PackedByteArray).hex_encode() == row["expect"])
	t.check("and is remembered", not a.x25519_native())
	var n := fake.calls.size()
	a.x25519_public(String(row["scalar"]).hex_decode())
	t.check("no further native x25519 calls", fake.calls.size() == n)
	t.check("AES-GCM stays native", not a.aes_gcm_seal(_zeros(32), _zeros(12), PackedByteArray(), PackedByteArray()).is_empty() and fake.calls.has("aes_gcm_seal"))


## Anything but a non-empty PackedByteArray with status 1 is a refusal.
func _replies(t: PKeyTestContext) -> void:
	t.check("null reply", PKeyWinCrypto._body(null).is_empty() and PKeyWinCrypto._status(null) == -1)
	t.check("empty reply", PKeyWinCrypto._status(PackedByteArray()) == -1)
	t.check("a string reply", PKeyWinCrypto._body("x").is_empty())
	t.check("status 0 carries no plaintext", PKeyWinCrypto._body(PackedByteArray([0, 9, 9])).is_empty())
	t.check("status 3", PKeyWinCrypto._body(PackedByteArray([3, 9, 9])).is_empty())
	t.check("status 1", PKeyWinCrypto._body(PackedByteArray([1, 9, 8])) == PackedByteArray([9, 8]))


static func _zeros(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	return b
