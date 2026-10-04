class_name PKeyUpdateFlow
extends RefCounted
## `PolarisKey.update.decide()`'s core: plans/P3-01.md §2.5 steps 2–18 and "After a refusal", a
## port of client-core `check.ts` (`runUpdateCheck`), so the order, the fallback and the error
## map are the ones every SDK runs. It does no I/O of its own: the service hands it the two
## fetches (the feed for a requested channel, a record by hash) and the cache slices, and gets
## back the UpdateCheck members plus the slices to write. Step 1 (discovery), the options refusals
## (`not-configured`, `invalid-options`) and the write itself stay with the service.
##
## `run(opts)` is a coroutine and never fails by error. `opts`:
##   channel         the REQUESTED name (it may be an alias, such as `latest`)
##   expected_aud    the product
##   trust           the EFFECTIVE product trust set (pins ∪ manifest keys)
##   release_keys    `pinned_release_keys` (never empty here)
##   now             the effective clock, max(system, highWaterMark)
##   install_id      the device id (the rollout bucket's install id), or "" for none
##   installed       {version, binaryVersion, buildNumber, platform, arch, format, engine}
##   outlet          {id, kind};  subkind  String or null
##   staged          {version, channel} or null;  skip_version  String or null
##   methods         Array of binary methods
##   cache           {feeds: {k: jws}, releaseRecords: {h: jws}} as stored (re-verified here)
##   fetch_feed      Callable(channel) -> {ok: true, body} | {ok: false, code} (may await)
##   fetch_record    Callable(sha256) -> the same
##   offload         run each Ed25519 verify off the calling thread
##   content         optional (plans/P4-13.md §2.5 steps 10–14, §2.6): {stamp: {contentApi, pins,
##                   expects}, holds (stamp_holds; null when unusable), active: {pack: {sha256,
##                   seq, version}} (the running set, embedded baselines included), engine (the
##                   host's `godot-<maj>.<min>`), axes, revoked: {target: verified revocation} (the
##                   pack engine's), relearn: [packId], delegated: {record sha256: {pack,
##                   delegation}} (the pack engine's delegated_releases(), plans/P4-19.md §2.7)}.
##                   Omitted: no content decision, every answer is P3-01's
##
## Returns {ok: true, check: {channel, decision, feed, record, errors}, boot, feed_doc, content
## (PKeyFeed.feed_content over feed_doc with its own non-wire pointers, the delta menu included:
## client-core's check result `content`, plans/P4-29.md §2.4 step 1), record_doc, committed: {k: {jws, feed, content}}, records: {h: {jws, record}}, cache: {feeds,
## releaseRecords}, revocations?: {learned: [{revocation, jws}], relearnCleared: [packId]}} or
## {ok: false, error: {code, detail}} when there is nothing to decide from. `revocations` (with
## `content` only) is what the pack engine stores (PKeyPackEngine.record_revocations).

const FEED_REJECTED := "feed-rejected"
const FEED_ROLLBACK := "feed-rollback"
const RECORD_REJECTED := "record-rejected"
const RECORD_MISMATCH := "record-mismatch"


static func _fetch(fetcher: Callable, arg: String, fallback_code: String) -> Dictionary:
	if not fetcher.is_valid():
		return {"ok": false, "code": fallback_code}
	var out = await fetcher.call(arg)
	if out is Dictionary and PKeyClaims.is_true(out.get("ok")) and (out.get("body") is String or out.get("body") is PackedByteArray):
		return out
	if out is Dictionary and PKeyClaims.is_false(out.get("ok")) and out.get("code") is String and out["code"] != "":
		return out
	return {"ok": false, "code": fallback_code}


static func _text(body: Variant) -> String:
	return body if body is String else (body as PackedByteArray).get_string_from_utf8()


## The step 3–8 refusal's entry in `errors`, or null for `not-newer` (nothing is reported).
static func feed_error(reason: String) -> Variant:
	if reason == "not-newer":
		return null
	if reason == "rollback":
		return {"code": FEED_ROLLBACK, "detail": null}
	return {"code": FEED_REJECTED, "detail": reason}


