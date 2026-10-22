class_name PKeyListScroll
extends RefCounted
## A list that scrolls inside its card (UI-KITS.md §4.3, DL3: the form's primary stays on screen and
## the list gives way). The card passes its content through while the list takes only the room the
## rest of the card leaves; a list longer than that scrolls, following the focus. Devices and
## LicenseChoice use it, nested in the gate or standing alone.
##
##   var scroll := PKeyListScroll.make(frame, "ListScroll")     # in _build()
##   PKeyListScroll.apply(self, scroll, panel, least)           # in _arrange(), after super()
##   func _layout_stale() -> bool: return PKeyListScroll.stale(self, scroll, panel, least)

## The meta a list's scroll area carries (the matrix does not hold a list to "no scroll fallback").
const META := &"pkey_list_scroll"


static func make(parent: Node, node_name := "ListScroll") -> ScrollContainer:
	var sc := ScrollContainer.new()
	sc.name = node_name
	sc.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	sc.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	sc.follow_focus = true
	sc.set_meta(META, true)
	parent.add_child(sc)
	return sc


## The height `scroll` is held to while `panel` (its content) is taller than the room the outermost
## view's card leaves it, else 0 (the list is as tall as its rows). `least` is the least it may be.
static func wanted(view: PKeyUiView, scroll: ScrollContainer, panel: Control, least: float) -> float:
	if not scroll.visible:
		return 0.0
	var need := panel.get_combined_minimum_size().y
	var outer := view.outer_view()
	var content: Control = null
	if not outer._scrolls.is_empty() and (outer._scrolls[0] as ScrollContainer).get_child_count() > 0:
		content = (outer._scrolls[0] as ScrollContainer).get_child(0) as Control
	var total := content.get_combined_minimum_size().y if content != null else need
	var room := outer.available_height() - (total - scroll.get_combined_minimum_size().y)
	if need <= room + 0.5:
		return 0.0
	return maxf(room, least)


## Hold the list to the room it has (scrolling) or let it be as tall as its rows. True when that
## changed the list (the containers around it are then sorted again, as the engine does not always
## re-sort a container whose child's minimum changed).
static func apply(view: PKeyUiView, scroll: ScrollContainer, panel: Control, least: float) -> bool:
	var want := wanted(view, scroll, panel, least)
	var mode := ScrollContainer.SCROLL_MODE_AUTO if want > 0.0 else ScrollContainer.SCROLL_MODE_DISABLED
	var changed := false
	if scroll.vertical_scroll_mode != mode:
		scroll.vertical_scroll_mode = mode
		changed = true
	if not is_equal_approx(scroll.custom_minimum_size.y, want):
		scroll.custom_minimum_size.y = want
		changed = true
	return changed


## Let the list be as tall as its rows, whatever the room (the card around it scrolls instead).
static func pass_through(scroll: ScrollContainer) -> bool:
	var changed := scroll.vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED or not is_zero_approx(scroll.custom_minimum_size.y)
	scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.custom_minimum_size.y = 0.0
	return changed


## True when the height the list was given no longer matches the room (measured before the text
## finished wrapping): the view lays out again.
static func stale(view: PKeyUiView, scroll: ScrollContainer, panel: Control, least: float) -> bool:
	if not (view.is_inside_tree() and view.is_visible_in_tree()):
		return false
	var want := wanted(view, scroll, panel, least)
	return not is_equal_approx(scroll.custom_minimum_size.y, want) or (want > 0.0) != (scroll.vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED)


## The width a row of the list has: the card's content (capped at `max_content_width`, or the host
## card's room when nested), less the card's and the list panel's padding and, when `scroll` is given,
## the room its scroll bar keeps.
static func inner_room(view: PKeyUiView, panel: Control, scroll: ScrollContainer = null) -> float:
	var w := view.card_width(INF)
	var capped := view.content_width()
	if capped > 0.0:
		w = minf(w, capped)
	w -= view.card_padding_x() + PKeyUiView.side_padding(panel)
	if scroll != null:
		w -= scroll.get_v_scroll_bar().get_combined_minimum_size().x
	return w


## Fit the labels of the buttons under `root` (a list's rows) to the room the list leaves: the base
## fits a button to the card's whole width, which a button inside a padded list panel then exceeds (a
## label wider than the room wraps at its words, DL11). The scroll bar's width is kept free whether
## the list scrolls now or not, so a list that starts to scroll does not push the card wider.
static func fit_buttons(view: PKeyUiView, root: Node, panel: Control, scroll: ScrollContainer = null) -> void:
	var room := inner_room(view, panel, scroll)
	for b in root.find_children("*", "Button", true, false):
		if (b as Button).get_class() == "Button" and (b as Button).is_visible_in_tree():
			PKeyUiView._fit_label(b as Button, room)


## A full-screen view that grew past its parent while its list still took its full height keeps that
## size when the list is bounded (the engine does not take a smaller minimum back by itself): size it
## to its minimum and let the kit give it the parent's rect again. A view that fits is left alone.
static func resync(view: PKeyUiView) -> void:
	var parent := view.get_parent() as Control
	if parent == null or parent is Container or not view.is_inside_tree() or view.outer_view() != view:
		return
	var want := parent.size
	if view.size.x <= want.x + 0.5 and view.size.y <= want.y + 0.5:
		return
	var least := view.get_combined_minimum_size()
	if least.x > want.x + 0.5 or least.y > want.y + 0.5:
		return
	view.set_size(Vector2.ZERO)
	view._release_offsets()
