extends RefCounted
# @pkey-feature identity.gamecenter
# The gc1. token encoder (I-48.6b, WIRE-CONTRACT-V5 §12.11.7), the same golden as the Swift
# GameCenterTests: the prefix and six fields in order, every field but the timestamp base64url,
# the timestamp plain decimal, at most 4096 characters, and a refusal ("") for anything malformed.
# The transcripts (suite_transcripts, exchange-gamecenter-*) prove the bytes against the Worker.

const GOLDEN := "gc1.aHR0cHM6Ly9zdGF0aWMuZ2MuYXBwbGUuY29tL3B1YmxpYy1rZXkvZ2MtcHJvZC0xMi5jZXI.AQID.UEtleQECAwQ.1699999995000.VDp0cmFuc2NyaXB0LXRlYW0tcGxheWVyLTE.Y29tLmFjbWUubWFj"


static func fields() -> Dictionary:
	return {
		"publicKeyUrl": "https://static.gc.apple.com/public-key/gc-prod-12.cer",
		"signature": "AQID",
		"salt": "UEtleQECAwQ",
		"timestamp": "1699999995000",
		"teamPlayerId": "T:transcript-team-player-1",
		"bundleId": "com.acme.mac",
	}


func run(t: PKeyTestContext) -> void:
	var f := fields()
	t.check("gc1: the golden token (the Swift one)", PKeyGameCenterToken.encode(f) == GOLDEN)
	t.check("gc1: seven dot-joined parts, the prefix first", GOLDEN.split(".").size() == 7 and PKeyGameCenterToken.encode(f).begins_with("gc1."))
	var as_float := f.duplicate()
	as_float["timestamp"] = 1699999995000.0
	var as_int := f.duplicate()
	as_int["timestamp"] = 1699999995000
	t.check("gc1: a numeric timestamp (JSON float or int) is the same decimal", PKeyGameCenterToken.encode(as_float) == GOLDEN and PKeyGameCenterToken.encode(as_int) == GOLDEN)
	var unicode := f.duplicate()
	unicode["teamPlayerId"] = "T:Zoë"
	var token := PKeyGameCenterToken.encode(unicode)
	t.check("gc1: strings are UTF-8 then base64url", token != "" and PKeyB64Url.decode_strict(token.split(".")[5]).get_string_from_utf8() == "T:Zoë")
	for key in f.keys():
		var missing := f.duplicate()
		missing.erase(key)
		var empty := f.duplicate()
		empty[key] = ""
		t.check("gc1: %s missing or empty is refused" % key, PKeyGameCenterToken.encode(missing) == "" and PKeyGameCenterToken.encode(empty) == "")
	var padded := f.duplicate()
	padded["signature"] = "AQID="
	var standard := f.duplicate()
	standard["salt"] = "UEtl+QECAwQ"
	var loose := f.duplicate()
	loose["signature"] = "AQJ"
	var refused := [padded, standard, loose].all(func(g): return PKeyGameCenterToken.encode(g) == "")
	t.check("gc1: a padded, standard-alphabet or non-canonical signature or salt is refused", refused)
	for bad in ["-1", "+5", "01", "1.5", "abc", " 5", "5 "]:
		var g := f.duplicate()
		g["timestamp"] = bad
		t.check("gc1: timestamp '%s' is refused" % bad, PKeyGameCenterToken.encode(g) == "")
	var neg := f.duplicate()
	neg["timestamp"] = -5
	var frac := f.duplicate()
	frac["timestamp"] = 1.5
	t.check("gc1: a negative or fractional numeric timestamp is refused", PKeyGameCenterToken.encode(neg) == "" and PKeyGameCenterToken.encode(frac) == "")
	var zero := f.duplicate()
	zero["timestamp"] = "0"
	t.check("gc1: zero is a timestamp", PKeyGameCenterToken.encode(zero).split(".")[4] == "0")
	var big := f.duplicate()
	big["signature"] = PKeyB64Url.encode(PackedByteArray([7]).duplicate() + _bytes(4000))
	t.check("gc1: a token over 4096 characters is refused", PKeyGameCenterToken.encode(big) == "")
	var wrong_type := f.duplicate()
	wrong_type["bundleId"] = 5
	t.check("gc1: a non-string field is refused", PKeyGameCenterToken.encode(wrong_type) == "")


static func _bytes(n: int) -> PackedByteArray:
	var out := PackedByteArray()
	out.resize(n)
	out.fill(7)
	return out
