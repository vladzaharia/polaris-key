"""The Qt equivalent of the modernity lint (UI-KITS.md §7.3), as a test helper for the Qt kit.

``lint_widget_tree(root)`` walks a live QWidget tree (PySide6 or PyQt6; duck-typed, so it imports
neither) and returns one finding per broken rule:

- no default system dialogs for anything the kit owns (QMessageBox, QProgressDialog, QInputDialog;
  §1.5 rule 3);
- no check box where a switch is meant (QCheckBox; §1.5 rule 6);
- the theme's families only (Rubik and JetBrains Mono unless the native preset is on; §2.1);
- weights 400 / 500 / 600 only (DL12, §1.5 rule 6) and no all-caps text (§1.5 rule 6);
- no text below 12 px (§7.3);
- RTL-safe alignment: never ``Qt.AlignAbsolute`` (Qt mirrors AlignLeft / AlignRight itself; §4.7).

UK-12 (the Qt kit) calls it on every rendered state in its own suite::

    from ui_lint_qt import lint_widget_tree
    assert lint_widget_tree(window) == []

Two design-language checks (UK-55) take the screen and the copy::

    assert lint_refusals(window, REFUSAL_PATTERNS) == []   # DL6: a refusal is a neutral callout
    assert lint_initial_focus(window) == []                # DL9: focus starts inside the screen

The source half of the Qt rules (QSS margins, colour literals) is packages/ui-qa/bin/kit-lint.mjs.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, List, Sequence

THEME_FAMILIES = ("Rubik", "JetBrains Mono")
SYSTEM_DIALOGS = ("QMessageBox", "QProgressDialog", "QInputDialog")
ALIGN_ABSOLUTE = 0x0010  # Qt.AlignmentFlag.AlignAbsolute
ALL_UPPERCASE = 1  # QFont.Capitalization.AllUppercase
MIN_PX = 12
WEIGHTS = (400, 500, 600)


def _class_name(w: Any) -> str:
    meta = getattr(w, "metaObject", None)
    if callable(meta):
        try:
            return str(meta().className())
        except Exception:  # pragma: no cover - a half-built widget
            pass
    return type(w).__name__


def _int(v: Any) -> int:
    for attr in ("value",):
        if hasattr(v, attr):
            return int(getattr(v, attr))
    return int(v)


def _children(w: Any) -> Iterable[Any]:
    find = getattr(w, "children", None)
    return find() if callable(find) else []


def _label(w: Any) -> str:
    name = getattr(w, "objectName", None)
    text = getattr(w, "text", None)
    parts = [_class_name(w)]
    if callable(name) and name():
        parts.append(f"#{name()}")
    if callable(text):
        try:
            t = text()
            if t:
                parts.append(repr(str(t)[:40]))
        except TypeError:
            pass
    return " ".join(parts)


def lint_widget_tree(root: Any, *, families: Iterable[str] = THEME_FAMILIES, native: bool = False) -> List[str]:
    allowed = {f.lower() for f in families}
    findings: List[str] = []
    stack = [root]
    while stack:
        w = stack.pop()
        stack.extend(c for c in _children(w) if hasattr(c, "font") or hasattr(c, "children"))
        cls = _class_name(w)
        where = _label(w)
        if cls in SYSTEM_DIALOGS:
            findings.append(f"system-dialog: {where} (use the kit's sheet or inline confirm)")
        if cls == "QCheckBox":
            findings.append(f"checkbox: {where} (the kit's one switch, never a check box)")
        font_fn = getattr(w, "font", None)
        if callable(font_fn):
            f = font_fn()
            fam = str(f.family())
            if not native and fam.lower() not in allowed:
                findings.append(f"font-family: {where} uses {fam}")
            if _int(f.weight()) not in WEIGHTS:
                findings.append(f"font-weight: {where} is {_int(f.weight())}")
            px = f.pixelSize()
            if px is None or px <= 0:
                pt = f.pointSizeF()
                px = pt * 96 / 72 if pt and pt > 0 else None
            if px is not None and px < MIN_PX:
                findings.append(f"text-size: {where} is {px:g}px (min {MIN_PX})")
            cap = getattr(f, "capitalization", None)
            if callable(cap) and _int(cap()) == ALL_UPPERCASE:
                findings.append(f"uppercase: {where}")
        align = getattr(w, "alignment", None)
        if callable(align):
            try:
                if _int(align()) & ALIGN_ABSOLUTE:
                    findings.append(f"rtl: {where} sets AlignAbsolute")
            except TypeError:
                pass
    return findings


def _prop(w: Any, name: str) -> Any:
    fn = getattr(w, "property", None)
    if not callable(fn):
        return None
    try:
        return fn(name)
    except TypeError:
        return None


def _is_invalid(w: Any) -> bool:
    return bool(_prop(w, "invalid")) or _prop(w, "tone") == "danger" and _class_name(w) in ("QLineEdit", "QPlainTextEdit")


def lint_refusals(root: Any, patterns: Sequence[str], *, danger_colors: Sequence[str] = ()) -> List[str]:
    """DL6: a refusal the person can resolve (device limit, revoked, expired, version, channel) is a
    neutral callout. A widget whose text matches a refusal pattern fails when it carries ``tone ==
    "danger"``, when its style sheet names a danger colour (``#rrggbb``), or when an invalid field
    (``invalid`` true, or a danger-toned line edit) is its sibling."""
    res = [re.compile(p) for p in patterns]
    findings: List[str] = []
    stack = [(root, None)]
    while stack:
        w, parent = stack.pop()
        stack.extend((c, w) for c in _children(w))
        text_fn = getattr(w, "text", None)
        if not callable(text_fn):
            continue
        try:
            text = str(text_fn() or "").strip()
        except TypeError:
            continue
        if not text or not any(r.search(text) for r in res):
            continue
        where = _label(w)
        if _prop(w, "tone") == "danger":
            findings.append(f"refusal-styling: {where} is a refusal in the danger tone (a neutral callout, DL6)")
        sheet_fn = getattr(w, "styleSheet", None)
        sheet = str(sheet_fn()).lower() if callable(sheet_fn) else ""
        if any(c.lower() in sheet for c in danger_colors):
            findings.append(f"refusal-styling: {where} draws a refusal in a danger colour (DL6)")
        if parent is not None and any(_is_invalid(sib) for sib in _children(parent) if sib is not w):
            findings.append(f"refusal-styling: {where} sits beside an invalid field (DL6)")
    return findings


def lint_initial_focus(window: Any) -> List[str]:
    """DL9: once the screen is shown, the focus widget is the screen or inside it."""
    focus_fn = getattr(window, "focusWidget", None)
    focused = focus_fn() if callable(focus_fn) else None
    if focused is None:
        return [f"initial-focus: {_label(window)} has no focus widget (DL9)"]
    inside = getattr(window, "isAncestorOf", None)
    if focused is not window and callable(inside) and not inside(focused):
        return [f"initial-focus: focus is on {_label(focused)}, outside {_label(window)} (DL9)"]
    return []
