class_name PKeyUpdateCheck
extends PKeyResult
## What `await PolarisKey.update.decide()` returns: plans/P3-01.md §2.5's UpdateCheck as a
## PKeyResult. When `ok`:
##
##   channel        the CANONICAL channel: the `channel` claim of the feed the decision used
##                  (`latest` answers as `stable`). A host that stages an update records THIS as
##                  `staged.channel`, never the name it asked for
##   decision       the update decision (PKeyDecision.decide_update): a Dictionary with
##                  `update-matrix.json`'s members, `action` one of none, code-ready, binary,
##                  store, platform, blocked, packs (plans/P4-13.md §2.6: with a content stamp)
##   feed           "network" when the fetched feed was committed or equals the committed one;
##                  "committed" when the decision used the earlier copy instead
##   record         "network", "cache" or "none"
##   errors         Array of {code, detail}: what went wrong on the way without stopping the
##                  decision (a transport code, `feed-rejected` with its step, `feed-rollback`,
##                  `record-rejected` with its step, `record-mismatch`)
##   boot           PKeyDecision.boot_decision(decision): "none", "optional" or "required".
##                  Floors never stop play; "required" comes only from a CI-signed revocation of a
##                  REQUIRED pack (`blocked {revoked-content}`, or `contentBlock:
##                  "revoked-content"`; plans/P4-13.md decision 4, amending P3-01 decision 1)
##   undismissable  a mandatory binary, store or platform answer, or any blocked answer: a prompt
##                  the player cannot dismiss over a game that keeps running
##   feed_doc       the verified feed the decision used;  record_doc  the verified record, or null
##
## A failure (`ok` false) means there was nothing to decide from, or the call was refused before
## dialling: `code` is `not-configured` (no configure(), or empty pinned_release_keys),
## `service-unavailable` (Update off, or a Worker without the signed feed: fall back to
## check()), `feed-rejected` (detail in `detail`), `feed-rollback`, or the transport's code
## (`network-error`, `timeout`, `local-only`, …) or the Worker's wire code
## (`feed_not_composable`, …) when no committed feed exists.

var channel := ""
var decision: Dictionary = {}
var feed := ""
var record := ""
var errors: Array = []
var boot := ""
var undismissable := false
var feed_doc: Dictionary = {}
var record_doc = null


static func of(flow: Dictionary) -> PKeyUpdateCheck:
	var r := PKeyUpdateCheck.new(true)
	var check: Dictionary = flow["check"]
	r.channel = check["channel"]
	r.decision = check["decision"]
	r.feed = check["feed"]
	r.record = check["record"]
	r.errors = check["errors"]
	r.boot = flow["boot"]
	r.undismissable = PKeyDecision.is_undismissable(r.decision)
	r.feed_doc = flow["feed_doc"]
	r.record_doc = flow["record_doc"]
	r.detail = check
	return r


static func failed(p_code: StringName, p_message: String, p_detail: Variant = null) -> PKeyUpdateCheck:
	return PKeyUpdateCheck.new(false, p_code, p_message, p_detail)


## The five UpdateCheck members, as the transcripts' `expect` names them.
func to_dictionary() -> Dictionary:
	return {"channel": channel, "decision": decision, "feed": feed, "record": record, "errors": errors}


## The action, or "" for a failure.
func action() -> String:
	return String(decision.get("action", "")) if ok else ""


func _to_string() -> String:
	if not ok:
		return "PKeyUpdateCheck(%s: %s)" % [code, message]
	return "PKeyUpdateCheck(%s %s, feed=%s, record=%s, errors=%d)" % [channel, JSON.stringify(decision), feed, record, errors.size()]
