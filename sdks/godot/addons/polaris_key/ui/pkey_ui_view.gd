class_name PKeyUiView
extends PanelContainer
## The base of every UI kit scene: built-in controls only, every visible string from `copy`
## (PKeyUiCopy, through `tr()`), a Theme taken from the scene file (theme/pkey_theme.tres, the
## kit's stock theme, which follows `PKeyUiTheme` in `_ready` and on every refresh: neutral over the game's
## project theme by default, the Polaris Key theme when branding is on) or from an ancestor, and a focus chain wired after every render so ui_up / ui_down (and Tab) walk every
## interactive control in order, wrapping at the ends, on a keyboard, a gamepad or a TV remote.
##
## A subclass builds its node tree once in `_build()` (called from `_init`, so `.new()` and the
## `.tscn` behave the same), renders its state in `_render()`, lays it out for the screen in
## `_arrange()`, and lists its interactive controls in order in `_focus_chain()`. Hidden or
## disabled controls are skipped by the chain and get no focus. Nodes whose text is data rather
## than copy (a user code, a version, a catalog label) carry the meta `pkey_data` so the copy test
## can tell them apart. `ui_cancel` calls `_cancel()`.
##
## `sdk` is the PolarisKey autoload (or a test's SDK node); it defaults to /root/PolarisKey when
## that exists.
##
## **Layout: every scene is responsive** (owner, 2026-10-07: "Our drop-in UIs should be responsive
## … landscape not portrait"). The outermost view measures the area it is given (its own rect
## when it is anchored to stretch or placed by a Container, else its parent's or the viewport's),
## less the device's safe area on a phone or tablet, and lays out for it (`layout_metrics()`):
##
## - **Orientation.** Wider than tall, with room for two columns, is landscape: a screen with two
##   parts (the device code and its QR, the product and the activation form, the offline request
##   and its import) puts them side by side; otherwise they stack. The decision is the panel's,
##   never the OS's.
## - **Scale.** On the Polaris Key theme every size (text, padding, radii, the QR, the cards'
##   widths) follows the screen: 1 on a 1280×720 screen (600×1080 in portrait), down to 0.75 (a
##   640×360 window) and up to 2 (2560×1440), in steps of 1/8. The neutral look and a game's own
##   theme keep the game's sizes (the game owns its type scale).
## - **Density.** The theme's spacing (PKeyUiTheme, the PKeyLayout constants) in the density the
##   game asked for (spacious by default), stepping down to comfortable and compact when the
##   screen is short or narrow.
## - **Margins.** The content keeps at least `page_margin` from the area's (safe) edges, and is
##   capped in width and centred, so it never hugs an edge or floats adrift on a 4K screen.
##
## It follows the viewport's and the view's own resizes live, and keeps the focus where it was. A
## view nested in another reads the outermost view's measurements, so a gate, its activation
## panel and the sign-in inside it agree on one layout.
##
## Every scene also works without an SDK, from the state its setters were given, which is how the
## headless snapshot tests drive it.

## Meta set on a node whose text is data, not copy.
const DATA_META := &"pkey_data"
## Meta set on a control whose ui_accept reveals more controls (the focus test presses it).
const DISCLOSURE_META := &"pkey_disclosure"
## Meta set on a control whose height the layout leaves alone (every other button and input is
## the theme's `control_height`).
const FREE_HEIGHT_META := &"pkey_free_height"
## A scroll area a scene scrolls by hand (the settings list, with room for the focus ring).
const MANUAL_SCROLL_META := &"pkey_manual_scroll"
## Set this meta on a view anchored across the screen to keep the offsets it was given (see
## `_release_offsets()`).
const KEEP_OFFSETS_META := &"pkey_keep_offsets"
## Meta set on a container the scene hides while every child of it is hidden (so an empty group
## adds no gap).
const AUTO_HIDE_META := &"pkey_auto_hide"
const AUTO_HIDDEN_META := &"pkey_auto_hidden"
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
## The widest the centred content gets, in logical pixels at scale 1 (0: fill the view, no
## centring).
@export var max_content_width := 520.0
## The least space kept between the content and the viewport's edges, in logical pixels, whatever
## the theme says.
const GUTTER := 16.0
## The kinds of brand node `brand_node()` makes.
const BRAND_POWERED_BY := &"powered_by"

## The design reference: a landscape screen of this size is scale 1, and so is a portrait one of
## REFERENCE_PORTRAIT (a card spans a phone's width less its margins).
const REFERENCE := Vector2(1280, 720)
const REFERENCE_PORTRAIT := Vector2(600, 1080)
## The scale range and step on the Polaris Key theme.
const SCALE_MIN := 0.75
const SCALE_MAX := 2.0
const SCALE_STEP := 0.125
## A QR code is never smaller than this on the screen, in physical pixels (a phone must read it),
## nor wider than this share of the screen's shorter side.
const QR_MIN_PHYSICAL := 160.0
const QR_MAX_SHARE := 0.42
## The room (in scale-1 pixels) below which the density steps down: compact under the first pair,
## comfortable under the second.
const COMPACT_ROOM := Vector2(440, 560)
const COMFORTABLE_ROOM := Vector2(560, 680)
## The least room (scale-1 pixels) for a two-column landscape layout.
const COLUMNS_MIN_WIDTH := 680.0

## [left, top, right, bottom] in logical pixels to use instead of the device's safe area (tests,
## the screenshot matrix); null reads the device.
static var safe_insets_override: Variant = null
## Tests and the screenshot matrix: pretend this is a phone or tablet ({"dpr": density-independent
## pixels per 160 dpi, e.g. 2.75}) or not (false); null reads the device (OS.has_feature("mobile")
## and DisplayServer.screen_get_dpi()).
static var mobile_override: Variant = null
## Tests and the matrix: true or false for "a joypad is the only input"; null reads the device.
static var pad_only_override: Variant = null
## The least a phone's body text is, in density-independent pixels, and its controls' height (44 pt
## on iOS, 48 dp on Android).
const MOBILE_BODY_DP := 16.0
const MOBILE_CONTROL_DP := 48.0
## The widest panel, in layout pixels, that is a phone's (with a portrait aspect) on a desktop.
const PHONE_MAX_WIDTH := 560.0
## True after the last keyboard or joypad input, false after the last mouse or touch input: a
## screen grabs focus on its own only for the former.
static var pointer_last := false
static var _pointer_known := false
## How long (ms) a modal ignores input after it opens, so a button press that opened it cannot
## also answer it (UI-KITS.md §4.3).
const MODAL_GUARD_MSEC := 250

## The outermost view's last measurements (see `layout_metrics()`).
var metrics: Dictionary = {}

var _brand_nodes: Array = []
var _built := false
var _layout_queued := false
var _own_panel := false
var _safe_base: StyleBox = null
var _safe_applied: Array = [0.0, 0.0, 0.0, 0.0]
var _safe_theme: Theme = null
## The card a dialog draws itself in while it is the outermost view (`card_panel()`), or null.
var _card_box: PanelContainer = null
var _scrolls: Array = []
var _checks_left := 0
## How far the layout has squeezed to fit a short screen (0: not at all, up to `squeeze_max()`).
## The outermost view owns it; every view inside reads it through `squeeze_level()`.
var _squeeze := 0
var _squeeze_key := ""
var _action_rows: Array = []
var _loading_bar: ProgressBar = null
var _loading_since := 0
var _flips := 0
## The focus chain as last wired, and the index the focus held when its control went away.
var _last_chain: Array = []
var _lost_index := -1
## The screen the view showed when it last asked for focus (see `_screen_key()`).
var _focus_key := ""
var _was_visible := false
## The control that had focus when this view opened (`remember_opener()`), restored on `close()`.
var _opener: Control = null
var _guard_until := 0
var _layout_frame := -1
var _layouts_in_frame := 0


func _init() -> void:
	focus_mode = Control.FOCUS_NONE
	add_to_group(GROUP)
	_build()
	# A view that brings its own panel (an empty one, say) keeps it when nested.
	_own_panel = has_theme_stylebox_override("panel")
	_built = true


