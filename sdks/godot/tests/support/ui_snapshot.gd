class_name PKeyUiSnapshot
extends RefCounted
## Structural snapshots of a UI kit scene for the headless `ui` suite (there is no renderer, so
## no pixels): one line per visible leaf control, as `path: Type "text" [flags]`, where flags are
## `disabled`, `pressed`, `secret`, `placeholder "…"`, `value N` and `focus N` (the control's index
## in the scene's focus chain, from 1). Containers only contribute their names to the paths.
## Hidden nodes and everything under them are left out.
##
## Also the independent oracle for the focus test: `interactive(view)` walks the tree for every
## visible, enabled control a player can operate, without asking the scene's own focus chain.


static func take(view: Control) -> String:
	var order: Array = view.focus_order() if view.has_method("focus_order") else []
	var lines: PackedStringArray = []
	if not view.visible:
		lines.append("<hidden>")
	_walk(view, view, order, lines)
	return "\n".join(lines)


static func _walk(root: Control, node: Node, order: Array, lines: PackedStringArray) -> void:
	for child in node.get_children():
		if child is CanvasItem and not (child as CanvasItem).visible:
			continue
		if not (child is Control):
			continue
		var line := _line(root, child, order)
		if line != "":
			lines.append(line)
		if not _is_leaf(child):
			_walk(root, child, order, lines)


static func _is_leaf(n: Node) -> bool:
	return n is Label or n is BaseButton or n is LineEdit or n is TextEdit or n is Range or n is TextureRect


static func _line(root: Control, n: Control, order: Array) -> String:
	var path := String(root.get_path_to(n))
	var flags: PackedStringArray = []
	var text := ""
	var type := n.get_class()
	if n is PKeyQrRect:
		type = "PKeyQrRect"
		text = (n as PKeyQrRect).text
	elif n is TextureRect:
		if (n as TextureRect).texture == null:
			return ""
		type = "TextureRect"
	elif n is Label:
		text = (n as Label).text
	elif n is OptionButton:
		var ob := n as OptionButton
		text = ob.get_item_text(ob.selected) if ob.selected >= 0 else ""
		var items: PackedStringArray = []
		for i in ob.item_count:
			items.append(ob.get_item_text(i))
		flags.append("items [%s]" % ", ".join(items))
	elif n is BaseButton:
		text = (n as Button).text if n is Button else ""
		if (n as BaseButton).toggle_mode and (n as BaseButton).button_pressed:
			flags.append("pressed")
	elif n is LineEdit:
		var le := n as LineEdit
		text = le.text
		if le.placeholder_text != "":
			flags.append("placeholder \"%s\"" % _esc(le.placeholder_text))
		if le.secret:
			flags.append("secret")
		if not le.editable:
			flags.append("read-only")
	elif n is TextEdit:
		var te := n as TextEdit
		text = te.text
		if te.placeholder_text != "":
			flags.append("placeholder \"%s\"" % _esc(te.placeholder_text))
		if not te.editable:
			flags.append("read-only")
	elif n is SpinBox:
		var sp := n as SpinBox
		flags.append("value %s" % str(sp.value))
		if not sp.editable:
			flags.append("read-only")
	elif n is ProgressBar:
		pass
	else:
		return ""
	if n is BaseButton and (n as BaseButton).disabled:
		flags.append("disabled")
	var focus_target: Control = (n as SpinBox).get_line_edit() if n is SpinBox else n
	var at := order.find(focus_target)
	if at >= 0:
		flags.append("focus %d" % (at + 1))
	var out := "%s: %s" % [path, type]
	if text != "":
		out += " \"%s\"" % _esc(text)
	if not flags.is_empty():
		out += " [" + ", ".join(flags) + "]"
	return out


## Backslashes, newlines and quotes escaped; the bidi isolates the kit draws around a product's
## name (FSI, PDI) spelled out, so a fixture shows them.
static func _esc(s: String) -> String:
	return s.replace("\\", "\\\\").replace("\n", "\\n").replace("\"", "\\\"").replace(String.chr(0x2068), "\\u2068").replace(String.chr(0x2069), "\\u2069")


## Every visible, enabled control a player can operate under `view`: buttons (check buttons and
## option buttons included), line and text edits that are editable, and spin boxes (as their
## line edit). Independent of the scene's focus chain.
static func interactive(view: Control) -> Array:
	var out: Array = []
	_collect(view, out)
	return out


static func _collect(node: Node, out: Array) -> void:
	for child in node.get_children():
		if child is CanvasItem and not (child as CanvasItem).visible:
			continue
		if child is Window:
			continue
		if child is BaseButton:
			# A pointer-only control (a stepper's minus and plus: left and right do it on a pad)
			# takes no focus.
			if not (child as BaseButton).disabled and (child as BaseButton).focus_mode != Control.FOCUS_NONE:
				out.append(child)
			continue
		if child is Slider:
			if (child as Slider).editable and (child as Slider).focus_mode != Control.FOCUS_NONE:
				out.append(child)
			continue
		if child is SpinBox:
			if (child as SpinBox).editable:
				out.append((child as SpinBox).get_line_edit())
			continue
		if child is LineEdit:
			if (child as LineEdit).editable:
				out.append(child)
			continue
		if child is TextEdit:
			if (child as TextEdit).editable:
				out.append(child)
			continue
		_collect(child, out)


## Every visible text a player reads under `view`, as [node, text] pairs: Label and Button text,
## and the placeholders of line and text edits. OptionButton items count through the button text.
static func texts(view: Control) -> Array:
	var out: Array = []
	_texts(view, out)
	return out


static func _texts(node: Node, out: Array) -> void:
	for child in node.get_children():
		if child is CanvasItem and not (child as CanvasItem).visible:
			continue
		if child is Label and (child as Label).text != "":
			out.append([child, (child as Label).text])
		elif child is Button and (child as Button).text != "":
			out.append([child, (child as Button).text])
		elif child is LineEdit and (child as LineEdit).placeholder_text != "":
			out.append([child, (child as LineEdit).placeholder_text])
		elif child is TextEdit and (child as TextEdit).placeholder_text != "":
			out.append([child, (child as TextEdit).placeholder_text])
		if not (child is Button or child is Label or child is LineEdit or child is TextEdit):
			_texts(child, out)
