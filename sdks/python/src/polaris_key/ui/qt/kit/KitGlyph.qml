import QtQuick
import QtQuick.Shapes
import ".."

// A bare line glyph on the 24 x 24 grid (2 px round stroke), drawn at `size`: the form factor of a
// device (phone, tablet, tv, computer), the lock of a managed setting, the new-window mark and the
// check of a chosen row. Decorative: the row names it (Accessible.name on the item that holds it).
Item {
    id: glyph
    property string name: "computer"
    property real size: 20
    property color color: Theme.textMuted
    implicitWidth: size
    implicitHeight: size

    readonly property var paths: ({
        "phone": ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M12 18h.01", ""],
        "tablet": ["M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M12 18h.01", ""],
        "tv": ["M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M7 21h10", ""],
        "computer": ["M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M2 20h20", ""],
        "lock": ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z", "M7 11V7a5 5 0 0 1 10 0v4", ""],
        "external": Theme.glyphNewWindow,
        "check": ["M20 6 9 17l-5-5", "", ""],
        "sliders": ["M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3", "M1 14h6M9 8h6M17 16h6", ""],
        "download": ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
        "copy": ["M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z", "M5 15H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1", ""]
    })
    readonly property var current: paths[name] || ["", "", ""]

    Shape {
        width: 24
        height: 24
        scale: glyph.size / 24
        transformOrigin: Item.TopLeft
        antialiasing: true
        ShapePath {
            strokeWidth: 2
            strokeColor: glyph.color
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: glyph.current[0] }
        }
        ShapePath {
            strokeWidth: 2
            strokeColor: glyph.color
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: glyph.current[1] }
        }
        ShapePath {
            strokeWidth: 2
            strokeColor: glyph.color
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: glyph.current[2] }
        }
    }
}
