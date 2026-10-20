import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import ".."

// One kit screen, drawn from the bridge's `spec` (polaris_key.ui.qt.layout.ScreenSpec): the product
// as the hero, a heading, sentences, at most one filled action. Responsive on the root's width and
// height (DL1): below 520 logical px the card is the window; above, a centred column.
Rectangle {
    id: root
    // The Python bridge (polaris_key.ui.qt.bridge.KitBridge), set as a context property.
    readonly property QtObject kit: bridge
    readonly property var spec: kit.spec
    readonly property real fs: kit.fontScale
    readonly property bool compact: width < 520
    readonly property real gutter: compact ? 16 : 32

    color: Theme.surfacePage
    Accessible.role: Accessible.Pane
    Accessible.name: spec.title || spec.product

    Binding { target: Theme; property: "scheme"; value: kit.scheme }
    Binding { target: Theme; property: "platform"; value: kit.platform }
    Binding { target: Theme; property: "accent"; value: kit.accent; when: kit.accent !== "" }
    Binding { target: Theme; property: "accentOn"; value: kit.accentOn; when: kit.accent !== "" }
    Binding { target: Theme; property: "accentFg"; value: kit.accentFg; when: kit.accent !== "" }
    Binding { target: Theme; property: "accentSubtle"; value: kit.accentSubtle; when: kit.accent !== "" }
    Binding { target: Theme; property: "focusRing"; value: kit.focusRing; when: kit.accent !== "" }

    Flickable {
        id: scroller
        anchors.fill: parent
        contentWidth: width
        contentHeight: Math.max(height, card.height + 2 * root.gutter)
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Rectangle {
            id: card
            visible: !spec.hidden
            width: Math.min(scroller.width - 2 * root.gutter, 480)
            x: (scroller.width - width) / 2
            y: Math.max(root.gutter, (scroller.height - height) / 2)
            height: column.implicitHeight + 2 * Theme.cardPad
            radius: Theme.radiusSurface
            color: Theme.surfaceRaised
            border.width: 1
            border.color: Theme.borderSubtle

            ColumnLayout {
                id: column
                x: Theme.cardPad
                y: Theme.cardPad
                width: card.width - 2 * Theme.cardPad
                spacing: 12

                RowLayout {
                    visible: spec.product !== "" || icon.status === Image.Ready
                    spacing: 10
                    Image {
                        id: icon
                        visible: status === Image.Ready
                        source: kit.iconSource
                        sourceSize.width: 48 * root.fs
                        sourceSize.height: 48 * root.fs
                        Layout.preferredWidth: 40 * root.fs
                        Layout.preferredHeight: 40 * root.fs
                        fillMode: Image.PreserveAspectFit
                        Accessible.role: Accessible.Graphic
                        Accessible.name: kit.iconLabel
                    }
                    ColumnLayout {
                        spacing: 0
                        Text {
                            text: spec.product
                            visible: text !== ""
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeLabel.size * root.fs
                            font.weight: Theme.typeLabel.weight
                            color: Theme.textStrong
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }
                        Text {
                            text: kit.developerLine
                            visible: text !== ""
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.typeMeta.size * root.fs
                            color: Theme.textMuted
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }
                    }
                }

                Text {
                    id: heading
                    visible: text !== ""
                    text: spec.title
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.typeTitle.size * root.fs
                    font.weight: Theme.typeTitle.weight
                    color: spec.tone === "danger" ? Theme.danger : Theme.textStrong
                    // The heading takes focus when a state has no field (DL9), so a reader lands on it.
                    focus: spec.focus === "heading"
                    activeFocusOnTab: true
                    Accessible.role: Accessible.Heading
                    Accessible.name: text
                }

                Repeater {
                    model: spec.body
                    Text {
                        required property string modelData
                        text: modelData
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.typeBody.size * root.fs
                        lineHeight: Theme.typeBody.lineHeight * root.fs
                        lineHeightMode: Text.FixedHeight
                        color: Theme.textDefault
                        Accessible.role: Accessible.StaticText
                        Accessible.name: modelData
                    }
                }

                ProgressBar {
                    id: bar
                    visible: spec.progress > -2
                    Layout.fillWidth: true
                    indeterminate: spec.progress < 0 && spec.progress > -2
                    value: Math.max(0, spec.progress)
                    Accessible.name: spec.title || spec.product
                    background: Rectangle { implicitHeight: 4; radius: 2; color: Theme.surfaceSunken }
                    contentItem: Item {
                        id: track
                        implicitHeight: 4
                        Rectangle {
                            id: fill
                            width: track.width * (bar.indeterminate ? 0.35 : bar.visualPosition)
                            height: track.height
                            radius: 2
                            color: Theme.accent
                            SequentialAnimation on x {
                                running: kit.animate && bar.indeterminate && bar.visible
                                loops: Animation.Infinite
                                NumberAnimation { from: 0; to: 0.65 * track.width; duration: 1200; easing.type: Easing.InOutQuad }
                                NumberAnimation { from: 0.65 * track.width; to: 0; duration: 1200; easing.type: Easing.InOutQuad }
                            }
                        }
                    }
                }

                // UI-KITS §1.6: the Locker micro mark (16) and the phrase; with poweredBy "badge",
                // the 320 x 104 badge where 320 px is free, else the line.
                Image {
                    id: poweredBadge
                    readonly property bool shown: spec.poweredBy === "badge" && column.width >= 320
                    visible: shown
                    Layout.alignment: Qt.AlignHCenter
                    Layout.preferredWidth: shown ? 320 : 0
                    Layout.preferredHeight: shown ? 104 : 0
                    sourceSize.width: 640
                    sourceSize.height: 208
                    source: shown ? kit.poweredByBadge : ""
                    Accessible.role: Accessible.Graphic
                    Accessible.name: spec.poweredByText
                }
                RowLayout {
                    visible: spec.poweredBy !== "" && !poweredBadge.shown
                    spacing: 8
                    Image {
                        Layout.preferredWidth: 16
                        Layout.preferredHeight: 16
                        sourceSize.width: 32
                        sourceSize.height: 32
                        source: kit.poweredByMark
                        Accessible.ignored: true
                    }
                    Text {
                        text: spec.poweredByText
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.typeMeta.size * root.fs
                        color: Theme.textSubtle
                        Accessible.role: Accessible.StaticText
                        Accessible.name: text
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: 8
                    spacing: 8
                    visible: spec.buttons.length > 0
                    Repeater {
                        model: spec.buttons.filter(b => b.role !== "quiet")
                        KitButton {
                            required property var modelData
                            text: modelData.text
                            role: modelData.role
                            scale_: root.fs
                            Layout.fillWidth: true
                            onClicked: kit.invoke(modelData.key, modelData.action)
                        }
                    }
                    Flow {
                        Layout.fillWidth: true
                        spacing: 12
                        Repeater {
                            model: spec.buttons.filter(b => b.role === "quiet")
                            KitButton {
                                required property var modelData
                                text: modelData.text
                                role: "quiet"
                                scale_: root.fs
                                onClicked: kit.invoke(modelData.key, modelData.action)
                            }
                        }
                    }
                }
            }
        }
    }
}