## Steps 2–9 alone, over the reload path (PolarisKey.update.feed() runs just this): the
## committed feeds re-verified, the fetched feed verified and committed, or the fallback.
## Returns {ok: false, error} with nothing to decide from, else {ok: true, feed, content,
## feed_source, errors, committed: {k: {jws, feed, content}}, feeds: {k: jws}}; `content` is
## PKeyFeed.feed_content over the feed the decision uses (with its own pointers).
static func feed_step(opts: Dictionary) -> Dictionary:
	var requested: String = String(opts.get("channel", ""))
	var installed: Dictionary = opts.get("installed", {})
	var platform: String = String(installed.get("platform", ""))
	var aud: String = String(opts.get("expected_aud", ""))
	var trust: Dictionary = opts.get("trust", {})
	var offload := PKeyClaims.is_true(opts.get("offload", false))
	var cache: Dictionary = opts.get("cache", {}) if opts.get("cache") is Dictionary else {}
	var errors: Array = []

	# The reload path: the committed feeds that still verify, and the floors they set.
	var reloaded := await PKeyFeed.reload_feeds(cache.get("feeds"), {
		"trust": trust, "expected_aud": aud, "platform": platform, "offload": offload,
	})
	var committed: Dictionary = reloaded["feeds"]
	var floors: Dictionary = reloaded["floors"]
	var feeds := {}
	for k in committed:
		feeds[k] = committed[k]["jws"]

	var feed = null
	var content = null
	var feed_source := "network"
	var fetched := await _fetch(opts.get("fetch_feed", Callable()), requested, String(PKeyErrors.NETWORK))
	if fetched["ok"]:
		var body := _text(fetched["body"])
		# Step 2: an unchanged body decides from the committed copy.
		for k in PKeyFeed.bound_channels(requested):
			if committed.has(k) and committed[k]["jws"] == body:
				feed = committed[k]["feed"]
				content = committed[k].get("content")
				break
		if feed == null:
			var v := await PKeyFeed.verify_feed(body, {
				"trust": trust, "expected_aud": aud, "channel": requested, "platform": platform,
				"now": opts.get("now", PKeyClaims.system_now()), "check_freshness": true, "floors": floors,
				"offload": offload,
			})
			if v["ok"]:
				# Step 9: commit under the claim; an alias answer removes the requested name's entry.
				feed = v["feed"]
				content = v["content"]
				var claim: String = feed["channel"]
				feeds = PKeyFeed.commit_feed(feeds, requested, claim, body)
				var prior_committed := committed
				committed = {}
				for k in prior_committed:
					if k != requested or claim == requested:
						committed[k] = prior_committed[k]
				committed[claim] = {"jws": body, "feed": feed, "content": content}
			else:
				var err = feed_error(v["reason"])
				var prior = _fallback(committed, requested, v.get("channel"))
				if prior == null:
					return {"ok": false, "error": err if err != null else {"code": FEED_REJECTED, "detail": v["reason"]}}
				if err != null:
					errors.append(err)
				feed = prior["feed"]
				content = prior.get("content")
				feed_source = "committed"
	else:
		var prior = _fallback(committed, requested, null)
		if prior == null:
			return {"ok": false, "error": {"code": fetched["code"], "detail": null}}
		errors.append({"code": fetched["code"], "detail": null})
		feed = prior["feed"]
		content = prior.get("content")
		feed_source = "committed"
	return {"ok": true, "feed": feed, "content": content, "feed_source": feed_source, "errors": errors, "committed": committed, "feeds": feeds}


