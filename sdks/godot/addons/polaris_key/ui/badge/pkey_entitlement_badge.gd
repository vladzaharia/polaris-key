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

## At most this many grants are chips; the rest collapse into "+N".
const MAX_CHIPS := 4

var _lead: Label
var _chips: HFlowContainer
var _bound := false


func _build() -> void:
	name = "PKeyEntitlementBadge"
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_chips = HFlowContainer.new()
	_chips.name = "Chips"
	_chips.theme_type_variation = "PKeyActions"
	_lead = Label.new()
	_lead.name = "Lead"
	_lead.theme_type_variation = "PKeyMuted"
	_lead.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_lead.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	# A row of chips: centred within the space the game gives the badge, never forced wider.
	max_content_width = 0.0
	if "alignment" in _chips:
		_chips.set("alignment", 1)
	_chips.add_child(_lead)
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
	# One lead-in, then the grants as chips: the first four, the rest as "+N".
	var shown: Array = []
	for i in mini(labels.size(), MAX_CHIPS):
		shown.append(tr(labels[i]))
	if labels.size() > MAX_CHIPS:
		shown.append(c().text("badge_more", labels.size() - MAX_CHIPS))
	_lead.text = c().text("badge_lead")
	_lead.visible = not labels.is_empty()
	var chips: Array = []
	for ch in _chips.get_children():
		if ch != _lead:
			chips.append(ch)
	while chips.size() < shown.size():
		var l := label(_chips, "Chip%d" % chips.size(), "PKeyBadge", true)
		l.autowrap_mode = TextServer.AUTOWRAP_OFF
		# The grant label is catalog data, formatted into translated copy.
		chips.append(l)
	for i in chips.size():
		var l: Label = chips[i]
		l.visible = i < shown.size()
		if l.visible:
			l.text = shown[i]
	visible = not labels.is_empty()


## The flow is as wide as its chips side by side (the lead-in, the chips and their gaps), within
## the room the screen leaves, before it wraps: a centred badge never becomes a column of chips
## while the screen has room.
func _arrange(m: Dictionary) -> void:
	super(m)
	var gap := float(_chips.get_theme_constant("h_separation"))
	var sum := 0.0
	var count := 0
	for ch in _chips.get_children():
		if ch is Control and (ch as Control).visible:
			sum += (ch as Control).get_combined_minimum_size().x
			count += 1
	sum += maxf(0.0, count - 1.0) * gap
	var room: float = (m["room"] as Vector2).x - 2.0 * gutter() - side_padding(self)
	_chips.custom_minimum_size.x = minf(sum, maxf(room, 0.0))
