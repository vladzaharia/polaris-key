import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Shapes
import ".."

// The device-code block of SignInHandoff (UI-KITS 4.3, DL14): the sign-in code in mono on a borderless
// fill, so it reads as output and not as an input, with a ghost Copy button at the end; the countdown
// ring with "Code expires in 4:12"; and a QR only where the screen's link may be scanned (a TV or a
// console), carrying exactly the link the text names. Everything it shows arrives in `code`
// (polaris_key.ui.qt.layout.Code).
ColumnLayout {
    id: block
    property var code
    property real fs: 1
    // The bridge: invoke(key, action).
    property QtObject kit
    spacing: 10 * Theme.densityScale

    Text {
        text: block.code ? block.code.label : ""
        visible: text !== ""
        font.family: Theme.fontFamily
        font.pixelSize: Theme.typeMeta.size * block.fs
        font.weight: Theme.weightMedium
        color: Theme.textMuted
        Accessible.ignored: true
    }

    Rectangle {
        id: tile
        objectName: "codeTile"
        Layout.fillWidth: true
        implicitHeight: Math.max(Theme.typeCode.lineHeight * block.fs + 28, 56)
        radius: Theme.radiusControl < 0 ? Math.min(height / 2, 16) : Math.max(Theme.radiusControl, 8)
        color: Theme.surfaceSunken
        Accessible.role: Accessible.StaticText
        Accessible.name: block.code ? block.code.value : ""

        RowLayout {
            anchors.fill: parent
            anchors.margins: 12
            spacing: 8
            Text {
                objectName: "codeValue"
                text: block.code ? block.code.value : ""
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignHCenter
                elide: Text.ElideRight
                font.family: Theme.monoFamily
                font.pixelSize: Theme.typeCode.size * block.fs
                font.weight: Theme.typeCode.weight
                font.letterSpacing: Theme.typeCode.size * block.fs * 0.12
                color: Theme.textStrong
                Accessible.ignored: true
            }
            Button {
                id: copyButton
                objectName: "copyCode"
                visible: !!block.code && block.code.copyLabel !== ""
                Layout.preferredWidth: 36 * block.fs
                Layout.preferredHeight: 36 * block.fs
                hoverEnabled: true
                focusPolicy: Qt.StrongFocus
                onClicked: block.kit.invoke("a11y.copyCode", "copy-code")
                Accessible.role: Accessible.Button
                Accessible.name: block.code ? block.code.copyLabel : ""
                contentItem: KitGlyph {
                    name: "copy"
                    size: 18 * block.fs
                    color: copyButton.hovered ? Theme.textStrong : Theme.textMuted
                }
                background: Rectangle {
                    radius: Theme.radiusControl < 0 ? height / 2 : Theme.radiusControl
                    color: copyButton.down ? Theme.surfaceOverlay : "transparent"
                    border.width: copyButton.visualFocus ? Math.max(Theme.focusWidth, 2) : 0
                    border.color: Theme.focusRing
                }
            }
        }
    }

    RowLayout {
        visible: !!block.code && (block.code.expires !== "" || block.code.copied !== "")
        spacing: 8
        // The countdown ring: what is left of the code's life, when the screen knows it.
        Item {
            id: ring
            objectName: "ring"
            visible: !!block.code && block.code.fraction >= 0
            Layout.preferredWidth: 18 * block.fs
            Layout.preferredHeight: 18 * block.fs
            Accessible.ignored: true
            Shape {
                anchors.fill: parent
                antialiasing: true
                ShapePath {
                    strokeWidth: 2
                    strokeColor: Theme.borderSubtle
                    fillColor: "transparent"
                    PathAngleArc { centerX: ring.width / 2; centerY: ring.height / 2; radiusX: ring.width / 2 - 1; radiusY: ring.height / 2 - 1; startAngle: 0; sweepAngle: 360 }
                }
                ShapePath {
                    strokeWidth: 2
                    strokeColor: Theme.accent
                    fillColor: "transparent"
                    capStyle: ShapePath.RoundCap
                    PathAngleArc {
                        centerX: ring.width / 2
                        centerY: ring.height / 2
                        radiusX: ring.width / 2 - 1
                        radiusY: ring.height / 2 - 1
                        startAngle: -90
                        sweepAngle: 359.9 * (block.code ? Math.max(0, block.code.fraction) : 0)
                    }
                }
            }
        }
        Text {
            objectName: "expires"
            text: block.code ? block.code.expires : ""
            visible: text !== ""
            font.family: Theme.fontFamily
            font.pixelSize: Theme.typeMeta.size * block.fs
            color: Theme.textMuted
            Accessible.role: Accessible.StaticText
            Accessible.name: text
        }
        Text {
            objectName: "copied"
            text: block.code ? block.code.copied : ""
            visible: text !== ""
            font.family: Theme.fontFamily
            font.pixelSize: Theme.typeMeta.size * block.fs
            font.weight: Theme.weightMedium
            color: Theme.success
            Accessible.role: Accessible.StaticText
            Accessible.name: text
        }
    }

    // The QR carries the same link as the address under it (DL14). The SVG paints its own white
    // ground and quiet zone, so it scans in either scheme.
    Image {
        objectName: "qr"
        visible: !!block.code && block.code.qr !== ""
        source: block.code ? block.code.qr : ""
        Layout.alignment: Qt.AlignHCenter
        Layout.preferredWidth: 176 * block.fs
        Layout.preferredHeight: 176 * block.fs
        sourceSize.width: 352 * block.fs
        sourceSize.height: 352 * block.fs
        smooth: false
        Accessible.role: Accessible.Graphic
        Accessible.name: block.code ? block.code.qrLabel : ""
    }
}