static func run(opts: Dictionary) -> Dictionary:
	var installed: Dictionary = opts.get("installed", {})
	var platform: String = String(installed.get("platform", ""))
	var aud: String = String(opts.get("expected_aud", ""))
	var trust: Dictionary = opts.get("trust", {})
	var release_keys: Dictionary = opts.get("release_keys", {})
	var offload := PKeyClaims.is_true(opts.get("offload", false))
	var cache: Dictionary = opts.get("cache", {}) if opts.get("cache") is Dictionary else {}

	var step := await feed_step(opts)
	if not step["ok"]:
		return step
	var feed: Dictionary = step["feed"]
	var feed_source: String = step["feed_source"]
	var errors: Array = step["errors"]
	var committed: Dictionary = step["committed"]
	var feeds: Dictionary = step["feeds"]
	var docs := {}
	for k in committed:
		docs[k] = committed[k]["feed"]

	# Steps 10–16.
	var target = PKeyDecision.feed_target(feed["app"]["targets"], platform)
	var cached_records: Dictionary = cache["releaseRecords"] if cache.get("releaseRecords") is Dictionary else {}
	var record = null
	var record_nw = null
	var record_source := "none"
	var record_jws = null
	if target is Dictionary:
		var pin: Dictionary = target["release"]
		var verify_opts := {
			"release_keys": release_keys, "product_trust": trust, "expected_aud": aud,
			"expected_hash": pin["sha256"],
			"pin": {"deliverable": "app", "version": pin["version"], "seq": pin["seq"]},
			"offload": offload,
		}
		var cached = cached_records.get(pin["sha256"])
		if cached is String:
			var r := await PKeyReleaseRecord.verify_release_record(cached, verify_opts)
			if r["ok"]:
				record = r["record"]
				record_nw = r["non_wire_integers"]
				record_source = "cache"
				record_jws = cached
		if record == null:
			var got := await _fetch(opts.get("fetch_record", Callable()), pin["sha256"], String(PKeyErrors.NETWORK))
			if not got["ok"]:
				errors.append({"code": got["code"], "detail": null})
			else:
				var r := await PKeyReleaseRecord.verify_release_record(got["body"], verify_opts)
				if r["ok"]:
					record = r["record"]
					record_nw = r["non_wire_integers"]
					record_source = "network"
					record_jws = got["body"] if got["body"] is String else (got["body"] as PackedByteArray).get_string_from_ascii()
				elif r["step"] == PKeyReleaseRecord.STEP_CROSS_CHECK:
					errors.append({"code": RECORD_MISMATCH, "detail": null})
				else:
					errors.append({"code": RECORD_REJECTED, "detail": r["step"]})

	# A record is kept only while a committed feed's target for this platform pins it.
	var pinned := {}
	for k in docs:
		var t = PKeyDecision.feed_target(docs[k]["app"]["targets"], platform)
		if t is Dictionary:
			pinned[t["release"]["sha256"]] = true
	var candidates := cached_records.duplicate()
	if record_jws != null and target is Dictionary:
		candidates[target["release"]["sha256"]] = record_jws
	var kept := await PKeyReleaseRecord.reload_release_records(candidates, {
		"release_keys": release_keys, "product_trust": trust, "expected_aud": aud, "pinned": pinned,
		"offload": offload,
	})
	var release_records := {}
	for h in kept:
		release_records[h] = kept[h]["jws"]

	# Steps 17–18.
	var outlet: Dictionary = opts.get("outlet", {"id": null, "kind": PKeyDecision.OUTLET_UNKNOWN})
	var entry = PKeyDecision.outlet_entry(target, outlet)
	var install_id = opts.get("install_id")
	var bucket = null
	if entry is Dictionary and entry.get("rollout") is Dictionary and install_id is String and install_id != "":
		bucket = PKeyDecision.rollout_bucket(entry["rollout"]["salt"], install_id)

	# plans/P4-13.md §2.5 content steps 10–14.
	var content_input = null
	var revocations = null
	var decision_feed: Dictionary = feed
	var decision_record = record
	# client-core's check result `content` (plans/P4-29.md §2.4 step 1): the feed's content members
	# read with its own non-wire pointers, the delta menu included.
	var fc: Dictionary = step["content"] if step.get("content") is Dictionary else PKeyFeed.feed_content(feed)
	if opts.get("content") is Dictionary:
		decision_feed = PKeyFeed.with_feed_content(feed, fc)
		var steps := await _content_steps(opts, fc, feed_source, errors)
		content_input = steps["input"]
		revocations = steps["revocations"]
		# The record's holds, read with its own non-wire pointers: unusable reads as null, so the
		# decision (which re-reads them without the token rule) sees the same verdict.
		if record is Dictionary and record.get("content") is Dictionary and record_nw != null:
			var h = PKeyPackClaims.holds_of(record["content"], record_nw, "/content")
			if h == null and record["content"].has("holds"):
				decision_record = record.duplicate()
				var rc: Dictionary = record["content"].duplicate()
				rc["holds"] = null
				decision_record["content"] = rc

	var input := {
		"now": opts.get("now", PKeyClaims.system_now()),
		"feed": decision_feed,
		"record": decision_record,
		"installed": installed,
		"outlet": outlet,
		"subkind": opts.get("subkind"),
		"staged": opts.get("staged"),
		"skipVersion": opts.get("skip_version"),
		"bucket": bucket,
		"methods": opts.get("methods", ["download"]),
	}
	if content_input != null:
		input["content"] = content_input
	var decision := PKeyDecision.decide_update(input)
	var out := {
		"ok": true,
		"check": {
			"channel": feed["channel"],
			"decision": decision,
			"feed": feed_source,
			"record": record_source,
			"errors": errors,
		},
		"boot": PKeyDecision.boot_decision(decision),
		"feed_doc": feed,
		"content": fc,
		"record_doc": record,
		"committed": committed,
		"records": kept,
		"cache": {"feeds": feeds, "releaseRecords": release_records},
	}
	if revocations != null:
		out["revocations"] = revocations
	return out


