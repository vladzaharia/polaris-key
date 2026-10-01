class_name PKeyUpdateFeed
extends PKeyResult
## What `await PolarisKey.update.feed(channel)` returns: the channel feed (`pkey-feed+jws`) this
## install now holds for a requested channel, after plans/P3-01.md §2.5 steps 1–9. When `ok`:
##
##   channel   the CANONICAL channel (the verified feed's own `channel` claim; `latest` answers
##             as `stable`)
##   feed_doc  the verified feed document
##   source    "network" when the fetched feed was committed or equals the committed one;
##             "committed" when the fetched one was refused or never arrived and the earlier copy
##             stands
##   errors    Array of {code, detail}, as PKeyUpdateCheck's
##
## A failure has PKeyUpdateCheck's codes: nothing committed to fall back on, or a refusal before
## dialling.

var channel := ""
var feed_doc: Dictionary = {}
var source := ""
var errors: Array = []


static func of(p_feed: Dictionary, p_source: String, p_errors: Array) -> PKeyUpdateFeed:
	var r := PKeyUpdateFeed.new(true)
	r.channel = p_feed["channel"]
	r.feed_doc = p_feed
	r.source = p_source
	r.errors = p_errors
	return r


static func failed(p_code: StringName, p_message: String, p_detail: Variant = null) -> PKeyUpdateFeed:
	return PKeyUpdateFeed.new(false, p_code, p_message, p_detail)


func _to_string() -> String:
	if not ok:
		return "PKeyUpdateFeed(%s: %s)" % [code, message]
	return "PKeyUpdateFeed(%s seq=%s, %s)" % [channel, str(feed_doc.get("seq")), source]