func _ready() -> void:
	ensure_pad_bindings()
	if sdk == null and auto_sdk:
		sdk = default_sdk()
	_watch_viewport()
	refresh_view()


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSLATION_CHANGED and _built and is_inside_tree():
		refresh_view()
	elif what == NOTIFICATION_VISIBILITY_CHANGED and _opener != null and not is_visible_in_tree():
		# The dialog went away (hidden by its host, dismissed): the game's control gets its focus back.
		restore_opener()
	elif what == NOTIFICATION_ENTER_TREE and _built:
		_watch_viewport()
	elif what == NOTIFICATION_EXIT_TREE and _built and _opener == null:
		_unwatch_viewport()
	elif what == NOTIFICATION_EXIT_TREE and _opener != null:
		_unwatch_viewport()
		# A game that frees the view instead of hiding it: the control that opened it gets the focus
		# back (unless the view was only moved to another parent, which keeps its opener).
		PKeyUiView._give_back.call_deferred(_opener, weakref(self))
	elif what == NOTIFICATION_PARENTED and _built:
		layout_content()
	elif what == NOTIFICATION_RESIZED and _built and is_inside_tree() and outer_view() == self:
		queue_layout()


var _watched: Viewport = null


## Follow the viewport the view is in now (a view moved into another one, a SubViewport, follows that
## one's size and focus, not the one it was first added to).
func _watch_viewport() -> void:
	var vp := get_viewport() if is_inside_tree() else null
	if vp == _watched:
		return
	_unwatch_viewport()
	_watched = vp
	if vp != null:
		vp.size_changed.connect(queue_layout)
		vp.gui_focus_changed.connect(_on_gui_focus_changed)


func _unwatch_viewport() -> void:
	if _watched != null and is_instance_valid(_watched):
		if _watched.size_changed.is_connected(queue_layout):
			_watched.size_changed.disconnect(queue_layout)
		if _watched.gui_focus_changed.is_connected(_on_gui_focus_changed):
			_watched.gui_focus_changed.disconnect(_on_gui_focus_changed)
	_watched = null


static var _pad_bound := false


## Godot's default input map binds ui_accept to the keyboard and ui_cancel to Escape only in some
## projects (measured on 4.4.1 and 4.7.2: a joypad A and B then do nothing on a kit screen). Add the
## pad's A (accept) and B (cancel) to an action that has no joypad button of its own, once, keeping
## every binding the game made. Called by the PolarisKey autoload and by every kit view.
static func ensure_pad_bindings() -> void:
	if _pad_bound:
		return
	_pad_bound = true
	for pair in [[&"ui_accept", JOY_BUTTON_A], [&"ui_cancel", JOY_BUTTON_B]]:
		var action: StringName = pair[0]
		if not InputMap.has_action(action):
			continue
		var has_pad := false
		for e in InputMap.action_get_events(action):
			if e is InputEventJoypadButton:
				has_pad = true
		if not has_pad:
			var ev := InputEventJoypadButton.new()
			ev.button_index = pair[1]
			InputMap.action_add_event(action, ev)


## The last kind of input, for `pointer_last`; and a modal's input guard.
func _input(event: InputEvent) -> void:
	if event is InputEventKey or event is InputEventJoypadButton or (event is InputEventJoypadMotion and absf((event as InputEventJoypadMotion).axis_value) > 0.5):
		pointer_last = false
		_pointer_known = true
	elif event is InputEventMouseButton or event is InputEventScreenTouch:
		pointer_last = true
		_pointer_known = true
	if _guard_until > 0 and Time.get_ticks_msec() < _guard_until and is_visible_in_tree() and outer_view() == self:
		if event is InputEventKey or event is InputEventJoypadButton or event is InputEventMouseButton or event is InputEventScreenTouch:
			get_viewport().set_input_as_handled()


func _unhandled_input(event: InputEvent) -> void:
	if not is_visible_in_tree():
		return
	var inside := _has_focus_inside()
	if event.is_action_pressed("ui_cancel") and (inside or (outer_view() == self and not _focus_elsewhere())):
		if _cancel():
			get_viewport().set_input_as_handled()
		return
	# Nothing has focus (a screen opened after a pointer): the first direction or accept key
	# focuses the screen's initial control and is consumed.
	if outer_view() == self and not inside and not _focus_elsewhere() and _is_nav_event(event):
		if ensure_focus(true):
			get_viewport().set_input_as_handled()


static func _is_nav_event(event: InputEvent) -> bool:
	for a in ["ui_up", "ui_down", "ui_left", "ui_right", "ui_accept"]:
		if event.is_action_pressed(a):
			return true
	return false


## True when something outside this view holds the focus (the game's own control).
func _focus_elsewhere() -> bool:
	var f := get_viewport().gui_get_focus_owner() if get_viewport() != null else null
	return f != null and f != self and not is_ancestor_of(f)


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
	var outer := outer_view() == self
	if outer and is_inside_tree():
		metrics = _measure()
	# The control holding focus before the render, and its place in the chain: a render can hide or
	# disable it, and the engine then drops the focus.
	var held: Control = null
	if outer and is_inside_tree():
		held = get_viewport().gui_get_focus_owner()
		if held != null and not (held == self or is_ancestor_of(held)):
			held = null
	var held_at := _last_chain.find(held) if held != null else -1
	_resolve_theme()
	_render_brand()
	_render()
	if outer:
		# What the device decides (a phone shows no QR code, say) is rendered by every view inside,
		# not only the ones whose own state changed.
		for v in _views():
			if v != self:
				(v as PKeyUiView)._render()
	auto_hide(self)
	wire_focus()
	layout_content()
	if outer:
		if held != null and held_at >= 0 and not held.has_focus() and _lost_index < 0:
			_lost_index = held_at
		_manage_focus.call_deferred()
	elif is_inside_tree():
		# A view nested in another (the activation panel in the gate) changed what it shows: the
		# outermost view owns the focus, and asks for it again when the screen it shows differs
		# (a device limit replaced the key field the focus was on).
		outer_view()._manage_focus.call_deferred()


## Hide every container under `n` marked AUTO_HIDE_META whose children are all hidden, innermost
## first, and show one it hid again once a child shows. A container the scene hid itself stays
## hidden.
static func auto_hide(n: Node) -> bool:
	var any := false
	for ch in n.get_children():
		if not (ch is CanvasItem):
			continue
		var item := ch as CanvasItem
		if ch.has_meta(AUTO_HIDE_META):
			var inner := auto_hide(ch)
			if not inner and item.visible:
				item.visible = false
				item.set_meta(AUTO_HIDDEN_META, true)
			elif inner and not item.visible and item.has_meta(AUTO_HIDDEN_META):
				item.visible = true
			if item.visible and item.has_meta(AUTO_HIDDEN_META):
				item.remove_meta(AUTO_HIDDEN_META)
		elif ch is Container and not (ch is PKeyUiView):
			auto_hide(ch)
		any = any or item.visible
	return any


## Follow the UI options (`PKeyUiTheme`) while the scene is still on a kit stock theme: the brand
## theme when branding is on, else the neutral theme derived from the scene's place in the tree,
## in the screen's scale and density (`PKeyUiTheme.variant()`). A scene given a Theme of its own
## (no `pkey_stock` meta) keeps it. Runs on every refresh and whenever the scale or density
## changes, so options applied after the scene entered the tree (PolarisKey.boot() configures from
## polaris_key.tres once its view is already shown) still take effect.
func _resolve_theme() -> void:
	if not is_inside_tree() or not PKeyUiTheme.is_stock(theme):
		return
	if not PKeyUiTheme.branded() and PKeyUiTheme.override == null and _is_brand_theme(theme):
		# Back to neutral: derive it from the tree, not from the brand theme still applied here.
		theme = null
	var m := layout_metrics()
	var t := PKeyUiTheme.variant(PKeyUiTheme.for_view(self), m["scale"], m["density"])
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
			# The focus is leaving this control (hidden or disabled): remember its place in the
			# old chain so the new chain can take it at the same index.
			_lost_index = maxi(_last_chain.find(ctl), 0)
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
	_last_chain = chain
	_after_wire()


