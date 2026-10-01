class_name PKeyChangelogEntry
extends RefCounted
## One published release, as `GET /<p>/release/changelog` reports it (sdk-node `ChangelogEntry`).

var version := ""
var tag := ""
## An ISO 8601 timestamp, or null when the release has none.
var date: Variant = null
## The curated summary, or null when the release body yielded none.
var summary: Variant = null
var url := ""


## An entry from one element of the Worker's `entries` array: strings are kept, anything else
## reads as "" (version, tag, url) or null (date, summary).
static func from_dict(d: Dictionary) -> PKeyChangelogEntry:
	var e := PKeyChangelogEntry.new()
	e.version = d["version"] if d.get("version") is String else ""
	e.tag = d["tag"] if d.get("tag") is String else ""
	e.date = d["date"] if d.get("date") is String else null
	e.summary = d["summary"] if d.get("summary") is String else null
	e.url = d["url"] if d.get("url") is String else ""
	return e


## The wire spelling: {version, tag, date, summary, url}.
func to_dict() -> Dictionary:
	return {"version": version, "tag": tag, "date": date, "summary": summary, "url": url}


func _to_string() -> String:
	return "PKeyChangelogEntry(%s)" % version
