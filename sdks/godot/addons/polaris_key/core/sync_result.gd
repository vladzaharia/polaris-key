class_name PKeySyncResult
extends PKeyResult
## One sync pass (sdk-node `SyncResult`). `ok` is false only when the pass could not run at all
## (`not-started`, `local-only`); what happened to each document is in `documents`.

## True when any document's content changed and was applied.
var applied := false
## A document fetch ended on a hard 401 after the single re-acquire.
var unauthorized := false
## `/license/document` answered 403 with a version or channel block.
var blocked := false
## A document fetch answered 429 (no retry: the caller decides when to come back).
var rate_limited := false
## slice -> "applied" | "unchanged" | "unauthorized" | "blocked" | "rate-limited" | "error",
## for each document this product fetches.
var documents: Dictionary = {}
## slice -> {status, code} for each document whose outcome is "error": `status` is the HTTP
## status of an unusable answer (a 5xx, an unexpected 4xx, or 200 for a document that did not
## verify), or 0 when the request got no answer at all (DNS, connect, TLS, reset, or the request
## deadline); `code` is the transport's code when there was one. PKeyBoot classifies a sync from
## it (plans/P1-09.md §2.2: no answer is offline, unusable is error).
var errors: Dictionary = {}

## Transport codes that mean an answer arrived but could not be used.
const UNUSABLE_TRANSPORT_CODES := ["response-too-large", "too-many-redirects", "insecure-redirect"]


## How the documents this pass counted were answered (plans/P1-09.md §2.2): "offline" when any
## got no answer, else "error" when any answer was unusable, else "ok" (200 that verified, 304,
## 401, 403, 429, or nothing fetched because there is no token).
func classify() -> String:
	var unusable := false
	for slice in documents:
		if documents[slice] != "error":
			continue
		var e: Dictionary = errors.get(slice, {"status": 0, "code": ""})
		if int(e["status"]) == 0 and not PackedStringArray(UNUSABLE_TRANSPORT_CODES).has(String(e["code"])):
			return "offline"
		unusable = true
	return "error" if unusable else "ok"


func _init(p_ok := true, p_code: StringName = &"", p_message := "") -> void:
	super(p_ok, p_code, p_message, null)