## After a render: focus a control when the view needs one (see `ensure_focus()`), at the index the
## lost focus held, or the screen's initial control when the screen itself changed.
func _manage_focus() -> void:
	if not is_inside_tree():
		return
	var visible_now := is_visible_in_tree()
	var key := _screen_key()
	var changed := key != _focus_key or (visible_now and not _was_visible)
	_focus_key = key
	_was_visible = visible_now
	if not visible_now:
		return
	if _lost_index >= 0 and not changed:
		var chain := focus_order()
		var idx := _lost_index
		_lost_index = -1
		if not chain.is_empty() and not _focus_elsewhere() and not _has_focus_inside():
			chain[clampi(idx, 0, chain.size() - 1)].grab_focus()
		return
	_lost_index = -1
	if changed:
		if _guard_for_modal():
			_guard_until = Time.get_ticks_msec() + MODAL_GUARD_MSEC
		# A dialog over a running game takes the focus from the game's own control (a pad's A
		# must answer the dialog, never press the game's button behind it) and gives it back
		# when it closes.
		# The screen changed under a focus already inside it (a sign-in code arrived while Cancel was
		# focused): the new screen's primary takes it, unless it is already there.
		if _has_focus_inside():
			var lead := _initial_focus()
			if lead != null and lead.is_inside_tree() and is_focusable(lead) and not lead.has_focus():
				lead.grab_focus()
			return
		var takes := _takes_focus_from_game()
		if takes and not _has_focus_inside():
			remember_opener()
		ensure_focus(takes)


## Focus the view's initial control when nothing inside it has focus: after keyboard or joypad
## input, or `force` (a direction or accept key pressed while nothing is focused). After a mouse or
## touch nothing is focused until `force`. Returns true when a control now has focus.
func ensure_focus(force := false) -> bool:
	var outer := outer_view()
	if outer != self:
		return outer.ensure_focus(force)
	if not is_inside_tree() or not is_visible_in_tree():
		return false
	var f := get_viewport().gui_get_focus_owner()
	if f != null and (f == self or is_ancestor_of(f)) and is_focusable(f):
		return true
	if _focus_elsewhere() and not force:
		return false
	var pointer := pointer_last if _pointer_known else (DisplayServer.is_touchscreen_available() and Input.get_connected_joypads().is_empty() and not _has_keyboard())
	if pointer and not force:
		return false
	var c := _initial_focus()
	if c == null or not c.is_inside_tree():
		var chain := focus_order()
		c = chain[0] if not chain.is_empty() else null
	if c == null:
		return false
	c.grab_focus()
	return c.has_focus()


static func _has_keyboard() -> bool:
	return OS.has_feature("pc") or OS.has_feature("web")


## The control a screen puts focus on when it opens: its primary action, else the first control.
## Scenes override it (a stop card: Try again; a pad-only gate: Sign in).
func _initial_focus() -> Control:
	var chain := focus_order()
	for ctl in chain:
		if ctl is Button and ctl.theme_type_variation == &"PKeyPrimary":
			return ctl
	return chain[0] if not chain.is_empty() else null


## A key naming the screen the view shows now: when it changes, the view asks for focus again.
func _screen_key() -> String:
	return ""


## Whether this view, as the outermost one, opens over a running game and so takes the focus from
## the game's control (the scrim dialogs: update modal, sign-in, offline activation, settings).
func _takes_focus_from_game() -> bool:
	return outer_view() == self and _scrim_wanted()


## Whether this view guards its first 250 ms against input (a modal).
func _guard_for_modal() -> bool:
	return false


## Remember the control that has focus now (the one that opened this view), to give it back on
## `close_view()`.
func remember_opener() -> void:
	var f := get_viewport().gui_get_focus_owner() if is_inside_tree() else null
	_opener = f if f != null and f != self and not is_ancestor_of(f) else null


static func _give_back(opener: Control, view: WeakRef) -> void:
	var v = view.get_ref()
	if v != null:
		if (v as Node).is_inside_tree():
			return
		v._opener = null
	if is_instance_valid(opener) and opener.is_inside_tree() and is_focusable(opener):
		opener.grab_focus()


## Give the focus back to the control that opened this view, if it is still there.
func restore_opener() -> void:
	if _opener != null and is_instance_valid(_opener) and _opener.is_inside_tree() and is_focusable(_opener):
		_opener.grab_focus.call_deferred()
	_opener = null


## Called after the focus chain is wired: a scene adds focus neighbours of its own.
func _after_wire() -> void:
	pass


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


# ── Measuring ────────────────────────────────────────────────────────────────────────────

## The measurements every layout decision reads, taken by the outermost view:
##
##   area       Vector2  the size the outermost view lays out in (logical pixels)
##   insets     Array    [left, top, right, bottom] the device's safe area keeps clear in it
##   room       Vector2  the area less the insets
##   screen     Vector2  the viewport's visible size (logical pixels)
##   physical   float    physical pixels per logical pixel on the screen
##   scale      float    every stock-theme size is this many times its scale-1 value
##   density    String   "spacious", "comfortable" or "compact"
##   landscape  bool     the room is wider than tall, with room for two columns
func layout_metrics() -> Dictionary:
	var outer := outer_view()
	if outer.metrics.is_empty():
		outer.metrics = outer._measure()
	return outer.metrics


## True on a landscape layout with room for two columns (see `layout_metrics()`).
func is_landscape() -> bool:
	return layout_metrics()["landscape"]


func _measure() -> Dictionary:
	var area := _area_size()
	var ins := safe_insets()
	var room := Vector2(maxf(1.0, area.x - ins[0] - ins[2]), maxf(1.0, area.y - ins[1] - ins[3]))
	var screen := get_viewport_rect().size if is_inside_tree() else area
	var physical := physical_scale()
	var k := _scale_for(screen, physical)
	# A strip (not stretched vertically) takes its density from the screen's height, not its own.
	var tall := room.y if _stretches_vertically() else maxf(room.y, screen.y)
	var u := Vector2(room.x, tall) / k
	var density: String = PKeyUiTheme.density
	if u.x < COMPACT_ROOM.x or u.y < COMPACT_ROOM.y:
		density = "compact"
	elif (u.x < COMFORTABLE_ROOM.x or u.y < COMFORTABLE_ROOM.y) and density == "spacious":
		density = "comfortable"
	var density_base := density
	# The last step of the squeeze ladder (4): everything at the compact density.
	if _squeeze >= 4:
		density = "compact"
	var landscape := room.x > room.y and room.x / k >= COLUMNS_MIN_WIDTH
	var mobile := is_mobile()
	return {
		"area": area,
		"insets": ins,
		"room": room,
		"screen": screen,
		"physical": physical,
		"scale": k,
		"density": density,
		"density_base": density_base,
		"landscape": landscape,
		# A phone's layout: portrait, on a phone or on a panel narrower than a phone.
		# (A tablet, 600 dp or more on its shorter side, is not one: it gets a centred card.)
		"phone": room.y >= room.x and ((mobile and minf(screen.x, screen.y) * physical / device_dpr() < 600.0) or room.x / k < PHONE_MAX_WIDTH),
		"mobile": mobile,
		# On a phone a control is at least 48 dp tall: the floor, in layout pixels.
		"min_control": MOBILE_CONTROL_DP * device_dpr() / physical if mobile else 0.0,
		# Two identity-plus-form panes only on a wide enough, wide-shaped panel (Deck 1.6, 16:9).
		"wide": landscape and room.x / room.y >= 1.5,
	}


## True on a phone or tablet.
static func is_mobile() -> bool:
	if mobile_override is bool:
		return mobile_override
	if mobile_override is Dictionary:
		return true
	return OS.has_feature("mobile")


## True on a phone: a mobile device whose shorter side is under 600 dp, in either orientation (a
## tablet is not one).
func is_phone_device() -> bool:
	if not is_mobile():
		return false
	var screen := get_viewport_rect().size if is_inside_tree() else Vector2(1, 1) * 400.0
	return minf(screen.x, screen.y) * physical_scale() / device_dpr() < 600.0


## Density-independent pixels per 160 dpi: the factor a platform minimum (16 dp, 48 dp) is
## multiplied by to get physical pixels.
static func device_dpr() -> float:
	if mobile_override is Dictionary:
		return float((mobile_override as Dictionary).get("dpr", 2.0))
	var dpi := DisplayServer.screen_get_dpi()
	if dpi > 0:
		return float(dpi) / 160.0
	return maxf(1.0, DisplayServer.screen_get_scale())


## True when a joypad is the only input here (a TV, a console, a Steam Deck in game mode).
static func pad_only() -> bool:
	if pad_only_override is bool:
		return pad_only_override
	return PKeyActivationController.manage_presentation_here() == "qr"


