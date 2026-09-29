extends RefCounted
# args: fast|ref

static func canon(v) -> String:
	match typeof(v):
		TYPE_NIL: return "N"
		TYPE_BOOL: return "T" if v else "F"
		TYPE_INT: return "n" + str(v)
		TYPE_FLOAT: return "n" + str(int(v))
		TYPE_STRING: return "s" + String(v).to_utf8_buffer().hex_encode()
		TYPE_ARRAY:
			var parts := PackedStringArray()
			for x in v: parts.append(canon(x))
			return "[" + ",".join(parts) + "]"
		TYPE_DICTIONARY:
			var ks := []
			for k in v.keys(): ks.append([String(k).to_utf8_buffer().hex_encode(), k])
			ks.sort_custom(func(a, b): return a[0] < b[0])
			var parts := PackedStringArray()
			for e in ks: parts.append(e[0] + ":" + canon(v[e[1]]))
			return "{" + ",".join(parts) + "}"
	return "?"


func run(args: PackedStringArray) -> void:
	var fast: bool = args.size() == 0 or args[0] != "ref"
	var tag := "fast" if fast else "ref"
	PKEd25519Fast.warmup()
	# --- 1. full verifyJws pipeline over corpus v2 jwsCases
	var cases = JSON.parse_string(FileAccess.get_file_as_string("res://vectors/corpus_jws.json"))
	var pass_n := 0
	var doc_mismatch := []
	for c in cases:
		var t0 := Time.get_ticks_usec()
		var r = PKJws.verify(c.jws, c.trust, c.typ, int(c.maxPayloadBytes), fast)
		var dt := (Time.get_ticks_usec() - t0) / 1000.0
		var got := "ok" if r != null else "fail"
		var ok: bool = got == c.expect
		var note := ""
		if ok and r != null:
			if c.kid != null and r.kid != c.kid:
				ok = false; note = "kid mismatch"
			elif c.docCanon != null and canon(r.payload) != c.docCanon:
				note = "DOC DIFFERS"
				doc_mismatch.append(c.id)
		if ok: pass_n += 1
		print("%-4s %-34s expect=%-4s got=%-4s %8.2f ms %s" % ["PASS" if ok else "FAIL", c.id, c.expect, got, dt, note])
	print("[%s] corpus v2 jwsCases verdicts: %d/%d match; decoded-doc mismatches: %s" % [tag, pass_n, cases.size(), doc_mismatch])
	# --- 2. raw Ed25519 over every distinct JWS in cases.json (Node/OpenSSL verdict as oracle)
	var sigs = JSON.parse_string(FileAccess.get_file_as_string("res://vectors/corpus_sigs.json"))
	var agree := 0
	var total_ms := 0.0
	var worst := 0.0
	for s in sigs:
		var t0 := Time.get_ticks_usec()
		var msg: PackedByteArray = String(s.signingInput).to_ascii_buffer()
		var v: bool
		if fast:
			v = PKEd25519Fast.verify(String(s.sig).hex_decode(), msg, String(s.pk).hex_decode())
		else:
			v = PKEd25519Ref.verify(String(s.sig).hex_decode(), msg, String(s.pk).hex_decode())
		var dt := (Time.get_ticks_usec() - t0) / 1000.0
		total_ms += dt
		if dt > worst: worst = dt
		if v == bool(s.expect): agree += 1
		else: print("DISAGREE kid=%s typ=%s len=%d node=%s gd=%s" % [s.kid, s.typ, msg.size(), s.expect, v])
	print("[%s] raw Ed25519 over %d distinct corpus JWS: %d agree with Node/OpenSSL; mean %.2f ms, worst %.2f ms (largest signing input)" % [tag, sigs.size(), agree, total_ms / sigs.size(), worst])