## plans/P4-13.md §2.5 content steps 10–13: the relevant revocations (fetched and verified against
## the pinned release keys, at most MAX_FEED_REVOCATIONS per check, superseding by
## newer_revocation), their replacements (fetched, verified as pack records, not revoked, and with
## a variant for this host), the gate buckets, and the decision's content input. A failed fetch
## retries at the next check; a failed verification is ignored and never trusted. A coroutine
## returning {input, revocations: {learned, relearnCleared}}.
static func _content_steps(opts: Dictionary, fc: Dictionary, feed_source: String, errors: Array) -> Dictionary:
	var c: Dictionary = opts["content"]
	var installed: Dictionary = opts.get("installed", {})
	var platform: String = String(installed.get("platform", ""))
	var engine: String = installed["engine"] if installed.get("engine") is String else ""
	var aud: String = String(opts.get("expected_aud", ""))
	var trust: Dictionary = opts.get("trust", {})
	var release_keys: Dictionary = opts.get("release_keys", {})
	var offload := PKeyClaims.is_true(opts.get("offload", false))
	var fetch_record: Callable = opts.get("fetch_record", Callable())
	var stamp: Dictionary = c.get("stamp", {}) if c.get("stamp") is Dictionary else {}
	var active: Dictionary = c.get("active", {}) if c.get("active") is Dictionary else {}
	var axes: Dictionary = c.get("axes", {}) if c.get("axes") is Dictionary else {}
	var holds = c.get("holds")
	var pins: Array = stamp.get("pins", []) if stamp.get("pins") is Array else []
	var expects: Array = stamp.get("expects", []) if stamp.get("expects") is Array else []
	var delegated: Dictionary = c.get("delegated", {}) if c.get("delegated") is Dictionary else {}

	# H: the active pack records, the stamp's pins and holds, and the feed targets §2.6 selects
	# (gate fallbacks included).
	var H := {}
	for p in active:
		H[active[p]["sha256"]] = true
	for p in pins:
		H[p["release"]["sha256"]] = true
	if holds is Array:
		for h in holds:
			H[h["release"]["sha256"]] = true
	# plans/P4-19.md §2.7: H's pack set (the stamp's expects, pins and holds, the active installs
	# and the feed targets), for the relevance of delegation entries; the delegations of the
	# delegated releases the pack engine knows.
	var packs_h := {}
	for p in active:
		packs_h[p] = true
	for p in pins:
		packs_h[p["pack"]] = true
	for e in expects:
		if e is Dictionary and e.get("pack") is String:
			packs_h[e["pack"]] = true
	if holds is Array:
		for h in holds:
			packs_h[h["pack"]] = true
	var delegations := {}
	for r in delegated:
		if delegated[r] is Dictionary and delegated[r].get("delegation") is String:
			delegations[delegated[r]["delegation"]] = true
	var ps = fc.get("packSets")
	var outlets: Dictionary = ps.get("outlets", {}) if ps is Dictionary else {}
	if ps is Dictionary:
		var targets := PKeyDecision.select_pack_rows(ps, {"contentApi": stamp.get("contentApi"), "platform": platform, "engine": engine, "axes": axes})
		for pack in targets:
			packs_h[pack] = true
			var h: String = targets[pack]
			H[h] = true
			for o in outlets:
				var gates: Dictionary = outlets[o].get("gates", {})
				if gates.has(h) and gates[h]["fallback"] != null:
					H[gates[h]["fallback"]] = true

	# Step 11.
	var stored: Dictionary = (c.get("revoked", {}) as Dictionary).duplicate() if c.get("revoked") is Dictionary else {}
	var learned: Array = []
	# The feed entries step 11 considers (target in H) that are now known: already stored with
	# that record, or fetched and verified in this check (a newer stored one may still win).
	var known := {}
	var fetches := 0
	var feed_revocations = fc.get("revocations")
	if feed_revocations is Array:
		for entry in feed_revocations:
			if not _relevant(entry, H, packs_h, delegations):
				continue
			var have = stored.get(entry["target"])
			if have is Dictionary and have["record"] == entry["record"]:
				known[entry["record"]] = true
				continue
			if fetches >= PKeyConstants.MAX_FEED_REVOCATIONS:
				break
			fetches += 1
			var got := await _fetch(fetch_record, entry["record"], String(PKeyErrors.NETWORK))
			if not got["ok"]:
				errors.append({"code": got["code"], "detail": null})
				continue
			var r := await PKeyReleaseRecord.verify_revocation(got["body"], {
				"release_keys": release_keys, "product_trust": trust, "expected_aud": aud, "entry": entry, "offload": offload,
			})
			if not r["ok"]:
				errors.append({"code": RECORD_REJECTED, "detail": r["step"]})
				continue
			known[entry["record"]] = true
			var rev: Dictionary = r["revocation"]
			if not (have is Dictionary) or is_same(PKeyReleaseRecord.newer_revocation(rev, have), rev):
				stored[entry["target"]] = rev
				learned.append({"revocation": rev, "jws": _ascii(got["body"])})

	# Step 12: the replacements of the relevant stored revocations.
	var rev_input: Array = []
	for target in stored:
		var rev: Dictionary = stored[target]
		var usable := false
		# A delegation target has no replacement (plans/P4-19.md §2.6): one is ignored.
		var rep = null if delegations.has(target) else rev.get("replacement")
		if rep is Dictionary and H.has(target) and not stored.has(rep["sha256"]):
			var got := await _fetch(fetch_record, rep["sha256"], String(PKeyErrors.NETWORK))
			if got["ok"]:
				var v := await PKeyReleaseRecord.verify_release_record(got["body"], {
					"release_keys": release_keys, "product_trust": trust, "expected_aud": aud,
					"expected_hash": rep["sha256"], "offload": offload,
					"pin": {"kind": "pack", "deliverable": rev["pack"], "version": rep["version"], "seq": rep["seq"]},
				})
				if v["ok"]:
					var variants = v["record"].get("variants", [])
					var sel := PKeyPackSelect.select_variant(variants if variants is Array else [], {"engine": c.get("engine"), "axes": axes})
					usable = not sel.has("error")
		rev_input.append({"target": target, "pack": rev["pack"], "replacement": rep, "replacementUsable": usable})
	# plans/P4-19.md §2.7: each known delegated release whose delegation is revoked is revoked for
	# the decision, with no replacement.
	for r in delegated:
		var d = delegated[r]
		if d is Dictionary and d.get("delegation") is String and PKeyReleaseRecord.record_revoked(String(r), d["delegation"], stored) == "delegation":
			rev_input.append({"target": r, "pack": d["pack"], "replacement": null, "replacementUsable": false})

	# Step 13: the bucket of every gate salt.
	var buckets := {}
	var install_id = opts.get("install_id")
	for o in outlets:
		var gates: Dictionary = outlets[o].get("gates", {})
		for g in gates:
			var ro = gates[g].get("rollout")
			if ro is Dictionary and not buckets.has(ro["salt"]):
				buckets[ro["salt"]] = PKeyDecision.rollout_bucket(ro["salt"], install_id) if install_id is String and install_id != "" else null

	# `relearn` clears only on a fresh, network-verified feed with a usable `revocations` member,
	# once step 11 has fetched, verified and stored every revocation it considers for that pack
	# (the entries step 11 finds relevant: a target in H, or a delegation entry by §2.7's rule).
	# Entries for releases outside H never keep a pack there.
	var relearn_cleared: Array = []
	if feed_source == "network" and feed_revocations is Array and c.get("relearn") is Array:
		for p in c["relearn"]:
			var all := true
			for e in feed_revocations:
				if e["pack"] == p and _relevant(e, H, packs_h, delegations) and not known.has(e["record"]):
					all = false
					break
			if all:
				relearn_cleared.append(p)

	return {
		"input": {
			"stamp": {"contentApi": stamp.get("contentApi"), "pins": pins, "expects": stamp.get("expects", []), "holds": holds},
			"active": active,
			"axes": axes,
			"revocations": rev_input,
			"buckets": buckets,
		},
		"revocations": {"learned": learned, "relearnCleared": relearn_cleared},
	}


## Step 11's relevance (plans/P4-13.md §2.5, plans/P4-19.md §2.7): a pack-record entry when its
## target is in H; a delegation entry when its target is the delegation of a delegated release the
## pack engine knows, or its scope root covers, by whole segments, a pack in H's pack set.
static func _relevant(entry: Dictionary, H: Dictionary, packs_h: Dictionary, delegations: Dictionary) -> bool:
	if entry.get("kind") == "delegation":
		if delegations.has(entry["target"]):
			return true
		for p in packs_h:
			if PKeyReleaseRecord.covers_pack(String(entry["pack"]), String(p)):
				return true
		return false
	return H.has(entry["target"])


static func _ascii(body: Variant) -> String:
	return body if body is String else (body as PackedByteArray).get_string_from_ascii()


## The first committed feed among `committed[claim]` (only when the fetched feed passed step 5),
## `committed[requested]` and `committed[CHANNEL_ALIASES[requested]]`, or null.
static func _fallback(committed: Dictionary, requested: String, claim: Variant) -> Variant:
	var keys: Array = []
	if claim is String:
		keys.append(claim)
	keys.append_array(Array(PKeyFeed.bound_channels(requested)))
	for k in keys:
		if committed.has(k):
			return committed[k]
	return null