## The scale for a screen of `screen` logical pixels: 1 at REFERENCE, within SCALE_MIN..SCALE_MAX
## in SCALE_STEP steps, on the Polaris Key theme. The neutral look and a game's own theme are
## measured against the size the game designed its theme for (display/window/size) and scale the
## same way, unless the engine already scales the UI (a stretch mode: physical pixels per logical
## one other than 1), where they stay as they are; they only shrink on a screen under 80 % of it.
## On a phone the floor is whatever puts body text at 16 dp. A Theme the kit did not build is
## never scaled.
func _scale_for(screen: Vector2, physical := 1.0) -> float:
	if not PKeyUiTheme.is_stock(outer_view().theme):
		return 1.0
	var branded := PKeyUiTheme.branded()
	var ref := REFERENCE if screen.x >= screen.y else REFERENCE_PORTRAIT
	if not branded:
		var design := Vector2(
			float(ProjectSettings.get_setting("display/window/size/viewport_width", 1152)),
			float(ProjectSettings.get_setting("display/window/size/viewport_height", 648)))
		ref = design if screen.x >= screen.y else Vector2(design.y, design.x)
		if absf(physical - 1.0) > 0.01:
			return 1.0
	var raw := minf(screen.x / ref.x, screen.y / ref.y)
	var top := SCALE_MAX
	var k := clampf(floorf(raw / SCALE_STEP + 0.001) * SCALE_STEP, SCALE_MIN, top)
	if is_mobile():
		# Body text at 16 dp or more: the ladder's floor on a phone, raised past the usual top.
		var body := 18.0 if branded else float(PKeyUiTheme.neutral_body_size(outer_view().theme))
		var need := MOBILE_BODY_DP * device_dpr() / (body * physical)
		k = maxf(k, ceilf(need / SCALE_STEP - 0.001) * SCALE_STEP)
		k = minf(k, 4.0)
	return k


func _stretches_vertically() -> bool:
	return anchor_top != anchor_bottom or get_parent() is Container


## The size the view lays out in: what a Container gives it; else, along an axis it is anchored to
## stretch on, the span its anchors and offsets take of its parent (never its own size, which its
## content's minimum can inflate), and along any other axis its parent's (or the viewport's).
func _area_size() -> Vector2:
	if not is_inside_tree():
		return size
	var vp := get_viewport_rect().size
	var parent := get_parent()
	if parent is Container:
		return Vector2(maxf(size.x, 1.0), maxf(size.y, 1.0))
	var pc := parent as Control
	var ps := pc.size if pc != null else vp
	var w := ps.x * (anchor_right - anchor_left) + offset_right - offset_left if anchor_left != anchor_right else ps.x
	var h := ps.y * (anchor_bottom - anchor_top) + offset_bottom - offset_top if anchor_top != anchor_bottom else ps.y
	return Vector2(w if w >= 1.0 else vp.x, h if h >= 1.0 else vp.y)


## Physical pixels per logical pixel where this view is drawn: the stretch of every viewport
## between it and the screen (content scale, canvas_items or viewport stretch, a SubViewport's 2D
## override).
func physical_scale() -> float:
	if not is_inside_tree():
		return 1.0
	var s := 1.0
	var vp := get_viewport()
	var guard := 0
	while vp != null and guard < 8:
		s *= absf(vp.get_final_transform().get_scale().x)
		var p := vp.get_parent()
		vp = p.get_viewport() if p != null else null
		guard += 1
	return maxf(s, 0.01)


## [left, top, right, bottom], in this view's logical pixels: the part of the outermost view the
## device keeps for a notch, a camera cut-out, rounded corners or the home indicator
## (`DisplayServer.get_display_safe_area()`), on a phone or tablet; zero elsewhere, and zero for a
## view that does not reach those edges.
func safe_insets() -> Array:
	if safe_insets_override is Array and (safe_insets_override as Array).size() == 4:
		return safe_insets_override
	var none := [0.0, 0.0, 0.0, 0.0]
	var outer := outer_view()
	if not OS.has_feature("mobile") or not outer.is_inside_tree():
		return none
	var win := outer.get_window()
	if win == null or outer.get_viewport() != win or win != outer.get_tree().root:
		return none
	var safe := Rect2(DisplayServer.get_display_safe_area())
	if safe.size.x <= 0.0 or safe.size.y <= 0.0:
		return none
	var origin := Vector2(DisplayServer.window_get_position())
	var to_logical := win.get_final_transform().affine_inverse()
	var a := to_logical * (safe.position - origin)
	var b := to_logical * (safe.end - origin)
	var r := outer.get_global_rect()
	return [maxf(0.0, a.x - r.position.x), maxf(0.0, a.y - r.position.y), maxf(0.0, r.end.x - b.x), maxf(0.0, r.end.y - b.y)]


## A layout role from the theme (PKeyUiTheme: `page_margin`, `card_padding`, `section_gap`,
## `stack_gap`, `tight_gap`, `inline_gap`, `column_gap`, `control_height`, `control_padding`,
## `card_width`, `card_width_wide`, `content_width`, `qr_size`, `space_N`), in logical pixels.
## A Theme of the game's own that does not set it gets the kit's value for the screen.
func role(name: StringName) -> float:
	var v := _role(name)
	if name == &"control_height":
		v = maxf(v, float(layout_metrics().get("min_control", 0.0)))
	return v


func _role(name: StringName) -> float:
	if has_theme_constant(name, PKeyUiTheme.LAYOUT_TYPE):
		return float(get_theme_constant(name, PKeyUiTheme.LAYOUT_TYPE))
	var m := layout_metrics()
	var roles: Dictionary = PKeyUiTheme.DENSITIES.get(m["density"], PKeyUiTheme.DENSITIES[PKeyUiTheme.DEFAULT_DENSITY])
	return float(roles.get(name, PKeyUiTheme.MEASURES.get(name, 0))) * float(m["scale"])


## The space kept on each side between the outermost view's (safe) edge and its content, beyond
## the view's own panel padding: `page_margin` in all, never under GUTTER.
func gutter() -> float:
	var outer := outer_view()
	var pad: float = (side_padding(outer) - outer._safe_applied[0] - outer._safe_applied[2]) / 2.0
	return maxf(0.0, maxf(GUTTER, role("page_margin")) - pad)


## The width and height the outermost view's content can take: the room less the view's own
## padding and a gutter on each side.
func content_room() -> Vector2:
	var outer := outer_view()
	var m := layout_metrics()
	var sx: float = outer._safe_applied[0] + outer._safe_applied[2]
	var sy: float = outer._safe_applied[1] + outer._safe_applied[3]
	var g := gutter()
	var room: Vector2 = m["room"]
	return Vector2(maxf(0.0, room.x - (side_padding(outer) - sx) - 2.0 * g), maxf(0.0, room.y - (end_padding(outer) - sy) - 2.0 * g))


## The height this view's content can take (logical pixels): the outermost view's content room,
## less the vertical padding of every panel between this view and it (a host card's, say).
func available_height() -> float:
	var room := content_room().y
	if _card_box != null and _card_shown():
		room -= end_padding(_card_box)
	var outer := outer_view()
	var n: Node = self
	while n != null and n != outer:
		if n is PanelContainer:
			room -= end_padding(n as Control)
		n = n.get_parent()
	return maxf(0.0, room)


## The side of a QR code that fits `room` (logical pixels): the theme's `qr_size`, within the
## room and QR_MAX_SHARE of the screen's shorter side, and never under QR_MIN_PHYSICAL on screen.
func qr_side(room := INF) -> float:
	var m := layout_metrics()
	var screen: Vector2 = m["screen"]
	var least := QR_MIN_PHYSICAL / float(m["physical"])
	var most := minf(room, QR_MAX_SHARE * minf(screen.x, screen.y))
	return roundf(maxf(least, minf(role("qr_size"), most)))


# ── Layout ───────────────────────────────────────────────────────────────────────────────

## Lay the view out again on the next idle frame (the viewport or the view changed size).
func queue_layout() -> void:
	if _layout_queued or not _built:
		return
	_layout_queued = true
	var frame := Engine.get_process_frames()
	if frame != _layout_frame:
		_layout_frame = frame
		_layouts_in_frame = 0
	_layouts_in_frame += 1
	if _layouts_in_frame > 8 and is_inside_tree():
		# A chain of re-layouts in one frame (text re-wrapping as widths settle) waits for the
		# next frame instead of filling the message queue.
		get_tree().process_frame.connect(_run_queued_layout, CONNECT_ONE_SHOT)
		return
	_run_queued_layout.call_deferred()


func _run_queued_layout() -> void:
	_layout_queued = false
	if is_inside_tree():
		layout_content()


