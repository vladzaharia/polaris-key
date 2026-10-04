class_name PKeyPackSelect
extends RefCounted
## Variant selection, target mapping and the install planner (plans/P4-01.md §2.9; notes/A7 §4.2;
## WIRE-CONTRACT-V4 §11.4): a port of client-core `packs/select.ts` and `plan.ts`.
## `plan-matrix.json` pins `select_variant` (variantCases), `plan_target` (targetCases) and `plan`
## (rows). Pure integer functions over Dictionaries; they return verdicts and never fail.
##
##   select_variant(variants, prefs)     {index} or {error: "pack-no-variant"}; prefs {engine, axes}
##   plan_target(variant, record_sha256, files_index)   the planner's target (A7 §4.1)
##   plan(input)                         the chosen candidate with peakDisk and fallbacks, a
##                                       platform answer, or {error: plan-*}

const PLAN_TRANSPORT_UNSUPPORTED := "plan-transport-unsupported"
const PLAN_INSUFFICIENT_DISK := "plan-insufficient-disk"
const PLAN_NO_STRATEGY := "plan-no-strategy"
const PACK_NO_VARIANT := "pack-no-variant"


## An object ref is usable when its codec is `zstd` or `none` (§2.9).
static func usable_codec(codec: Variant) -> bool:
	return codec is String and (codec == "zstd" or codec == "none")


## The index is readable when `files.format` is `pkey-files/1`, its ref usable and `files.size`
## at most MAX_FILES_INDEX_BYTES.
static func index_readable(files: Variant) -> bool:
	return files is Dictionary and PKeyPackClaims.same(files.get("format"), PKeyConstants.FILES_FORMAT) and usable_codec(files.get("codec")) and PKeyClaims.is_number(files.get("size")) and float(files["size"]) <= float(PKeyConstants.MAX_FILES_INDEX_BYTES)


## A container's index and gaps together are rebuildable: a readable index and a usable gaps ref.
## A tree needs only the readable index.
static func index_rebuildable(files: Variant) -> bool:
	if not index_readable(files):
		return false
	if not PKeyPackClaims.same(files.get("layout"), "container"):
		return true
	return files.get("gaps") is Dictionary and usable_codec(files["gaps"].get("codec"))


## A variant is usable when its layout is `container`, or `tree` with a readable index.
static func variant_usable(variant: Variant) -> bool:
	if not (variant is Dictionary) or not (variant.get("files") is Dictionary):
		return false
	var layout = variant["files"].get("layout")
	if PKeyPackClaims.same(layout, "container"):
		return true
	return PKeyPackClaims.same(layout, "tree") and index_readable(variant["files"])


## `selectVariant` (§2.9): eligible when usable, `requires.engine` absent or equal to the host's
## `engine`, and every declared axis has a host preference list containing its value. The lowest
## tuple of preference indexes over the axis names in byte order wins; ties keep the earlier one.
static func select_variant(variants: Variant, prefs: Dictionary) -> Dictionary:
	var best_index := -1
	var best_key: Array = []
	if variants is Array:
		var axes = prefs.get("axes", {})
		for i in variants.size():
			var v = variants[i]
			if not variant_usable(v):
				continue
			var req = v.get("requires")
			if req is Dictionary and req.has("engine") and not PKeyPackClaims.same(req["engine"], prefs.get("engine")):
				continue
			var sel: Dictionary = v["variant"] if v.get("variant") is Dictionary else {}
			var names: Array = sel.keys()
			names.sort_custom(func(a, b): return PKeyPackClaims.compare_bytes(String(a), String(b)) < 0)
			var key: Array = []
			var eligible := true
			for axis in names:
				var list = axes.get(axis) if axes is Dictionary else null
				var k: int = list.find(sel[axis]) if list is Array else -1
				if k < 0:
					eligible = false
					break
				key.append(k)
			if not eligible:
				continue
			if best_index < 0 or _lex_less(key, best_key):
				best_index = i
				best_key = key
	if best_index < 0:
		return {"error": PACK_NO_VARIANT}
	return {"index": best_index}


static func _lex_less(x: Array, y: Array) -> bool:
	for j in x.size():
		if x[j] != y[j]:
			return x[j] < y[j]
	return false


