class_name PKeyProgressController
extends RefCounted
## PKeyUpdateProgress's (and the progress toast's) headless logic: the model input for a download or
## install, the time left from the rate so far, and the sizes as one unit ("38 of 91 MB"). No node
## and no SDK call here.
##
## The phases are the model's (ui-matrix.json `update.progress.phase`): queued, download, verify
## (still downloading: the copy never says installed before apply), paused, install, failed, done.

const Models := preload("res://addons/polaris_key/ui/model/models.gd")
const Vocabulary := preload("res://addons/polaris_key/ui/model/vocabulary.gd")

## The bytes-per-second window: older samples than this (seconds) do not count towards the rate.
const WINDOW := 8.0

var _samples: Array = []


## Note `received` bytes at `now` (seconds); the rate is the bytes over the last WINDOW seconds.
func note(received: int, now: float) -> void:
	_samples.append([now, received])
	while _samples.size() > 2 and now - float(_samples[0][0]) > WINDOW:
		_samples.pop_front()


func reset() -> void:
	_samples.clear()


## Seconds until `total` bytes are in, at the rate so far; -1 when it cannot be said yet (fewer than
## two samples, no progress, or a total that is not known).
func seconds_left(received: int, total: int) -> float:
	if total <= 0 or received >= total or _samples.size() < 2:
		return -1.0 if received < total or total <= 0 else 0.0
	var first: Array = _samples[0]
	var last: Array = _samples[_samples.size() - 1]
	var dt := float(last[0]) - float(first[0])
	var db := float(last[1]) - float(first[1])
	if dt <= 0.0 or db <= 0.0:
		return -1.0
	return float(total - received) / (db / dt)


## The model input (ui-matrix.json `update`): `action` is `packs` for content, else the update's
## action; `fraction` is null for an indeterminate phase.
static func input(phase: String, fraction: Variant = null, action := "packs", version := "") -> Dictionary:
	var progress := {"phase": phase}
	if fraction != null:
		progress["fraction"] = fraction
	var update := {"action": action, "progress": progress}
	if version != "":
		update["version"] = version
	return {"update": update}


static func view(inp: Dictionary) -> Dictionary:
	return Models.view_of("UpdateProgress", inp)


static func phases() -> Array:
	return Vocabulary.PROGRESS_PHASES


## `received` and `total` bytes as ["38", "91 MB"]: both in the total's unit, the received count
## with a decimal only while the total is small in it.
static func sizes(received: int, total: int) -> Array:
	var unit := "B"
	var div := 1.0
	if total >= 1000 * 1000 * 1000:
		unit = "GB"
		div = 1.0e9
	elif total >= 1000 * 1000:
		unit = "MB"
		div = 1.0e6
	elif total >= 1000:
		unit = "KB"
		div = 1.0e3
	var big := float(total) / div >= 10.0
	var got := "%d" % int(floor(float(received) / div)) if big else "%.1f" % (float(received) / div)
	var all := "%d %s" % [int(round(float(total) / div)), unit] if big else "%.1f %s" % [float(total) / div, unit]
	return [got, all]


## The fraction received, clamped to 0..1 (null when the total is not known).
static func fraction_of(received: int, total: int) -> Variant:
	if total <= 0:
		return null
	return clampf(float(received) / float(total), 0.0, 1.0)
