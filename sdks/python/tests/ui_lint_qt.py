"""The Qt equivalent of the modernity lint (UI-KITS.md §7.3), as a test helper for the Qt kit.

``lint_widget_tree(root)`` walks a live QWidget tree (PySide6 or PyQt6; duck-typed, so it imports
neither) and returns one finding per broken rule:

- no default system dialogs for anything the kit owns (QMessageBox, QProgressDialog, QInputDialog;
  §1.5 rule 3);
- no check box where a switch is meant (QCheckBox; §1.5 rule 6);
- the theme's families only (Rubik and JetBrains Mono unless the native preset is on; §2.1);
- weights 400 / 500 / 600 only (§1.5 rule 6) and no all-caps text (§1.5 rule 6);
- no text below 12 px (§7.3);
- RTL-safe alignment: never ``Qt.AlignAbsolute`` (Qt mirrors AlignLeft / AlignRight itself; §4.7).

UK-12 (the Qt kit) calls it on every rendered state in its own suite::

    from ui_lint_qt import lint_widget_tree
    assert lint_widget_tree(window) == []

The source half of the Qt rules (QSS margins, colour literals) is packages/ui-qa/bin/kit-lint.mjs.
"""

from __future__ import annotations

from typing import Any, Iterable, List

THEME_FAMILIES = ("Rubik", "JetBrains Mono")
SYSTEM_DIALOGS = ("QMessageBox", "QProgressDialog", "QInputDialog")
ALIGN_ABSOLUTE = 0x0010  # Qt.AlignmentFlag.AlignAbsolute
ALL_UPPERCASE = 1  # QFont.Capitalization.AllUppercase
MIN_PX = 12
MAX_WEIGHT = 600


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
            if _int(f.weight()) > MAX_WEIGHT:
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