## Measure and lay out the whole scene (the outermost view does it for every view inside it):
## the theme for the screen's scale and density, the safe area, then each view's `_arrange()`,
## outermost first. Safe at any time; called on every render and when the viewport changes size.
func layout_content() -> void:
	if not _built:
		return
	var outer := outer_view()
	if outer != self:
		outer.layout_content()
		return
	if not is_inside_tree():
		return
	_release_offsets()
	var before := metrics
	metrics = _measure()
	var views := _views()
	if before.get("scale") != metrics["scale"] or before.get("density") != metrics["density"]:
		for v in views:
			v._resolve_theme()
	_apply_safe_area(metrics["insets"])
	for v in views:
		v._arrange(metrics)
	# `_arrange()` re-parents nodes (`place()`), and the focus paths are relative to where a node
	# sits: wire them again once everything is in place, or a neighbour path no longer resolves.
	wire_focus()
	if before.get("landscape") != metrics["landscape"] or before.get("scale") != metrics["scale"] or before.get("density") != metrics["density"]:
		# A switch between layouts flips containers and moves nodes; the engine does not always
		# re-sort a container whose child's minimum changed that way, so re-sort them all.
		_resort_all(self)
	_schedule_checks()


## A view anchored across an axis of its parent (a full-screen scene) is exactly that big: the
## engine's `set_anchors_and_offsets_preset()` (a game's own call, or ours) writes the view's
## minimum size at that moment into its offsets, and a view first laid out before its content settled
## would then stay wider or shorter than the screen for good. The kit owns the offsets of such a view
## (a game that wants margins around it wraps it in a MarginContainer, or sets the `KEEP_OFFSETS_META`
## meta). This makes the arrangement a function of the size, not of how the view got there.
func _release_offsets() -> void:
	if get_parent() is Container or has_meta(KEEP_OFFSETS_META):
		return
	if is_zero_approx(anchor_left) and is_equal_approx(anchor_right, 1.0) and not (is_zero_approx(offset_left) and is_zero_approx(offset_right)):
		offset_left = 0.0
		offset_right = 0.0
	if is_zero_approx(anchor_top) and is_equal_approx(anchor_bottom, 1.0) and not (is_zero_approx(offset_top) and is_zero_approx(offset_bottom)):
		offset_top = 0.0
		offset_bottom = 0.0


## For a few frames after a layout pass, check that every container holds its children at their
## minimum at least, and re-sort the view when one does not: the engine drops a re-sort a
## container asks for while it is sorting, which text re-wrapping after a resize can do.
func _schedule_checks() -> void:
	_checks_left = 3
	_flips = 0
	_connect_check()


func _connect_check() -> void:
	var tree := get_tree() if is_inside_tree() else null
	if tree != null and not tree.process_frame.is_connected(_check_sorted):
		tree.process_frame.connect(_check_sorted, CONNECT_ONE_SHOT)


## How many steps a scene can squeeze (0: none). Each step drops something optional or moves
## something so the primary action and the user code stay on screen before any scrolling: 1 the QR
## code toward its smallest, 2 the actions into the spare space or under both columns, 3 the
## secondary lines.
func squeeze_max() -> int:
	return 0


func squeeze_level() -> int:
	return outer_view()._squeeze


## Step the squeeze up while the content is taller than the room (outermost, vertically bounded
## views only). Returns true when it changed.
func _fit_squeeze() -> bool:
	if outer_view() != self or squeeze_max() == 0 or not _stretches_vertically():
		return false
	var content := _content()
	if content == null:
		return false
	var m := layout_metrics()
	var key := "%s|%s|%s|%s|%s" % [m["area"], m["scale"], m["density_base"], m["landscape"], _screen_key()]
	if key != _squeeze_key:
		_squeeze_key = key
		_squeeze = 0
		return true
	# The content's own height, not the card's: a scrolling card is only as tall as its room.
	var need := content.get_combined_minimum_size().y
	var room := content_room().y
	if not _scrolls.is_empty() and (_scrolls[0] as ScrollContainer).get_child_count() > 0:
		var inner := (_scrolls[0] as ScrollContainer).get_child(0) as Control
		need = inner.get_combined_minimum_size().y
		room = available_height()
	if need > room + 0.5 and _squeeze < squeeze_max():
		_squeeze += 1
		return true
	return false


func _check_sorted() -> void:
	if not is_inside_tree():
		return
	if _fit_squeeze():
		_flips = 0
		_checks_left = 3
		# What a view renders can depend on the squeeze (a lede dropped at step 3): render again, not
		# only arrange, so the result is the same as a view that was first shown at this squeeze.
		refresh_view()
	var rows_changed := false
	for v in _views():
		if (v as PKeyUiView).fit_action_rows():
			rows_changed = true
	if rows_changed and _flips < 8:
		_flips += 1
		_resort_all(self)
		_checks_left = 3
	if _unsorted(self):
		_resort_all(self)
	if _scrolls_stale():
		queue_layout()
	_checks_left -= 1
	if _checks_left > 0:
		_connect_check()
	else:
		_reveal_focus()


var _reveal_pending := false


## A control took the focus: once the frame's layout has been sorted, bring it into view in the scroll
## areas it sits in (the engine's own follow-focus measures positions a re-sort is about to move, and
## a pad's focus could end on a button below the visible page).
func _on_gui_focus_changed(ctl: Control) -> void:
	if ctl == null or outer_view() != self or not (ctl == self or is_ancestor_of(ctl)) or _reveal_pending:
		return
	_reveal_pending = true
	await get_tree().process_frame
	_reveal_pending = false
	if is_inside_tree():
		_reveal_focus()


## Once the layout has settled, bring the focused control into view in every scroll area it sits in
## (a squeezed card that still scrolls must never leave the focused primary off screen).
func _reveal_focus() -> void:
	var f := get_viewport().gui_get_focus_owner() if is_inside_tree() else null
	if f == null or not (f == self or is_ancestor_of(f)):
		return
	var n := f.get_parent()
	while n != null and n != get_parent():
		if n is ScrollContainer and (n as ScrollContainer).vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED and not n.has_meta(MANUAL_SCROLL_META):
			(n as ScrollContainer).ensure_control_visible(f)
		n = n.get_parent()
	for v in _views():
		(v as PKeyUiView)._revealed(f)


## A view that scrolls its own list (`MANUAL_SCROLL_META`) brings the focused control `f` into view
## here, once the layout has settled.
func _revealed(_f: Control) -> void:
	pass


## Whether a scroll area's last decision no longer matches its content (measured on a frame whose
## text had not finished wrapping).
func _scrolls_stale() -> bool:
	for v in _views():
		if (v as PKeyUiView)._layout_stale():
			return true
		for sc in (v as PKeyUiView)._scrolls:
			if not sc.has_meta(&"pkey_fit") or sc.get_child_count() == 0:
				continue
			var fit: Array = sc.get_meta(&"pkey_fit")
			var content := sc.get_child(0) as Control
			var should: bool = fit[1] and content != null and content.get_combined_minimum_size().y > float(fit[0]) + 0.5
			if should != (sc.vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED):
				return true
	return false


## True when a decision this view took in `_arrange()` (the height of a list of its own, say) no
## longer matches the measurements it would take from the layout now: the view is laid out again.
func _layout_stale() -> bool:
	return false


static func _unsorted(n: Node) -> bool:
	for ch in n.get_children():
		if not (ch is Control) or not (ch as Control).visible:
			continue
		var c := ch as Control
		# A scroll area that passes its content through holds it at its minimum too.
		if n is Container and not (n is ScrollContainer and (n as ScrollContainer).vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED):
			var m := c.get_combined_minimum_size()
			if c.size.x + 0.5 < m.x or c.size.y + 0.5 < m.y:
				return true
			# Or a child that runs past its container (whose minimum the engine left stale).
			var pc := n as Control
			if c.position.x + c.size.x > pc.size.x + 0.5 or c.position.y + c.size.y > pc.size.y + 0.5:
				return true
		if _unsorted(ch):
			return true
	return false


static func _resort_all(n: Node) -> void:
	for ch in n.get_children():
		_resort_all(ch)
	if n is Control:
		(n as Control).update_minimum_size()
		if n is Container:
			(n as Container).queue_sort()


## This view and every PKeyUiView inside it, outermost first.
func _views() -> Array:
	var out: Array = [self]
	var i := 0
	while i < out.size():
		for ch in (out[i] as Node).get_children():
			_collect_views(ch, out)
		i += 1
	return out


static func _collect_views(n: Node, out: Array) -> void:
	if n is PKeyUiView:
		if not out.has(n):
			out.append(n)
		return
	for ch in n.get_children():
		_collect_views(ch, out)


