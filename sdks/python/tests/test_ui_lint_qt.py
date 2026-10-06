"""The Qt modernity-lint helper (tests/ui_lint_qt.py) on fake widget trees, and on a real Qt tree
when PySide6 or PyQt6 is installed."""

from __future__ import annotations

import pytest

from ui_lint_qt import lint_widget_tree


class FakeFont:
    def __init__(self, family="Rubik", weight=400, px=15, cap=0):
        self._f, self._w, self._px, self._cap = family, weight, px, cap

    def family(self):
        return self._f

    def weight(self):
        return self._w

    def pixelSize(self):
        return self._px

    def pointSizeF(self):
        return -1.0

    def capitalization(self):
        return self._cap


class FakeWidget:
    def __init__(self, cls="QLabel", font=None, kids=(), align=0, text=""):
        self._cls, self._font, self._kids, self._align, self._text = cls, font or FakeFont(), list(kids), align, text

    def metaObject(self):
        cls = self._cls

        class M:
            def className(self):
                return cls

        return M()

    def font(self):
        return self._font

    def children(self):
        return self._kids

    def alignment(self):
        return self._align

    def text(self):
        return self._text

    def objectName(self):
        return ""


def test_a_clean_tree_passes():
    tree = FakeWidget("QWidget", kids=[FakeWidget(text="Add your license"), FakeWidget("QPushButton", FakeFont(weight=500), text="Activate")])
    assert lint_widget_tree(tree) == []


@pytest.mark.parametrize(
    "widget,rule",
    [
        (FakeWidget("QMessageBox"), "system-dialog"),
        (FakeWidget("QCheckBox"), "checkbox"),
        (FakeWidget(font=FakeFont(family="Arial")), "font-family"),
        (FakeWidget(font=FakeFont(weight=700)), "font-weight"),
        (FakeWidget(font=FakeFont(px=11)), "text-size"),
        (FakeWidget(font=FakeFont(cap=1)), "uppercase"),
        (FakeWidget(align=0x0010 | 0x0001), "rtl"),
    ],
)
def test_each_rule_fails_on_a_seeded_violation(widget, rule):
    findings = lint_widget_tree(FakeWidget("QWidget", kids=[widget]))
    assert [f.split(":")[0] for f in findings] == [rule]


def test_native_preset_allows_the_system_font():
    assert lint_widget_tree(FakeWidget(font=FakeFont(family="Segoe UI")), native=True) == []


def test_a_real_qt_tree():
    qt = pytest.importorskip("PySide6.QtWidgets")
    app = qt.QApplication.instance() or qt.QApplication([])
    root = qt.QWidget()
    qt.QMessageBox(root)
    findings = lint_widget_tree(root, families=[app.font().family()])
    assert any(f.startswith("system-dialog") for f in findings)
