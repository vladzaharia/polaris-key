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
##
## Returns {ok: true, check: {channel, decision, feed, record, errors}, boot, feed_doc,
## record_doc, committed: {k: {jws, feed}}, records: {h: {jws, record}}, cache: {feeds,
## releaseRecords}} or {ok: false, error: {code, detail}} when there is nothing to decide from.

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
## Returns {ok: false, error} with nothing to decide from, else {ok: true, feed, feed_source,
## errors, committed: {k: {jws, feed}}, feeds: {k: jws}}.
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
	var feed_source := "network"
	var fetched := await _fetch(opts.get("fetch_feed", Callable()), requested, String(PKeyErrors.NETWORK))
	if fetched["ok"]:
		var body := _text(fetched["body"])
		# Step 2: an unchanged body decides from the committed copy.
		for k in PKeyFeed.bound_channels(requested):
			if committed.has(k) and committed[k]["jws"] == body:
				feed = committed[k]["feed"]
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
				var claim: String = feed["channel"]
				feeds = PKeyFeed.commit_feed(feeds, requested, claim, body)
				var prior_committed := committed
				committed = {}
				for k in prior_committed:
					if k != requested or claim == requested:
						committed[k] = prior_committed[k]
				committed[claim] = {"jws": body, "feed": feed}
			else:
				var err = feed_error(v["reason"])
				var prior = _fallback(committed, requested, v.get("channel"))
				if prior == null:
					return {"ok": false, "error": err if err != null else {"code": FEED_REJECTED, "detail": v["reason"]}}
				if err != null:
					errors.append(err)
				feed = prior["feed"]
				feed_source = "committed"
	else:
		var prior = _fallback(committed, requested, null)
		if prior == null:
			return {"ok": false, "error": {"code": fetched["code"], "detail": null}}
		errors.append({"code": fetched["code"], "detail": null})
		feed = prior["feed"]
		feed_source = "committed"
	return {"ok": true, "feed": feed, "feed_source": feed_source, "errors": errors, "committed": committed, "feeds": feeds}


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
	var decision := PKeyDecision.decide_update({
		"now": opts.get("now", PKeyClaims.system_now()),
		"feed": feed,
		"record": record,
		"installed": installed,
		"outlet": outlet,
		"subkind": opts.get("subkind"),
		"staged": opts.get("staged"),
		"skipVersion": opts.get("skip_version"),
		"bucket": bucket,
		"methods": opts.get("methods", ["download"]),
	})
	return {
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
		"record_doc": record,
		"committed": committed,
		"records": kept,
		"cache": {"feeds": feeds, "releaseRecords": release_records},
	}


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
