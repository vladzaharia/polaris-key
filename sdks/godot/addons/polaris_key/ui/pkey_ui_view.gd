class_name PKeyUiView
extends PanelContainer
## The base of every UI kit scene: built-in controls only, every visible string from `copy`
## (PKeyUiCopy, through `tr()`), a Theme taken from the scene file (theme/pkey_theme.tres, the
## Polaris Key dark theme; `PKeyUiTheme.scheme` and `PKeyUiTheme.override` swap it) or from an
## ancestor, and a focus chain wired after every render so ui_up / ui_down (and Tab) walk every
## interactive control in order, wrapping at the ends, on a keyboard, a gamepad or a TV remote.
##
## A subclass builds its node tree once in `_build()` (called from `_init`, so `.new()` and the
## `.tscn` behave the same), renders its state in `_render()`, and lists its interactive controls
## in order in `_focus_chain()`. Hidden or disabled controls are skipped by the chain and get no
## focus. Nodes whose text is data rather than copy (a user code, a version, a catalog label) carry
## the meta `pkey_data` so the copy test can tell them apart. `ui_cancel` calls `_cancel()`.
##
## `sdk` is the PolarisKey autoload (or a test's SDK node); it defaults to /root/PolarisKey when
## that exists. Every scene also works without one, from the state its setters were given, which
## is how the headless snapshot tests drive it.

## Meta set on a node whose text is data, not copy.
const DATA_META := &"pkey_data"
## Meta set on a control whose ui_accept reveals more controls (the focus test presses it).
const DISCLOSURE_META := &"pkey_disclosure"

## The strings every visible node shows.
var copy: PKeyUiCopy = null:
	set(value):
		copy = value
		refresh_view()

## The PolarisKey node this scene reads from and acts on, or null.
var sdk: Node = null
## Use /root/PolarisKey when `sdk` is null at `_ready` (off: a scene driven only by its setters).
var auto_sdk := true

var _built := false


func _init() -> void:
	focus_mode = Control.FOCUS_NONE
	_build()
	_built = true


func _ready() -> void:
	if sdk == null and auto_sdk:
		sdk = default_sdk()
	if PKeyUiTheme.is_stock(theme):
		var t := PKeyUiTheme.current()
		if t != theme:
			theme = t
	refresh_view()


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSLATION_CHANGED and _built and is_inside_tree():
		refresh_view()


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
	_render()
	wire_focus()


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