## `planTarget(variant, recordSha256, filesIndex)` (§2.9): a variant onto the planner's input. An
## unusable variant maps to no candidate at all. `full` needs a usable ref whose size is the
## payload's (a tree's costs its index too, in two requests); `files` needs the index, a readable
## one (a container: rebuildable); a `payload` delta is kept on a container, a `files` delta when
## `files` is kept and its `patch` ref is usable.
static func plan_target(variant: Dictionary, record_sha256: String, files_index: Variant, chunk_index: Variant = null) -> Dictionary:
	var payload = variant.get("payload")
	if not variant_usable(variant):
		return {"release": record_sha256, "payload": payload, "full": null, "platform": null, "chunks": null, "files": null, "deltas": []}
	var files: Dictionary = variant["files"]
	var container: bool = PKeyPackClaims.same(files["layout"], "container")
	var full = variant.get("full")
	var full_t = null
	if full is Dictionary and usable_codec(full.get("codec")) and PKeyClaims.is_number(full.get("size")) and float(full["size"]) == float(payload["size"]):
		if container:
			full_t = {"bytes": full["bytes"], "requests": 1}
		else:
			full_t = {"bytes": float(full["bytes"]) + float(files["bytes"]), "requests": 2}
	var files_t = null
	if files_index is Dictionary and index_rebuildable(files):
		var list: Array = []
		for f in files_index["files"]:
			list.append({"sha256": f["sha256"], "blobBytes": f["blob"]["bytes"]})
		files_t = {"indexBytes": files["bytes"], "gapsBytes": files["gaps"]["bytes"] if container else 0, "files": list}
	var deltas: Array = []
	var vd = variant.get("deltas", [])
	for d in (vd if vd is Array else []):
		if PKeyPackClaims.same(d.get("scope"), "payload") and container:
			deltas.append({
				"id": d["artifact"]["sha256"], "method": d["method"], "from": d["from"], "memBytes": d["memBytes"],
				"artifacts": [{"sha256": d["artifact"]["sha256"], "bytes": d["artifact"]["bytes"]}],
			})
		elif PKeyPackClaims.same(d.get("scope"), "files") and files_t != null and d.get("patch") is Dictionary and usable_codec(d["patch"].get("codec")):
			var arts: Array = [{"sha256": files["sha256"], "bytes": files["bytes"]}]
			if container:
				arts.append({"sha256": files["gaps"]["sha256"], "bytes": files["gaps"]["bytes"]})
			arts.append({"sha256": d["patch"]["sha256"], "bytes": d["patch"]["bytes"]})
			arts.append({"sha256": d["data"]["sha256"], "bytes": d["data"]["bytes"]})
			deltas.append({"id": d["patch"]["sha256"], "method": d["method"], "from": d["from"], "memBytes": d["memBytes"], "artifacts": arts})
	return {"release": record_sha256, "payload": payload, "full": full_t, "platform": null, "chunks": _chunk_target(variant, chunk_index), "files": files_t, "deltas": deltas}


## plans/P4-10.md §2.5 (client-core's `chunkTarget`): {indexBytes: chunks.bytes, records} when
## the variant is a usable container, `chunks.format` is pkey-chunks/1, its codec is usable,
## `chunks.size` is at most MAX_CHUNK_INDEX_BYTES, the parsed index is given and bound to the
## payload, and no record's length exceeds MAX_CHUNK_BYTES; null otherwise. Godot's chunk parser
## and applier are P4-11's, so production passes no index yet and this answers null.
static func _chunk_target(variant: Dictionary, chunk_index: Variant) -> Variant:
	var c = variant.get("chunks")
	if not (chunk_index is Dictionary) or not (c is Dictionary):
		return null
	if not PKeyPackClaims.same(variant["files"].get("layout"), "container"):
		return null
	if not PKeyPackClaims.same(c.get("format"), PKeyConstants.CHUNKS_FORMAT) or not usable_codec(c.get("codec")):
		return null
	if not PKeyClaims.is_number(c.get("size")) or float(c["size"]) > float(PKeyConstants.MAX_CHUNK_INDEX_BYTES):
		return null
	if not PKeyClaims.is_number(c.get("bytes")):
		return null
	var payload: Dictionary = variant["payload"]
	if not PKeyPackClaims.same(chunk_index.get("payloadSize"), payload.get("size")) or not PKeyPackClaims.same(chunk_index.get("payloadSha256"), payload.get("sha256")):
		return null
	var records: Array = []
	for r in chunk_index.get("records", []):
		if float(r[1]) > float(PKeyConstants.MAX_CHUNK_BYTES):
			return null
		records.append([r[0], r[1], r[2], r[3], r[4]])
	return {"indexBytes": c["bytes"], "records": records}


