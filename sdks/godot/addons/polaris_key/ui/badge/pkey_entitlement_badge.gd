class_name PKeyEntitlementBadge
extends PKeyUiView
## "Included with Supporter" chips: one per user-facing entitlement this licence grants. A chip
## is a catalog `flag` entry with `userGrant: true` that `PolarisKey.license.is_entitled()` holds;
## its text is the entry's `grantLabel` (else its `label`). Set `entitlement` to show one flag's
## chip alone. Never focusable; hidden when nothing is granted.
##
## Headless logic: `granted(config, license, only)` (static) lists the labels.

## One flag key, or "" for every user-grant flag.
@export var entitlement := ""

## The labels to show when there is no SDK (snapshots); null reads the SDK.
var labels_override: Variant = null

var _chips: HFlowContainer
var _bound := false


func _build() -> void:
	name = "PKeyEntitlementBadge"
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_chips = HFlowContainer.new()
	_chips.name = "Chips"
	_chips.theme_type_variation = "PKeyActions"
	# A row of chips: centred within the space the game gives the badge, never forced wider.
	max_content_width = 0.0
	if "alignment" in _chips:
		_chips.set("alignment", 1)
	add_child(_chips)


func _ready() -> void:
	super()
	if sdk != null and not _bound and sdk.has_signal("state_changed"):
		_bound = true
		sdk.state_changed.connect(func(_s): refresh_view())


## The grant labels this licence earns: catalog `flag` entries with `userGrant` that
## `license.is_entitled(key)` holds, in catalog order; only `only` when it is not "".
static func granted(config: PKeyConfig, license: PKeyLicense, only := "") -> Array:
	var out: Array = []
	if config == null or license == null:
		return out
	for e in config.catalog().get("entries", []):
		if not (e is Dictionary) or e.get("kind") != "flag" or e.get("userGrant") != true:
			continue
		var key: String = e.get("key", "")
		if only != "" and key != only:
			continue
		if license.is_entitled(key):
			var text = e.get("grantLabel") if e.get("grantLabel") is String and e["grantLabel"] != "" else e.get("label", key)
			out.append(String(text))
	return out


func show_labels(labels: Variant) -> void:
	labels_override = labels
	refresh_view()


func _render() -> void:
	var labels: Array = []
	if labels_override is Array:
		labels = labels_override
	elif sdk != null and sdk.get("license") != null:
		labels = granted(sdk.config, sdk.license, entitlement)
	var chips := _chips.get_children()
	while chips.size() < labels.size():
		var l := label(_chips, "Chip%d" % chips.size(), "PKeyBadge")
		l.autowrap_mode = TextServer.AUTOWRAP_OFF
		# The grant label is catalog data, formatted into translated copy.
		chips.append(l)
	for i in chips.size():
		var l: Label = chips[i]
		l.visible = i < labels.size()
		if l.visible:
			l.text = c().text("badge_included", tr(labels[i]))
	visible = not labels.is_empty()
