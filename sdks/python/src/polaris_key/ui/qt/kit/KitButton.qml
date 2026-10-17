import QtQuick
import QtQuick.Controls.Basic
import ".."

// One kit button. `role` is "primary" (the one filled action, in the product accent), "secondary"
// (outlined) or "quiet" (text). The ring draws on visualFocus only (keyboard), never on a click.
Button {
    id: control
    property string role: "secondary"
    property real scale_: 1
    readonly property bool primary: role === "primary"
    readonly property bool quiet: role === "quiet"

    implicitHeight: Math.max(Theme.controlHeight * scale_, 24)
    implicitWidth: quiet ? contentItem.implicitWidth + 8 : Math.max(contentItem.implicitWidth + 2 * 16, 88)
    horizontalPadding: quiet ? 0 : 16
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    Accessible.role: Accessible.Button
    Accessible.name: text

    contentItem: Text {
        text: control.text
        font.family: Theme.fontFamily
        font.pixelSize: Theme.typeButton.size * control.scale_
        font.weight: Theme.typeButton.weight
        color: !control.enabled ? Theme.actionDisabledOn
             : control.primary ? Theme.accentOn
             : control.quiet ? (control.hovered ? Theme.textStrong : Theme.textMuted)
             : Theme.textStrong
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }

    background: Rectangle {
        radius: Theme.radiusControl < 0 ? height / 2 : Theme.radiusControl
        color: control.quiet ? "transparent"
             : control.primary ? (control.down ? Qt.darker(Theme.accent, 1.15) : control.hovered ? Qt.lighter(Theme.accent, 1.08) : Theme.accent)
             : (control.down ? Theme.surfaceSunken : Theme.surfaceOverlay)
        border.width: control.primary || control.quiet ? 0 : 1
        border.color: control.hovered ? Theme.borderStrong : Theme.borderSubtle
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