## Lay this view out for `m` (`layout_metrics()`): a nested view draws no page ground of its own,
## every button and input takes the theme's control height, and the outermost view centres its
## content at `content_width()`. Subclasses add their landscape and portrait arrangements and call
## this first.
func _arrange(_m: Dictionary) -> void:
	_apply_scrim()
	_nest_panel()
	_style_card()
	_size_controls(self)
	auto_hide(self)
	_apply_width(content_width())
	fit_scrolls(available_height(), outer_view() == self and _stretches_vertically())


## A PanelContainer for a dialog's content, under this view: the theme's card (PKeyCard) while
## the view is the outermost one, nothing while a host card holds it (`_card_shown()`). Returns
## the parent for the content: the card's scroll area (`scroll_area()`), or with `scrolls` false
## the card itself (a view that scrolls a list of its own).
func card_panel(node_name := "Card", scrolls := true) -> Container:
	var p := PanelContainer.new()
	p.name = node_name
	add_child(p)
	_card_box = p
	return scroll_area(p) if scrolls else p


## A vertical scroll area under `parent`: a plain pass-through (exactly its content's height)
## while the screen has the room, scrolling (following a gamepad's focus) only when it has not,
## the last resort for a game's own theme with type too large for a small screen.
## `fit_scrolls()` decides.
func scroll_area(parent: Node, node_name := "Scroll") -> ScrollContainer:
	var sc := ScrollContainer.new()
	sc.name = node_name
	sc.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	sc.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	sc.follow_focus = true
	parent.add_child(sc)
	_scrolls.append(sc)
	return sc


## Let this view's scroll areas scroll only where `bounded` and their content is taller than
## `room` (then they are `room` tall); otherwise they pass their content's height through. Runs
## again whenever a content's minimum size changes.
func fit_scrolls(room: float, bounded: bool) -> void:
	for sc in _scrolls:
		var content: Control = null
		for ch in sc.get_children():
			if ch is Control:
				content = ch
		if content == null:
			continue
		if not content.minimum_size_changed.is_connected(queue_layout):
			content.minimum_size_changed.connect(queue_layout)
		# A ScrollContainer stretches its child only along an axis it is set to expand on.
		content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		content.size_flags_vertical = Control.SIZE_EXPAND_FILL
		var need := content.get_combined_minimum_size().y
		sc.set_meta(&"pkey_fit", [room, bounded])
		var scrolls := bounded and need > room + 0.5
		if scrolls and sc.vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED and not is_equal_approx(float(sc.get_meta(&"pkey_scroll_room", -1.0)), room):
			# Scrolling, the bar narrows the content and its text wraps taller: measure once more
			# at the full width (pass through) before scrolling for this room, and only once.
			scrolls = false
			sc.set_meta(&"pkey_scroll_room", room)
		var mode := ScrollContainer.SCROLL_MODE_AUTO if scrolls else ScrollContainer.SCROLL_MODE_DISABLED
		if sc.vertical_scroll_mode != mode:
			sc.vertical_scroll_mode = mode
		# Passing through, it clips nothing (a focus ring at its edge shows whole).
		sc.clip_contents = scrolls
		var want := maxf(0.0, room) if scrolls else 0.0
		if not is_equal_approx(sc.custom_minimum_size.y, want):
			sc.custom_minimum_size.y = want


## Whether the dialog draws its own card now: while it is the outermost view.
func _card_shown() -> bool:
	return outer_view() == self


## The card's left plus right padding while it shows, else 0.
func card_padding_x() -> float:
	if _card_box == null or not _card_shown() or (phone_bleed() and not phone_sheet()):
		return 0.0
	return side_padding(_card_box) + scrollbar_width()


## The width this view's content can take: the room the screen leaves, less the padding of every
## panel around it (a host card's) and of its own card.
func room_x() -> float:
	return maxf(0.0, card_width(INF) - card_padding_x())


## The width a scrolling card's scroll bar takes from its content (0 while it passes through).
func scrollbar_width() -> float:
	if _scrolls.is_empty():
		return 0.0
	var sc := _scrolls[0] as ScrollContainer
	if sc.vertical_scroll_mode == ScrollContainer.SCROLL_MODE_DISABLED:
		return 0.0
	return sc.get_v_scroll_bar().get_combined_minimum_size().x


## The type variation of the dialog's card while it shows (PKeyBanner for a strip's card).
func _card_variation() -> String:
	return "PKeyCard"


## Whether this view is a strip that floats its card (it manages its own panel margins).
func _floats() -> bool:
	return false


## A transparent panel for a strip that floats its card `page_margin` in from the top and the
## sides of the screen (the update banner, the status banner).
func _float_strip() -> void:
	var m := role("page_margin")
	# The safe area (a status bar, a notch) pushes the card further in.
	var want := [m + _safe_applied[0], m + _safe_applied[1], m + _safe_applied[2], 0.0]
	var box := get_theme_stylebox("panel") as StyleBoxEmpty
	var have := [box.content_margin_left, box.content_margin_top, box.content_margin_right, box.content_margin_bottom] if box != null else []
	if have != want:
		var e := StyleBoxEmpty.new()
		e.content_margin_left = want[0]
		e.content_margin_top = want[1]
		e.content_margin_right = want[2]
		e.content_margin_bottom = want[3]
		add_theme_stylebox_override("panel", e)


func _style_card() -> void:
	if _card_box == null:
		return
	if _card_shown() and phone_sheet():
		# A dialog over the game on a phone: an opaque sheet docked to the bottom, never text drawn
		# straight onto the scrim (a busy frame behind it would swallow a user code).
		if _card_box.has_theme_stylebox_override("panel"):
			_card_box.remove_theme_stylebox_override("panel")
		_card_box.theme_type_variation = _card_variation()
		_card_box.size_flags_vertical = Control.SIZE_SHRINK_END
		# A phone's sheet pads less than a desktop card: the width is the content's.
		var base := _card_box.get_theme_stylebox("panel")
		if base is StyleBoxFlat:
			var pad := maxf(12.0, roundf(role("card_padding") * 0.6))
			var cur := (_card_box.get_theme_stylebox("panel") as StyleBoxFlat)
			if not is_equal_approx(cur.content_margin_left, pad) or not _card_box.has_theme_stylebox_override("panel"):
				var box := (base as StyleBoxFlat).duplicate() as StyleBoxFlat
				box.set_content_margin_all(pad)
				_card_box.add_theme_stylebox_override("panel", box)
	elif _card_shown() and phone_bleed():
		_card_box.size_flags_vertical = Control.SIZE_FILL
		# Full-bleed: the page is the card, at the page margin from the (safe) edges.
		var pad := maxf(0.0, role("page_margin") - side_padding(outer_view()) / 2.0)
		var e := _card_box.get_theme_stylebox("panel") as StyleBoxEmpty if _card_box.has_theme_stylebox_override("panel") else null
		if e == null or not is_equal_approx(e.content_margin_left, pad) or not is_equal_approx(e.content_margin_top, pad) or not is_equal_approx(e.content_margin_bottom, pad):
			var box := StyleBoxEmpty.new()
			box.content_margin_left = pad
			box.content_margin_right = pad
			box.content_margin_top = pad
			box.content_margin_bottom = pad
			_card_box.add_theme_stylebox_override("panel", box)
	elif _card_shown():
		_card_box.size_flags_vertical = Control.SIZE_FILL
		if _card_box.has_theme_stylebox_override("panel"):
			_card_box.remove_theme_stylebox_override("panel")
		_card_box.theme_type_variation = _card_variation()
	elif not _card_box.has_theme_stylebox_override("panel"):
		_card_box.add_theme_stylebox_override("panel", StyleBoxEmpty.new())


## Whether the outermost view fills a phone's screen edge to edge (UI-KITS.md §1.5): portrait, on a
## phone, for a scene that bleeds (`_bleeds()`). Its content is then top-aligned under the safe
## area, its actions dock to the bottom, and no card floats.
func phone_bleed() -> bool:
	return outer_view() == self and _bleeds() and bool(layout_metrics().get("phone", false))


func _bleeds() -> bool:
	return false


## Whether this view, the outermost one, is a dialog over the game on a phone: it sits on an opaque
## sheet docked to the bottom (the scrim above it shows the game, dimmed).
func phone_sheet() -> bool:
	return phone_bleed() and _scrim_wanted()


