extends SceneTree

const Ed := preload("res://addons/polaris_key/crypto/ed25519.gd")


func _init() -> void:
	var v: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://vectors.json"))
	var fails := 0
	for t in v["sha"]:
		var got := Ed.sha512(String(t["msg"]).hex_decode()).hex_encode()
		if got != t["d"]:
			fails += 1
			print("SHA FAIL len=", String(t["msg"]).length() / 2, " got ", got.substr(0, 16))
	print("sha512: ", v["sha"].size() - fails, "/", v["sha"].size(), " ok")
	var ef := 0
	for t in v["ed"]:
		var ok := Ed.verify(String(t["pub"]).hex_decode(), String(t["msg"]).hex_decode(), String(t["sig"]).hex_decode())
		if ok != bool(t["ok"]):
			ef += 1
			print("ED FAIL ", t["name"], " expected ", t["ok"], " got ", ok)
	print("ed25519: ", v["ed"].size() - ef, "/", v["ed"].size(), " ok")

	# Timing: warm-up once (static setup, base point decode), then N verifies of a short message.
	var t0: Dictionary = v["ed"][3]  # rand-0 (empty message)
	var pub := String(t0["pub"]).hex_decode()
	var msg := String(t0["msg"]).hex_decode()
	var sig := String(t0["sig"]).hex_decode()
	Ed.verify(pub, msg, sig)
	var n := 10
	var start := Time.get_ticks_usec()
	for i in n:
		Ed.verify(pub, msg, sig)
	var per := (Time.get_ticks_usec() - start) / float(n) / 1000.0
	print("verify (short msg): %.1f ms avg over %d" % [per, n])

	# Breakdown: SHA-512 of 16 KiB, decode_point, fe_mul throughput.
	var big := PackedByteArray()
	big.resize(16384)
	start = Time.get_ticks_usec()
	Ed.sha512(big)
	print("sha512(16 KiB): %.1f ms" % ((Time.get_ticks_usec() - start) / 1000.0))
	start = Time.get_ticks_usec()
	for i in 10:
		Ed.decode_point(pub)
	print("decode_point: %.2f ms" % ((Time.get_ticks_usec() - start) / 10000.0))
	var a := Ed.fe_frombytes(pub)
	var b := Ed.fe_frombytes(sig.slice(0, 32))
	start = Time.get_ticks_usec()
	for i in 10000:
		a = Ed.fe_mul(a, b)
	print("fe_mul: %.2f us" % ((Time.get_ticks_usec() - start) / 10000.0))
	start = Time.get_ticks_usec()
	for i in 10000:
		a = Ed.fe_sq(a)
	print("fe_sq: %.2f us" % ((Time.get_ticks_usec() - start) / 10000.0))
	print("RESULT fails=", fails + ef)
	quit(1 if fails + ef > 0 else 0)
