class_name PKeySeatMeter
extends HBoxContainer
## A seat meter (UI-KITS.md §4.1 LicenseChoice, AccountAndLicense): one segment per device the
## license allows, the used ones filled (PKeySeatOn / PKeySeatOff). Status is never colour alone: the
## caller sets a text label beside it ("1 of 3 devices"), and `accessibility_name` reads the count.
## A limit over MAX_SEGMENTS draws MAX_SEGMENTS segments, filled in proportion.

const MAX_SEGMENTS := 12


## Draw `used` of `limit` seats at `unit` times the 1x size. A limit of 0 or less draws nothing.
func show_seats(used: int, limit: int, unit := 1.0) -> void:
	var segments := mini(limit, MAX_SEGMENTS) if limit > 0 else 0
	var filled := clampi(used, 0, maxi(limit, 0))
	if limit > MAX_SEGMENTS:
		filled = clampi(ceili(float(used) / float(limit) * MAX_SEGMENTS), 0 if used <= 0 else 1, MAX_SEGMENTS)
	add_theme_constant_override("separation", maxi(2, roundi(3.0 * unit)))
	while get_child_count() < segments:
		var seg := PanelContainer.new()
		seg.mouse_filter = Control.MOUSE_FILTER_IGNORE
		add_child(seg)
	for i in get_child_count():
		var seg := get_child(i) as PanelContainer
		seg.visible = i < segments
		seg.custom_minimum_size = Vector2(roundf(16.0 * unit), roundf(8.0 * unit))
		seg.theme_type_variation = &"PKeySeatOn" if i < filled else &"PKeySeatOff"
	visible = segments > 0
	size_flags_vertical = Control.SIZE_SHRINK_CENTER