## Whether the screen this view is on bleeds on a phone: its own state as the outermost view, the
## outermost view's when it sits inside one (a dialog inside the gate).
func phone_screen() -> bool:
	return outer_view().phone_bleed()


## Whether, as the outermost view, this one paints the scrim over the game instead of an opaque
## page (a dialog that opens over a running game; UI-KITS.md §2.1 scrim tokens).
func _scrim_wanted() -> bool:
	return false


func _apply_scrim() -> void:
	if outer_view() == self and _scrim_wanted():
		if theme_type_variation != &"PKeyScrim":
			theme_type_variation = &"PKeyScrim"
	elif theme_type_variation == &"PKeyScrim":
		theme_type_variation = &""


func _nest_panel() -> void:
	if _own_panel:
		return
	var nested := outer_view() != self
	var has := has_theme_stylebox_override("panel")
	if nested and not has:
		add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	elif not nested and has and _safe_base == null and not _any_safe():
		remove_theme_stylebox_override("panel")


func _size_controls(n: Node) -> void:
	var h := role("control_height")
	for ch in n.get_children():
		if ch is PKeyUiView:
			continue
		if (ch is Button or ch is LineEdit or ch is SpinBox) and not ch.has_meta(FREE_HEIGHT_META):
			var ctl := ch as Control
			if not is_equal_approx(ctl.custom_minimum_size.y, h):
				ctl.custom_minimum_size.y = h
		if ch.get_class() == "Button":
			_fit_label(ch as Button)
		if not (ch is SpinBox):
			_size_controls(ch)


## A button at least as wide as its label measures plus its padding, with a little slack: at
## exactly its own minimum width the engine drops a bold label's last glyph.
static func _fit_label(b: Button) -> void:
	var w := 0.0
	if b.text != "":
		var box := b.get_theme_stylebox("normal")
		w = ceilf(text_width(b, b.text) + 0.1 * b.get_theme_font_size("font_size") + (box.get_minimum_size().x if box != null else 0.0))
	if not is_equal_approx(b.custom_minimum_size.x, w):
		b.custom_minimum_size.x = w


func _any_safe() -> bool:
	return _safe_applied.any(func(x): return x > 0.0)


## Pad the outermost view by the safe-area insets (on top of its theme padding).
func _apply_safe_area(ins: Array) -> void:
	var want: Array = ins.map(func(x): return roundf(float(x)))
	if _floats():
		# A floating strip folds the insets into its own margins (`_float_strip()`).
		_safe_applied = want
		return
	if want == _safe_applied and (theme == _safe_theme or not _any_safe()):
		return
	if _any_safe():
		if _safe_base != null:
			add_theme_stylebox_override("panel", _safe_base)
		else:
			remove_theme_stylebox_override("panel")
		_safe_base = null
	_safe_applied = want
	_safe_theme = theme
	if not _any_safe():
		return
	if has_theme_stylebox_override("panel"):
		_safe_base = get_theme_stylebox("panel")
	var base := get_theme_stylebox("panel")
	var box: StyleBox = base.duplicate() if base != null else StyleBoxEmpty.new()
	box.content_margin_left = (base.get_margin(SIDE_LEFT) if base != null else 0.0) + want[0]
	box.content_margin_top = (base.get_margin(SIDE_TOP) if base != null else 0.0) + want[1]
	box.content_margin_right = (base.get_margin(SIDE_RIGHT) if base != null else 0.0) + want[2]
	box.content_margin_bottom = (base.get_margin(SIDE_BOTTOM) if base != null else 0.0) + want[3]
	add_theme_stylebox_override("panel", box)


## The width the centred content gets now: `max_content_width` at the screen's scale, capped by
## the room less the gutters; 0 when this view does not centre (nested, or `max_content_width` 0).
func content_width() -> float:
	if max_content_width <= 0.0 or not is_inside_tree():
		return 0.0
	var parent := get_parent() as Control
	var anchored := parent == null or not (parent is Container)
	if outer_view() != self and not anchored:
		return 0.0
	return maxf(0.0, minf(max_content_width * float(layout_metrics()["scale"]), content_room().x))


## Give the content `width` (0: fill). The default centres `_content()`; full-screen scenes
## that centre a card themselves override it.
func _apply_width(width: float) -> void:
	var content := _content()
	if content == null:
		return
	if phone_screen():
		content.size_flags_horizontal = Control.SIZE_FILL
		content.size_flags_vertical = Control.SIZE_SHRINK_END if outer_view().phone_sheet() else Control.SIZE_FILL
		content.custom_minimum_size.x = 0.0
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
## width of a card a full-screen scene centres in a CenterContainer. The room is the outermost
## view's content room (less its gutters and padding), less the padding of every panel between
## this view and it.
func card_width(wanted: float) -> float:
	if not is_inside_tree():
		return wanted
	var room := content_room().x
	var outer := outer_view()
	var n: Node = self
	while n != null and n != outer:
		if n is PanelContainer:
			room -= side_padding(n as Control)
		n = n.get_parent()
	return maxf(0.0, minf(wanted, room))


## The left plus right content margins of `panel`'s "panel" stylebox.
static func side_padding(panel: Control) -> float:
	var box := panel.get_theme_stylebox("panel")
	return box.get_margin(SIDE_LEFT) + box.get_margin(SIDE_RIGHT) if box != null else 0.0


## The top plus bottom content margins of `panel`'s "panel" stylebox.
static func end_padding(panel: Control) -> float:
	var box := panel.get_theme_stylebox("panel")
	return box.get_margin(SIDE_TOP) + box.get_margin(SIDE_BOTTOM) if box != null else 0.0


## The node `_apply_width()` centres: the first child Control by default.
func _content() -> Control:
	for n in get_children():
		if n is Control and not (n as Control).top_level:
			return n
	return null


## Move `node` under `parent` at `index` (-1: last) unless it is already there. Only for nodes
## that take no focus (a QR code, a caption): a focusable control never moves, so a layout switch
## never drops a gamepad's place.
static func place(node: Node, parent: Node, index := -1) -> void:
	var old := node.get_parent()
	if old != parent:
		# Moving a subtree drops the focus held inside it: give it back.
		var held: Control = null
		if node.is_inside_tree():
			var f := node.get_viewport().gui_get_focus_owner()
			if f != null and (f == node or node.is_ancestor_of(f)):
				held = f
		if old != null:
			old.remove_child(node)
		parent.add_child(node)
		if held != null and held.is_inside_tree() and held.is_visible_in_tree():
			held.grab_focus()
	if index >= 0 and node.get_index() != index:
		parent.move_child(node, index)
	if old != parent:
		# The engine does not always re-sort every container between the two ends of a move.
		_resort(old)
		_resort(parent)


static func _resort(n: Node) -> void:
	while n != null:
		if n is Control:
			(n as Control).update_minimum_size()
			if n is Container:
				(n as Container).queue_sort()
		n = n.get_parent()


# ── Brand and product ────────────────────────────────────────────────────────────────────

## A TextureRect for the compact "Powered by Polaris Key" badge (`BRAND_POWERED_BY`, shown only when
## `PKeyUiTheme.powered_by` is on, at its kit minimum or larger, never cropped). Hidden otherwise:
## no screen carries a Polaris Key mark of its own, the product leads every one.
func brand_node(parent: Node, node_name: String, kind: StringName, align := Control.SIZE_SHRINK_CENTER) -> TextureRect:
	var r := TextureRect.new()
	r.name = node_name
	r.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	r.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	r.size_flags_horizontal = align
	r.visible = false
	r.custom_minimum_size = PKeyUiTheme.powered_by_size("compact")
	r.tooltip_text = PKeyBrand.POWERED_BY_PHRASE
	if "accessibility_name" in r:
		r.set("accessibility_name", PKeyBrand.POWERED_BY_PHRASE)
	parent.add_child(r)
	_brand_nodes.append([r, kind])
	return r


func _render_brand() -> void:
	if _brand_nodes.is_empty():
		return
	var dark := PKeyUiTheme.is_dark(self)
	for pair in _brand_nodes:
		var r: TextureRect = pair[0]
		var on := PKeyUiTheme.powered_by
		r.texture = PKeyUiTheme.powered_by_texture(dark) if on else null
		r.visible = on and r.texture != null


## The product's identity (UI-KITS.md §1.2, the product is the hero): its icon, or a monogram
## tile of its initial, beside its name (PKeyProductHeader). `hero` sizes it to lead a screen.
func product_header(parent: Node, node_name := "Product", hero := false) -> PKeyProductHeader:
	var h := PKeyProductHeader.new()
	h.name = node_name
	h.hero = hero
	parent.add_child(h)
	return h


