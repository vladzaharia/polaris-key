class_name PKeyTestSigner
extends RefCounted
## TEST ONLY: Ed25519 signing in pure GDScript (TweetNaCl's crypto_sign over PKeyEd25519Ref's
## primitives) and `signJws`'s exact bytes (shared-jws: header `{"alg":"EdDSA","typ":…,"kid":…}`,
## the payload as compact JSON), so the packs suite can mint pack records with the corpus's own
## test release key (`cases.json` `keys`, never a production key). Slow (the reference scalar
## multiplication): a handful of records per run.

const R := preload("res://addons/polaris_key/core/crypto/ed25519_ref.gd")


## The 32-byte seed of a PKCS#8 Ed25519 private key in PEM (its last 32 DER bytes).
static func seed_from_pem(pem: String) -> PackedByteArray:
	var body := ""
	for line in pem.split("\n"):
		var l := line.strip_edges()
		if l == "" or l.begins_with("-----"):
			continue
		body += l
	var der := Marshalls.base64_to_raw(body)
	return der.slice(der.size() - 32)


static func public_key(seed: PackedByteArray) -> PackedByteArray:
	var d := PKeySha512.hash(seed)
	d[0] &= 248
	d[31] &= 127
	d[31] |= 64
	var p := [R.gf(), R.gf(), R.gf(), R.gf()]
	R.scalarbase(p, d.slice(0, 32))
	var pk := PackedByteArray()
	pk.resize(32)
	R.pack(pk, p)
	return pk


static func sign_bytes(msg: PackedByteArray, seed: PackedByteArray) -> PackedByteArray:
	var d := PKeySha512.hash(seed)
	d[0] &= 248
	d[31] &= 127
	d[31] |= 64
	var pk := public_key(seed)
	var rin := d.slice(32, 64)
	rin.append_array(msg)
	var r := R.reduce(PKeySha512.hash(rin))
	var p := [R.gf(), R.gf(), R.gf(), R.gf()]
	R.scalarbase(p, r)
	var big_r := PackedByteArray()
	big_r.resize(32)
	R.pack(big_r, p)
	var hin := big_r.duplicate()
	hin.append_array(pk)
	hin.append_array(msg)
	var h := R.reduce(PKeySha512.hash(hin))
	var x := PackedInt64Array()
	x.resize(64)
	for i in 32:
		x[i] = r[i]
	for i in 32:
		for j in 32:
			x[i + j] += h[i] * d[j]
	var s := PackedByteArray()
	s.resize(32)
	R.modL(s, x)
	var sig := big_r
	sig.append_array(s)
	return sig


## A compact JWS of `payload_text` (compact JSON the caller built, integers written as integers).
static func sign_jws(payload_text: String, seed: PackedByteArray, kid: String, typ: String) -> String:
	var header := "{\"alg\":\"EdDSA\",\"typ\":\"%s\",\"kid\":\"%s\"}" % [typ, kid]
	var input := PKeyB64Url.encode(header.to_utf8_buffer()) + "." + PKeyB64Url.encode(payload_text.to_utf8_buffer())
	return input + "." + PKeyB64Url.encode(sign_bytes(input.to_utf8_buffer(), seed))
