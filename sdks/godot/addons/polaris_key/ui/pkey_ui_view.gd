class_name PKeyUiView
extends PanelContainer
## The base of every UI kit scene: built-in controls only, every visible string from `copy`
## (PKeyUiCopy, through `tr()`), a Theme taken from the scene file (theme/pkey_theme.tres, the
## kit's stock theme, which follows `PKeyUiTheme` in `_ready` and on every refresh: neutral over the game's
## project theme by default, the Polaris Key theme when branding is on) or from an ancestor, and a focus chain wired after every render so ui_up / ui_down (and Tab) walk every
## interactive control in order, wrapping at the ends, on a keyboard, a gamepad or a TV remote.
##
## A subclass builds its node tree once in `_build()` (called from `_init`, so `.new()` and the
## `.tscn` behave the same), renders its state in `_render()`, and lists its interactive controls
## in order in `_focus_chain()`. Hidden or disabled controls are skipped by the chain and get no
## focus. Nodes whose text is data rather than copy (a user code, a version, a catalog label) carry
## the meta `pkey_data` so the copy test can tell them apart. `ui_cancel` calls `_cancel()`.
##
## `sdk` is the PolarisKey autoload (or a test's SDK node); it defaults to /root/PolarisKey when
## that exists.
##
## Layout: the outermost view centres its content horizontally and vertically, at most
## `max_content_width` wide and never wider than the viewport less a gutter, so it holds from a
## phone in portrait to 4K and under every stretch mode. A view nested in another fills the space
## its parent gives it. Set `max_content_width = 0` to let the content fill the view instead.
##
## Every scene also works without one, from the state its setters were given, which
## is how the headless snapshot tests drive it.

## Meta set on a node whose text is data, not copy.
const DATA_META := &"pkey_data"
## Meta set on a control whose ui_accept reveals more controls (the focus test presses it).
const DISCLOSURE_META := &"pkey_disclosure"
## The group every kit view joins, so `PKeyUiTheme.apply_options()` can re-theme mounted views.
const GROUP := &"pkey_ui_views"

## The strings every visible node shows.
var copy: PKeyUiCopy = null:
	set(value):
		copy = value
		refresh_view()

## The PolarisKey node this scene reads from and acts on, or null.
var sdk: Node = null
## Use /root/PolarisKey when `sdk` is null at `_ready` (off: a scene driven only by its setters).
var auto_sdk := true
## The widest the centred content gets, in logical pixels (0: fill the view, no centring).
@export var max_content_width := 520.0
## The least space kept between the content and the viewport's edges, in logical pixels.
const GUTTER := 16.0
## The kinds of brand node `brand_node()` makes.
const BRAND_MARK := &"mark"
const BRAND_POWERED_BY := &"powered_by"

var _brand_nodes: Array = []

var _built := false


func _init() -> void:
	focus_mode = Control.FOCUS_NONE
	add_to_group(GROUP)
	_build()
	_built = true


func _ready() -> void:
	if sdk == null and auto_sdk:
		sdk = default_sdk()
	var vp := get_viewport()
	if vp != null and not vp.size_changed.is_connected(layout_content):
		vp.size_changed.connect(layout_content)
	refresh_view()


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSLATION_CHANGED and _built and is_inside_tree():
		refresh_view()
	elif what == NOTIFICATION_PARENTED and _built:
		layout_content()


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel") and is_visible_in_tree() and _has_focus_inside():
		if _cancel():
			get_viewport().set_input_as_handled()


## The copy in use: `copy`, else the shared defaults.
func c() -> PKeyUiCopy:
	return copy if copy != null else PKeyUiCopy.shared()


## Re-render and re-wire focus. Safe at any time.
func refresh_view() -> void:
	if not _built:
		return
	# A deferred refresh (PKeyUiTheme.refresh_views()) can outlive the SDK node it was given.
	if not is_instance_valid(sdk):
		sdk = null
	_resolve_theme()
	_render_brand()
	_render()
	wire_focus()
	layout_content()


## Follow the UI options (`PKeyUiTheme`) while the scene is still on a kit stock theme: the brand
## theme when branding is on, else the neutral theme derived from the scene's place in the tree.
## A scene given a Theme of its own (no `pkey_stock` meta) keeps it. Runs on every refresh, so
## options applied after the scene entered the tree (PolarisKey.boot() configures from
## polaris_key.tres once its view is already shown) still take effect.
func _resolve_theme() -> void:
	if not is_inside_tree() or not PKeyUiTheme.is_stock(theme):
		return
	if not PKeyUiTheme.branded() and PKeyUiTheme.override == null and _is_brand_theme(theme):
		# Back to neutral: derive it from the tree, not from the brand theme still applied here.
		theme = null
	var t := PKeyUiTheme.for_view(self)
	if t != theme:
		theme = t


