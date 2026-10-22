import QtQuick
import QtQuick.Layouts
import ".."

// The neutral seat meter (UI-KITS 1.5 rule 9): one segment per seat, the used ones in text-strong at
// 80 %, the rest at 10 %, with the caption saying the count once. A full license is a limit, not an
// error; warning colour only when over it. Read as one labelled image (rule 4.4.8: never by colour alone).
Item {
    id: meter
    property var seat
    property real fs: 1
    implicitHeight: column.implicitHeight
    implicitWidth: 160
    Accessible.role: Accessible.Graphic
    Accessible.name: seat ? seat.label : ""

    ColumnLayout {
        id: column
        width: parent.width
        spacing: 6
        RowLayout {
            Layout.fillWidth: true
            spacing: 4
            Repeater {
                model: meter.seat ? meter.seat.segments : []
                Rectangle {
                    required property bool modelData
                    Layout.fillWidth: true
                    Layout.preferredHeight: 6 * meter.fs
                    radius: height / 2
                    color: modelData ? Qt.alpha(meter.seat.over ? Theme.warning : Theme.textStrong, 0.8)
                                     : Qt.alpha(Theme.textStrong, 0.1)
                }
            }
        }
        Text {
            visible: text !== ""
            text: meter.seat ? meter.seat.caption : ""
            font.family: Theme.fontFamily
            font.pixelSize: Theme.typeMeta.size * meter.fs
            color: Theme.textMuted
            Accessible.ignored: true
        }
    }
}
