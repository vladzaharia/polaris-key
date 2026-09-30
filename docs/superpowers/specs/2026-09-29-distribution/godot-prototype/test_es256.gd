extends SceneTree
## ES256 (JWS raw r||s) -> DER, verified by Godot's built-in mbedTLS Crypto.

static func _der_int(b: PackedByteArray) -> PackedByteArray:
	var i := 0
	while i < b.size() - 1 and b[i] == 0:
		i += 1
	var v := b.slice(i)
	if v[0] & 0x80:
		v.insert(0, 0)
	var out := PackedByteArray([0x02, v.size()])
	out.append_array(v)
	return out

static func raw_to_der(raw: PackedByteArray) -> PackedByteArray:
	var body := _der_int(raw.slice(0, 32))
	body.append_array(_der_int(raw.slice(32, 64)))
	var out := PackedByteArray([0x30, body.size()])
	out.append_array(body)
	return out

static func b64u(s: String) -> PackedByteArray:
	var b := s.replace("-", "+").replace("_", "/")
	while b.length() % 4 != 0:
		b += "="
	return Marshalls.base64_to_raw(b)

func _init() -> void:
	var parts := FileAccess.get_file_as_string("res://es.jws").strip_edges().split(".")
	var key := CryptoKey.new()
	print("load: ", error_string(key.load("res://es.pub.pem", true)))
	var si := (parts[0] + "." + parts[1]).to_ascii_buffer()
	var der := raw_to_der(b64u(parts[2]))
	var hc := HashingContext.new()
	hc.start(HashingContext.HASH_SHA256)
	hc.update(si)
	var digest := hc.finish()
	var c := Crypto.new()
	print("ES256 valid: ", c.verify(HashingContext.HASH_SHA256, digest, der, key))
	var bad := digest.duplicate()
	bad[0] ^= 1
	print("ES256 tampered: ", c.verify(HashingContext.HASH_SHA256, bad, der, key))
	var n := 200
	var t := Time.get_ticks_usec()
	for i in n:
		c.verify(HashingContext.HASH_SHA256, digest, der, key)
	print("native ES256 verify: %.3f ms" % ((Time.get_ticks_usec() - t) / float(n) / 1000.0))
	var rk := CryptoKey.new()
	rk.load("res://rsa.pub.pem", true)
	var rs := FileAccess.get_file_as_bytes("res://rsa.sig")
	var hc2 := HashingContext.new()
	hc2.start(HashingContext.HASH_SHA256)
	hc2.update(FileAccess.get_file_as_bytes("res://msg.bin"))
	var d2 := hc2.finish()
	t = Time.get_ticks_usec()
	for i in n:
		c.verify(HashingContext.HASH_SHA256, d2, rs, rk)
	print("native RSA-2048 verify: %.3f ms" % ((Time.get_ticks_usec() - t) / float(n) / 1000.0))
	quit()
