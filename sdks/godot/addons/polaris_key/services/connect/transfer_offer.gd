@tool
class_name PKeyTransferOffer
extends RefCounted
## What a peer offers (WIRE-CONTRACT-V5 section 15.11): the argument of the handler `on_offer` sets. Answer
## with `accept(path)` or `decline()`, at once or later; unanswered, the offer ends after 120 s (`withdrawn`
## is then true). `name` is already cleaned display data and never reaches a path: the file goes where
## `accept` says. `from` is {kind, id, label}: `device` and its id, `link` and the link's id in mode c;
## the label is the certified HELLO label (a device) or the stored contact label (a link).

var id := ""
var name := ""
var type := ""
var size := 0
var category := ""
var from := {}
## Where an accepted offer goes; "" until `accept` was taken.
var path := ""
## True once the peer or a timer ended the offer before it was answered.
var withdrawn := false

var _answer: Callable


func _init(p_id: String, p_size: int, p_answer: Callable) -> void:
	id = p_id
	size = p_size
	_answer = p_answer


func _to_string() -> String:
	return "PKeyTransferOffer(%s size=%d)" % [id, size]


## Accept into `to`: a file path (absolute or `user://`) in an existing, writable directory. Anything at
## `to` (a file, a directory, a link) declines the offer unless `overwrite` is set, and a directory never
## is replaced. An unusable path declines.
func accept(to: String, overwrite := false) -> void:
	if _answer.is_valid():
		_answer.call(self, to, overwrite)


func decline() -> void:
	if _answer.is_valid():
		_answer.call(self, "", false)
