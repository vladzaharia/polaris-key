extends RefCounted
# @pkey-feature connect.noise
# The Apple lane of the crypto port (CC-14b.3): PKeyAppleCrypto over a fake binary entry that parses
# the wire layout (key, nonce, big-endian aad length, aad, message; status byte first in the reply),
# and, when the macOS dylib is built and installed, over the real CryptoKit ops: the known answers,
# agreement with the GDScript lane on varied inputs, a 1 MiB chunk, the refusals, and the selector
# taking the lane. Needs PKEY_APPLE_SELFTEST=1 only for the other suite's echo ops, not here.


## A native object with the cx_* ops, answering from the GDScript lane.
class FakeBin:
	extends RefCounted
	var base := PKeyPeerCrypto.new()
	var ops: Array[String] = []
	var unknown := false

	func poll_bin() -> Array:
		return []

	func cmd_bin(op: String, d: PackedByteArray) -> PackedByteArray:
		ops.append(op)
		var out := PackedByteArray()
		if unknown:
			return out
		if op == "cx_x25519_pub":
			out = _ok(base.x25519_public(d)) if d.size() == 32 else PackedByteArray([3])
		elif op == "cx_x25519":
			out = _dh(d)
		elif op == "cx_seal" or op == "cx_open":
			out = _gcm(op, d)
		return out

	func _dh(d: PackedByteArray) -> PackedByteArray:
		if d.size() != 64:
			return PackedByteArray([3])
		var r = base.x25519(d.slice(0, 32), d.slice(32))
		return _ok(r) if r != null else PackedByteArray([0])

	func _gcm(op: String, d: PackedByteArray) -> PackedByteArray:
		if d.size() < 48:
			return PackedByteArray([3])
		var n := (d[44] << 24) | (d[45] << 16) | (d[46] << 8) | d[47]
		if n > d.size() - 48:
			return PackedByteArray([3])
		var aad := d.slice(48, 48 + n)
		var body := d.slice(48 + n)
		if op == "cx_seal":
			return _ok(base.aes_gcm_seal(d.slice(0, 32), d.slice(32, 44), aad, body))
		var r = base.aes_gcm_open(d.slice(0, 32), d.slice(32, 44), aad, body)
		return _ok(r) if r != null else PackedByteArray([0])

	func _ok(b: PackedByteArray) -> PackedByteArray:
		return PackedByteArray([1]) + b


func run(t: PKeyTestContext) -> void:
	_fake(t)
	_real(t)


func _apple_over(fake: Object) -> PKeyApple:
	var a := PKeyApple.new()
	a.platform = "ios"
	a.native = fake
	return a


