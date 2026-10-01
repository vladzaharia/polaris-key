# S-04 low-end wrapper. Runs a fixed list with no command line (phones have none):
#   1. correctness: SHA-512 (24), Ed25519 (26, fast and sliced), corpus v2 jwsCases (36),
#      raw corpus signatures (68), content vectors (75, small set);
#   2. timings, interleaved: one warm-up round, then ROUNDS measured rounds, each running every
#      metric once (phones throttle, so a metric is never looped on its own);
#   3. the frame-time probe: a spinner keeps turning while a bundle-sized verify runs on the main
#      thread, on WorkerThreadPool, and sliced across frames.
# Writes user://results.json, prints it on one line prefixed "S04RESULT ", and on web POSTs it to
# /results/<tag> on the page's origin (lowend/browser/server.mjs's sibling endpoint).
# Optional user args (desktop only): rounds=<n> large=0|1 quit=0|1 probe_reps=<n>
extends Node2D

var ROUNDS := 5
var PROBE_REPS := 3
var use_large := true
var quit_at_end := false

var R := {}
var status: Label
var spinner: Node2D
var frame_log := PackedInt64Array()
var recording := false
var benchv := []
var next_seq := 0


## ContentRunner numbers its mounted PCK paths per instance; a second instance would reuse a path that
## an earlier instance already mounted (with a different base), so every core gets its own range.
func new_core(root: String) -> PKLowendContent:
	var core := PKLowendContent.new()
	core.vroot = root
	core.seq = next_seq
	next_seq += 1000000
	return core


func _ready() -> void:
	status = $Status
	spinner = $Spinner
	for a in OS.get_cmdline_user_args():
		var kv := a.split("=")
		if kv.size() != 2:
			continue
		match kv[0]:
			"rounds": ROUNDS = int(kv[1])
			"large": use_large = kv[1] == "1"
			"quit": quit_at_end = kv[1] == "1"
			"probe_reps": PROBE_REPS = int(kv[1])
	if DisplayServer.get_name() == "headless":
		quit_at_end = true
	Engine.max_fps = 60 if DisplayServer.get_name() == "headless" else 0
	await get_tree().process_frame
	await run_all()


func _process(delta: float) -> void:
	spinner.rotation += delta * 4.0
	if recording:
		frame_log.append(Time.get_ticks_usec())


func say(s: String) -> void:
	status.text = s
	print("[s04] ", s)


func run_all() -> void:
	var t_all := Time.get_ticks_msec()
	R.env = env()
	say("env: %s" % JSON.stringify(R.env))
	PKEd25519Fast.warmup()
	benchv = JSON.parse_string(FileAccess.get_file_as_string("res://vectors/ed25519_bench.json"))
	for v in benchv:
		v.pk_b = String(v.pk).hex_decode()
		v.sig_b = String(v.sig).hex_decode()
		v.msg_b = String(v.signingInput).to_ascii_buffer()
	await frame()
	R.correctness = await correctness()
	say("correctness: %s" % JSON.stringify(R.correctness.summary))
	R.timings = await timings("small")
	if use_large and FileAccess.file_exists("res://vectors/large/cases.json"):
		R.timings_large = await timings("large")
	R.frame_probe = await frame_probe()
	R.total_s = (Time.get_ticks_msec() - t_all) / 1000.0
	var js := JSON.stringify(R)
	var f := FileAccess.open("user://results.json", FileAccess.WRITE)
	f.store_string(js)
	f.close()
	if OS.has_feature("mobile"):
		# Android logs cut a line near 1 KB and a release APK cannot be run-as'd, so collect.sh
		# reassembles these chunks.
		var n := ceili(js.length() / 800.0)
		for i in n:
			print("S04CHUNK %d/%d %s" % [i, n, js.substr(i * 800, 800)])
	else:
		print("S04RESULT ", js)
	say("done in %.0f s; results in %s" % [R.total_s, ProjectSettings.globalize_path("user://results.json")])
	if OS.has_feature("web"):
		var tag := "godot-web"
		JavaScriptBridge.eval("fetch('/results/' + %s + '?ua=' + encodeURIComponent(navigator.userAgent), {method: 'POST', body: %s}).then(r => console.log('posted', r.status))" % [JSON.stringify(tag), JSON.stringify(js)])
	if quit_at_end:
		await frame()
		get_tree().quit(0 if R.correctness.summary.all_pass else 1)


func frame() -> void:
	await get_tree().process_frame