## The strategies in the rank that breaks a cost tie (`full` is always last).
static func _rank(strategy: String) -> int:
	match strategy:
		"noop":
			return 0
		"platform":
			return 1
		"delta":
			return 2
		"chunk":
			return 3
		"file":
			return 4
		"full":
			return 5
	return 6


static func _has(list: Variant, v: Variant) -> bool:
	return list is Array and list.has(v)


## `plan(input)` (§2.9, A7 §4.2): `noop` when a release with the target payload is installed; a
## platform-bound target takes `platform` when the host lists its transport, else
## `plan-transport-unsupported`. Otherwise every allowed, feasible candidate is costed (`bytes +
## requestWeight × requests`), with `peakDisk` = payload size + bytes: each delta whose method
## the host lists, whose base is installed and whose `memBytes` fits `memBudget`; `chunk` from the
## installed seeds; `file` from the installed files indexes; `full` whenever the target has one.
## Candidates over `freeDisk` drop. The cheapest wins (ties: rank, then record order); the rest
## are fallbacks in cost order with `full` moved last. Integers stay exact up to 2^53.
static func plan(input: Dictionary) -> Dictionary:
	var t: Dictionary = input["target"]
	var inst: Array = input.get("installed", [])
	var caps: Dictionary = input.get("caps", {})
	for i in inst:
		if PKeyPackClaims.same(i.get("payloadSha256"), t["payload"]["sha256"]):
			return {"strategy": "noop", "bytes": 0, "requests": 0, "cost": 0, "peakDisk": 0, "fallbacks": []}
	if t.get("platform") is Dictionary:
		if _has(caps.get("transports", []), t["platform"].get("transport")):
			return {"strategy": "platform", "transport": t["platform"]["transport"], "fallbacks": []}
		return {"error": PLAN_TRANSPORT_UNSUPPORTED}
	var strategies = caps.get("strategies", [])
	var have := {}
	for i in inst:
		have[i.get("payloadSha256")] = true
	var cands: Array = []

	if _has(strategies, "delta"):
		var deltas = t.get("deltas", [])
		var k := 0
		for d in (deltas if deltas is Array else []):
			if _has(caps.get("patchMethods", []), d["method"]) and have.has(d["from"]) and float(d["memBytes"]) <= float(caps.get("memBudget", 0)):
				var b := 0
				for a in d["artifacts"]:
					b += int(a["bytes"])
				cands.append({"strategy": "delta", "delta": d["id"], "bytes": b, "requests": (d["artifacts"] as Array).size(), "ord": k})
			k += 1

	var seeds: Array = []
	for i in inst:
		if i.get("chunks") is Dictionary:
			seeds.append(i["chunks"])
	if _has(strategies, "chunk") and t.get("chunks") is Dictionary and not seeds.is_empty():
		var seeded := {}
		for s in seeds:
			for id in s.get("ids", []):
				seeded[id] = true
		var seen := {}
		var prev = null
		var runs := 0
		var bytes := int(t["chunks"]["indexBytes"])
		for r in t["chunks"]["records"]:
			var id = r[0]
			if seeded.has(id) or seen.has(id):
				continue
			seen[id] = true
			bytes += int(r[2])
			if prev == null or int(r[3]) != int(prev[3]) or int(r[4]) != int(prev[4]) + int(prev[2]):
				runs += 1
			prev = r
		cands.append({"strategy": "chunk", "bytes": bytes, "requests": 1 + runs, "ord": 0})

	var with_files: Array = []
	for i in inst:
		if i.get("files") is Array:
			with_files.append(i)
	if _has(strategies, "file") and t.get("files") is Dictionary and not with_files.is_empty():
		var held := {}
		for i in with_files:
			for x in i["files"]:
				held[x] = true
		var missing := {}
		var sum := 0
		for f in t["files"]["files"]:
			if not held.has(f["sha256"]) and not missing.has(f["sha256"]):
				missing[f["sha256"]] = true
				sum += int(f["blobBytes"])
		var gaps_bytes := int(t["files"]["gapsBytes"])
		cands.append({
			"strategy": "file",
			"bytes": int(t["files"]["indexBytes"]) + gaps_bytes + sum,
			"requests": 1 + (1 if gaps_bytes > 0 else 0) + missing.size(),
			"ord": 0,
		})

	if t.get("full") is Dictionary:
		cands.append({"strategy": "full", "bytes": int(t["full"]["bytes"]), "requests": int(t["full"].get("requests", 1)) if t["full"].get("requests") != null else 1, "ord": 0})

	if cands.is_empty():
		return {"error": PLAN_NO_STRATEGY}
	var w := int(caps["requestWeight"]) if PKeyClaims.is_number(caps.get("requestWeight")) else PKeyConstants.PLAN_REQUEST_WEIGHT
	var size := int(t["payload"]["size"])
	var free := float(caps.get("freeDisk", 0)) if PKeyClaims.is_number(caps.get("freeDisk")) else 0.0
	var feasible: Array = []
	for c in cands:
		c["cost"] = int(c["bytes"]) + w * int(c["requests"])
		c["peakDisk"] = size + int(c["bytes"])
		if float(c["peakDisk"]) <= free:
			feasible.append(c)
	if feasible.is_empty():
		return {"error": PLAN_INSUFFICIENT_DISK}
	feasible.sort_custom(func(a, b):
		if a["cost"] != b["cost"]:
			return a["cost"] < b["cost"]
		if _rank(a["strategy"]) != _rank(b["strategy"]):
			return _rank(a["strategy"]) < _rank(b["strategy"])
		return a["ord"] < b["ord"])
	var chosen: Dictionary = feasible[0]
	var ordered: Array = []
	for c in feasible.slice(1):
		if c["strategy"] != "full":
			ordered.append(_publish(c))
	for c in feasible.slice(1):
		if c["strategy"] == "full":
			ordered.append(_publish(c))
	var out := _publish(chosen)
	out["peakDisk"] = chosen["peakDisk"]
	out["fallbacks"] = ordered
	return out