func _fake(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	var apple := _apple_over(fake)
	var lane := PKeyAppleCrypto.create(apple)
	t.check("fake: the adapter is created over a native with the binary entry", lane != null and lane.available() and lane.lane_name() == "apple")
	if lane == null:
		return
	t.check("fake: the known answers pass through the wire layout", lane.known_answers_ok())
	t.check("fake: the selector takes it", PKeyPeerCrypto.select([lane]) == lane)
	var key := PackedByteArray(range(32))
	var nonce := PackedByteArray(range(12))
	var aad := PackedByteArray()
	aad.resize(300)
	aad.fill(7)
	var sealed := lane.aes_gcm_seal(key, nonce, aad, PackedByteArray([1, 2, 3]))
	var want := PKeyPeerCrypto.new().aes_gcm_seal(key, nonce, aad, PackedByteArray([1, 2, 3]))
	t.check("fake: a 300-byte aad (a length above 255) is framed big endian", sealed == want)
	t.check("fake: open returns the plaintext, and null for a wrong aad", lane.aes_gcm_open(key, nonce, aad, sealed) == PackedByteArray([1, 2, 3]) \
			and lane.aes_gcm_open(key, nonce, PackedByteArray(), sealed) == null)
	t.check("fake: an empty message opens to empty, not null", lane.aes_gcm_open(key, nonce, aad, lane.aes_gcm_seal(key, nonce, aad, PackedByteArray())) is PackedByteArray)
	t.check("fake: unusable arguments never reach the native side", _no_calls(fake, lane, key, nonce))
	fake.unknown = true
	t.check("fake: a build without the ops answers empty and fails the known answers", lane.x25519_public(key).is_empty() and not lane.known_answers_ok()
			and PKeyPeerCrypto.select([lane]).lane_name() == "gdscript")
	apple.free()
	var none := _apple_over(RefCounted.new())
	t.check("fake: no binary entry, no adapter", PKeyAppleCrypto.create(none) == null)
	none.free()


func _no_calls(fake: FakeBin, lane: PKeyAppleCrypto, key: PackedByteArray, nonce: PackedByteArray) -> bool:
	var before := fake.ops.size()
	var short := PackedByteArray([1])
	var ok := lane.x25519_public(short).is_empty() and lane.x25519(short, key) == null and lane.x25519(key, short) == null
	ok = ok and lane.aes_gcm_seal(short, nonce, short, short).is_empty() and lane.aes_gcm_seal(key, short, short, short).is_empty()
	ok = ok and lane.aes_gcm_open(short, nonce, short, key) == null and lane.aes_gcm_open(key, nonce, short, short) == null
	return ok and fake.ops.size() == before


func _real(t: PKeyTestContext) -> void:
	var lane := PKeyAppleCrypto.create()
	if lane == null:
		t.info("real: the macOS dylib with the crypto ops is not built here (native/macos/build_apple.sh --install); skipped")
		return
	var gd := PKeyPeerCrypto.new()
	t.check("real: the known answers pass on CryptoKit", lane.available() and lane.known_answers_ok())
	t.check("real: the selector takes the lane", PKeyPeerCrypto.select([lane]) == lane)
	PKeyPeerCrypto.reset_for_tests()
	t.check("real: for_platform picks it", PKeyPeerCrypto.for_platform().lane_name() == "apple")
	PKeyPeerCrypto.reset_for_tests()
	var crypto := Crypto.new()
	var agree := true
	var gcm := true
	for i in 12:
		var a := crypto.generate_random_bytes(32)
		var b := crypto.generate_random_bytes(32)
		var pa := gd.x25519_public(a)
		var pb := gd.x25519_public(b)
		agree = agree and lane.x25519_public(a) == pa and lane.x25519(a, pb) == gd.x25519(a, pb) and lane.x25519(a, pb) == lane.x25519(b, pa)
		var aad := crypto.generate_random_bytes(i * 5)
		var plain := crypto.generate_random_bytes(i * 37)
		var nonce := crypto.generate_random_bytes(12)
		var s := lane.aes_gcm_seal(a, nonce, aad, plain)
		gcm = gcm and s == gd.aes_gcm_seal(a, nonce, aad, plain) and lane.aes_gcm_open(a, nonce, aad, s) == plain and gd.aes_gcm_open(a, nonce, aad, s) == plain
	t.check("real: X25519 agrees with the GDScript lane on random keys", agree)
	t.check("real: AES-GCM agrees with the GDScript lane on random inputs", gcm)
	var k := PackedByteArray(range(32))
	var n := PackedByteArray(range(12))
	var low := PackedByteArray()
	low.resize(32)
	t.check("real: an all-zero (low-order) peer is refused", lane.x25519(k, low) == null)
	var big := crypto.generate_random_bytes(1 << 20)
	var sealed := lane.aes_gcm_seal(k, n, PackedByteArray(), big)
	var opened = lane.aes_gcm_open(k, n, PackedByteArray(), sealed)
	t.check("real: a 1 MiB chunk seals and opens (no 64 KiB cap on this lane)", sealed.size() == big.size() + 16 and opened == big)
	sealed[5] ^= 1
	t.check("real: a flipped ciphertext bit does not open", lane.aes_gcm_open(k, n, PackedByteArray(), sealed) == null)
	# The device key store reaches it through the port.
	var store := PKeyDeviceKeyStore.new("memory", "user://pkey", true)
	store.crypto = lane
	var peer := gd.x25519_public(k)
	var made := store.ensure()
	var d := store.dh(peer)
	t.check("real: the device key store agrees through the Apple lane", made.ok and d.ok and d.detail is PackedByteArray and d.detail.size() == 32)