func env() -> Dictionary:
	var e := {
		"os": OS.get_name(), "os_version": OS.get_version(), "distribution": OS.get_distribution_name(),
		"model": OS.get_model_name(), "processor": OS.get_processor_name(), "cores": OS.get_processor_count(),
		"memory": OS.get_memory_info(), "engine": Engine.get_version_info().string,
		"arch": Engine.get_architecture_name(), "debug_build": OS.is_debug_build(),
		"threads": OS.has_feature("threads"), "display": DisplayServer.get_name(),
		"renderer": RenderingServer.get_video_adapter_name(), "rounds": ROUNDS,
	}
	if OS.has_feature("web"):
		e.user_agent = JavaScriptBridge.eval("navigator.userAgent")
		e.hardware_concurrency = JavaScriptBridge.eval("navigator.hardwareConcurrency")
	return e


# ------------------------------------------------------------------ correctness

func correctness() -> Dictionary:
	var out := {}
	var fails := []
	# SHA-512
	var ok := 0
	var sv = JSON.parse_string(FileAccess.get_file_as_string("res://vectors/sha512.json"))
	for c in sv:
		if PKSha512.hash(String(c.msg).hex_decode()).hex_encode() == c.sha512:
			ok += 1
		else:
			fails.append("sha512/len=%d" % (String(c.msg).length() / 2))
	out.sha512 = "%d/%d" % [ok, sv.size()]
	await frame()
	# Ed25519, fast and sliced
	var ev = JSON.parse_string(FileAccess.get_file_as_string("res://vectors/ed25519.json"))
	var okf := 0
	var oks := 0
	var sl := PKLowendSliced.new(get_tree(), 1000.0)
	for c in ev:
		var sig: PackedByteArray = String(c.sig).hex_decode()
		var msg: PackedByteArray = String(c.msg).hex_decode()
		var pk: PackedByteArray = String(c.pk).hex_decode()
		if PKEd25519Fast.verify(sig, msg, pk) == bool(c.expect):
			okf += 1
		else:
			fails.append("ed25519-fast/" + c.name)
		if (await sl.verify(sig, msg, pk)) == bool(c.expect):
			oks += 1
		else:
			fails.append("ed25519-sliced/" + c.name)
	out.ed25519_fast = "%d/%d" % [okf, ev.size()]
	out.ed25519_sliced = "%d/%d" % [oks, ev.size()]
	await frame()
	# Corpus v2 jwsCases through the full PKJws pipeline
	var jv = JSON.parse_string(FileAccess.get_file_as_string("res://vectors/corpus_jws.json"))
	ok = 0
	for c in jv:
		var r = PKJws.verify(c.jws, c.trust, c.typ, int(c.maxPayloadBytes), true)
		var got := "ok" if r != null else "fail"
		if got == c.expect and (r == null or c.kid == null or r.kid == c.kid):
			ok += 1
		else:
			fails.append("jws/" + c.id)
	out.jws_cases = "%d/%d" % [ok, jv.size()]
	await frame()
	# Raw Ed25519 over every distinct corpus JWS, Node/OpenSSL verdict as oracle; sliced too
	var cs = JSON.parse_string(FileAccess.get_file_as_string("res://vectors/corpus_sigs.json"))
	ok = 0
	oks = 0
	for s in cs:
		var msg: PackedByteArray = String(s.signingInput).to_ascii_buffer()
		var sig: PackedByteArray = String(s.sig).hex_decode()
		var pk: PackedByteArray = String(s.pk).hex_decode()
		if PKEd25519Fast.verify(sig, msg, pk) == bool(s.expect):
			ok += 1
		else:
			fails.append("sig-fast/%s/%d" % [s.typ, msg.size()])
		if (await sl.verify(sig, msg, pk)) == bool(s.expect):
			oks += 1
		else:
			fails.append("sig-sliced/%s/%d" % [s.typ, msg.size()])
	out.corpus_sigs_fast = "%d/%d" % [ok, cs.size()]
	out.corpus_sigs_sliced = "%d/%d" % [oks, cs.size()]
	await frame()
	# Content vectors (small set), same loop as ContentRunner._init
	var cc := content_cases("res://vectors/small")
	out.content = "%d/%d" % [cc.pass, cc.n]
	fails.append_array(cc.fails)
	out.fails = fails
	out.summary = {"all_pass": fails.is_empty(), "sha512": out.sha512, "ed25519": out.ed25519_fast,
		"ed25519_sliced": out.ed25519_sliced, "jws": out.jws_cases, "sigs": out.corpus_sigs_fast,
		"content": out.content, "fails": fails.size()}
	return out