static func _publish(c: Dictionary) -> Dictionary:
	var out := {"strategy": c["strategy"]}
	if c.has("delta"):
		out["delta"] = c["delta"]
	out["bytes"] = c["bytes"]
	out["requests"] = c["requests"]
	out["cost"] = c["cost"]
	return out


## A delta's id: a `payload` delta's `artifact.sha256`, a `files` delta's `patch.sha256`; null
## for anything else.
static func delta_id(d: Variant) -> Variant:
	if not (d is Dictionary):
		return null
	var ref = null
	if PKeyPackClaims.same(d.get("scope"), "payload"):
		ref = d.get("artifact")
	elif PKeyPackClaims.same(d.get("scope"), "files"):
		ref = d.get("patch")
	var id = ref.get("sha256") if ref is Dictionary else null
	return id if id is String else null


## `with_feed_deltas(variant, deltas)` (plans/P4-29.md §2.4 step 2; client-core `withFeedDeltas`):
## the variant with the feed's menu for its payload appended to a COPY of its deltas, after the
## record's own. Unchanged, with empty `feedIds`, when `deltas` is null, the variant is not usable,
## its layout is not `container`, or the menu has no key equal to `variant.payload.sha256`. An
## entry whose `artifact.sha256` equals an existing delta id is skipped (a record delta wins).
## `feedIds` lists the appended artifact hashes in feed order. The merged list may exceed
## MAX_VARIANT_DELTAS, a claim on records only. Returns {variant, feedIds}; never fails, never
## changes its arguments.
static func with_feed_deltas(variant: Dictionary, deltas: Variant) -> Dictionary:
	if not (deltas is Dictionary) or not variant_usable(variant) \
			or not PKeyPackClaims.same(variant["files"].get("layout"), "container") \
			or not (variant.get("payload") is Dictionary) or not (deltas as Dictionary).has(variant["payload"].get("sha256")):
		return {"variant": variant, "feedIds": []}
	var merged: Array = (variant["deltas"] as Array).duplicate() if variant.get("deltas") is Array else []
	var ids := {}
	for d in merged:
		# As select.ts: a `payload` delta's artifact, any other scope's patch.
		var ref = null
		if d is Dictionary:
			ref = d.get("artifact") if PKeyPackClaims.same(d.get("scope"), "payload") else d.get("patch")
		if ref is Dictionary and ref.get("sha256") is String:
			ids[ref["sha256"]] = true
	var feed_ids: Array = []
	var entries = deltas[variant["payload"]["sha256"]]
	if entries is Array:
		for e in entries:
			var h: String = e["artifact"]["sha256"]
			if ids.has(h):
				continue
			ids[h] = true
			merged.append({"method": e["method"], "scope": "payload", "from": e["from"], "memBytes": e["memBytes"], "artifact": {"sha256": h, "bytes": e["artifact"]["bytes"]}})
			feed_ids.append(h)
	if feed_ids.is_empty():
		return {"variant": variant, "feedIds": feed_ids}
	var out := variant.duplicate()
	out["deltas"] = merged
	return {"variant": out, "feedIds": feed_ids}
