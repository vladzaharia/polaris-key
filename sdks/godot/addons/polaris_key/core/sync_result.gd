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


func _init(p_ok := true, p_code: StringName = &"", p_message := "") -> void:
	super(p_ok, p_code, p_message, null)