## The brand theme sets a default font size and the Label colour; the neutral ones never do.
static func _is_brand_theme(t: Theme) -> bool:
	return t != null and (t.has_default_font_size() or t.has_color("font_color", "Label"))


## The interactive controls, in focus order, that are visible and enabled now.
func focus_order() -> Array[Control]:
	var out: Array[Control] = []
	for n in _focus_chain():
		var ctl := n as Control
		if ctl != null and is_focusable(ctl):
			out.append(ctl)
	return out


## Link the visible, enabled controls into one wrapping chain (down/next and up/previous), and
## take focus away from the rest. A scene nested in another (the activation panel in the gate,
## the gate in PKeyBoot) is part of its outermost scene's chain, so the outermost one wires it.
func wire_focus() -> void:
	var outer := outer_view()
	if outer != self:
		outer.wire_focus()
		return
	for n in _focus_chain():
		var ctl := n as Control
		if ctl == null:
			continue
		var usable := is_focusable(ctl)
		if not usable and ctl.has_focus():
			ctl.release_focus()
		ctl.focus_mode = Control.FOCUS_ALL if _enabled(ctl) else Control.FOCUS_NONE
	var chain := focus_order()
	var n := chain.size()
	for i in n:
		var ctl: Control = chain[i]
		var next := ctl.get_path_to(chain[(i + 1) % n])
		var prev := ctl.get_path_to(chain[(i - 1 + n) % n])
		ctl.focus_neighbor_bottom = next
		ctl.focus_next = next
		ctl.focus_neighbor_top = prev
		ctl.focus_previous = prev


## The outermost PKeyUiView this one is nested in (itself when it is not nested).
func outer_view() -> PKeyUiView:
	var v: PKeyUiView = self
	var n := get_parent()
	while n != null:
		if n is PKeyUiView:
			v = n
		n = n.get_parent()
	return v


## Focus the first interactive control (for a gamepad, which has no pointer).
func focus_first() -> void:
	var chain := focus_order()
	if not chain.is_empty() and chain[0].is_inside_tree():
		chain[0].grab_focus()


## True when `ctl` takes part in the focus chain now: visible and enabled.
static func is_focusable(ctl: Control) -> bool:
	return ctl.is_visible_in_tree() and _enabled(ctl) if ctl.is_inside_tree() else _visible_chain(ctl) and _enabled(ctl)


static func _enabled(ctl: Control) -> bool:
	if ctl is BaseButton and (ctl as BaseButton).disabled:
		return false
	if ctl is LineEdit and not (ctl as LineEdit).editable:
		return false
	if ctl is TextEdit and not (ctl as TextEdit).editable:
		return false
	return true


static func _visible_chain(ctl: Control) -> bool:
	var n: Node = ctl
	while n != null:
		if n is CanvasItem and not (n as CanvasItem).visible:
			return false
		n = n.get_parent()
	return true


## The PolarisKey autoload when this scene runs inside a game, else null.
static func default_sdk() -> Node:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null or tree.root == null:
		return null
	return tree.root.get_node_or_null(^"PolarisKey")


# ── Layout ───────────────────────────────────────────────────────────────────────────────

## The width the centred content gets now: `max_content_width`, capped by the viewport (and by
## a non-Container parent's width) less the gutters; 0 when this view does not centre.
func content_width() -> float:
	if max_content_width <= 0.0 or not is_inside_tree():
		return 0.0
	var parent := get_parent() as Control
	var anchored := parent == null or not (parent is Container)
	if outer_view() != self and not anchored:
		return 0.0
	var room := get_viewport_rect().size.x
	if parent != null and anchored and parent.size.x > 0.0:
		room = minf(room, parent.size.x)
	return maxf(0.0, minf(max_content_width, room - side_padding(self) - 2.0 * GUTTER))


## Centre the content at `content_width()`. Safe at any time; called on every render and when
## the viewport changes size.
func layout_content() -> void:
	if not _built:
		return
	_apply_width(content_width())


## Give the content `width` (0: fill). The default centres `_content()`; full-screen scenes
## that centre a card themselves override it.
func _apply_width(width: float) -> void:
	var content := _content()
	if content == null:
		return
	if width <= 0.0:
		content.size_flags_horizontal = Control.SIZE_FILL
		content.size_flags_vertical = Control.SIZE_FILL
		content.custom_minimum_size.x = 0.0
		return
	content.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	content.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	content.custom_minimum_size.x = width