# ── Builders for subclasses ──────────────────────────────────────────────────────────────

## A Label; `variation` is a theme type variation (PKeyTitle, PKeySection, PKeyMuted, PKeyCode,
## PKeyMono, PKeyError).
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


## A column whose gap is the theme's: `variation` is PKeyStack (related items, the default),
## PKeyTight (a title over its line, a label over its control) or PKeySections (a card's
## sections).
func vbox(parent: Node, node_name: String, variation := "PKeyStack") -> VBoxContainer:
	var v := VBoxContainer.new()
	v.name = node_name
	v.theme_type_variation = variation
	v.set_meta(AUTO_HIDE_META, true)
	parent.add_child(v)
	return v


## A row whose gap is the theme's `inline_gap` (PKeyRow).
func hbox(parent: Node, node_name: String, variation := "PKeyRow") -> HBoxContainer:
	var h := HBoxContainer.new()
	h.name = node_name
	h.theme_type_variation = variation
	h.set_meta(AUTO_HIDE_META, true)
	parent.add_child(h)
	return h


## A QR code on its white rounded tile (PKeyQrTile), under `parent`; returns the code. The tile
## shows while the code does.
func qr_tile(parent: Node, node_name := "QrCode") -> PKeyQrRect:
	var tile := PanelContainer.new()
	tile.name = node_name + "Tile"
	tile.theme_type_variation = "PKeyQrTile"
	tile.set_meta(AUTO_HIDE_META, true)
	tile.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	tile.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	parent.add_child(tile)
	var qr := PKeyQrRect.new()
	qr.name = node_name
	tile.add_child(qr)
	return qr


## A row of buttons that wraps when it runs out of width (PKeyActions), the primary action first.
func actions_row(parent: Node, node_name: String, align: int = BoxContainer.ALIGNMENT_CENTER) -> BoxContainer:
	var f := BoxContainer.new()
	f.name = node_name
	f.theme_type_variation = "PKeyActionRow"
	f.alignment = align as BoxContainer.AlignmentMode
	f.set_meta(AUTO_HIDE_META, true)
	f.set_meta(&"pkey_align", align)
	parent.add_child(f)
	_action_rows.append(f)
	return f


## Lay every action row out on one line while its buttons fit the width, and otherwise stack all of
## them at equal width, the primary (first) on top (UI-KITS.md §1.5 rules 10 and 11): never two on
## a line and one alone. Returns true when a row changed.
func fit_action_rows() -> bool:
	var changed := false
	for row in _action_rows:
		var r := row as BoxContainer
		if not is_instance_valid(r) or not r.is_visible_in_tree():
			continue
		var buttons: Array = []
		for ch in r.get_children():
			if ch is Control and (ch as Control).visible:
				buttons.append(ch)
		var need := 0.0
		for b in buttons:
			need += (b as Control).get_combined_minimum_size().x
		need += maxf(0.0, buttons.size() - 1.0) * float(r.get_theme_constant("separation"))
		var avail := r.size.x
		var parent := r.get_parent_control()
		if parent != null and parent.size.x > 0.0:
			avail = parent.size.x
		# A parent that grew to hold the row is no measure of the room: the width it was given, and
		# the screen's, are.
		if parent != null and parent.custom_minimum_size.x > 1.0:
			avail = minf(avail, parent.custom_minimum_size.x)
		if avail > 1.0:
			avail = minf(avail, card_width(INF) - card_padding_x())
		var stack: bool = outer_view().phone_bleed() or bool(r.get_meta(&"pkey_force_stack", false)) or (avail > 1.0 and need > avail + 0.5)
		if r.vertical != stack:
			r.vertical = stack
			changed = true
		for b in buttons:
			var want := Control.SIZE_FILL if stack else Control.SIZE_SHRINK_BEGIN
			if (b as Control).size_flags_horizontal != want:
				(b as Control).size_flags_horizontal = want
				changed = true
		var align: int = r.get_meta(&"pkey_align", BoxContainer.ALIGNMENT_CENTER)
		if not stack and r.alignment != align:
			r.alignment = align as BoxContainer.AlignmentMode
	return changed


## A control that takes the space left in its column: it docks what follows it (the actions) to the
## bottom of a full-height phone screen. Hidden unless `phone_bleed()`.
func spacer(parent: Node, node_name := "Spacer") -> Control:
	var c := Control.new()
	c.name = node_name
	c.mouse_filter = Control.MOUSE_FILTER_IGNORE
	c.size_flags_vertical = Control.SIZE_EXPAND_FILL
	c.visible = false
	parent.add_child(c)
	return c


## A status glyph (lock, cloud_off, warning) at `px` logical pixels, tinted by `modulate`.
func glyph_node(parent: Node, node_name: String, glyph_name: String) -> TextureRect:
	var r := TextureRect.new()
	r.name = node_name
	r.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	r.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	r.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	r.set_meta(&"pkey_glyph", glyph_name)
	parent.add_child(r)
	return r


## Draw the glyphs of this view for the screen's scale; `px` is the size at scale 1.
func size_glyph(r: TextureRect, px := 24.0, tint := Color.WHITE) -> void:
	var k := float(layout_metrics()["scale"]) * float(layout_metrics()["physical"])
	var side := maxf(16.0, roundf(px * float(layout_metrics()["scale"])))
	r.texture = PKeyUiTheme.glyph(String(r.get_meta(&"pkey_glyph")), Color.WHITE, px, k * 2.0)
	r.custom_minimum_size = Vector2(side, side)
	r.modulate = tint


## A 2 px indeterminate bar for a loading state, shown only once `loading` has been true for
## 250 ms (UI-KITS.md §1.5 rule 4). `set_loading()` drives it.
func loading_bar(parent: Node) -> ProgressBar:
	var b := ProgressBar.new()
	b.name = "Loading"
	b.show_percentage = false
	b.indeterminate = true
	b.visible = false
	b.set_meta(FREE_HEIGHT_META, true)
	b.mouse_filter = Control.MOUSE_FILTER_IGNORE
	b.custom_minimum_size.y = 2.0
	parent.add_child(b)
	_loading_bar = b
	return b


func set_loading(on: bool) -> void:
	if _loading_bar == null:
		return
	if not on:
		_loading_since = 0
		_loading_bar.visible = false
		return
	if _loading_since == 0:
		_loading_since = Time.get_ticks_msec()
	_loading_bar.visible = Time.get_ticks_msec() - _loading_since >= 250


## The loading bar's delay needs a timer when nothing else re-renders.
func _tick_loading() -> void:
	if _loading_bar != null and _loading_since > 0 and not _loading_bar.visible and Time.get_ticks_msec() - _loading_since >= 250:
		_loading_bar.visible = true


## Two parts side by side in landscape, stacked in portrait (`set_columns()`), `column_gap` apart
## (PKeyColumns).
func columns(parent: Node, node_name: String) -> BoxContainer:
	var b := BoxContainer.new()
	b.name = node_name
	b.theme_type_variation = "PKeyColumns"
	parent.add_child(b)
	return b


## Lay `box` (from `columns()`) out side by side (`column_gap` apart) or stacked (`section_gap`
## apart).
static func set_columns(box: BoxContainer, side_by_side: bool) -> void:
	box.vertical = not side_by_side
	box.theme_type_variation = "PKeyColumns" if side_by_side else "PKeySections"


## The width `text` takes in `ctl`'s font and size, on one line.
static func text_width(ctl: Control, text: String) -> float:
	return ctl.get_theme_font("font").get_string_size(text, HORIZONTAL_ALIGNMENT_CENTER, -1, ctl.get_theme_font_size("font_size")).x


## Make Tab and Shift+Tab leave a TextEdit for the next and previous control instead of typing a
## tab (the engine's `tab_input_mode` where it exists, a gui_input handler otherwise).
static func tab_leaves(te: TextEdit) -> void:
	if "tab_input_mode" in te:
		te.set("tab_input_mode", false)
		return
	te.gui_input.connect(func(e: InputEvent) -> void:
		if e is InputEventKey and (e as InputEventKey).pressed and (e as InputEventKey).keycode == KEY_TAB:
			var target := te.find_next_valid_focus() if not (e as InputEventKey).shift_pressed else te.find_prev_valid_focus()
			if target != null:
				target.grab_focus()
			te.accept_event())


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
