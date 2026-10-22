import QtQuick
import QtQuick.Controls.Basic
import ".."

// One kit button. `role` is "primary" (the one filled action, in the product accent), "secondary"
// (outlined), "quiet" (text), "danger" (the destructive action: the danger solid with a white label,
// as the other kits' danger variant) or "dangerText" (outlined, in danger text: Sign out, UI-KITS 4.1).
// The ring draws on visualFocus only (keyboard), never on a click.
Button {
    id: control
    property string role: "secondary"
    property real scale_: 1
    // DL4: a busy control keeps its label and its focus and adds the indicator.
    property bool busy: false
    property bool animate: true
    // UI-KITS 1.5 rule 11: an action that leaves the app carries the new-window glyph after its label;
    // the glyph is decorative, so `externalNote` ("Opens in your browser") is the description.
    property bool external: false
    property string externalNote: ""
    readonly property bool primary: role === "primary"
    readonly property bool quiet: role === "quiet"
    readonly property bool danger: role === "danger"
    readonly property bool dangerText: role === "dangerText"

    implicitHeight: Math.max(Theme.controlHeight * scale_, 24)
    implicitWidth: quiet ? contentItem.implicitWidth + 8 : Math.max(contentItem.implicitWidth + 2 * 16, 88)
    horizontalPadding: quiet ? 0 : 16
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    Accessible.role: Accessible.Button
    Accessible.name: text
    Accessible.description: externalNote

    contentItem: Item {
        id: content
        // The label's own width, not the row's: the row clamps the label to this item, which would
        // make the button as wide as its clamped (elided) text.
        implicitWidth: label.implicitWidth + (control.busy ? spinner.width + row.spacing : 0) + (control.external ? leave.width + row.spacing : 0)
        implicitHeight: row.implicitHeight
        readonly property color ink: !control.enabled ? Theme.actionDisabledOn
             : control.primary ? Theme.accentOn
             : control.danger ? Theme.dangerSolidOn
             : control.dangerText ? Theme.danger
             : control.quiet ? (control.hovered ? Theme.textStrong : Theme.textMuted)
             : Theme.textStrong
        Row {
            id: row
            anchors.centerIn: parent
            spacing: 8
            Item {
                id: spinner
                visible: control.busy
                width: 14 * control.scale_
                height: width
                anchors.verticalCenter: parent.verticalCenter
                Rectangle {
                    anchors.fill: parent
                    radius: width / 2
                    color: "transparent"
                    border.width: 2
                    border.color: Qt.alpha(content.ink, 0.3)
                }
                Rectangle {
                    width: 4 * control.scale_
                    height: width
                    radius: width / 2
                    color: content.ink
                    x: (spinner.width - width) / 2
                    y: 0
                }
                RotationAnimator on rotation {
                    running: control.busy && control.animate
                    from: 0
                    to: 360
                    duration: 900
                    loops: Animation.Infinite
                }
            }
            Text {
                id: label
                text: control.text
                width: Math.min(implicitWidth, content.width - (control.busy ? spinner.width + row.spacing : 0) - (control.external ? leave.width + row.spacing : 0))
                font.family: Theme.fontFamily
                font.pixelSize: Theme.typeButton.size * control.scale_
                font.weight: Theme.typeButton.weight
                color: content.ink
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
                elide: Text.ElideRight
            }
            KitGlyph {
                id: leave
                visible: control.external
                name: "external"
                size: Theme.typeButton.size * control.scale_
                color: content.ink
                anchors.verticalCenter: parent.verticalCenter
            }
        }
    }

    background: Rectangle {
        radius: Theme.radiusControl < 0 ? height / 2 : Theme.radiusControl
        color: control.quiet ? "transparent"
             : control.danger ? (control.down ? Qt.darker(Theme.dangerSolid, 1.15) : control.hovered ? Qt.lighter(Theme.dangerSolid, 1.08) : Theme.dangerSolid)
             : control.primary ? (control.down ? Qt.darker(Theme.accent, 1.15) : control.hovered ? Qt.lighter(Theme.accent, 1.08) : Theme.accent)
             : (control.down ? Theme.surfaceSunken : Theme.surfaceOverlay)
        border.width: control.primary || control.danger || control.quiet ? 0 : 1
        border.color: control.dangerText ? Theme.dangerBorder : control.hovered ? Theme.borderStrong : Theme.borderSubtle
        scale: control.down ? Theme.pressScale : 1
        Behavior on scale { NumberAnimation { duration: Theme.durationFast; easing.type: Easing.OutCubic } }
        Behavior on color { ColorAnimation { duration: Theme.durationFast } }

        Rectangle {
            visible: control.visualFocus
            anchors.fill: parent
            anchors.margins: Theme.focusOffset
            radius: parent.radius
            color: "transparent"
            border.width: Math.max(Theme.focusWidth, 2)
            border.color: Theme.focusRing
        }
    }
}
