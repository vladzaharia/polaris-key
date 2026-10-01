@tool
class_name PKeyQrRect
extends TextureRect
## A QR code for `text` (a device-code sign-in's `verification_uri_complete`), drawn crisply at
## any size: one texel per module, scaled with NEAREST filtering, kept square and centred, with a
## four-module quiet zone of the light colour (the standard's minimum; scanners need it).
##
##   var qr := PKeyQrRect.new()
##   qr.text = prompt.verification_uri_complete
##   qr.custom_minimum_size = Vector2(256, 256)
##
## Colours: the theme's `dark` and `light` colours for the type `PKeyQrRect` when the theme
## defines them, else `dark_color` and `light_color`. Keep dark on light: many scanners read
## nothing else. `text` that does not fit version 10 (213 bytes) renders nothing and sets
## `encode_failed`.

## The content to encode.
@export var text := "":
	set(value):
		text = value
		_render()
## Module colour when the theme has none.
@export var dark_color := Color.BLACK:
	set(value):
		dark_color = value
		_render()
## Background and quiet-zone colour when the theme has none.
@export var light_color := Color.WHITE:
	set(value):
		light_color = value
		_render()
## Light modules around the symbol (4 is the standard's minimum).
@export_range(4, 16) var quiet_zone := 4:
	set(value):
		quiet_zone = maxi(value, 4)
		_render()

## The symbol drawn now, or null.
var code: PKeyQrCode = null
## `text` did not fit (or was empty) at the last render.
var encode_failed := false


func _init() -> void:
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED


func _notification(what: int) -> void:
	if what == NOTIFICATION_THEME_CHANGED:
		_render()


## The colours in use: [dark, light].
func colors() -> Array[Color]:
	var dark := get_theme_color("dark", "PKeyQrRect") if has_theme_color("dark", "PKeyQrRect") else dark_color
	var light := get_theme_color("light", "PKeyQrRect") if has_theme_color("light", "PKeyQrRect") else light_color
	return [dark, light]


func _render() -> void:
	code = PKeyQr.encode(text) if text != "" else null
	encode_failed = code == null
	if code == null:
		texture = null
		return
	var c := colors()
	texture = ImageTexture.create_from_image(code.to_image(c[0], c[1], quiet_zone))