func content_cases(root: String) -> Dictionary:
	var core := new_core(root)
	DirAccess.make_dir_recursive_absolute("user://xl")
	var doc = JSON.parse_string(FileAccess.get_file_as_string(root.path_join("cases.json")))
	var fails := []
	for name in doc.blobs:
		if core.sha(core.raw(name)) != doc.blobs[name].sha256:
			fails.append("integrity/" + name)
	var n := 0
	for g in ["chunkIndexCases", "applyCases", "planCases", "pathCases"]:
		for c in doc[g]:
			var got
			match g:
				"chunkIndexCases":
					core.err = {}
					var ix: Dictionary = core.parse_index(core.raw_mut(c.index))
					got = core.err if core.err else core.summary(ix)
				"applyCases":
					got = core.apply_case(c)
				"planCases":
					got = core.plan(c.input)
				_:
					got = core.check_paths(c.paths)
			n += 1
			if PKLowendContent.canon(got) != PKLowendContent.canon(c.expected):
				fails.append("content/%s/%s" % [g, c.id])
	return {"n": n, "pass": n - fails.size(), "fails": fails}


# ------------------------------------------------------------------ timings

func ms(t0: int) -> float:
	return (Time.get_ticks_usec() - t0) / 1000.0


func stats(xs: Array) -> Dictionary:
	var s := xs.duplicate()
	s.sort()
	var med: float = s[s.size() / 2] if s.size() % 2 == 1 else (s[s.size() / 2 - 1] + s[s.size() / 2]) / 2.0
	return {"median": snappedf(med, 0.01), "best": snappedf(s[0], 0.01), "worst": snappedf(s[-1], 0.01), "n": s.size(), "runs": xs.map(func(x): return snappedf(x, 0.01))}


func timings(set_name: String) -> Dictionary:
	var root := "res://vectors/" + set_name
	var core := new_core(root)
	var doc = JSON.parse_string(FileAccess.get_file_as_string(root.path_join("cases.json")))
	var n2 := int(doc.payloads.v2.size)
	var n1 := int(doc.payloads.v1.size)
	var cases := {}
	for c in doc.applyCases:
		cases[c.id] = c
	for c in doc.planCases:
		cases[c.id] = c
	# Both sets ship v1 as the full-payload blob; v2 is only reachable by chunk, delta or file apply.
	var full1: PackedByteArray = core.raw("payload/v1.full.zst")
	var dcase: Dictionary = cases["delta-whole-v1-to-v2"]
	var v1: PackedByteArray = core.mat(dcase.base)
	var art: PackedByteArray = core.raw(dcase.delta.artifact.blob)
	var tix: PackedByteArray = core.raw("chunks/v2.pkc")
	var sha512_in := PackedByteArray()
	sha512_in.resize(262144)
	# Each metric returns ms for one run.
	var m := {}
	if set_name == "small":
		for v in benchv:
			var vv: Dictionary = v
			m["ed25519_" + vv.name] = func() -> float:
				var t := Time.get_ticks_usec()
				var okv := PKEd25519Fast.verify(vv.sig_b, vv.msg_b, vv.pk_b)
				var dt := ms(t)
				assert(okv)
				return dt if okv else -1.0
		m.sha512_gdscript_256KiB = func() -> float:
			var t := Time.get_ticks_usec(); PKSha512.hash(sha512_in); return ms(t)
	m.sha256_engine_stream = func() -> float:
		var t := Time.get_ticks_usec()
		var h := HashingContext.new(); h.start(HashingContext.HASH_SHA256)
		var o := 0
		while o < v1.size():
			h.update(v1.slice(o, o + (1 << 20))); o += 1 << 20
		h.finish()
		return ms(t)
	m.zstd_decode_full = func() -> float:
		var t := Time.get_ticks_usec(); var o := core.zstd(full1, n1); var dt := ms(t); return dt if o.size() == n1 else -1.0
	m.content_full_apply = func() -> float:
		var t := Time.get_ticks_usec(); var r: Dictionary = core.apply_case(cases["full-v1"]); var dt := ms(t); return dt if r.get("ok") else -1.0
	m.content_chunk_sync = func() -> float:
		core.err = {}
		var t := Time.get_ticks_usec(); var r: Dictionary = core.apply_chunk(cases["chunk-v1-to-v2"]); var dt := ms(t); return dt if r.get("ok") else -1.0
	m.content_delta_verified = func() -> float:
		core.err = {}
		var t := Time.get_ticks_usec(); core.apply_delta(v1, dcase.delta, art, false); var dt := ms(t); return dt if core.err.is_empty() else -1.0
	m.content_delta_engine_decode = func() -> float:
		var t := Time.get_ticks_usec(); core.patch_from(v1, art); return ms(t)
	m.content_file_rebuild = func() -> float:
		core.err = {}
		var t := Time.get_ticks_usec(); var r: Dictionary = core.apply_files(cases["file-delta-v1-to-v2"]); var dt := ms(t); return dt if r.get("ok") else -1.0
	m.parse_chunk_index = func() -> float:
		core.err = {}
		var t := Time.get_ticks_usec(); core.parse_index(tix); return ms(t)
	m.plan_real_case = func() -> float:
		var t := Time.get_ticks_usec(); core.plan(cases["plan-real-v1-v2"].input); return ms(t)
	var runs := {}
	for k in m:
		runs[k] = []
	var rounds := ROUNDS if set_name == "small" else maxi(3, ROUNDS - 2)
	for rnd in rounds + 1:
		say("%s timings round %d/%d" % [set_name, rnd, rounds])
		for k in m:
			var dt: float = m[k].call()
			if rnd > 0:
				runs[k].append(dt)
			await frame()
	var out := {"set": set_name, "v2_bytes": n2, "v1_bytes": v1.size(), "full_zstd_bytes": full1.size(), "delta_bytes": art.size()}
	for k in runs:
		out[k] = stats(runs[k])
	# Throughput (MB/s of output) from the best and median runs.
	var mbps := {}
	var bytes_of := {"sha256_engine_stream": n1, "zstd_decode_full": n1, "content_full_apply": n1,
		"content_chunk_sync": n2, "content_delta_verified": n2, "content_delta_engine_decode": n2, "content_file_rebuild": n2,
		"sha512_gdscript_256KiB": 262144}
	for k in bytes_of:
		if out.has(k) and out[k].best > 0:
			mbps[k] = {"median": snappedf(bytes_of[k] / 1e6 / (out[k].median / 1e3), 0.1), "best": snappedf(bytes_of[k] / 1e6 / (out[k].best / 1e3), 0.1)}
	out.MBps = mbps
	return out


