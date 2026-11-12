class_name PKeyPairVisual
extends VBoxContainer
## What the show screen draws beside the code so the other device can read it: today a plain QR code
## on its white tile. It is the one node the screen asks to draw the pairing payload, so a richer
## presentation replaces it without touching the screen: set `PKeyLocalPairing.visual_factory` to a
## Callable that answers any Control with the two calls below.
##
##   present(payload: String)   draw the payload (the text the QR encodes); "" draws nothing
##   set_side(px: float)        the side, in logical pixels, the visual may take
##
## The visual is decoration for the other device's camera: the code beside it is the whole story for
## a person, so it takes no focus and says what it is to a screen reader once.

var _tile: PanelContainer
var _qr: PKeyQrRect


func _init() -> void:
	name = "PairVisual"
	size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	_tile = PanelContainer.new()
	_tile.name = "QrTile"
	_tile.theme_type_variation = "PKeyQrTile"
	_tile.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	_tile.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	add_child(_tile)
	_qr = PKeyQrRect.new()
	_qr.name = "Qr"
	_tile.add_child(_qr)
	# The one QR the layout rules allow beside a device that is not pad-only: the other device scans it.
	_qr.set_meta(&"pkey_pair_qr", true)
	visible = false


func present(payload: String) -> void:
	_qr.text = payload
	visible = payload != "" and not _qr.encode_failed


func set_side(px: float) -> void:
	_qr.custom_minimum_size = Vector2(px, px)


## The text drawn now ("" for none), for a test.
func payload() -> String:
	return _qr.text


## Name the visual for a screen reader.
func describe(text: String) -> void:
	if "accessibility_name" in _qr:
		_qr.set("accessibility_name", text)