## `wanted` logical pixels, or less on a viewport too narrow for it (keeping the gutters): the
## width of a card a full-screen scene centres in a CenterContainer. The room is the viewport's
## width (or that of the first non-Container ancestor that has one), less the panel padding of
## this view and of every panel it is nested in (the brand page panel pads 24 px a side).
func card_width(wanted: float) -> float:
	if not is_inside_tree():
		return wanted
	var room := get_viewport_rect().size.x
	var pad := 0.0
	var n: Control = self
	while n != null:
		if n is PanelContainer:
			pad += side_padding(n)
		var parent := n.get_parent() as Control
		if parent != null and not (parent is Container) and parent.size.x > 0.0:
			room = minf(room, parent.size.x)
			break
		n = parent
	return maxf(0.0, minf(wanted, room - pad - 2.0 * GUTTER))


## The left plus right content margins of `panel`'s "panel" stylebox.
static func side_padding(panel: Control) -> float:
	var box := panel.get_theme_stylebox("panel")
	return box.get_margin(SIDE_LEFT) + box.get_margin(SIDE_RIGHT) if box != null else 0.0


## The node `_apply_width()` centres: the first child Control by default.
func _content() -> Control:
	for n in get_children():
		if n is Control and not (n as Control).top_level:
			return n
	return null


# ── Brand ────────────────────────────────────────────────────────────────────────────────

## A TextureRect for the Pinned K (`BRAND_MARK`, shown only when Polaris Key branding is on) or
## the compact "Powered by Polaris Key" badge (`BRAND_POWERED_BY`, shown only when
## `PKeyUiTheme.powered_by` is on, at its kit minimum or larger, never cropped). Hidden otherwise,
## so the default look carries no Polaris Key artwork.
func brand_node(parent: Node, node_name: String, kind: StringName, align := Control.SIZE_SHRINK_CENTER) -> TextureRect:
	var r := TextureRect.new()
	r.name = node_name
	r.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	r.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	r.size_flags_horizontal = align
	r.visible = false
	if kind == BRAND_MARK:
		r.custom_minimum_size = Vector2(PKeyUiTheme.MARK_SIZE, PKeyUiTheme.MARK_SIZE)
		r.tooltip_text = ""
	else:
		r.custom_minimum_size = PKeyUiTheme.powered_by_size("compact")
		r.tooltip_text = PKeyBrand.POWERED_BY_PHRASE
	if "accessibility_name" in r:
		r.set("accessibility_name", "Polaris Key" if kind == BRAND_MARK else PKeyBrand.POWERED_BY_PHRASE)
	parent.add_child(r)
	_brand_nodes.append([r, kind])
	return r


func _render_brand() -> void:
	if _brand_nodes.is_empty():
		return
	var dark := PKeyUiTheme.is_dark(self)
	for pair in _brand_nodes:
		var r: TextureRect = pair[0]
		var on := PKeyUiTheme.branded() if pair[1] == BRAND_MARK else PKeyUiTheme.powered_by
		r.texture = (PKeyUiTheme.mark_texture(dark) if pair[1] == BRAND_MARK else PKeyUiTheme.powered_by_texture(dark)) if on else null
		r.visible = on and r.texture != null


# ── Builders for subclasses ──────────────────────────────────────────────────────────────

## A Label; `variation` is a theme type variation (PKeyTitle, PKeyMuted, PKeyCode, PKeyError).
func label(parent: Node, node_name: String, variation := "", data := false) -> Label:
	var l := Label.new()
	l.name = node_name
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	if variation != "":
		l.theme_type_variation = variation
	if data:
		l.set_meta(DATA_META, true)
	parent.add_child(l)
	return l


func button(parent: Node, node_name: String, pressed: Callable, variation := "") -> Button:
	var b := Button.new()
	b.name = node_name
	b.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	if variation != "":
		b.theme_type_variation = variation
	if pressed.is_valid():
		b.pressed.connect(pressed)
	parent.add_child(b)
	return b


func vbox(parent: Node, node_name: String, separation := -1) -> VBoxContainer:
	var v := VBoxContainer.new()
	v.name = node_name
	if separation >= 0:
		v.add_theme_constant_override("separation", separation)
	parent.add_child(v)
	return v


func hbox(parent: Node, node_name: String) -> HBoxContainer:
	var h := HBoxContainer.new()
	h.name = node_name
	parent.add_child(h)
	return h


## Show `node` with `text`, or hide it when `text` is empty.
static func show_text(node: Control, text: String) -> void:
	node.visible = text != ""
	if node is Label:
		(node as Label).text = text
	elif node is Button:
		(node as Button).text = text


# ── Overridables ─────────────────────────────────────────────────────────────────────────

func _build() -> void:
	pass


func _render() -> void:
	pass


func _focus_chain() -> Array:
	return []


## ui_cancel inside the scene. Return true when it was handled.
func _cancel() -> bool:
	return false


func _has_focus_inside() -> bool:
	var f := get_viewport().gui_get_focus_owner() if get_viewport() != null else null
	return f != null and (f == self or is_ancestor_of(f))