# ------------------------------------------------------------------ frame-time probe

func frames_begin() -> void:
	frame_log.clear()
	recording = true


func frames_end() -> Dictionary:
	recording = false
	var gaps := []
	for i in range(1, frame_log.size()):
		gaps.append((frame_log[i] - frame_log[i - 1]) / 1000.0)
	if gaps.is_empty():
		return {"frames": 0}
	var s := gaps.duplicate()
	s.sort()
	var over := func(lim: float) -> int: return s.filter(func(x): return x > lim).size()
	return {"frames": gaps.size(), "max_ms": snappedf(s[-1], 0.01), "p50_ms": snappedf(s[s.size() / 2], 0.01),
		"p95_ms": snappedf(s[int(s.size() * 0.95)], 0.01), "over_20ms": over.call(20.0), "over_33ms": over.call(33.4), "over_50ms": over.call(50.0)}


func probe_once(mode: String, v: Dictionary) -> Dictionary:
	frames_begin()
	for i in 10:
		await frame()
	var t := Time.get_ticks_usec()
	var okv := false
	var extra := {}
	match mode:
		"idle":
			for i in 30:
				await frame()
			okv = true
		"main":
			okv = PKEd25519Fast.verify(v.sig_b, v.msg_b, v.pk_b)
		"pool":
			var box := [false]
			var tid := WorkerThreadPool.add_task(func(): box[0] = PKEd25519Fast.verify(v.sig_b, v.msg_b, v.pk_b), true, "s04 verify")
			var waited := 0
			while not WorkerThreadPool.is_task_completed(tid):
				await frame()
				waited += 1
			WorkerThreadPool.wait_for_task_completion(tid)
			okv = box[0]
			extra.frames_while_running = waited
		"sliced4", "sliced8":
			var sl := PKLowendSliced.new(get_tree(), 4.0 if mode == "sliced4" else 8.0)
			okv = await sl.verify(v.sig_b, v.msg_b, v.pk_b)
			extra.yields = sl.yields
	var wall := ms(t)
	for i in 10:
		await frame()
	var f := frames_end()
	f.merge(extra)
	f.wall_ms = snappedf(wall, 0.01)
	f.ok = okv
	return f


func frame_probe() -> Dictionary:
	var out := {"max_fps": Engine.max_fps, "note": "gaps are _process-to-_process intervals; 'main' blocks one frame"}
	var modes := ["idle", "main", "pool", "sliced4", "sliced8"]
	for vi in [1, 2]:  # payload87k, bundle350k
		var v: Dictionary = benchv[vi]
		var per := {}
		for mode in modes:
			per[mode] = []
		for rep in PROBE_REPS:
			for mode in modes:  # interleaved
				if vi == 1 and mode == "idle" and rep > 0:
					continue
				say("frame probe %s %s rep %d" % [v.name, mode, rep])
				per[mode].append(await probe_once(mode, v))
		out[v.name] = per
	return out
