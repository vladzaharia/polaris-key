import QtQuick
import QtQuick.Layouts
import ".."

// One numbered step (UI-KITS 4.1 OfflineActivation): the number marker, the step's sentence and, on
// step 1, the request QR on its white tile. The marker is a formatted integer, not copy; the QR is
// one labelled image (never by colour alone), and the code and Copy carry the request without it.
RowLayout {
    id: row
    property var step
    property real fs: 1
    spacing: 12

    Rectangle {
        Layout.alignment: Qt.AlignTop
        Layout.preferredWidth: 24 * row.fs
        Layout.preferredHeight: 24 * row.fs
        radius: width / 2
        color: Theme.surfaceSunken
        border.width: 1
        border.color: Theme.borderStrong
        Text {
            anchors.centerIn: parent
            text: Number(row.step.number).toLocaleString(Qt.locale(), "f", 0)
            font.family: Theme.fontFamily
            font.pixelSize: Theme.typeMeta.size * row.fs
            font.weight: Theme.weightSemibold
            color: Theme.textStrong
            Accessible.ignored: true
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        spacing: 10
        Text {
            text: row.step.text
            Layout.fillWidth: true
            wrapMode: Text.WordWrap
            font.family: Theme.fontFamily
            font.pixelSize: Theme.typeBody.size * row.fs
            lineHeight: Theme.typeBody.lineHeight * row.fs
            lineHeightMode: Text.FixedHeight
            color: Theme.textDefault
            Accessible.role: Accessible.StaticText
            Accessible.name: row.step.number + ". " + row.step.text
        }
        Image {
            objectName: "requestQr"
            visible: row.step.qr !== ""
            source: row.step.qr
            sourceSize.width: 152
            sourceSize.height: 152
            Layout.preferredWidth: 152 * row.fs
            Layout.preferredHeight: 152 * row.fs
            fillMode: Image.PreserveAspectFit
            smooth: false
            Accessible.role: Accessible.Graphic
            Accessible.name: row.step.qrLabel
        }
    }
}
